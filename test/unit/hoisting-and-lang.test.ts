// Second adversarial review, C-17: planted bugs that every gate passed. (1) A function that defaults to the context node
// (string(), name(), normalize-space(), ...) called with no argument inside a predicate that also holds an absolute path must
// not be taken for a document-only subexpression (it would be evaluated once and the answer reused for every node: a wrong
// node-set, silently). (2) strict lang() matches a language or a sublanguage, never a longer name that merely starts with it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { select } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
// The text of an element, by walking the DOM (no XPath engine, and DomNode has no textContent).
function stringValue(node: DomNode): string {
    let text = '';
    for (let child = node.firstChild; child != null; child = child.nextSibling)
        text += child.nodeType === 3 ? (child.nodeValue ?? '') : stringValue(child);
    return text;
}
const names = (expression: string, xml: string, mode: 'strict' | 'upstream'): string => {
    const found = select(expression, parseXml(xml), false, { mode });
    assert.ok(Array.isArray(found), expression);
    return found.map((node: DomNode) => `${node.nodeName}:${stringValue(node)}`).join(' | ');
};

const SAML =
    '<r><Assertion><NameID>evil</NameID></Assertion><Assertion><NameID>good</NameID></Assertion><want>good</want></r>';

void test('a zero-argument function that reads the context node is evaluated per node, next to an absolute path (C-17, P5/P5b)', () => {
    for (const mode of ['strict', 'upstream'] as const) {
        assert.equal(names('//NameID[string() = string(//want)]', SAML, mode), 'NameID:good', mode);
        assert.equal(
            names("//*[local-name() = 'NameID' and string(.) = string(//want)]", SAML, mode),
            'NameID:good',
            mode
        );
        assert.equal(names("//Assertion[normalize-space() = concat(//want, '')]", SAML, mode), 'Assertion:good', mode);
        assert.equal(names('//*[name() = name(//want)]', SAML, mode), 'want:good', mode);
        assert.equal(
            names('//*[namespace-uri() = namespace-uri(//want)][name() = name(//want)]', SAML, mode),
            'want:good',
            mode
        );
        assert.equal(
            names('//*[string-length() = string-length(//want) and name() != name(//want)]', SAML, mode),
            'Assertion:evil | NameID:evil | Assertion:good | NameID:good',
            mode
        );
        const numbers = '<r><n>1</n><n>2</n><n>3</n><pick>2</pick></r>';
        assert.equal(names('//n[number() = number(//pick)]', numbers, mode), 'n:2', mode);
        assert.equal(names('//n[. = //pick]', numbers, mode), 'n:2', mode);
        assert.equal(names('//n[string() = //pick]', numbers, mode), 'n:2', mode);
        // The same functions given an argument are a different thing: document-only, and still right.
        assert.equal(names('//n[number(//pick) = 2][. = 3]', numbers, mode), 'n:3', mode);
    }
});

void test('strict lang(): equal ignoring case, or equal up to a `-`; never a longer name (C-17, P6)', () => {
    const xml =
        '<r><a xml:lang="en-US"/><b xml:lang="eng"/><c xml:lang="EN"/><d xml:lang="e"/><f xml:lang="en"/><g xml:lang="en-"/></r>';
    const matching = (mode: 'strict' | 'upstream', wanted: string): string => {
        const found = select(`//*[lang('${wanted}')]`, parseXml(xml), false, { mode });
        assert.ok(Array.isArray(found));
        return found.map((node: DomNode) => node.nodeName).join(' ');
    };
    // en-US (a sublanguage), EN (case), en (equal), en- (an empty subtag, as `-` follows) match; eng and e do not.
    assert.equal(matching('strict', 'en'), 'a c f g');
    assert.equal(matching('strict', 'EN'), 'a c f g');
    assert.equal(matching('strict', 'en-us'), 'a');
    assert.equal(matching('strict', 'e'), 'd');
    assert.equal(matching('strict', 'eng'), 'b');
    // Upstream mode: case-sensitive.
    assert.equal(matching('upstream', 'en'), 'a f g');
    assert.equal(matching('upstream', 'EN'), 'c');
    // And inherited by the descendants.
    const inherited = select("//*[lang('en')]", parseXml('<r xml:lang="eng"><a/></r>'), false, { mode: 'strict' });
    assert.deepEqual(inherited, []);
});
