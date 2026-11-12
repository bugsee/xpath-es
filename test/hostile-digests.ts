// Records what the oracle (upstream xpath) answers on each hostile case, as a short digest, in
// baselines/oracle-digests.json. The gate (test/hostile.ts) compares a candidate's answer with it, so a candidate
// that is fast because it is wrong fails.
//
// Every case ends with a digest. Upstream is quadratic or worse on some cases: one that does not finish within the limit
// falls back to the case's `reference` answer (bench/hostile-cases.ts: derived from the document by plain DOM code, never by
// an XPath engine). The reference is checked against the oracle wherever the oracle does finish, and the script fails when
// they differ (a reference that is wrong would bless a wrong engine) or when a case has neither.
//
//   node test/hostile-digests.ts                         all cases, 6 at a time
//   HOSTILE_DIGEST_ONLY='id\(|resolver' node test/hostile-digests.ts   only these (the others keep their entries)
//   HOSTILE_DIGEST_LIMIT_MS=600000 node test/hostile-digests.ts

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CASES } from '../bench/hostile-cases.ts';
import { isMeasurement } from '../bench/hostile-run.ts';

const limitMs = Number(process.env['HOSTILE_DIGEST_LIMIT_MS'] ?? 300_000);
const only = process.env['HOSTILE_DIGEST_ONLY'] === undefined ? null : new RegExp(process.env['HOSTILE_DIGEST_ONLY']);
const runner = new URL('../bench/hostile-run.ts', import.meta.url).pathname;
const output = new URL('../baselines/oracle-digests.json', import.meta.url).pathname;

interface Entry {
    readonly digest: string;
    readonly size: number;
    /** Where the digest comes from: the oracle's answer, or the case's reference answer when the oracle cannot finish. */
    readonly source: 'oracle' | 'reference';
    readonly oracleMs: number | null;
}

interface Measured {
    readonly digest: string;
    readonly size: number;
    readonly ms: number;
}

function measure(engine: 'upstream' | 'reference', at: number, timeout: number): Promise<Measured | null> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [runner, engine, String(at)],
            { timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1 << 24 },
            (_error, stdout) => {
                let parsed: unknown = null;
                try {
                    parsed = JSON.parse(stdout);
                } catch {
                    parsed = null;
                }
                resolve(
                    isMeasurement(parsed) && parsed.error === null
                        ? { digest: parsed.digest, size: parsed.size, ms: Math.round(parsed.ms) }
                        : null
                );
            }
        );
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

const previous: Record<string, Entry> = {};
if (existsSync(output)) {
    const content: unknown = JSON.parse(readFileSync(output, 'utf8'));
    const cases = isRecord(content) ? content['cases'] : null;
    if (isRecord(cases))
        for (const [name, entry] of Object.entries(cases)) {
            if (!isRecord(entry)) continue;
            const { digest, size, oracleMs, source } = entry;
            if (typeof digest === 'string' && typeof size === 'number')
                previous[name] = {
                    digest,
                    size,
                    source: source === 'reference' ? 'reference' : 'oracle',
                    oracleMs: typeof oracleMs === 'number' ? oracleMs : null
                };
        }
}

const entries: Record<string, Entry> = {};
const problems: string[] = [];
const queue = CASES.map((item, at) => ({ item, at }));
async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const { item, at } = next;
        if (only !== null && !only.test(item.name)) {
            const kept = previous[item.name];
            if (kept !== undefined) entries[item.name] = kept;
            else problems.push(`${item.name}: not selected and not recorded before`);
            continue;
        }
        const oracle = await measure('upstream', at, limitMs);
        const reference = item.reference === undefined ? null : await measure('reference', at, 120_000);
        if (oracle !== null && reference !== null && oracle.digest !== reference.digest) {
            problems.push(
                `${item.name}: the reference answer (${reference.digest}) differs from the oracle's (${oracle.digest})`
            );
            console.log(`${at} ${item.name}: REFERENCE DISAGREES WITH THE ORACLE`);
            continue;
        }
        const chosen = oracle ?? reference;
        if (chosen === null) {
            problems.push(
                `${item.name}: the oracle did not finish in ${limitMs / 1000} s and the case has no reference answer`
            );
            console.log(`${at} ${item.name}: no digest`);
            continue;
        }
        entries[item.name] = {
            digest: chosen.digest,
            size: chosen.size,
            source: oracle !== null ? 'oracle' : 'reference',
            oracleMs: oracle?.ms ?? null
        };
        console.log(
            `${at} ${item.name}: ${chosen.digest} (${oracle !== null ? `oracle${reference !== null ? ', reference agrees' : ''}` : 'reference'})`
        );
    }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
const ordered: Record<string, Entry> = {};
for (const item of CASES) {
    const entry = entries[item.name];
    if (entry !== undefined) ordered[item.name] = entry;
}
writeFileSync(output, `${JSON.stringify({ oracle: 'xpath@0.0.36', limitMs, cases: ordered }, null, 4)}\n`);
console.log(`written ${output}`);
for (const problem of problems) console.log(`PROBLEM ${problem}`);
process.exitCode = problems.length === 0 ? 0 : 1;
