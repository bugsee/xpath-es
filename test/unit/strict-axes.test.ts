// Strict following:: and preceding:: over many context nodes (src/ranked.ts), against the Recommendation's definitions
// (section 2.2: following = after the node in document order, descendants excluded; preceding = before it, ancestors
// excluded; an attribute or namespace node stands where its element stands, section 5) and the position rule of
// section 2.4 (a predicate's position is relative to each context node's own axis, reverse axes nearest first).
// Expected values are written out by hand, or derived by a plain-DOM model of the definitions below: no XPath engine
// is consulted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom, makeRandom } from '../harness.ts';
import { documentText } from '../generate.ts';
import { select, XPathBudgetError, XPathProgram } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
const run = (expression: string, node: DomNode): unknown => select(expression, node, false, { mode: 'strict' });
const ids = (expression: string, node: DomNode): string => {
    const found = run(expression, node);
    assert.ok(Array.isArray(found), `${expression} is not a node-set`);
    return found.map((n: DomNode) => n.getAttribute?.('id') ?? String(n.nodeName)).join(' ');
};

// Document order: r a1 b1 c1 a2 (attribute x) b2 b3
const DOC = parseXml('<r><a id="a1"><b id="b1"/><c id="c1"/></a><a id="a2" x="1"><b id="b2"/></a><b id="b3"/></r>');

void test('following::*[k] and [last()] from several context nodes: each context counts its own axis', () => {
    // following(b1) = c1 a2 b2 b3; following(b2) = b3; following(b3) = nothing.
    assert.equal(ids('//b/following::*[1]', DOC), 'c1 b3');
    assert.equal(ids('//b/following::*[2]', DOC), 'a2');
    assert.equal(ids('//b/following::*[3]', DOC), 'b2');
    assert.equal(ids('//b/following::*[4]', DOC), 'b3');
    assert.equal(ids('//b/following::*[5]', DOC), '');
    assert.equal(ids('//b/following::*[last()]', DOC), 'b3');
    assert.equal(ids('//b/following::c[1]', DOC), 'c1');
    assert.equal(ids('//b/following::b[1]', DOC), 'b2 b3');
    assert.equal(ids('//b/following::b[last()]', DOC), 'b3');
});

void test('preceding::*[k] and [last()] from several context nodes: nearest first, ancestors excluded', () => {
    // preceding(b1) = nothing (r and a1 are ancestors); preceding(b2) = c1 b1 a1 (nearest first); preceding(b3) = b2 a2 c1 b1 a1.
    assert.equal(ids('//b/preceding::*[1]', DOC), 'c1 b2');
    assert.equal(ids('//b/preceding::*[2]', DOC), 'b1 a2');
    assert.equal(ids('//b/preceding::*[3]', DOC), 'a1 c1');
    assert.equal(ids('//b/preceding::*[5]', DOC), 'a1');
    assert.equal(ids('//b/preceding::*[6]', DOC), '');
    assert.equal(ids('//b/preceding::*[last()]', DOC), 'a1');
    assert.equal(ids('//b/preceding::b[1]', DOC), 'b1 b2');
    assert.equal(ids('//b/preceding::b[last()]', DOC), 'b1');
});

void test('attribute nodes as contexts stand where their element stands', () => {
    // @x of a2: following = its element's children and everything after the element: b2 b3; preceding = c1 b1 a1.
    assert.equal(ids('//@x/following::*[1]', DOC), 'b2');
    assert.equal(ids('//@x/following::*[last()]', DOC), 'b3');
    assert.equal(ids('//@x/preceding::*[1]', DOC), 'c1');
    assert.equal(ids('//@x/preceding::*[last()]', DOC), 'a1');
    // The element a2 (its descendants do not follow it) and its attribute (its element's children follow it) differ.
    assert.equal(ids('(//a[@x] | //@x)/following::*[1]', DOC), 'b2 b3');
    assert.equal(ids('(//a[@x] | //@x/..)/preceding::*[1]', DOC), 'c1');
});

void test('contexts inside other contexts, duplicates, and a mix of kinds', () => {
    assert.equal(ids('(//a | //b)/following::*[1]', DOC), 'c1 a2 b3');
    assert.equal(ids('(//a | //b)/preceding::*[1]', DOC), 'c1 b2');
    assert.equal(ids('(//a | //a/b | //b | //a)/following::*[last()]', DOC), 'b3');
    assert.equal(ids('(//* | //b)/preceding::*[last()]', DOC), 'a1 b1');
    // following::*[1] of the b's is c1 and b3; before c1 the nearest non-ancestor is b1, before b3 it is b2.
    assert.equal(ids('//b/following::*[1]/preceding::*[1]', DOC), 'b1 b2');
    // A positional predicate after another: [k] is taken on the nodes that passed the first predicate.
    assert.equal(ids('//b/following::*[1][self::c]', DOC), 'c1');
    assert.equal(ids('//b/following::*[self::b][1]', DOC), 'b2 b3');
    assert.equal(ids('//b/following::*[1][2]', DOC), '');
    assert.equal(ids('//b/following::*[position() = 2]', DOC), 'a2');
    assert.equal(ids('//b/preceding::*[position() = last()]', DOC), 'a1');
    // A position that no node can have.
    assert.equal(ids('//b/following::*[0]', DOC), '');
    assert.equal(ids('//b/preceding::*[1.5]', DOC), '');
});

void test('preceding:: of a node-set never holds the document node or the root: they are ancestors (review P2)', () => {
    // The last context is b3, a child of the root: before it, and not its ancestors, are a1 b1 c1 a2 b2.
    assert.equal(ids('(//b | //c)/preceding::node()', DOC), 'a1 b1 c1 a2 b2');
    assert.equal(ids('(//a | //b)/preceding::node()', DOC), 'a1 b1 c1 a2 b2');
});

void test('the document node and the root element as contexts', () => {
    assert.equal(ids('//r/following::*[1]', DOC), '');
    assert.equal(ids('//r/preceding::*[last()]', DOC), '');
    assert.equal(ids('(/ | //r | //b)/following::*[last()]', DOC), 'b3');
});

void test('many contexts: the answers are right and the work is linear', () => {
    const count = 3000;
    const wide = parseXml(`<r>${'<a><b/></a>'.repeat(count)}</r>`);
    const program = (text: string): XPathProgram => new XPathProgram(text, { mode: 'strict' });
    const lengthOf = (text: string): number => {
        const found = program(text).run({ node: wide });
        assert.ok(Array.isArray(found.value));
        return found.value.length;
    };
    // b(i) follows a(i-1) and a(i) is not an ancestor of it; every b but the first has an `a` before it that is no ancestor.
    assert.equal(lengthOf('//a/following::b[1]'), count - 1);
    assert.equal(lengthOf('//a/preceding::b'), count - 1);
    assert.equal(lengthOf('//b[position() = last()]/preceding::*[last()]'), 1);
    assert.equal(lengthOf('//b/preceding::a[1]'), count - 1);
    // Each of these cost about nine million units when every context walked its axis (the default budget is five million).
    for (const text of [
        '//a/following::b[1]',
        '//a/preceding::b',
        '//b[position() = last()]/preceding::*[last()]',
        '//a/following::*[last()]'
    ]) {
        const { work } = program(text).run({ node: wide });
        assert.ok(work < 60 * count, `${text}: ${work} units for ${count} contexts`);
    }
    // The budget is still charged: a budget smaller than the pass over the tree stops it.
    assert.throws(() => program('//a/following::b[1]').run({ node: wide, budget: 1000 }), XPathBudgetError);
});

// ---- a model of the definitions, in plain DOM code ----

function documentOrder(root: DomNode): DomNode[] {
    const out: DomNode[] = [];
    const visit = (node: DomNode): void => {
        out.push(node);
        for (let child = node.firstChild; child != null; child = child.nextSibling) visit(child);
    };
    visit(root);
    return out;
}

/** The definitions of section 2.2 over one document, with the order, the subtree sizes and the ancestors worked out once. */
function makeModel(
    order: readonly DomNode[]
): (
    axis: 'following' | 'preceding',
    context: DomNode,
    wanted: (node: DomNode) => boolean,
    k: number
) => DomNode | null {
    const position = new Map<DomNode, number>(order.map((node, i) => [node, i]));
    const ancestors = new Map<DomNode, Set<DomNode>>();
    const ancestorsOf = (node: DomNode): Set<DomNode> => {
        let known = ancestors.get(node);
        if (known === undefined) {
            known = new Set<DomNode>();
            for (let up = node.parentNode; up != null; up = up.parentNode) known.add(up);
            ancestors.set(node, known);
        }
        return known;
    };
    return (axis, context, wanted, k) => {
        const anchor = context.nodeType === 2 ? (context.ownerElement ?? context) : context;
        const at = position.get(anchor) ?? -1;
        // Past the subtree of a tree node: the first node that is neither the node nor one of its descendants. An
        // attribute comes after its element and before its children, so the element's children follow it.
        let after = at + 1;
        if (context.nodeType !== 2)
            while (after < order.length && ancestorsOf(order[after] ?? anchor).has(anchor)) after++;
        const matching: DomNode[] = [];
        if (axis === 'following') {
            for (let i = after; i < order.length; i++)
                if (wanted(order[i] ?? anchor)) matching.push(order[i] ?? anchor);
        } else {
            const above = ancestorsOf(anchor);
            for (let i = at - 1; i >= 0; i--) {
                const node = order[i] ?? anchor;
                if (!above.has(node) && wanted(node)) matching.push(node);
            }
        }
        // A reverse axis is read nearest first: its last node is the one farthest in document order.
        return k === 0 ? (matching.at(-1) ?? null) : (matching[k - 1] ?? null);
    };
}

void test('random trees: every context node set, against the model of the definitions', () => {
    const random = makeRandom(20260512);
    let checked = 0;
    for (let d = 0; d < 40; d++) {
        const doc = parseXml(documentText(random));
        const order = documentOrder(doc).filter((node) => ![5, 6, 10, 12].includes(node.nodeType));
        const elements = order.filter((node) => node.nodeType === 1);
        const attributes = elements.flatMap((element) => {
            const out: DomNode[] = [];
            for (let i = 0; i < (element.attributes?.length ?? 0); i++) {
                const attribute = element.attributes?.item(i);
                if (attribute != null && !String(attribute.name).startsWith('xmlns')) out.push(attribute);
            }
            return out;
        });
        const model = makeModel(order);
        const sets: readonly (readonly [string, DomNode[]])[] = [
            ['//*', elements],
            ['//a', elements.filter((node) => node.nodeName === 'a' && !node.namespaceURI)],
            ['//@*', attributes],
            ['//text()', order.filter((node) => [3, 4].includes(node.nodeType))]
        ];
        for (const [path, contexts] of sets) {
            for (const axis of ['following', 'preceding'] as const) {
                for (const k of [1, 2, 3, 0]) {
                    const found = run(`${path}/${axis}::*[${k === 0 ? 'last()' : k}]`, doc);
                    assert.ok(Array.isArray(found));
                    const expected = new Set<DomNode>();
                    for (const context of contexts) {
                        const hit = model(axis, context, (node) => node.nodeType === 1, k);
                        if (hit !== null) expected.add(hit);
                    }
                    // Compared by document position: a failed comparison of DOM nodes would print the whole object graph.
                    const place = (nodes: readonly DomNode[]): string =>
                        nodes.map((node) => order.indexOf(node)).join(' ');
                    const inOrder = order.filter((node) => expected.has(node));
                    assert.equal(
                        place(found),
                        place(inOrder),
                        `${path}/${axis}::*[${k === 0 ? 'last()' : k}] (document ${d})`
                    );
                    checked++;
                }
            }
        }
    }
    assert.ok(checked > 300);
});
