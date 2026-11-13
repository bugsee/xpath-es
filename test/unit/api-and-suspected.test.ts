// Second adversarial review, group C: the truthiness of `single` (C-12), and the two suspected defects (S-2, S-3).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOM_NAMES, loadDom } from '../harness.ts';
import {
    select,
    select1,
    selectWithResolver,
    useNamespaces,
    XPathProgram,
    XPathResolveError
} from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

void test('C-12: any truthy `single` asks for the first node, as upstream tests it', () => {
    const doc = loadDom('xmldom08')('<r><a n="1"/><a n="2"/></r>');
    const first = (value: unknown): string => {
        if (value === null || typeof value !== 'object' || !('getAttribute' in value)) return JSON.stringify(value);
        const method: unknown = Reflect.get(value, 'getAttribute');
        return typeof method === 'function' ? String(Reflect.apply(method, value, ['n'])) : JSON.stringify(value);
    };
    for (const single of [true, 1, 'yes']) {
        assert.equal(first(Reflect.apply(select, undefined, ['//a', doc, single])), '1', String(single));
        assert.equal(
            first(Reflect.apply(selectWithResolver, undefined, ['//a', doc, null, single])),
            '1',
            String(single)
        );
        assert.equal(first(Reflect.apply(useNamespaces({}), undefined, ['//a', doc, single])), '1', String(single));
    }
    for (const single of [false, 0, '', undefined])
        assert.ok(Array.isArray(Reflect.apply(select, undefined, ['//a', doc, single])), String(single));
    assert.equal(first(select1('//a', doc)), '1');
});

void test('S-2: strict mode resolves every prefix before any node test runs, so the fast and the slow path agree on an unresolvable one', () => {
    const doc = loadDom('xmldom08')('<r><a/><b/></r>');
    for (const expression of [
        '//b/following::q:z[1]',
        '//b/following::q:z[last()]',
        '//a/preceding::q:z[1]',
        '//b/following::q:*',
        '(//a | //b)/preceding::q:z[last()]'
    ]) {
        for (const slow of [false, true]) {
            XPathProgram.forceSlowPath = slow;
            try {
                // No node follows `//b`, so no node test is ever applied: strict mode refuses the expression all the same.
                assert.throws(
                    () => select(expression, doc, false, { mode: 'strict' }),
                    XPathResolveError,
                    `${expression} (${slow ? 'slow' : 'fast'})`
                );
            } finally {
                XPathProgram.forceSlowPath = false;
            }
        }
    }
});

void test('S-3: an attribute or a namespace node has no siblings, even in a DOM that gives an Attr a parentNode', () => {
    type Loose = { -readonly [K in keyof DomNode]: DomNode[K] };
    const doc = loadDom('xmldom08')('<r x="1"><a/><b/><c/></r>');
    const element = doc.documentElement;
    assert.ok(element != null);
    const attribute = element.attributes?.item(0);
    assert.ok(attribute != null);
    // A DOM in which Attr.parentNode is the owner element (the DOM Standard says null; some implementations differ).
    const odd: Loose = {
        nodeType: 2,
        nodeName: 'x',
        name: 'x',
        value: '1',
        nodeValue: '1',
        parentNode: element,
        ownerElement: element,
        ownerDocument: doc
    };
    for (const mode of ['strict', 'upstream'] as const)
        for (const expression of [
            'following-sibling::*[last()]',
            'preceding-sibling::*[last()]',
            'following-sibling::*[1]',
            'count(following-sibling::*)',
            'count(preceding-sibling::*)',
            'following-sibling::node()'
        ]) {
            const found = select(expression, odd, false, { mode });
            assert.ok(
                found === 0 || (Array.isArray(found) && found.length === 0),
                `${mode} ${expression}: ${JSON.stringify(found)}`
            );
        }
});

void test('S-3: attribute contexts have no siblings on every DOM of the matrix, with and without a prefix test', () => {
    // jsdom 31 and happy-dom 21 need Node 22 (their undici does not load on Node 20, which the built suite also runs on).
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    for (const name of DOM_NAMES) {
        if (nodeMajor < 22 && (name === 'jsdom' || name === 'happy')) continue;
        const doc = loadDom(name)('<r x="1" y="2"><a x="3"/><b/><c y="4"/></r>');
        for (const mode of ['strict', 'upstream'] as const) {
            for (const expression of [
                'count(//@x/following-sibling::*)',
                '//@x/following-sibling::*[last()]',
                '//@y/preceding-sibling::*[1]',
                'count(//@*/preceding-sibling::node())'
            ]) {
                const found = select(expression, doc, false, { mode });
                assert.ok(found === 0 || (Array.isArray(found) && found.length === 0), `${name} ${mode} ${expression}`);
            }
            const withPrefix = useNamespaces({ p: 'urn:p' }, { mode })('//@x/following-sibling::p:*[1]', doc);
            assert.deepEqual(withPrefix, [], `${name} ${mode}`);
        }
    }
});
