// Records what the oracle (upstream xpath) answers on each hostile case, as a short digest, in
// baselines/oracle-digests.json. The gate (test/hostile.ts) compares a candidate's answer with it, so a candidate
// that is fast because it is wrong fails. Upstream is quadratic or worse on some cases: one that does not finish
// within the limit is recorded as null (unknown), and the gate then checks only the time for it.
//
//   node test/hostile-digests.ts            all cases, 6 at a time
//   HOSTILE_DIGEST_LIMIT_MS=600000 node test/hostile-digests.ts

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CASES } from '../bench/hostile-cases.ts';
import { isMeasurement } from '../bench/hostile-run.ts';

const limitMs = Number(process.env['HOSTILE_DIGEST_LIMIT_MS'] ?? 300_000);
const runner = new URL('../bench/hostile-run.ts', import.meta.url).pathname;
const output = new URL('../baselines/oracle-digests.json', import.meta.url).pathname;

interface Entry {
    readonly digest: string | null;
    readonly size: number | null;
    readonly oracleMs: number | null;
}

function measureOracle(at: number): Promise<Entry> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [runner, 'upstream', String(at)],
            { timeout: limitMs, killSignal: 'SIGKILL', encoding: 'utf8' },
            (_error, stdout) => {
                let parsed: unknown = null;
                try {
                    parsed = JSON.parse(stdout);
                } catch {
                    parsed = null;
                }
                resolve(
                    isMeasurement(parsed) && parsed.error === null
                        ? { digest: parsed.digest, size: parsed.size, oracleMs: Math.round(parsed.ms) }
                        : { digest: null, size: null, oracleMs: null }
                );
            }
        );
    });
}

const entries: Record<string, Entry> = {};
const queue = CASES.map((item, at) => ({ item, at }));
async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const entry = await measureOracle(next.at);
        entries[next.item.name] = entry;
        console.log(`${next.at} ${next.item.name}: ${entry.digest ?? `not finished in ${limitMs / 1000} s`}`);
    }
}
await Promise.all(Array.from({ length: 6 }, () => worker()));
const ordered: Record<string, Entry> = {};
for (const item of CASES) ordered[item.name] = entries[item.name] ?? { digest: null, size: null, oracleMs: null };
writeFileSync(output, `${JSON.stringify({ oracle: 'xpath@0.0.36', limitMs, cases: ordered }, null, 4)}\n`);
console.log(`written ${output}`);
