// Comparisons (XPath 1.0 section 3.4) as upstream evaluates them, without its nested loop over two node-sets.
// Q-CMP-1: `boolean < node-set` compares the boolean, as a number, with each node's number; `node-set < boolean`
// converts the node-set to a boolean first (the Recommendation asks for the second form in both directions).

import type { BinaryOp } from './ast.ts';
import { NodeSet, stringToNumber, stringValueOf, toBooleanValue } from './runtime.ts';
import type { EvalState, XValue } from './runtime.ts';

type Relational = '<' | '<=' | '>' | '>=';

function relate(op: Relational, a: number, b: number): boolean {
    switch (op) {
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
    }
}

const FLIP: Readonly<Record<Relational, Relational>> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

function scalarToNumber(value: string | number | boolean): number {
    if (typeof value === 'number') return value;
    return typeof value === 'string' ? stringToNumber(value) : value ? 1 : 0;
}

function anyNodeNumber(set: NodeSet, op: Relational, other: number, state: EvalState): boolean {
    state.charge(set.size);
    for (const node of set.unordered) if (relate(op, stringToNumber(stringValueOf(node)), other)) return true;
    return false;
}

function equalScalars(left: string | number | boolean, right: string | number | boolean): boolean {
    if (typeof left === 'boolean' || typeof right === 'boolean') return toBooleanValue(left) === toBooleanValue(right);
    if (typeof left === 'number' || typeof right === 'number') return scalarToNumber(left) === scalarToNumber(right);
    return left === right;
}

function equalSetScalar(set: NodeSet, other: string | number | boolean, negate: boolean, state: EvalState): boolean {
    if (typeof other === 'boolean') return (set.size > 0 === other) !== negate;
    state.charge(set.size);
    for (const node of set.unordered) {
        const text = stringValueOf(node);
        const equal = typeof other === 'number' ? stringToNumber(text) === other : text === other;
        if (equal !== negate) return true;
    }
    return false;
}

function equalSets(left: NodeSet, right: NodeSet, negate: boolean, state: EvalState): boolean {
    // "Some pair of nodes has equal (unequal) string-values": a hash of one side, O(n + m).
    if (left.size === 0 || right.size === 0) return false;
    state.charge(left.size + right.size);
    const values = new Set<string>();
    for (const node of right.unordered) values.add(stringValueOf(node));
    if (negate && values.size > 1) return true;
    for (const node of left.unordered) if (values.has(stringValueOf(node)) !== negate) return true;
    return false;
}

function relateSets(left: NodeSet, right: NodeSet, op: Relational, state: EvalState): boolean {
    // "Some pair satisfies a < b" is "min(left) < max(right)"; NaN never satisfies anything.
    state.charge(left.size + right.size);
    const less = op === '<' || op === '<=';
    let a = less ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    let b = less ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    let seenA = false;
    let seenB = false;
    for (const node of left.unordered) {
        const value = stringToNumber(stringValueOf(node));
        if (Number.isNaN(value)) continue;
        seenA = true;
        a = less ? Math.min(a, value) : Math.max(a, value);
    }
    for (const node of right.unordered) {
        const value = stringToNumber(stringValueOf(node));
        if (Number.isNaN(value)) continue;
        seenB = true;
        b = less ? Math.max(b, value) : Math.min(b, value);
    }
    return seenA && seenB && relate(op, a, b);
}

export function compareValues(op: BinaryOp, left: XValue, right: XValue, state: EvalState): boolean {
    if (op === '=' || op === '!=') {
        const negate = op === '!=';
        if (left instanceof NodeSet) {
            return right instanceof NodeSet ? equalSets(left, right, negate, state) : equalSetScalar(left, right, negate, state);
        }
        if (right instanceof NodeSet) return equalSetScalar(right, left, negate, state);
        return equalScalars(left, right) !== negate;
    }
    if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=') return false;
    if (left instanceof NodeSet) {
        if (right instanceof NodeSet) return relateSets(left, right, op, state);
        if (typeof right === 'boolean') return relate(op, left.size > 0 ? 1 : 0, right ? 1 : 0);
        return anyNodeNumber(left, op, scalarToNumber(right), state);
    }
    const number = scalarToNumber(left);
    if (right instanceof NodeSet) return anyNodeNumber(right, FLIP[op], number, state);
    return relate(op, number, scalarToNumber(right));
}
