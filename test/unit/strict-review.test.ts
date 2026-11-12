// Review findings on the strict default (CodeRabbit on PR 6), each pinned by a test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { evaluate, select, XPathProgram, XPathResult } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');

void test('a single context node: strict preceding:: does not number the document (the per-context walk is cheaper)', () => {
    // The context is the first child of the root element; 200 siblings follow it. Nothing precedes it that is not an
    // ancestor, so the per-context walk finishes within a few units, where numbering the document costs 200 or more.
    const doc = parseXml(`<r><a/>${'<z/>'.repeat(200)}</r>`);
    const first = doc.documentElement?.firstChild;
    assert.ok(first != null);
    const program = new XPathProgram('preceding::*', { mode: 'strict' });
    assert.deepEqual(program.run({ node: first, budget: 100 }).value, []);
    assert.ok(program.run({ node: first }).work < 20);
});

void test('a namespace callback: upstream mode asks it per name test, strict mode once per prefix; fast and slow paths agree', () => {
    const doc = parseXml('<r xmlns:p="urn:x"><p:a/><b/><c/></r>');
    const outcome = (mode: 'strict' | 'upstream'): { found: string[]; asked: number } => {
        let asked = 0;
        // A resolver whose answers change from call to call: only a mode that asks once is deterministic about it.
        const namespaces = (prefix: string): string | null => {
            asked++;
            return prefix === 'p' ? (asked % 2 === 0 ? 'urn:x' : 'urn:other') : null;
        };
        const program = new XPathProgram('(/r/b | /r/c)/preceding::p:a', { mode });
        const value = program.run({ node: doc, namespaces }).value;
        assert.ok(Array.isArray(value));
        return { found: value.map((node: DomNode) => node.nodeName), asked };
    };
    for (const mode of ['upstream', 'strict'] as const) {
        const normal = outcome(mode);
        XPathProgram.forceSlowPath = true;
        try {
            // Upstream mode asks per name test, and the fast and slow paths do not test the same number of nodes.
            const slow = outcome(mode);
            assert.deepEqual(mode === 'strict' ? slow : slow.found, mode === 'strict' ? normal : normal.found, mode);
        } finally {
            XPathProgram.forceSlowPath = false;
        }
        if (mode === 'upstream') assert.ok(normal.asked >= 2, 'the callback was asked once per name test per context');
        // Strict: asked once, so the first answer ('urn:other') is the binding for the whole evaluation.
        else assert.deepEqual(normal, { found: [], asked: 1 });
    }
});

void test('evaluate() with NUMBER_TYPE follows the mode: strict converts a node-set by the grammar of 4.4', () => {
    const doc = parseXml('<r><n>0x10</n><m>12</m></r>');
    const number = (expression: string, mode: 'strict' | 'upstream'): number | undefined =>
        evaluate(expression, doc, null, XPathResult.NUMBER_TYPE, null, { mode }).numberValue;
    // Recommendation 4.4: number(node-set) is number(string(first node)); '' and '0x10' are not numbers.
    assert.ok(Number.isNaN(number('/r/missing', 'strict')));
    assert.ok(Number.isNaN(number('/r/n', 'strict')));
    assert.equal(number('/r/m', 'strict'), 12);
    // Upstream goes through JavaScript's Number().
    assert.equal(number('/r/missing', 'upstream'), 0);
    assert.equal(number('/r/n', 'upstream'), 16);
    // And the default is strict.
    assert.ok(Number.isNaN(evaluate('/r/missing', doc, null, XPathResult.NUMBER_TYPE).numberValue ?? 0));
});

void test('id() in strict mode falls back to xml:id when id is empty or absent (xmldom answers "" for a missing attribute)', () => {
    const doc = parseXml(
        '<r xmlns:xml="http://www.w3.org/XML/1998/namespace"><a xml:id="x1"/><b id="i1"/><c id="" xml:id="x2"/></r>'
    );
    const names = (expression: string, mode: 'strict' | 'upstream'): string[] => {
        const found = select(expression, doc, false, { mode });
        assert.ok(Array.isArray(found));
        return found.map((node: DomNode) => node.nodeName);
    };
    assert.deepEqual(names("id('x1')", 'strict'), ['a']);
    assert.deepEqual(names("id('x2')", 'strict'), ['c']);
    assert.deepEqual(names("id('i1')", 'strict'), ['b']);
    // Upstream knows no xml:id.
    assert.deepEqual(names("id('x1')", 'upstream'), []);
});
