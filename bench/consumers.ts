// The expressions XML-signature and SAML libraries evaluate (test/corpus.ts, CONSUMER_EXPRESSIONS) on legitimate
// signed SAML responses: every expression from the document node, from the first Signature element and from the
// Assertion element. One process per engine; time for one pass over all of them; a digest of all results to prove
// the engines give the same answers. Needs the fixtures: `npm run fixtures`.
//
//   node bench/consumers.ts            table (ENGINES=upstream,candidate by default)
//   node bench/consumers.ts <engine>   JSON for one engine

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DomNode } from '../test/support/dom.ts';
import { CONSUMER_EXPRESSIONS } from '../test/corpus.ts';
import { allNodes, describe, errorText, loadDom, milliseconds } from '../test/harness.ts';
import { chosenEngines, isEngineName, loadEngine } from './engines.ts';
import type { EngineName } from './engines.ts';
import { readFixtures } from './saml-fixtures.ts';

interface Row {
    readonly doc: string;
    readonly evaluations: number;
    readonly ms: number;
    readonly digest: string;
}

function measure(engine: EngineName): Row[] {
    const select = loadEngine(engine);
    const fixtures = readFixtures();
    const parse = loadDom('xmldom08');
    const rows: Row[] = [];
    for (const [doc, b64] of [
        ['signed response, 4 KiB', fixtures.small],
        ['signed response, 1,000 groups, 82 KiB', fixtures.large]
    ] as const) {
        const document = parse(Buffer.from(b64, 'base64').toString());
        const nodes = allNodes(document);
        const index = new Map<unknown, number>(nodes.map((node, i) => [node, i]));
        const named = (name: string): DomNode | undefined =>
            nodes.find((node) => node.nodeType === 1 && node.localName === name);
        const contexts = [document, named('Signature'), named('Assertion')].filter((node) => node !== undefined);
        const pass = (collect: string[] | null): void => {
            for (const expression of CONSUMER_EXPRESSIONS) {
                for (const context of contexts) {
                    let result: unknown;
                    try {
                        result = select(expression, context);
                    } catch (error) {
                        result = `ERR ${errorText(error)}`;
                    }
                    collect?.push(describe(result, index));
                }
            }
        };
        const texts: string[] = [];
        pass(texts);
        for (let i = 0; i < 20; i++) pass(null);
        const times: number[] = [];
        for (let i = 0; i < 101; i++) times.push(milliseconds(() => pass(null)));
        times.sort((a, b) => a - b);
        rows.push({
            doc,
            evaluations: CONSUMER_EXPRESSIONS.length * contexts.length,
            ms: times[50] ?? 0,
            digest: createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 12)
        });
    }
    return rows;
}

function isRows(value: unknown): value is Row[] {
    return (
        Array.isArray(value) &&
        value.every(
            (row: unknown) => typeof row === 'object' && row !== null && 'ms' in row && 'digest' in row && 'doc' in row
        )
    );
}

const wanted = process.argv[2];
if (wanted !== undefined) {
    if (!isEngineName(wanted)) throw new Error(`unknown engine ${wanted}`);
    console.log(JSON.stringify(measure(wanted)));
} else {
    const all = new Map<EngineName, Row[]>();
    const engines = chosenEngines();
    for (const engine of engines) {
        const child = spawnSync(process.execPath, [process.argv[1] ?? '', engine], { encoding: 'utf8' });
        const parsed: unknown = JSON.parse(child.stdout);
        if (isRows(parsed)) all.set(engine, parsed);
    }
    const first = all.get(engines[0] ?? 'upstream') ?? [];
    console.log(
        `| all ${CONSUMER_EXPRESSIONS.length} consumer expressions, 3 context nodes, one pass | evaluations | ${engines.join(' | ')} | same results |`
    );
    console.log(`|---|---:|${engines.map(() => '---:').join('|')}|---|`);
    first.forEach((row, i) => {
        const cells = engines.map((engine) => `${(all.get(engine)?.[i]?.ms ?? Number.NaN).toFixed(2)} ms`);
        const digests = new Set(engines.map((engine) => all.get(engine)?.[i]?.digest));
        console.log(
            `| ${row.doc} | ${row.evaluations} | ${cells.join(' | ')} | ${digests.size === 1 ? 'yes' : 'NO'} |`
        );
    });
}
