// A deliberately slow candidate, for the harness self-test (test/harness-selftest.ts): upstream xpath that takes longer
// than the expression fuzzer's time limit on an expression with the following axis. The fuzzer must fail the run for it:
// a candidate that does not come back is a defect, not something to count and tolerate (upstream's own timeouts are).

import { call, loadOracleModule, member } from '../harness.ts';

const oracle = loadOracleModule();

function stall(expression: string): void {
    if (!expression.includes('following::')) return;
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
        // busy: the worker is stopped from outside
    }
}

export const select: (expression: string, node: unknown, single?: boolean) => unknown = (expression, node, single) => {
    stall(expression);
    return call(oracle, 'select', expression, node, single);
};
export const select1: (expression: string, node: unknown) => unknown = (expression, node) =>
    call(oracle, 'select1', expression, node);
export const parse: (expression: string) => unknown = (expression) => call(oracle, 'parse', expression);
export const evaluate: (...args: unknown[]) => unknown = (...args) => call(oracle, 'evaluate', ...args);
export const XNodeSet: unknown = member(oracle, 'XNodeSet');
