// Micro-benchmarks for the evaluation clock: the cost of one reading, and of a charge-heavy evaluation with the time
// limit on (default) and off (timeoutMs 0).
//
//   node bench/clock.ts

import { now } from '../src/clock.ts';
import { loadDom } from '../test/harness.ts';
import { XPathProgram } from '../src/index.ts';

const milliseconds = (run: () => void): number => {
    const start = process.hrtime.bigint();
    run();
    return Number(process.hrtime.bigint() - start) / 1e6;
};
const best = (runs: number, run: () => void): number => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) fastest = Math.min(fastest, milliseconds(run));
    return fastest;
};

const READINGS = 20_000_000;
let sink = 0;
const reading = best(5, () => {
    for (let i = 0; i < READINGS; i++) sink += now();
});
console.log(`clock reading: ${((reading * 1e6) / READINGS).toFixed(1)} ns per call (best of 5, ${READINGS} calls)`);

const parse = loadDom('xmldom08');
const doc = parse(`<r>${'<a><b/><b/></a>'.repeat(100_000)}</r>`);
const program = new XPathProgram('count(//b/ancestor::*) + count(//a/following::b) + count(//b/preceding-sibling::*)');
for (const [label, options] of [
    ['time limit on (default)', {}],
    ['time limit off (timeoutMs 0)', { timeoutMs: 0 }]
] as const) {
    const ms = best(7, () => {
        program.run({ node: doc, ...options });
    });
    console.log(`charge-heavy evaluation, ${label}: ${ms.toFixed(1)} ms (best of 7)`);
}
if (sink === 42) console.log('');
