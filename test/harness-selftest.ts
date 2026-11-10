// The harness tests itself: a gate that never fails is worth nothing. Each check runs the real scripts in a child
// process against a candidate whose verdict is known.
//
//   node test/harness-selftest.ts

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const script = (name: string): string => path.join(root, 'test', name);

interface Outcome {
    readonly status: number | null;
    readonly output: string;
}

function run(file: string, args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number): Outcome {
    const child = spawnSync(process.execPath, [script(file), ...args], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL'
    });
    return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

const REORDERING = './test/fixtures/reordering-candidate.ts';
const QUADRATIC = './test/fixtures/quadratic-candidate.ts';
// The first three hostile cases: fast on the fork, so any slowness in the quadratic candidate is its own.
const FAST_CASES = { HOSTILE_ONLY: '^(0|1|2)$', HOSTILE_BOUND_MS: '1000' };

let failed = 0;
function check(name: string, condition: boolean, detail: string): void {
    console.log(`${condition ? 'pass' : 'FAIL'}  ${name}`);
    if (!condition) {
        failed++;
        console.log(
            detail
                .split('\n')
                .slice(-12)
                .map((line) => `      ${line}`)
                .join('\n')
        );
    }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'xpath-es-selftest-'));
try {
    const sameOracle = run('fuzz.ts', ['xmldom08', '8', '3', 'all'], { CANDIDATE: 'xpath' }, 120_000);
    check(
        'differential fuzzer: the oracle against itself has no differences',
        sameOracle.status === 0,
        sameOracle.output
    );
    const sameMutations = run('mutation.ts', [], { CANDIDATE: 'xpath' }, 60_000);
    check(
        'mutation scenarios: the oracle against itself has no differences',
        sameMutations.status === 0,
        sameMutations.output
    );

    const reordering = run('fuzz.ts', ['xmldom08', '8', '3', 'all'], { CANDIDATE: REORDERING }, 120_000);
    check(
        'differential fuzzer: a candidate that reverses node-sets is caught',
        reordering.status === 1 && /\| static \| \d+ \| \d+ \| \d+ \| [1-9]\d* \|/.test(reordering.output),
        reordering.output
    );
    const reorderingMutations = run('mutation.ts', [], { CANDIDATE: REORDERING }, 60_000);
    check(
        'mutation scenarios: the reversing candidate is caught too',
        reorderingMutations.status === 1,
        reorderingMutations.output
    );

    const goodGate = run('hostile.ts', [], { ...FAST_CASES, CANDIDATE: 'xpath-fork', HOSTILE_STRICT: '1' }, 120_000);
    check(
        'hostile gate: a fast, correct candidate passes (strict)',
        goodGate.status === 0 && /0 failed/.test(goodGate.output),
        goodGate.output
    );
    const slowGate = run('hostile.ts', [], { ...FAST_CASES, CANDIDATE: QUADRATIC }, 180_000);
    check(
        'hostile gate: a quadratic candidate fails, for being slow and not for being wrong',
        slowGate.status === 1 && /FAIL (slow|timeout)/.test(slowGate.output) && !/FAIL wrong/.test(slowGate.output),
        slowGate.output
    );

    const baselineFile = path.join(scratch, 'baseline.json');
    writeFileSync(
        baselineFile,
        JSON.stringify({
            knownSlow: {
                '65k <a/> siblings': 'test',
                'cousins: 23k <a><b/></a>': 'test',
                'one element, 30k attributes (xml-crypto ID lookup)': 'test'
            }
        })
    );
    const baselined = run('hostile.ts', [], { ...FAST_CASES, CANDIDATE: QUADRATIC, BASELINE: baselineFile }, 180_000);
    check(
        'hostile gate: known-slow cases listed in a baseline keep the run green and are listed',
        baselined.status === 0 && /known slow \(baseline\)/.test(baselined.output),
        baselined.output
    );
    const shrinkable = run(
        'hostile.ts',
        [],
        { ...FAST_CASES, CANDIDATE: 'xpath-fork', BASELINE: baselineFile },
        120_000
    );
    check(
        'hostile gate: a baselined case that is within the bound is reported',
        shrinkable.status === 0 && /baselined but within the bound/.test(shrinkable.output),
        shrinkable.output
    );
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log(failed === 0 ? '\nself-test passed' : `\nself-test: ${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
