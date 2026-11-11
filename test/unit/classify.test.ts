// The class-5 classifier (namespace axis over duplicate contexts) must explain that difference and nothing else.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allNodes, describe, errorText, loadDom, loadModule, loadOracle, loadXPath } from '../harness.ts';
import type { DomName, XPathLike } from '../harness.ts';
import { isNamespaceDuplicate } from '../support/classify.ts';
import { loadInternedOracle } from '../support/interned-oracle.ts';

const XML = '<r xmlns:p="urn:p" xmlns:q="urn:q" x="1" xmlns="urn:def1"><![CDATA[cd]]><q:e id="i2" p:z="3"></q:e></r>';
// The context element is reached twice (from the document and from itself), so upstream makes its namespace nodes twice.
const DUPLICATING = '//descendant-or-self::*[last() - 1]/namespace::*[last() - 1]/self::*';
const COUNTING = 'count(//descendant-or-self::*[last() - 1]/namespace::*)';

function evaluate(engine: XPathLike, dom: DomName, expression: string): string {
    const doc = loadDom(dom)(XML);
    const index = new Map<unknown, number>(allNodes(doc).map((node, i) => [node, i]));
    try {
        return describe(engine.select(expression, doc), index);
    } catch (error) {
        return `ERR ${errorText(error)}`;
    }
}

const engine = loadXPath(loadModule('./src/index.ts'));

void test('the interned oracle equals the oracle except where upstream repeats a namespace node', () => {
    const interned = loadInternedOracle();
    const oracle = loadOracle();
    for (const expression of ['//*', '//*/namespace::q', '//@*', 'count(//*)', '//r/namespace::*[2]'])
        for (const dom of ['xmldom08', 'xmldom09'] as const)
            assert.equal(
                evaluate(interned, dom, expression),
                evaluate(oracle, dom, expression),
                `${dom} ${expression}`
            );
});

void test('a duplicate namespace node is classified, for a node-set and for a count()', () => {
    const interned = loadInternedOracle();
    let seen = 0;
    for (const dom of ['xmldom08', 'xmldom09'] as const) {
        for (const expression of [DUPLICATING, COUNTING]) {
            const expected = evaluate(loadOracle(), dom, expression);
            const actual = evaluate(engine, dom, expression);
            if (expected === actual) continue;
            seen++;
            assert.ok(
                isNamespaceDuplicate(expression, expected, actual, () => evaluate(interned, dom, expression)),
                `${dom} ${expression}: ${expected} vs ${actual}`
            );
        }
    }
    assert.ok(seen > 0, 'no duplicating expression differed any more: the test lost its subject');
});

void test('unrelated differences are not classified, even on an expression with a namespace axis', () => {
    const interned = loadInternedOracle();
    const reversing = loadXPath(loadModule('./test/fixtures/reordering-candidate.ts'));
    for (const expression of ['//*/namespace::*', '//*', DUPLICATING]) {
        const expected = evaluate(loadOracle(), 'xmldom08', expression);
        const actual = evaluate(reversing, 'xmldom08', expression);
        if (expected === actual) continue;
        assert.equal(
            isNamespaceDuplicate(expression, expected, actual, () => evaluate(interned, 'xmldom08', expression)),
            false,
            expression
        );
    }
});

void test('only an expression with the namespace axis can be classified', () => {
    assert.equal(
        isNamespaceDuplicate('//a', '[1,2]', '[1]', () => '[1]'),
        false
    );
    assert.equal(
        isNamespaceDuplicate('//a/namespace::*', 'ERR boom', '[1]', () => '[1]'),
        false
    );
});
