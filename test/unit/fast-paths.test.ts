// The engine's fast paths against plain-DOM references: sibling ranks, positional shortcuts from the cheap end of an axis,
// the sweep against the sort for large node-sets, unions. Each template is checked on a wide parent (more children than the
// thresholds of the fast paths: 3,000 siblings ranked at once, `n * 8 > total` for the sweep), on small random documents and
// with every fast path switched off. A bug planted in one of the fast paths (see test/mutation-testing.ts) must fail here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom, makeRandom } from '../harness.ts';
import { documentText } from '../generate.ts';
import { XPathProgram, select } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');

/** A name test without a prefix: the element's name, in no namespace. */
const named = (node: DomNode, name: string): boolean =>
    node.nodeType === 1 && node.nodeName === name && !node.namespaceURI;

const children = (node: DomNode, name: string): DomNode[] => {
    const out: DomNode[] = [];
    for (let child = node.firstChild; child != null; child = child.nextSibling) if (named(child, name)) out.push(child);
    return out;
};
const elements = (root: DomNode): DomNode[] => {
    const out: DomNode[] = [];
    const stack: DomNode[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        if (node.nodeType === 1) out.push(node);
        const kids: DomNode[] = [];
        for (let child = node.firstChild; child != null; child = child.nextSibling) kids.push(child);
        for (let i = kids.length - 1; i >= 0; i--) {
            const kid = kids[i];
            if (kid !== undefined) stack.push(kid);
        }
    }
    return out;
};

function wide(count: number): { doc: DomNode; parent: DomNode } {
    // a, b, a, a, b ... : a deterministic mix of two names.
    const body = Array.from({ length: count }, (_, i) => (i % 3 === 1 ? '<b/>' : '<a/>')).join('');
    const doc = parseXml(`<r><g>${body}</g></r>`);
    const parent = doc.documentElement?.firstChild;
    assert.ok(parent);
    return { doc, parent };
}

const same = (found: unknown, expected: readonly DomNode[], what: string): void => {
    assert.ok(Array.isArray(found), `${what}: not a node-set`);
    assert.equal(found.length, expected.length, `${what}: ${found.length} nodes, expected ${expected.length}`);
    for (let i = 0; i < expected.length; i++) assert.ok(found[i] === expected[i], `${what}: node ${i} differs`);
};

for (const slow of [false, true]) {
    const run = (expression: string, doc: DomNode): unknown => {
        XPathProgram.forceSlowPath = slow;
        try {
            // No limits: the fast paths are off, so a 3,000-sibling parent costs what it costs.
            return select(expression, doc, false, { budget: 0, timeoutMs: 0 });
        } finally {
            XPathProgram.forceSlowPath = false;
        }
    };
    const label = slow ? ' (fast paths off)' : '';

    for (const width of [40, 3001, 3500]) {
        void test(`sibling counts on a parent with ${width} children${label}`, () => {
            const { doc, parent } = wide(width);
            const as = children(parent, 'a');
            for (const k of [0, 1, 2, 3, as.length - 2, as.length - 1, as.length]) {
                same(
                    run(`/r/g/a[count(following-sibling::a)=${k}]`, doc),
                    as.filter((_, i) => as.length - 1 - i === k),
                    `following-sibling count ${k}`
                );
                same(
                    run(`/r/g/a[count(preceding-sibling::a)=${k}]`, doc),
                    as.filter((_, i) => i === k),
                    `preceding-sibling count ${k}`
                );
            }
            // Every a has the same number of following a as its position from the end.
            same(
                run('/r/g/a[count(following-sibling::*)>=3000]', doc),
                as.filter((a) => {
                    let after = 0;
                    for (let n = a.nextSibling; n != null; n = n.nextSibling) after++;
                    return after >= 3000;
                }),
                'count >= 3000'
            );
        });

        void test(`positional shortcuts from the cheap end of an axis, ${width} children${label}`, () => {
            const { doc, parent } = wide(width);
            const as = children(parent, 'a');
            const kids = elementsOf(parent);
            same(run('/r/g/a[last()]', doc), as.slice(-1), 'a[last()]');
            same(run('/r/g/b[1]', doc), children(parent, 'b').slice(0, 1), 'b[1]');
            same(run('/r/g/*[last()]', doc), kids.slice(-1), '*[last()]');
            same(run('/r/g/a/following-sibling::a[1]', doc), as.slice(1), 'following-sibling::a[1]');
            same(run('/r/g/a/following-sibling::a[2]', doc), as.slice(2), 'following-sibling::a[2]');
            same(run('/r/g/a/preceding-sibling::a[1]', doc), as.slice(0, -1), 'preceding-sibling::a[1]');
            same(run('/r/g/a/preceding-sibling::a[last()]', doc), as.slice(0, 1), 'preceding-sibling::a[last()]');
            same(run('/r/g/a/following-sibling::a[last()]', doc), as.slice(-1), 'following-sibling::a[last()]');
            same(
                run('/r/g/a[position() mod 100 = 1]', doc),
                as.filter((_, i) => i % 100 === 0),
                'position() mod 100'
            );
            same(run('/r/g/a[position() = last() - 1]', doc), as.slice(-2, -1), 'last() - 1');
            // An expression that walks the document and also reads the position is not the same for every context node.
            const bs = children(parent, 'b').length;
            same(run(`/r/g/a[count(/r/g/b) = position()]`, doc), as.slice(bs - 1, bs), 'count() = position()');
            same(run('/r/g/a/preceding::a[1]', doc), as.slice(0, -1), 'preceding::a[1]');
            same(run('/r/g/a/following::a[1]', doc), as.slice(1), 'following::a[1]');
        });

        void test(`unions and the sweep against the sort, ${width} children${label}`, () => {
            const { doc, parent } = wide(width);
            const kids = elementsOf(parent);
            // Large against the node count: the sweep (n * 8 > total).
            same(run('/r/g/a | /r/g/b', doc), kids, 'a | b');
            same(run('/r/g/b | /r/g/a', doc), kids, 'b | a');
            // Small against the node count: the sort.
            same(
                run('/r/g/a[position() = 3] | /r/g/b[position() = 2] | /r/g/a[1]', doc),
                [kids[0], kids[3], kids[4]].filter((n): n is DomNode => n !== undefined),
                'few'
            );
            same(run('//a | //b | /r/g/a', doc), kids, 'overlapping');
            same(run('(/r/g/b | /r/g/a)[position() <= 5]', doc), kids.slice(0, 5), 'first five of a union');
        });
    }

    void test(`random documents: the same answers as a plain walk${label}`, () => {
        const random = makeRandom(20260301);
        for (let d = 0; d < 60; d++) {
            const doc = parseXml(documentText(random));
            const all = elements(doc);
            const as = all.filter((n) => named(n, 'a'));
            same(run('//a', doc), as, '//a');
            same(run('//*', doc), all, '//*');
            for (const name of ['a', 'b', 'c']) {
                const matching = all.filter((n) => named(n, name));
                same(run(`//${name}`, doc), matching, `//${name}`);
                same(
                    run(`//${name}[count(following-sibling::${name})=0]`, doc),
                    matching.filter((n) => {
                        for (let s = n.nextSibling; s != null; s = s.nextSibling) if (named(s, name)) return false;
                        return true;
                    }),
                    `last ${name} of each parent`
                );
                same(
                    run(`//${name}/preceding-sibling::${name}[1]`, doc),
                    matching.filter((n) => {
                        for (let s = n.nextSibling; s != null; s = s.nextSibling) if (named(s, name)) return true;
                        return false;
                    }),
                    `has a following ${name} sibling`
                );
            }
        }
    });
}

function elementsOf(parent: DomNode): DomNode[] {
    const out: DomNode[] = [];
    for (let child = parent.firstChild; child != null; child = child.nextSibling)
        if (child.nodeType === 1) out.push(child);
    return out;
}
