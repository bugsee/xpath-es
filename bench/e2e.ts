// End to end through real consumers: samlify 2.13.1 -> xml-crypto 6.4.0 -> xpath, on signed login responses.
// The `xpath` module the consumers load is, per process, upstream 0.0.36 (the oracle), the candidate (CANDIDATE), or
// a shadow that runs upstream AND the candidate on every call, compares the two results node by node and answers
// with upstream's: the shadow shim an adopter would run, in miniature. The consumers share one copy of xpath (package.json
// `overrides`), so replacing that module's exports replaces it for all of them. Needs the fixtures:
// `npm run fixtures`.
//
//   node bench/e2e.ts                      table for all modes
//   node bench/e2e.ts --one <mode> [n]     one mode, JSON on stdout

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { call, candidateSpec, errorText, loadCandidateModule } from '../test/harness.ts';
import { readFixtures } from './saml-fixtures.ts';

const require = createRequire(import.meta.url);
const MODES = ['upstream', 'candidate', 'shadow'] as const;
type Mode = (typeof MODES)[number];

function isMode(value: string): value is Mode {
    return MODES.some((mode) => mode === value);
}

interface ShadowStats {
    calls: number;
    mismatches: number;
    readonly expressions: Set<string>;
    readonly examples: string[];
}

function sameResult(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => item === b[i]);
    return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

/** An `xpath` module object whose select family runs both engines and compares. */
function shadowModule(upstream: unknown, candidate: unknown, stats: ShadowStats): Record<string, unknown> {
    const both = (name: string, args: readonly unknown[]): unknown => {
        const [expression] = args;
        stats.calls++;
        if (typeof expression === 'string') stats.expressions.add(expression);
        let expected: unknown;
        let expectedError: unknown;
        try {
            expected = call(upstream, name, ...args);
        } catch (error) {
            expectedError = error;
        }
        let actual: unknown;
        let actualError: unknown;
        try {
            actual = call(candidate, name, ...args);
        } catch (error) {
            actualError = error;
        }
        const agree =
            expectedError === undefined
                ? actualError === undefined && sameResult(expected, actual)
                : actualError !== undefined;
        if (!agree) {
            stats.mismatches++;
            if (stats.examples.length < 5) stats.examples.push(`${name} ${String(expression)}`);
        }
        if (expectedError !== undefined) throw expectedError;
        return expected;
    };
    return {
        select: (...args: unknown[]) => both('select', args),
        select1: (...args: unknown[]) => both('select1', args),
        selectWithResolver: (...args: unknown[]) => both('selectWithResolver', args)
    };
}

interface Outcome {
    readonly mode: Mode;
    readonly rows: readonly {
        readonly doc: string;
        readonly ms: number;
        readonly outcome: string;
        readonly digest: string;
    }[];
    readonly shadow: {
        readonly calls: number;
        readonly mismatches: number;
        readonly distinct: number;
        readonly examples: readonly string[];
    } | null;
}

async function runOne(mode: Mode, iterations: number): Promise<Outcome> {
    const stats: ShadowStats = { calls: 0, mismatches: 0, expressions: new Set<string>(), examples: [] };
    if (mode !== 'upstream') {
        // Load the oracle module, then swap what it exports before any consumer is loaded.
        const file = require.resolve('xpath');
        const upstream: unknown = require(file);
        const entry = require.cache[file];
        if (entry === undefined) throw new Error('the xpath module is not in the require cache');
        const candidate = loadCandidateModule();
        entry.exports = mode === 'candidate' ? candidate : shadowModule(upstream, candidate, stats);
    }
    const saml: unknown = require('samlify');
    call(saml, 'setSchemaValidator', { validate: (): Promise<string> => Promise.resolve('ok') });
    const fixtures = readFixtures();
    const idp = call(saml, 'IdentityProvider', { metadata: fixtures.idpMetadata });
    const sp = call(saml, 'ServiceProvider', { metadata: fixtures.spMetadata });
    const rows: { doc: string; ms: number; outcome: string; digest: string }[] = [];
    for (const [doc, body] of [
        ['signed response, 4 KiB', fixtures.small],
        ['signed response, 1,000 groups, 82 KiB', fixtures.large],
        ['signed response, 2,000 groups, 164 KiB', fixtures.groups2000]
    ] as const) {
        const parseOnce = async (): Promise<string> => {
            try {
                const parsed: unknown = await call(sp, 'parseLoginResponse', idp, 'post', {
                    body: { SAMLResponse: body }
                });
                return `ACCEPTED ${JSON.stringify(typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'extract') : null)}`;
            } catch (error) {
                return `REJECTED ${errorText(error)}`;
            }
        };
        const first = await parseOnce();
        for (let i = 0; i < Math.min(5, iterations); i++) await parseOnce();
        const start = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) await parseOnce();
        const ms = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
        rows.push({
            doc,
            ms,
            outcome: first.slice(0, 8),
            digest: createHash('sha256').update(first).digest('hex').slice(0, 12)
        });
    }
    return {
        mode,
        rows,
        shadow:
            mode === 'shadow'
                ? {
                      calls: stats.calls,
                      mismatches: stats.mismatches,
                      distinct: stats.expressions.size,
                      examples: stats.examples
                  }
                : null
    };
}

function isOutcome(value: unknown): value is Outcome {
    return (
        typeof value === 'object' && value !== null && 'mode' in value && 'rows' in value && Array.isArray(value.rows)
    );
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
    const mode = args[1] ?? '';
    if (!isMode(mode)) throw new Error(`unknown mode ${mode}`);
    console.log(JSON.stringify(await runOne(mode, Number(args[2] ?? 30))));
} else {
    const outcomes: Outcome[] = [];
    for (const mode of MODES) {
        const child = spawnSync(process.execPath, [process.argv[1] ?? '', '--one', mode, args[0] ?? '30'], {
            encoding: 'utf8',
            timeout: 600_000
        });
        const line = child.stdout.trim().split('\n').at(-1) ?? '';
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(line);
        } catch {
            parsed = null;
        }
        if (isOutcome(parsed)) outcomes.push(parsed);
        else console.log(`${mode}: failed\n${child.stderr.slice(0, 600)}`);
    }
    const docs = outcomes[0]?.rows.map((row) => row.doc) ?? [];
    console.log(`candidate: ${candidateSpec()}`);
    console.log(
        `| samlify parseLoginResponse (whole ACS parse) | ${outcomes.map((o) => o.mode).join(' | ')} | same outcome and extract |`
    );
    console.log(`|---|${outcomes.map(() => '---:').join('|')}|---|`);
    docs.forEach((doc, i) => {
        const cells = outcomes.map(
            (o) => `${(o.rows[i]?.ms ?? Number.NaN).toFixed(2)} ms (${o.rows[i]?.outcome ?? '?'})`
        );
        const digests = new Set(outcomes.map((o) => o.rows[i]?.digest));
        console.log(`| ${doc} | ${cells.join(' | ')} | ${digests.size === 1 ? 'yes' : 'NO'} |`);
    });
    for (const outcome of outcomes) {
        if (outcome.shadow === null) continue;
        const { calls, mismatches, distinct, examples } = outcome.shadow;
        console.log(
            `\nshadow mode: ${calls} xpath calls (${distinct} distinct expressions) made by samlify and xml-crypto, ${mismatches} results differ between upstream and the candidate${examples.length > 0 ? `: ${examples.join('; ')}` : ''}`
        );
    }
}
