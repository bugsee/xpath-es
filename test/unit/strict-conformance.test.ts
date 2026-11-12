// Second adversarial review, group B: strict mode against the text of the Recommendation (W3C, 16 November 1999). Each
// expected value is the one the specification gives (the section is named); upstream mode keeps its quirks, pinned where
// they differ. No XPath engine is consulted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, loadDom } from '../harness.ts';
import { isDomNode } from '../../src/dom.ts';
import { select, XPathOrderError, XPathProgram, XPathSyntaxError } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
type Mode = 'strict' | 'upstream';

const shape = (value: unknown): string => {
    if (!Array.isArray(value)) return JSON.stringify(value);
    return `[${value
        .map((node: DomNode) => {
            const own = node.nodeType === 2 ? '@' : node.nodeType === 13 ? 'ns:' : '';
            return `${own}${node.nodeName}${node.getAttribute?.('n') ? `#${node.getAttribute('n')}` : ''}`;
        })
        .join(' ')}]`;
};
const run = (expression: string, xml: string, mode: Mode = 'strict', context?: (doc: DomNode) => DomNode): string => {
    const doc = parseXml(xml);
    return shape(select(expression, context === undefined ? doc : context(doc), false, { mode }));
};

const T = '<r x="1" n="r"><a x="5" n="a1"/></r>';
const NS = '<r xmlns:p="urn:p" xmlns:q="urn:q" n="r"><a n="a1"><b n="b1"/></a><c n="c1"><d n="d1"/></c></r>';

void test('section 2.3: * and a name select the principal node type of the axis (C-3)', () => {
    assert.equal(run('/r/@x/self::*', T), '[]');
    assert.equal(run('/r/@x/self::x', T), '[]');
    assert.equal(run('/r/@x/self::node()', T), '[@x]');
    assert.equal(run('count(//@*/ancestor-or-self::*)', T), '2');
    assert.equal(run('count(//@x/descendant-or-self::*)', T), '0');
    assert.equal(run('//@*', T), '[@x @n @x @n]');
    assert.equal(run('//a/attribute::*', T), '[@x @n]');
    assert.equal(run('count(//a/namespace::*)', T), '1');
    assert.equal(run('//a/namespace::xml', T), '[ns:xml]');
    assert.equal(run('//a/child::x', T), '[]');
    // Upstream mode (Q-TEST-1) has no principal node type: * and a name accept attributes on every axis.
    assert.equal(run('/r/@x/self::*', T, 'upstream'), '[@x]');
    assert.equal(run('count(//@x/descendant-or-self::*)', T, 'upstream'), '2');
});

void test('section 5.4: namespace nodes are ordered, all of an element are found, and node() accepts them (C-4)', () => {
    // In scope at b: xml, p, q (declared on r).
    assert.equal(run('//b/namespace::*', NS), '[ns:xml ns:p ns:q]');
    assert.equal(run('count(//namespace::*)', NS), '15');
    assert.equal(run('count(//b/namespace::*[name()="xml"])', NS), '1');
    assert.equal(run('//d/namespace::*[1]', NS), '[ns:xml]');
    assert.equal(run('//d/namespace::*[last()]', NS), '[ns:q]');
    assert.equal(run('//d/namespace::*[position()=2]', NS), '[ns:p]');
    assert.equal(run('count(/r/namespace::node())', NS), '3');
    assert.equal(run('count(//d/namespace::*/self::node())', NS), '3');
    assert.equal(run('//d/namespace::*/parent::*', NS), '[d#d1]');
    assert.equal(run('string(//b/namespace::q)', NS), '"urn:q"');
    assert.equal(run('name(//b/namespace::q)', NS), '"q"');
    assert.equal(run('namespace-uri(//b/namespace::q)', NS), '""');
    // An element comes first, then its namespace nodes, then its attributes (section 5).
    assert.equal(run('//b/@n | //b/namespace::* | //b', NS), '[b#b1 ns:xml ns:p ns:q @n]');
    assert.equal(run('//b/namespace::* | //a/namespace::*', NS), '[ns:xml ns:p ns:q ns:xml ns:p ns:q]');
    // Own declarations come before inherited ones; `xmlns=""` makes no node.
    const Y = '<r xmlns="urn:d" xmlns:p="urn:p"><a xmlns="" xmlns:p="urn:p2" xmlns:s="urn:s"><b/></a></r>';
    assert.equal(run('//b/namespace::*', Y), '[ns:xml ns:p ns:s]');
    assert.equal(run('string(//b/namespace::p)', Y), '"urn:p2"');
    // Upstream mode mirrors upstream's failure to order two inherited bindings (class 5): kept.
    assert.throws(() => run('//b/namespace::*', NS, 'upstream'), XPathOrderError);
});

void test('section 3.4: a node-set and a boolean are compared as booleans, whichever side the boolean is on (C-5)', () => {
    const doc = '<r><b/></r>';
    assert.equal(run('false() < //b', doc), 'true');
    assert.equal(run('true() > //z', doc), 'true');
    assert.equal(run('//b > false()', doc), 'true');
    assert.equal(run('true() <= //b', doc), 'true');
    assert.equal(run('true() < //b', doc), 'false');
    assert.equal(run('//z >= true()', doc), 'false');
    assert.equal(run('false() < //z', doc), 'false');
    // Upstream mode (Q-CMP-1): a boolean on the left is compared, as a number, with each node's number.
    assert.equal(run('false() < //b', '<r><b>1</b></r>', 'upstream'), 'true');
    assert.equal(run('false() < //b', doc, 'upstream'), 'false');
});

void test('section 4.1: local-name() of a node without an expanded name is empty (C-6)', () => {
    assert.equal(run('local-name(//a/text())', '<a>t</a>'), '""');
    assert.equal(run('local-name(/)', '<a/>'), '""');
    assert.equal(run('local-name(//comment())', '<a><!--c--></a>'), '""');
    assert.equal(run('local-name(//processing-instruction())', '<a><?pi d?></a>'), '"pi"');
    assert.equal(run('local-name(//a)', '<a/>'), '"a"');
    assert.equal(run('local-name(//@n)', '<a n="1"/>'), '"n"');
    assert.equal(run('local-name(//a/namespace::xml)', '<a/>'), '"xml"');
    assert.equal(run('local-name(/)', '<a/>', 'upstream'), '"#document"');
});

void test('section 3.7: white space between tokens, Digits "." Digits?, and `,` before `*` (C-7)', () => {
    const doc = '<a><b/><b/>t</a>';
    assert.equal(run('count (//b)', doc), '2');
    assert.equal(run('string-length ("ab")', doc), '2');
    assert.equal(run('true () and false ()', doc), 'false');
    assert.equal(run('count(//a/child :: b)', doc), '2');
    assert.equal(run('count(//a/text ())', doc), '1');
    assert.equal(run('count(//a/node ( ))', doc), '3');
    assert.equal(run('count(//a/processing-instruction ( "x" ))', doc), '0');
    assert.equal(run('1. + 1', doc), '2');
    assert.equal(run('.5 + 1.', doc), '1.5');
    assert.equal(run('concat("x", *)', doc), '"xt"');
    assert.equal(run('concat("x" , * )', doc), '"xt"');
    assert.equal(run('count(//b | //b)', doc), '2');
    assert.equal(run('2 * 3', doc), '6');
    assert.equal(run('count(*) * 3', doc), '3');
    // Upstream mode keeps Q-LEX-1, -3, -4.
    for (const expression of ['count (//b)', '1. + 1', 'concat("x", *)', '//a/text ()'])
        assert.throws(
            () => select(expression, parseXml(doc), false, { mode: 'upstream' }),
            XPathSyntaxError,
            expression
        );
});

void test('section 5.7 (C-8): adjacent Text and CDATASection nodes are one text node; the XML declaration is no node', () => {
    const doc = '<a>x<![CDATA[cd]]>w</a>';
    assert.equal(run('count(//a/text())', doc), '1');
    assert.equal(run('string(//a/text())', doc), '"xcdw"');
    assert.equal(run('count(//a/node())', doc), '1');
    assert.equal(run('//a/text()[1] = "xcdw"', doc), 'true');
    assert.equal(run('string-length(//a/text())', doc), '4');
    assert.equal(run('count(//a/text()[2])', doc), '0');
    assert.equal(run('count(//a/text() | //a/text())', doc), '1');
    assert.equal(run('count(//text())', doc), '1');
    assert.equal(run('count(//a/following-sibling::text())', doc), '0');
    // A comment separates two text nodes of the model.
    const split = '<a>x<![CDATA[cd]]><!--c-->w<![CDATA[z]]></a>';
    assert.equal(run('count(//a/text())', split), '2');
    assert.equal(run('string(//a/text()[1])', split), '"xcd"');
    assert.equal(run('string(//a/text()[2])', split), '"wz"');
    assert.equal(run('count(//a/node())', split), '3');
    assert.equal(run('string(//a)', split), '"xcdwz"');
    assert.equal(run('count(//a/text()[1]/following-sibling::node())', split), '2');
    // The XML declaration is not a node of the document.
    assert.equal(run('count(/processing-instruction())', '<?xml version="1.0"?><a/>'), '0');
    assert.equal(run('count(/node())', '<?xml version="1.0"?><!--c--><a/>'), '2');
    assert.equal(run('count(/processing-instruction())', '<?xml version="1.0"?><?p d?><a/>'), '1');
    // A signed NameID rewritten with a CDATA tail reads in full, so a consumer that evaluates string() sees all of it.
    const nameId = '<NameID>victim@example.test<![CDATA[.evil.test]]></NameID>';
    assert.equal(run('string(//NameID/text())', nameId), '"victim@example.test.evil.test"');
    assert.equal(run('//NameID/text() = "victim@example.test"', nameId), 'false');
    // Upstream mode (Q-TEXT, Q-STRVAL) keeps one node per DOM node.
    assert.equal(run('count(//a/text())', doc, 'upstream'), '3');
    assert.equal(run('string(//a/text())', doc, 'upstream'), '"x"');
});

void test('section 4.2 (C-9): translate() and the substring functions work on characters, not UTF-16 units', () => {
    const doc = '<a/>';
    assert.equal(run('translate("\u{1F600}", "\u{1F601}", "x")', doc), JSON.stringify('\u{1F600}'));
    assert.equal(run('translate("a\u{1F600}b", "\u{1F600}", "x")', doc), '"axb"');
    assert.equal(run('translate("a\u{1F600}b", "\u{1F600}b", "")', doc), '"a"');
    assert.equal(run('substring-before("\u{1F600}", "\\ude00")', doc).length > 0, true);
    assert.equal(run('contains("\u{1F600}", "\u{DE00}")', doc), 'false');
    assert.equal(run('substring-after("a\u{1F600}b", "\u{1F600}")', doc), '"b"');
    assert.equal(run('starts-with("\u{1F600}x", "\u{1F600}")', doc), 'true');
    assert.equal(run('string-length("\u{1F600}\u{1F600}")', doc), '2');
    assert.equal(run('substring("a\u{1F600}b", 2, 1)', doc), JSON.stringify('\u{1F600}'));
    // Upstream mode counts UTF-16 units.
    assert.equal(run('string-length("\u{1F600}")', doc, 'upstream'), '2');
    assert.equal(run('translate("abcabc", "ab", "x")', doc), '"xcxc"');
    assert.equal(run('translate("--aaa--", "abc-", "ABC")', doc), '"AAA"');
});

void test('section 2: `/` is the root of the tree that contains the context node; a fragment is such a root (C-21)', () => {
    const doc = parseXml('<r><a n="1"/></r>');
    // DOM methods through call(): the DomNode interface is read-only on purpose.
    const make = (owner: DomNode, method: string, ...args: unknown[]): DomNode => {
        const made = call(owner, method, ...args);
        assert.ok(isDomNode(made));
        return made;
    };
    const fragment = make(doc, 'createDocumentFragment');
    const holder = make(doc, 'createElement', 'z');
    const inner = make(doc, 'createElement', 'a');
    call(inner, 'setAttribute', 'n', 'f1');
    call(holder, 'appendChild', inner);
    call(fragment, 'appendChild', holder);
    const detached = make(doc, 'createElement', 'top');
    const leaf = make(doc, 'createElement', 'a');
    call(leaf, 'setAttribute', 'n', 'd1');
    call(detached, 'appendChild', leaf);
    const at = (expression: string, node: DomNode): string =>
        shape(select(expression, node, false, { mode: 'strict' }));
    assert.equal(at('//a', leaf), '[a#d1]');
    assert.equal(at('count(/)', leaf), '1');
    // The root is the detached element itself: its children are what `/*` selects.
    assert.equal(at('/*', leaf), '[a#d1]');
    assert.equal(at('.//a', fragment), '[a#f1]');
    assert.equal(at('a', fragment), '[]');
    assert.equal(at('z', fragment), '[z]');
    assert.equal(at('count(descendant-or-self::node())', fragment), '3');
    assert.equal(at('//a', inner), '[a#f1]');
    assert.equal(at('//a', parseXml('<r><a n="1"/></r>').documentElement ?? doc), '[a#1]');
    // Upstream mode (Q-ROOT) answers with the owner document.
    assert.equal(shape(select('//a', leaf, false, { mode: 'upstream' })), '[a#1]');
});

void test('section 2.3 / XML Names (C-22): the xml prefix is bound without a declaration', () => {
    const doc = '<r xml:lang="en"><a xml:lang="de"/></r>';
    assert.equal(run('count(//@xml:lang)', doc), '2');
    assert.equal(run('//a/@xml:lang', doc), '[@xml:lang]');
    assert.equal(run('count(//*[@xml:lang="de"])', doc), '1');
    assert.equal(shape(select('//@xml:lang', parseXml(doc), false, { mode: 'strict' })), '[@xml:lang @xml:lang]');
    const program = new XPathProgram('//@xml:lang', { mode: 'strict' });
    const value = program.run({ node: parseXml(doc), namespaces: () => null }).value;
    assert.ok(Array.isArray(value));
    assert.equal(value.length, 2);
});

void test('C-20: an element that only declares xmlns:ID matches [@*[local-name(.)="ID"]=...] in upstream mode, not in strict', () => {
    // The signature path of a SAML consumer looks for the element that carries the signed ID; upstream and upstream mode
    // also take an element that only declares a namespace prefix `ID` bound to that value. Strict does not (section 5.3:
    // a declaration is not an attribute). The decoy below is therefore rejected by upstream mode and ignored by strict.
    const doc = '<r><a ID="x"/><b xmlns:ID="x"/></r>';
    const find = (mode: Mode): string => run('//*[@*[local-name(.)="ID"]="x"]', doc, mode);
    assert.equal(find('strict'), '[a]');
    assert.equal(find('upstream'), '[a b]');
});
