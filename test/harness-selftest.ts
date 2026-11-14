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
const ENGINE = './src/index.ts';
// The first three hostile cases: fast on the engine, so any slowness in the quadratic candidate is its own.
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
    // The split gate (CLASSIFY=all, xmldom 0.9): the oracle against itself has nothing to classify, and a candidate that
    // reverses node-sets, where both engines answer, is not in any documented class.
    const classifiedSame = run(
        'fuzz.ts',
        ['xmldom09', '8', '3', 'all'],
        { CANDIDATE: 'xpath', CLASSIFY: 'all' },
        120_000
    );
    check(
        'split gate: the oracle against itself passes',
        classifiedSame.status === 0 && /UNCLASSIFIED\s+0/.test(classifiedSame.output),
        classifiedSame.output
    );
    const classifiedReordering = run(
        'fuzz.ts',
        ['xmldom09', '8', '3', 'all'],
        { CANDIDATE: REORDERING, CLASSIFY: 'all' },
        120_000
    );
    check(
        'split gate: a candidate that reverses node-sets is caught',
        classifiedReordering.status === 1 && /UNCLASSIFIED\s+[1-9]/.test(classifiedReordering.output),
        classifiedReordering.output
    );
    // Class 5 only (xmldom 0.8 and the expression fuzzer): unrelated differences still fail.
    const nsOnly = run(
        'fuzz.ts',
        ['xmldom08', '8', '3', 'all'],
        { CANDIDATE: REORDERING, CLASSIFY: 'ns-duplicate' },
        120_000
    );
    check(
        'class 5 only: a candidate that reverses node-sets still fails the document fuzzer',
        nsOnly.status === 1 && /UNCLASSIFIED\s+[1-9]/.test(nsOnly.output),
        nsOnly.output
    );
    const exprReordering = run(
        'fuzz-expr.ts',
        ['xmldom08', '6', '40', '3', 'ns', '3000'],
        { CANDIDATE: REORDERING, CLASSIFY: 'ns-duplicate' },
        180_000
    );
    check(
        'class 5 only: a candidate that reverses node-sets still fails the expression fuzzer',
        exprReordering.status === 1,
        exprReordering.output
    );
    const exprSame = run(
        'fuzz-expr.ts',
        ['xmldom08', '6', '40', '3', 'ns', '3000'],
        { CANDIDATE: 'xpath', CLASSIFY: 'ns-duplicate' },
        180_000
    );
    check(
        'class 5 only: the oracle against itself passes the expression fuzzer',
        exprSame.status === 0,
        exprSame.output
    );
    // A worker that cannot load its candidate must fail the run, not report success after comparing nothing.
    const brokenWorker = run(
        'fuzz-expr.ts',
        ['xmldom08', '3', '5', '1', 'ns', '2000'],
        { CANDIDATE: './test/fixtures/does-not-exist.ts' },
        120_000
    );
    check(
        'expression fuzzer: a candidate that cannot be loaded fails the run',
        brokenWorker.status !== 0,
        brokenWorker.output
    );
    // A candidate that does not come back within the time limit fails the expression fuzzer.
    const hanging = run(
        'fuzz-expr.ts',
        ['xmldom08', '6', '60', '3', 'ns', '800'],
        { CANDIDATE: './test/fixtures/hanging-candidate.ts' },
        300_000
    );
    check(
        'expression fuzzer: a candidate that times out fails the run',
        hanging.status === 1 && /candidate did not come back/.test(hanging.output),
        hanging.output
    );
    // Strict mode must not regress: with the deviating expressions let in, the agreement check must find differences.
    const modesAll = run('mode-agreement.ts', ['12', '60', '5'], { MODE_AGREEMENT_ALL: '1' }, 120_000);
    check(
        'mode agreement: with the deviating expressions included it finds differences',
        modesAll.status === 1 && /[1-9]\d* differences/.test(modesAll.output),
        modesAll.output
    );
    // The independent strict reference must find the difference when the engine is asked for upstream mode.
    const oracleUpstream = run(
        'strict-oracle.ts',
        ['xmldom08', '10', '60', '1'],
        { STRICT_ORACLE_MODE: 'upstream' },
        120_000
    );
    check(
        'strict oracle: a candidate in upstream mode is found out',
        oracleUpstream.status === 1 && /[1-9]\d* differences/.test(oracleUpstream.output),
        oracleUpstream.output
    );
    // A case the candidate must refuse (the oracle's own answer is not a refusal) fails the hostile gate.
    const answeredARefusal = run(
        'hostile.ts',
        [],
        {
            CANDIDATE: 'xpath',
            HOSTILE_ENGINE_CASES: '1',
            HOSTILE_ONLY: 'a chain 5,000 deep \\(every',
            HOSTILE_STRICT: '1'
        },
        180_000
    );
    check(
        'hostile gate: a candidate that answers a case it must refuse fails',
        answeredARefusal.status === 1 && /answered a case it must refuse/.test(answeredARefusal.output),
        answeredARefusal.output
    );
    const reorderingMutations = run('mutation.ts', [], { CANDIDATE: REORDERING }, 60_000);
    check(
        'mutation scenarios: the reversing candidate is caught too',
        reorderingMutations.status === 1,
        reorderingMutations.output
    );

    const goodGate = run('hostile.ts', [], { ...FAST_CASES, CANDIDATE: ENGINE, HOSTILE_STRICT: '1' }, 120_000);
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
    const shrinkable = run('hostile.ts', [], { ...FAST_CASES, CANDIDATE: ENGINE, BASELINE: baselineFile }, 120_000);
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
