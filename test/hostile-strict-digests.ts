// Records, in baselines/strict-digests.json, the answer of the XPath 1.0 Recommendation on the hostile cases where strict
// mode differs from upstream by design (a case with a `strictReference` in bench/hostile-cases.ts). The answer is derived
// from the document by plain DOM code, never by an XPath engine; the gate (test/hostile.ts) uses it, instead of the
// oracle's digest, for a candidate run in strict mode (CANDIDATE_MODE=strict). An entry that equals the oracle's digest is
// not needed and fails the script, so the file holds exactly the deviations.
//
//   node test/hostile-strict-digests.ts

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { CASES } from '../bench/hostile-cases.ts';
import { isMeasurement } from '../bench/hostile-run.ts';

const runner = new URL('../bench/hostile-run.ts', import.meta.url).pathname;
const oracleFile = new URL('../baselines/oracle-digests.json', import.meta.url).pathname;
const output = new URL('../baselines/strict-digests.json', import.meta.url).pathname;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

const oracle: unknown = JSON.parse(readFileSync(oracleFile, 'utf8'));
const oracleCases = isRecord(oracle) ? oracle['cases'] : null;
const entries: Record<string, { digest: string; size: number; source: 'reference' }> = {};
let problems = 0;
for (const [at, item] of CASES.entries()) {
    if (item.strictReference === undefined) continue;
    const parsed: unknown = JSON.parse(
        execFileSync(process.execPath, [runner, 'strict-reference', String(at)], {
            encoding: 'utf8',
            maxBuffer: 1 << 24
        })
    );
    if (!isMeasurement(parsed) || parsed.error !== null) {
        console.log(`PROBLEM ${item.name}: the strict reference answer could not be computed`);
        problems++;
        continue;
    }
    const upstream = isRecord(oracleCases) ? oracleCases[item.name] : null;
    if (isRecord(upstream) && upstream['digest'] === parsed.digest) {
        console.log(`PROBLEM ${item.name}: the strict answer equals upstream's; drop its strictReference`);
        problems++;
        continue;
    }
    entries[item.name] = { digest: parsed.digest, size: parsed.size, source: 'reference' };
    console.log(`${at} ${item.name}: ${parsed.digest} (${parsed.size} nodes; differs from upstream by design)`);
}
const note = 'plain-DOM answers under XPath 1.0 where strict mode differs from upstream by design';
// An incomplete set of entries would make the gate fall back to upstream's digest for a case that was left out, so the
// existing baseline is replaced only when every reference was computed.
if (problems === 0) {
    writeFileSync(output, `${JSON.stringify({ note, cases: entries }, null, 4)}\n`);
    console.log(`written ${output}`);
} else console.log(`not written: ${problems} problem(s); ${output} is unchanged`);
process.exitCode = problems === 0 ? 0 : 1;
