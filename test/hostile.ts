// The hostile-document gate: pass/fail. Every case of bench/hostile-cases.ts runs on the candidate (CANDIDATE, default
// this engine) in its own process, killed when it takes too long, and must
//   - finish within the bound, and
//   - give the same result as the oracle (upstream xpath), where baselines/oracle-digests.json knows it.
//
// Time bound: HOSTILE_BOUND_MS, default 2 000 ms per case for the engine (twice its default time limit of 1 000 ms, so a
// loop the limits do not see fails the gate unless the case is marked `expect: 'refuse'`) and 10 000 ms for a candidate
// without limits. It is loose on purpose: the cases that matter take 10-100 ms on a good engine and minutes on a quadratic
// one, so the gate separates the two on any CI machine.
//
// Baselines: a candidate with known-slow shapes lists them by case name in baselines/<candidate>.json (or the file
// BASELINE names). Such a case that is too slow does not fail the run, it is listed; one that is within the bound is
// reported, so the baseline can shrink when that is stable. A wrong result or an error is never baselined. Without a baseline file, or
// with HOSTILE_STRICT=1, a candidate is judged strictly.
//
// Cases marked `engineOnly` (the engine's limits, its resolver and id() paths) run only with HOSTILE_ENGINE_CASES=1: a
// candidate without those limits (upstream xpath, CANDIDATE=xpath) is judged on the original cases. A case marked `expect: 'refuse'`
// passes when the candidate stops with a typed limit, budget or timeout error within the bound (the oracle's answer is
// recorded, but nobody should be made to build it). Every case that runs must have an oracle digest: one without is a
// failure of the gate, not a pass on time alone.
//
//   node test/hostile.ts
//   HOSTILE_ENGINE_CASES=1 CANDIDATE=./src/index.ts node test/hostile.ts
//   HOSTILE_ONLY='deep|siblings' node test/hostile.ts      only the cases whose name or number matches
//   CANDIDATE=./my-engine.js BASELINE=./my-baseline.json node test/hostile.ts

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CASES } from '../bench/hostile-cases.ts';
import { isMeasurement } from '../bench/hostile-run.ts';
import { candidateMode, candidateSpec } from './harness.ts';

const engineCases = process.env['HOSTILE_ENGINE_CASES'] === '1';
// The engine stops an evaluation at 1,000 ms (its default time limit), so a case that takes more than twice that is a loop
// the limits do not see; a candidate without limits (upstream xpath) is judged on the loose bound.
const boundMs = Number(process.env['HOSTILE_BOUND_MS'] ?? (engineCases ? 2_000 : 10_000));
const killAfterMs = boundMs + 5_000;
const only = process.env['HOSTILE_ONLY'] === undefined ? null : new RegExp(process.env['HOSTILE_ONLY']);
const strict = process.env['HOSTILE_STRICT'] === '1';
// The scripts also run compiled to plain JavaScript (npm run build:tests, into dist-tests/): the runner is then the
// compiled sibling, and the baselines, which are not compiled, are looked up in the working directory (the repository).
const here = path.resolve(import.meta.dirname, '..');
const root = existsSync(path.join(here, 'baselines')) ? here : process.cwd();
const runner = path.join(here, `bench/hostile-run${path.extname(import.meta.filename)}`);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

function readJson(file: string): unknown {
    return JSON.parse(readFileSync(file, 'utf8'));
}

/** The digest per case name in a file of baselines/; a missing file or a null entry means "unknown". */
function loadOracleDigests(name = 'oracle-digests.json'): ReadonlyMap<string, string> {
    const file = path.join(root, 'baselines', name);
    const digests = new Map<string, string>();
    if (!existsSync(file)) return digests;
    const content = readJson(file);
    const cases = isRecord(content) ? content['cases'] : null;
    if (!isRecord(cases)) return digests;
    for (const [name, entry] of Object.entries(cases)) {
        const digest = isRecord(entry) ? entry['digest'] : null;
        if (typeof digest === 'string') digests.set(name, digest);
    }
    return digests;
}

/** The known-slow case names for this candidate, with the reason recorded for each. */
function loadBaseline(): { readonly file: string | null; readonly knownSlow: ReadonlyMap<string, string> } {
    const spec = candidateSpec();
    const named = process.env['BASELINE'];
    const isPath = spec.startsWith('.') || path.isAbsolute(spec);
    const file = strict
        ? null
        : named !== undefined
          ? path.resolve(named)
          : isPath
            ? null
            : path.join(root, 'baselines', `${spec}.json`);
    const knownSlow = new Map<string, string>();
    if (file === null || !existsSync(file)) return { file: null, knownSlow };
    const content = readJson(file);
    const listed = isRecord(content) ? content['knownSlow'] : null;
    if (isRecord(listed))
        for (const [name, reason] of Object.entries(listed))
            knownSlow.set(name, typeof reason === 'string' ? reason : '');
    return { file, knownSlow };
}

type Verdict = 'ok' | 'slow' | 'timeout' | 'wrong' | 'error';
interface Row {
    readonly at: number;
    readonly name: string;
    readonly verdict: Verdict;
    readonly ms: number | null;
    readonly note: string;
}

const oracle = loadOracleDigests();
// A candidate run in strict mode (CANDIDATE_MODE=strict) is judged against the Recommendation, not against upstream, on the
// cases where the two differ by design (baselines/strict-digests.json: plain-DOM answers, bench/hostile-cases.ts).
const strictDigests =
    candidateMode() === 'strict' ? loadOracleDigests('strict-digests.json') : new Map<string, string>();
const baseline = loadBaseline();
const rows: Row[] = [];

const REFUSALS = new Set(['LIMIT', 'BUDGET', 'TIMEOUT']);

CASES.forEach((item, at) => {
    if (only !== null && !only.test(item.name) && !only.test(String(at))) return;
    if (item.engineOnly === true && !engineCases) return;
    const child = spawnSync(process.execPath, [runner, 'candidate', String(at)], {
        timeout: killAfterMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        env: process.env
    });
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(child.stdout);
    } catch {
        parsed = null;
    }
    if (!isMeasurement(parsed)) {
        const killed = child.error !== undefined || child.signal === 'SIGKILL';
        rows.push({
            at,
            name: item.name,
            verdict: killed ? 'timeout' : 'error',
            ms: null,
            note: killed ? `killed after ${killAfterMs} ms` : (child.stderr.trim().split('\n').at(-1) ?? 'no output')
        });
        return;
    }
    const expected = strictDigests.get(item.name) ?? oracle.get(item.name);
    if (expected === undefined)
        rows.push({
            at,
            name: item.name,
            verdict: 'error',
            ms: parsed.ms,
            note: 'no oracle digest for this case (node test/hostile-digests.ts)'
        });
    else if (item.expect === 'refuse') {
        // The candidate must refuse, with a typed error, and quickly: an answer would have been the oracle's.
        if (parsed.errorCode !== null && REFUSALS.has(parsed.errorCode))
            rows.push({
                at,
                name: item.name,
                verdict: parsed.ms > boundMs ? 'slow' : 'ok',
                ms: parsed.ms,
                note: `refused: ${parsed.errorCode}`
            });
        else
            rows.push({
                at,
                name: item.name,
                verdict: 'wrong',
                ms: parsed.ms,
                note:
                    parsed.error === null
                        ? 'answered a case it must refuse'
                        : `failed with ${parsed.error.slice(0, 80)}, not a typed limit`
            });
    } else if (parsed.error !== null)
        rows.push({ at, name: item.name, verdict: 'error', ms: parsed.ms, note: parsed.error.slice(0, 100) });
    else if (expected !== parsed.digest)
        rows.push({
            at,
            name: item.name,
            verdict: 'wrong',
            ms: parsed.ms,
            note: `result ${parsed.digest}, ${strictDigests.has(item.name) ? 'strict reference' : 'oracle'} ${expected}`
        });
    else
        rows.push({
            at,
            name: item.name,
            verdict: parsed.ms > boundMs ? 'slow' : 'ok',
            ms: parsed.ms,
            note: ''
        });
});

const failures: Row[] = [];
const known: Row[] = [];
const nowFast: Row[] = [];
console.log(
    `candidate ${candidateSpec()}; bound ${boundMs} ms per case; baseline ${baseline.file === null ? 'none (strict)' : path.relative(root, baseline.file)}; oracle digests for ${oracle.size} of ${CASES.length} cases${engineCases ? '' : ' (engine-only cases not run)'}`
);
console.log('| # | case | time | result |');
console.log('|---|---|---:|---|');
for (const row of rows) {
    const isKnown = baseline.knownSlow.has(row.name);
    let label: string;
    if (row.verdict === 'ok') {
        label = isKnown ? 'ok (baselined, within the bound this time)' : 'ok';
        if (isKnown) nowFast.push(row);
    } else if ((row.verdict === 'slow' || row.verdict === 'timeout') && isKnown) {
        label = `known slow (baseline)`;
        known.push(row);
    } else {
        label = `FAIL ${row.verdict}${row.note === '' ? '' : `: ${row.note}`}`;
        failures.push(row);
    }
    const time = row.ms === null ? `> ${boundMs} ms` : `${row.ms < 10 ? row.ms.toFixed(1) : row.ms.toFixed(0)} ms`;
    console.log(`| ${row.at} | ${row.name} | ${time} | ${label} |`);
}
console.log(
    `\n${rows.length} cases: ${rows.length - failures.length - known.length} ok, ${known.length} known slow, ${failures.length} failed`
);
for (const row of known) console.log(`  known slow: ${row.name}: ${baseline.knownSlow.get(row.name) ?? ''}`);
for (const row of nowFast)
    console.log(
        `  baselined but within the bound (${Math.round(row.ms ?? 0)} ms): ${row.name}; if that is stable, shrink the baseline`
    );
process.exitCode = failures.length === 0 ? 0 : 1;
