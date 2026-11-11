// The class-5 classifier (namespace axis over duplicate contexts) must explain that difference and nothing else.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allNodes, call, describe, errorText, loadDom, loadModule, loadOracle, loadXPath } from '../harness.ts';
import type { DomName, XPathLike } from '../harness.ts';
import {
    allowedClasses,
    classifyDifference,
    DOCUMENTED,
    DOM_COMPARE_CRASH,
    isNamespaceDuplicate,
    ORDER_ERROR
} from '../support/classify.ts';
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

void test('a duplicate namespace node is classified, for a node-set and, separately, for a count()', () => {
    const interned = loadInternedOracle();
    for (const expression of [DUPLICATING, COUNTING]) {
        let explained = 0;
        for (const dom of ['xmldom08', 'xmldom09'] as const) {
            const expected = evaluate(loadOracle(), dom, expression);
            const actual = evaluate(engine, dom, expression);
            if (expected === actual) continue;
            assert.ok(
                isNamespaceDuplicate(expression, expected, actual, () => evaluate(interned, dom, expression)),
                `${dom} ${expression}: ${expected} vs ${actual}`
            );
            explained++;
        }
        assert.ok(explained > 0, `${expression}: upstream no longer differs on either DOM; the test lost its subject`);
    }
});

void test('the interned oracle does not return a stale namespace node after the document changes', () => {
    const interned = loadInternedOracle();
    const doc = loadDom('xmldom08')('<w><r xmlns:p="urn:1"><a/></r><s xmlns:p="urn:2"/></w>');
    const nodes = allNodes(doc);
    const a = nodes.find((node) => node.nodeName === 'a');
    const s = nodes.find((node) => node.nodeName === 's');
    assert.ok(a && s);
    const uris = (engineUnderTest: XPathLike): string => {
        const result = engineUnderTest.select('namespace::p', a);
        return Array.isArray(result) ? result.map((node) => String(Reflect.get(node, 'nodeValue'))).join() : '?';
    };
    assert.equal(uris(interned), 'urn:1');
    call(s, 'appendChild', a);
    assert.equal(uris(interned), uris(loadOracle()));
    assert.equal(uris(interned), 'urn:2');
});

void test('only the documented upstream crash excuses a difference', () => {
    const all = allowedClasses('all');
    const answer = '["x"]';
    // The documented crash is classified in its scenarios ...
    assert.equal(classifyDifference('detached', 'foo()', DOM_COMPARE_CRASH, answer, undefined, all), DOCUMENTED[1]);
    assert.equal(
        classifyDifference('static', '//a/namespace::*', DOM_COMPARE_CRASH, answer, undefined, all),
        DOCUMENTED[0]
    );
    assert.equal(classifyDifference('twodocs', '$a | $b', DOM_COMPARE_CRASH, answer, undefined, all), DOCUMENTED[3]);
    assert.equal(classifyDifference('pairs-two-trees', 'pair', answer, ORDER_ERROR, undefined, all), DOCUMENTED[2]);
    // ... any other upstream error is not: an unknown function, or a predicate that fails before the namespace step.
    for (const scenario of ['detached', 'static', 'twodocs', 'pairs-two-trees'] as const) {
        for (const error of ['ERR Cannot resolve QName foo', 'ERR n.getAttributeNS is not a function'])
            assert.equal(classifyDifference(scenario, "lang('x')/namespace::*", error, answer, undefined, all), null);
    }
    // The engine's own errors are excused only when it is the order error on several trees.
    assert.equal(classifyDifference('pairs-two-trees', 'pair', answer, 'ERR something else', undefined, all), null);
    assert.equal(classifyDifference('static', '//a', answer, ORDER_ERROR, undefined, all), null);
    // Class 5 alone allows none of the others.
    assert.equal(
        classifyDifference('detached', 'foo()', DOM_COMPARE_CRASH, answer, undefined, allowedClasses('ns-duplicate')),
        null
    );
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
