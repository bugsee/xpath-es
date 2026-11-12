// A namespace resolver, or a custom function, must not make an evaluation quadratic (review finding HIGH 1). The budget
// is deterministic work, so the checks do not depend on the speed of the machine: before the fix the same evaluations
// charged tens of millions of units and stopped with XPathBudgetError.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, loadDom } from '../harness.ts';
import { parse, select, useNamespaces, XPathBudgetError } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
const N = 3000;
const doc = parseXml(`<r xmlns:a="urn:x">${'<a:x><a:y/><a:y/></a:x>'.repeat(N)}</r>`);
// Linear work for this document is about 10 times its node count.
const LINEAR_BUDGET = 40 * N * 3;

void test('useNamespaces(...) is linear: a predicate that sorts two nodes per context node', () => {
    const run = useNamespaces({ a: 'urn:x' });
    assert.ok(Array.isArray(run('//a:x[string(a:y)="q"]', doc)));
    // The same through parse().select with a budget that only linear work fits in.
    const found = parse('//a:x[string(a:y)="q"]').select({
        node: doc,
        namespaces: { a: 'urn:x' },
        budget: LINEAR_BUDGET
    });
    assert.equal(found.length, 0);
});

void test('a namespace resolver function is linear and is still asked at every name test', () => {
    let asked = 0;
    const found = parse('//a:x[string(a:y)="q"]').select({
        node: doc,
        namespaces: (prefix: string) => {
            asked++;
            return prefix === 'a' ? 'urn:x' : null;
        },
        budget: LINEAR_BUDGET
    });
    assert.equal(found.length, 0);
    assert.ok(asked >= N, `the resolver was asked ${asked} times`);
});

void test('a custom function (which may change the document) does not make a sort per context node cost a whole-tree numbering', () => {
    let calls = 0;
    const found = parse('//a:x[string(a:y)="q" or f()]').select({
        node: doc,
        namespaces: { a: 'urn:x' },
        functions: { f: () => (calls++, false) },
        budget: LINEAR_BUDGET * 3
    });
    assert.equal(found.length, 0);
    assert.equal(calls, N);
});

void test('a custom function that changes the document is still seen by the next sort (more nodes than a local sort takes)', () => {
    // 41 nodes are more than sortFew orders locally, so the numbering of the whole tree is what a stale answer would come
    // from: the function moves the first element to the end while the evaluation holds a numbering made before.
    const crowded = parseXml(`<r>${'<a/>'.repeat(40)}<b/></r>`);
    const r = crowded.documentElement;
    assert.ok(r);
    let calls = 0;
    const found = parse('(//a | //b)[f()]').select({
        node: crowded,
        functions: {
            f: () => {
                if (++calls === 1 && r.firstChild != null) call(r, 'appendChild', r.firstChild);
                return true;
            }
        }
    });
    const inDocumentOrder: DomNode[] = [];
    for (let child = r.firstChild; child != null; child = child.nextSibling) inDocumentOrder.push(child);
    assert.equal(found.length, 41);
    assert.ok(
        found.every((node, i) => node === inDocumentOrder[i]),
        'the result is not in the order of the document as it now is'
    );
});

void test('a small budget still stops a resolver evaluation with the typed error', () => {
    assert.throws(
        () => parse('//a:x[string(a:y)="q"]').select({ node: doc, namespaces: { a: 'urn:x' }, budget: 100 }),
        XPathBudgetError
    );
    assert.ok(select('count(//*)', doc) === 3 * N + 1);
});
