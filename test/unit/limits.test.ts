// Unit tests of the engine's limits: the work budget, the wall-clock limit, linear string work, typed errors.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import {
    DEFAULT_BUDGET,
    DEFAULT_TIMEOUT_MS,
    XPathBudgetError,
    XPathError,
    XPathProgram,
    XPathSyntaxError,
    XPathTimeoutError,
    parse as parseCompat,
    select
} from '../../src/index.ts';

const parse = loadDom('xmldom08');

function flat(count: number): string {
    return `<r>${'<a>x</a>'.repeat(count)}</r>`;
}

function text(program: XPathProgram, xml: string, options: { budget?: number; timeoutMs?: number } = {}): string {
    const { value } = program.run({ node: parse(xml), ...options });
    if (typeof value === 'number') return String(value);
    assert.equal(typeof value, 'string');
    return typeof value === 'string' ? value : '';
}

void test('the defaults are finite', () => {
    assert.ok(Number.isFinite(DEFAULT_BUDGET) && DEFAULT_BUDGET > 0);
    assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0);
});

void test('a small budget stops a document walk with a typed error', () => {
    const program = new XPathProgram('count(//a)');
    assert.throws(
        () => program.run({ node: parse(flat(500)), budget: 100 }),
        (error: unknown) => error instanceof XPathBudgetError && error instanceof XPathError && error.code === 'BUDGET'
    );
    assert.equal(text(program, flat(500)), '500');
    assert.equal(text(program, flat(500), { budget: 0 }), '500');
});

void test('string work is charged: a string function over a big text stops on a small budget', () => {
    const xml = `<r>${'x'.repeat(200_000)}</r>`;
    for (const expression of [
        'contains(/r, "y")',
        'normalize-space(/r)',
        'translate(/r, "x", "y")',
        'string-length(/r)'
    ]) {
        const program = new XPathProgram(expression);
        assert.throws(() => program.run({ node: parse(xml), budget: 50 }), XPathBudgetError, expression);
    }
});

void test('the wall-clock limit stops evaluation with a typed error', () => {
    // string(/r) walks the whole document once per candidate: quadratic work the clock has to cut off.
    const program = new XPathProgram('count(//a[contains(string(/r), "y")])');
    const doc = parse(flat(20_000));
    const start = process.hrtime.bigint();
    assert.throws(
        () => program.run({ node: doc, budget: 0, timeoutMs: 20 }),
        (error: unknown) => error instanceof XPathTimeoutError && error.code === 'BUDGET'
    );
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 2000);
});

void test('the compat entry passes the limits on', () => {
    const doc = parse(flat(200));
    assert.throws(() => parseCompat('//a').select({ node: doc, budget: 50 }), XPathBudgetError);
    assert.equal(parseCompat('//a').select({ node: doc }).length, 200);
    assert.equal(select('//a', doc)?.constructor, Array);
});

void test('a syntax error is typed', () => {
    assert.throws(() => new XPathProgram('//['), XPathSyntaxError);
});

void test('normalize-space is linear on a long string with inner runs of spaces', () => {
    const xml = `<r>a${' '.repeat(100_000)}b${' '.repeat(100_000)}c </r>`;
    const start = process.hrtime.bigint();
    const result = text(new XPathProgram('normalize-space(/r)'), xml);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result, 'a b c');
    assert.ok(ms < 1000, `took ${ms} ms`);
});

void test('normalize-space matches the specification on edge cases', () => {
    const cases: readonly (readonly [string, string])[] = [
        ['', ''],
        ['   ', ''],
        [' a ', 'a'],
        ['a  b\t\tc\n\nd', 'a b c d'],
        [' a ', ' a '],
        ['a \r\n b', 'a b']
    ];
    for (const [input, expected] of cases) {
        const escaped = input.replaceAll('\r', '&#13;');
        assert.equal(
            text(new XPathProgram('normalize-space(/r)'), `<r>${escaped}</r>`),
            expected,
            JSON.stringify(input)
        );
    }
});
