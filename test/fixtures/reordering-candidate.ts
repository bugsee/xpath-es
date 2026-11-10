// A deliberately wrong candidate, for the harness self-test (test/harness-selftest.ts): upstream xpath with every
// node-set of two or more nodes returned in reverse document order. The differential fuzzer must catch it.

import { call, loadOracleModule, member } from '../harness.ts';

const oracle = loadOracleModule();

function isList(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function reversed(value: unknown): unknown {
    return isList(value) && value.length > 1 ? [...value].reverse() : value;
}

export const select: (expression: string, node: unknown, single?: boolean) => unknown = (expression, node, single) =>
    reversed(call(oracle, 'select', expression, node, single));
export const select1: (expression: string, node: unknown) => unknown = (expression, node) =>
    reversed(call(oracle, 'select1', expression, node));
export const parse: (expression: string) => unknown = (expression) => call(oracle, 'parse', expression);
export const evaluate: (...args: unknown[]) => unknown = (...args) => call(oracle, 'evaluate', ...args);
export const XNodeSet: unknown = member(oracle, 'XNodeSet');
