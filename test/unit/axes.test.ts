// Regression tests found by the differential fuzzer: the engine must evaluate predicates only on candidate nodes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allNodes, loadDom } from '../harness.ts';
import { XPathProgram } from '../../src/index.ts';

const parse = loadDom('xmldom08');

void test('preceding:: from the last context does not evaluate predicates on the context itself', () => {
    // lang() throws on a processing instruction; the only preceding nodes here are not processing instructions, so
    // no predicate may run on the context (a processing instruction) at all.
    const doc = parse('<r id="i0"></r><!--end--><?end pi?>');
    const context = allNodes(doc).find((node) => node.nodeType === 7);
    assert.ok(context);
    const program = new XPathProgram("preceding::processing-instruction()[lang('text1')]");
    const { value } = program.run({ node: context });
    assert.equal(typeof value === 'object' ? value.size : -1, 0);
});

void test('preceding:: still evaluates predicates on a context that precedes a later context', () => {
    const doc = parse('<r><a/><b/></r>');
    const program = new XPathProgram('preceding::*[name() = "a"]');
    const nodes = allNodes(doc).filter((node) => node.nodeType === 1);
    const { value } = program.run({ node: nodes[nodes.length - 1] });
    assert.equal(typeof value === 'object' ? value.size : -1, 1);
});
