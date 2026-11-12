// Second adversarial review, group A (safety): cost that is in the expression and not in the document, the clock, the
// DOM's getElementById, the mode string, resolvers, the parse cache, static analysis, error messages, cyclic DOMs.
// Work is counted in the engine's own units, so none of these depends on the speed of the machine, except the one that
// is about the clock, which asks for a limit of tens of milliseconds and allows seconds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import {
    parse,
    parseCacheSize,
    select,
    select1,
    selectWithResolver,
    useNamespaces,
    XPathBudgetError,
    XPathContextError,
    XPathProgram,
    XPathSyntaxError,
    XPathTimeoutError
} from '../support/engine.ts';
import { compile } from '../../src/compile.ts';
import type { Expr } from '../../src/ast.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
const flat = (count: number): DomNode => parseXml(`<r>${'<a/>'.repeat(count)}</r>`);

void test('C-1: a predicate that reads nothing is charged once per evaluation (before: 20,000 of them on 100,000 nodes ran 25 s)', () => {
    const doc = flat(1000);
    const { work } = new XPathProgram(`//*${'[1=1]'.repeat(5)}`).run({ node: doc });
    // 1,001 elements, five predicate passes, one unit per evaluation and one for the comparison in each.
    assert.ok(work >= 5 * 1001, `work ${work}`);
    for (const expression of [
        `//*${'[1=1]'.repeat(20_000)}`,
        `//*[${Array.from({ length: 20_000 }, () => '0').join(' or ')}]`,
        `//*[${Array.from({ length: 20_000 }, () => '1').join('+')}=0]`,
        `//*[${Array.from({ length: 20_000 }, () => "contains('a','b')").join(' or ')}]`,
        `//*[${Array.from({ length: 20_000 }, () => '-1').join(' and ')}]`
    ])
        assert.throws(() => select(expression, doc), XPathBudgetError, expression.slice(0, 40));
});

void test('C-1: each operand, call and variable costs a unit, in every mode', () => {
    const doc = flat(10);
    for (const mode of ['strict', 'upstream'] as const) {
        const cost = (expression: string): number => new XPathProgram(expression, { mode }).run({ node: doc }).work;
        const base = cost('1');
        assert.ok(cost('0 or 0 or 0 or 0') - base >= 4, `or: ${cost('0 or 0 or 0 or 0')}`);
        assert.ok(cost('1 and 1 and 1 and 1') - base >= 4);
        assert.ok(cost('1+1+1+1') - base >= 3);
        assert.ok(cost('1=1') - base >= 1);
        assert.ok(cost('-1') - base >= 1);
        assert.ok(cost("contains('a','b')") - base >= 1);
        assert.ok(cost('true()') - base >= 1);
    }
});

void test('C-1: the time limit stops expression-bound work even with the work budget off', () => {
    const doc = flat(50_000);
    const began = performance.now();
    assert.throws(
        () => new XPathProgram(`//*${'[1=1]'.repeat(2000)}`).run({ node: doc, budget: 0, timeoutMs: 50 }),
        XPathTimeoutError
    );
    // Not a speed test: before the change the clock was read only after 4,096 units, which this loop charged once per run.
    assert.ok(performance.now() - began < 5000, 'the limit of 50 ms held within seconds');
});

void test('C-2: upstream mode asks the DOM for an id once per distinct token, and is charged for the DOM walking', () => {
    const doc = flat(5000);
    let calls = 0;
    const original = doc.getElementById?.bind(doc);
    assert.ok(original !== undefined);
    doc.getElementById = (id: string): DomNode | null | undefined => {
        calls++;
        return original(id);
    };
    const found = select("//*[id('x')]", doc, false, { mode: 'upstream' });
    assert.ok(Array.isArray(found));
    assert.equal(found.length, 0);
    assert.equal(calls, 1, 'one DOM call for 5,001 evaluations of the same token');
    // A different token for each element: each call walks the document, so the budget refuses it (before: 20 s at 100k).
    const ids = parseXml(`<r>${Array.from({ length: 5000 }, (_, i) => `<a k="t${i}"/>`).join('')}</r>`);
    assert.throws(() => select('//*[id(@k)]', ids, false, { mode: 'upstream' }), XPathBudgetError);
    // Strict mode uses its own index: linear.
    assert.deepEqual(select('//*[id(@k)]', ids, false, { mode: 'strict' }), []);
});

void test('C-10: a mode that is neither strict nor upstream is refused by every entry point', () => {
    const doc = flat(1);
    const evaluator = parse('//a');
    // Reflect.apply passes what a JavaScript caller could pass, whatever the declared types say.
    for (const mode of ['Strict', 'bogus', '', 'UPSTREAM']) {
        const refused = (call: () => unknown): void => assert.throws(call, XPathContextError, mode);
        refused(() => Reflect.apply(select, undefined, ['//a', doc, false, { mode }]));
        refused(() => Reflect.apply(select1, undefined, ['//a', doc, { mode }]));
        refused(() => Reflect.apply(parse, undefined, ['//a', { mode }]));
        refused(() => Reflect.apply(useNamespaces, undefined, [{}, { mode }]));
        refused(() => Reflect.construct(XPathProgram, ['//a', { mode }]));
        refused(() => Reflect.apply(Reflect.get(evaluator, 'evaluate'), evaluator, [{ node: doc, mode }]));
    }
    // And the two that are valid, and none given.
    for (const mode of ['strict', 'upstream', undefined] as const)
        assert.ok(Array.isArray(select('//a', doc, false, { mode })));
    assert.ok(Array.isArray(select('//a', doc)));
});

void test('C-11: a function resolver keeps the one-pass axes in strict mode; strict resolves each prefix once', () => {
    const doc = parseXml(`<r xmlns:p="urn:p">${'<p:a/><p:b/>'.repeat(3000)}</r>`);
    let asked = 0;
    const resolver = {
        lookupNamespaceURI: (prefix: string): string | null => (asked++, prefix === 'p' ? 'urn:p' : null)
    };
    for (const expression of ['//p:b/preceding::p:a', '//p:b/following::p:a[1]', '//p:b/preceding::p:a[last()]']) {
        asked = 0;
        const found = selectWithResolver(expression, doc, resolver);
        assert.ok(Array.isArray(found) && found.length > 0);
        assert.equal(asked, 1, `${expression}: the resolver was asked ${asked} times`);
    }
    // The same through the maps: useNamespaces (data), and the typed API with a map and with a function.
    const viaMap = useNamespaces({ p: 'urn:p' })('//p:b/preceding::p:a', doc);
    assert.ok(Array.isArray(viaMap));
    assert.equal(viaMap.length, 3000);
    const viaFunction = new XPathProgram('//p:b/preceding::p:a').run({ node: doc, namespaces: () => 'urn:p' });
    assert.ok(Array.isArray(viaFunction.value));
    assert.equal(viaFunction.value.length, 3000);
    assert.ok(viaFunction.work < 100_000, `work ${viaFunction.work}`);
});

void test('C-11: upstream mode still asks a function resolver at each name test, and a plain map is not caller code', () => {
    const doc = parseXml(`<r xmlns:p="urn:p">${'<p:a/><p:b/>'.repeat(500)}</r>`);
    let asked = 0;
    selectWithResolver('//p:b/preceding::p:a', doc, { lookupNamespaceURI: () => (asked++, 'urn:p') }, false, {
        mode: 'upstream'
    });
    assert.ok(asked > 500, `asked ${asked}`);
    // useNamespaces' map is data: the one-pass paths stay on, in upstream mode as well (a budget that only they fit in).
    for (const mode of ['upstream', 'strict'] as const) {
        const found = parse('//p:b/preceding::p:a', { mode }).select({
            node: doc,
            namespaces: { p: 'urn:p' },
            budget: 20_000
        });
        assert.equal(found.length, 500, mode);
    }
});

void test('C-19: the parse cache is bounded by an estimate of the memory it retains, and static analysis is linear', () => {
    const doc = parseXml('<r/>');
    for (let i = 0; i < 300; i++) select(`a${'[1]'.repeat(600)}[${i}]`, doc);
    const size = parseCacheSize();
    assert.ok(size.estimatedBytes <= 16 << 20, `estimated ${size.estimatedBytes} bytes`);
    assert.ok(size.entries < 300, `${size.entries} entries held`);
    // compile() asks every node for its static facts on the way down: a fact is worked out once per node. The nodes
    // count how often they are read; a chain 400 deep read at every level would be read ~400 times each.
    let reads = 0;
    let expression: Expr = { kind: 'path', absolute: true, filter: null, filterPredicates: [], steps: [] };
    for (let depth = 0; depth < 400; depth++) {
        const operands = [expression];
        expression = {
            kind: 'and',
            get operands(): Expr[] {
                reads++;
                return operands;
            }
        };
    }
    compile(expression);
    assert.ok(reads <= 400 * 6, `${reads} reads of a 400-deep expression`);
});

void test('C-15: a syntax error quotes at most 80 characters of the expression', () => {
    for (const mode of ['strict', 'upstream'] as const) {
        try {
            select(`'${'x'.repeat(100_000)}`, parseXml('<r/>'), false, { mode });
            assert.fail('no error');
        } catch (error) {
            assert.ok(error instanceof XPathSyntaxError);
            assert.ok(error.message.length < 200, `${error.message.length} characters`);
            assert.match(error.message, /offset 0/);
        }
    }
});

void test('C-24: a DOM whose sibling links form a cycle is stopped with a typed error, not by a stack overflow', () => {
    type Loose = { -readonly [K in keyof DomNode]: DomNode[K] };
    const parent: Loose = { nodeType: 1, nodeName: 'p' };
    const child: Loose = { nodeType: 1, nodeName: 'a', parentNode: parent };
    child.nextSibling = child;
    parent.firstChild = child;
    for (const mode of ['strict', 'upstream'] as const)
        for (const expression of [
            'count(*)',
            'count(descendant::*)',
            'string-length(string(.))',
            'count(*[position() > 1])'
        ])
            assert.throws(
                () => select(expression, parent, false, { mode, timeoutMs: 5000 }),
                (error: unknown) => error instanceof XPathBudgetError || error instanceof XPathTimeoutError,
                `${mode} ${expression}`
            );
});

void test('nightly jsdom: a table of custom functions that the expression never calls does not make the evaluation impure', () => {
    const doc = parseXml(`<r>${'<a><b/><c/></a>'.repeat(1500)}</r>`);
    // Impure, `//b[//c]` would be evaluated for each of the 1,500 `a` (4.5 million units); pure, it is evaluated once.
    const expression = '//a[not(//b[//c])]';
    const found = parse(expression).select({ node: doc, functions: { f: () => 1 }, budget: 100_000 });
    assert.equal(found.length, 0);
    // A table that defines a function the expression calls is caller code that can run: the budget is spent.
    assert.throws(
        () => parse('//a[not(//b[//c]) or f()]').select({ node: doc, functions: { f: () => false }, budget: 100_000 }),
        XPathBudgetError
    );
});
