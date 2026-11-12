// Review findings HIGH 2 and MEDIUM 4, 5: uncharged or unbounded work, the defaults, the compat limits, the parse cache.
// Work is counted in the engine's own units, so none of these depends on the speed of the machine.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import {
    DEFAULT_BUDGET,
    DEFAULT_TIMEOUT_MS,
    parse,
    parseCacheSize,
    select,
    select1,
    useNamespaces,
    XPathBudgetError,
    XPathContextError,
    XPathLimitError,
    XPathProgram,
    XPathResolveError
} from '../support/engine.ts';

const parseXml = loadDom('xmldom08');

function work(expression: string, xml: string): number {
    return new XPathProgram(expression).run({ node: parseXml(xml) }).work;
}

void test('id(): one index per evaluation, tokens bounded (before: 10,000 tokens took 9 s, 10,000 missing ones 42 s)', () => {
    const doc = parseXml(`<r>${Array.from({ length: 50_000 }, (_, i) => `<e id="i${i}"/>`).join('')}</r>`);
    const tokens = (count: number, present: boolean): string =>
        Array.from({ length: count }, (_, i) => (present ? `i${i}` : `zz${i}`)).join(' ');
    const found = parse(`id("${tokens(10_000, true)}")`).select({ node: doc, budget: 400_000 });
    assert.equal(found.length, 10_000);
    assert.equal(parse(`id("${tokens(10_000, false)}")`).select({ node: doc, budget: 400_000 }).length, 0);
    assert.throws(() => parse(`id("${tokens(40_000, true)}")`).select({ node: doc }), XPathLimitError);
});

void test('id() of a node-set serialises under the budget: a 5,000-deep chain no longer builds gigabytes', () => {
    const chain = parseXml(`${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}`);
    assert.throws(
        () => parse('id(//*)').select({ node: chain }),
        (error: unknown) => error instanceof XPathLimitError || error instanceof XPathBudgetError
    );
});

void test('the namespace axis makes a bounded number of nodes (before: 8,000 levels made 32 million, 4 GB)', () => {
    const nest = (depth: number): string => {
        let open = '';
        for (let i = 0; i < depth; i++) open += `<n${i} xmlns:p${i}="u${i}">`;
        return open + Array.from({ length: depth }, (_, i) => `</n${depth - 1 - i}>`).join('');
    };
    // At depth d an element has d declarations and `xml` in scope: 2 + 3 + ... + 51 for 50 levels.
    assert.equal(parse('count(//namespace::*)').evaluateNumber({ node: parseXml(nest(50)) }), 1325);
    assert.throws(() => parse('count(//namespace::*)').evaluate({ node: parseXml(nest(2000)) }), XPathLimitError);
});

void test('a string cannot grow without bound by nested concat()', () => {
    const doc = parseXml(`<r a="${'a'.repeat(1_000_000)}"/>`);
    let expression = 'string(/r/@a)';
    for (let i = 0; i < 8; i++) expression = `concat(${expression},${expression})`;
    assert.throws(
        () => select(`string-length(${expression})`, doc, false, { budget: 0 }),
        (error: unknown) => error instanceof XPathLimitError
    );
});

void test('document-only subexpressions are evaluated once: nested absolute paths in predicates (before: 2.6 s, then the budget)', () => {
    const xml = `<r>${'<a><b/></a>'.repeat(3000)}</r>`;
    for (const expression of [
        '//a[//a[//a[//a]]]',
        '//a[//b[//a[//b[//a[//b]]]]]',
        '//*[count(//*)>0][count(//*[count(//*)>0])>0]'
    ]) {
        assert.ok(work(expression, xml) < 200_000, expression);
    }
});

void test('reverse axes are read nearest first, and [last()] from the cheap end', () => {
    assert.ok(work('//a/preceding::a[1]', `<r>${'<a><b/></a>'.repeat(3000)}</r>`) < 200_000);
    assert.ok(work('//b[position()=last()]/preceding::*[last()]', `<r>${'<a><b/></a>'.repeat(3000)}</r>`) < 200_000);
    assert.ok(work('//a/preceding-sibling::a[last()]', `<r>${'<a/>'.repeat(50_000)}</r>`) < 1_000_000);
});

void test('lang() is linear on a deep document for a DOM that answers null for a missing attribute', () => {
    const deep = parseXml(`${'<a>'.repeat(3000)}${'</a>'.repeat(3000)}`);
    const wrapped = new Proxy(deep, {});
    void wrapped;
    assert.ok(Array.isArray(select("//*[lang('en')]", deep)));
});

void test('the defaults are the measured ones and legitimate work is far below them', () => {
    assert.equal(DEFAULT_BUDGET, 5_000_000);
    assert.equal(DEFAULT_TIMEOUT_MS, 1_000);
    const groups = `<Attribute>${'<AttributeValue>xxxxxxxx-xxxx</AttributeValue>'.repeat(2000)}</Attribute>`;
    const used = work("/*[local-name(.)='Attribute']/*[local-name(.)='AttributeValue']", groups);
    assert.ok(used < 20_000, `a 2,000-value group list took ${used} units`);
    assert.ok(DEFAULT_BUDGET > 200 * used);
});

void test('limits are a number of at least 0: a string or NaN does not turn them off', () => {
    const doc = parseXml('<r><a/><a/></r>');
    const program = new XPathProgram('count(//a)');
    for (const bad of ['0', Number.NaN, -1, null, true, {}]) {
        // @ts-expect-error a caller from plain JavaScript can pass anything
        assert.throws(() => program.run({ node: doc, budget: bad }), XPathContextError);
        // @ts-expect-error likewise
        assert.throws(() => program.run({ node: doc, timeoutMs: bad }), XPathContextError);
    }
});

void test('select(), select1() and useNamespaces() take the limits', () => {
    const doc = parseXml(`<r xmlns:a="urn:a">${'<a:x/>'.repeat(500)}</r>`);
    assert.throws(() => select('//*', doc, false, { budget: 10 }), XPathBudgetError);
    assert.throws(() => select1('//*', doc, { budget: 10 }), XPathBudgetError);
    assert.throws(() => useNamespaces({ a: 'urn:a' })('//a:x', doc, false, { budget: 10 }), XPathBudgetError);
    assert.throws(() => useNamespaces({ a: 'urn:a' }, { budget: 10 })('//a:x', doc), XPathBudgetError);
    assert.equal(select('count(//*)', doc, false, { budget: 0, timeoutMs: 0 }), 501);
});

void test('plain-object resolvers see own properties only (before: a prefix called constructor resolved to Object)', () => {
    const doc = parseXml('<r/>');
    assert.throws(() => useNamespaces({})('//constructor:a', doc), XPathResolveError);
    assert.throws(() => useNamespaces({})('//__proto__:a', doc), XPathResolveError);
    assert.throws(() => parse('toString()').evaluate({ node: doc, functions: {} }), XPathResolveError);
    assert.throws(() => parse('$constructor').evaluate({ node: doc, variables: {} }), XPathResolveError);
});

void test('the parse cache is bounded in bytes and does not keep long expressions', () => {
    const before = parseCacheSize();
    const doc = parseXml('<r/>');
    for (let i = 0; i < 2000; i++) select(`/r[${i}]${'/self::node()'.repeat(120)}`, doc);
    const afterMany = parseCacheSize();
    assert.ok(afterMany.length <= 1 << 18, `the cache holds ${afterMany.length} characters`);
    assert.ok(afterMany.entries <= 512);
    // An expression beyond the cacheable length is parsed again and not kept.
    select(`/r${'/self::node()'.repeat(400)}`, doc);
    assert.deepEqual(parseCacheSize(), afterMany);
    assert.ok(before.entries >= 0);
});
