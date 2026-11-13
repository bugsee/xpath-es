// Review comments on the strict conformance changes: the walks that find the root of a tree and the run of text nodes
// are charged as they go.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { select, XPathBudgetError, XPathProgram, XPathTimeoutError } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

void test('strict: a cycle of empty text nodes is stopped by the limits (the run of text is charged while it is walked)', () => {
    type Loose = { -readonly [K in keyof DomNode]: DomNode[K] };
    const parent: Loose = { nodeType: 1, nodeName: 'p' };
    const first: Loose = { nodeType: 3, nodeName: '#text', nodeValue: '', parentNode: parent };
    const second: Loose = { nodeType: 3, nodeName: '#text', nodeValue: '', parentNode: parent };
    first.nextSibling = second;
    second.nextSibling = first;
    parent.firstChild = first;
    assert.throws(
        () => select('string(text())', parent, false, { mode: 'strict', timeoutMs: 5000 }),
        (error: unknown) => error instanceof XPathBudgetError || error instanceof XPathTimeoutError
    );
});

void test('strict: the root of each node of a deep chain is found once for the chain, and the walk is charged', () => {
    const depth = 3000;
    const doc = loadDom('xmldom08')(`${'<e>'.repeat(depth)}${'</e>'.repeat(depth)}`);
    // `/*` is evaluated for each of the 3,000 elements; each would walk up to its root (about 4.5 million steps).
    const { work } = new XPathProgram('count(//*[count(/*) > 0])', { mode: 'strict' }).run({ node: doc });
    assert.ok(work < 200_000, `work ${work}`);
    // An element of a chain that is not part of a pure evaluation is charged for the walk up: a small budget refuses it.
    const tiny = new XPathProgram('count(//*[count(/*) > 0])', { mode: 'strict' });
    assert.throws(() => tiny.run({ node: doc, budget: 1000 }), XPathBudgetError);
});
