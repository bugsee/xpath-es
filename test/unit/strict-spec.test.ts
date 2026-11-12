// Strict mode against the text of the XPath 1.0 Recommendation (W3C, 16 November 1999): the location-path examples of
// sections 2.2, 2.4 and 2.5, the data model of section 5, and the function library of section 4, each with the answer
// the specification gives. Upstream xpath is not consulted: this is the oracle for strict mode.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { isDomNode } from '../support/dom.ts';
import { select } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');
const DOC = parseXml(
    '<doc id="d" lang="x">' +
        '<chapter id="c1"><title>T1</title><para id="p1">one</para><para id="p2">two</para><para type="warning" id="p3">three</para></chapter>' +
        '<chapter id="c2"><title>Introduction</title><section id="s1"><para id="p4">four</para></section></chapter>' +
        '<appendix id="a1"><para id="p5">five</para></appendix>' +
        '</doc>'
);

const run = (expression: string, context: DomNode = DOC): unknown =>
    select(expression, context, false, { mode: 'strict' });
const ids = (expression: string, context: DomNode = DOC): string => {
    const found = run(expression, context);
    assert.ok(Array.isArray(found), `${expression} is not a node-set`);
    return found.map((node: DomNode) => node.getAttribute?.('id') || String(node.nodeName)).join(' ');
};
const first = (expression: string): DomNode => {
    const found: unknown = run(expression);
    assert.ok(Array.isArray(found));
    const node: unknown = found[0];
    assert.ok(isDomNode(node));
    return node;
};

void test('section 2.5: abbreviated location paths from the document element', () => {
    const doc = first('/doc');
    assert.equal(ids('chapter', doc), 'c1 c2');
    assert.equal(ids('*', doc), 'c1 c2 a1');
    assert.equal(ids('chapter/para', doc), 'p1 p2 p3');
    assert.equal(ids('*/para', doc), 'p1 p2 p3 p5');
    assert.equal(ids('chapter//para', doc), 'p1 p2 p3 p4');
    assert.equal(ids('//para', doc), 'p1 p2 p3 p4 p5');
    assert.equal(ids('.//para', doc), 'p1 p2 p3 p4 p5');
    assert.equal(ids('chapter[2]', doc), 'c2');
    assert.equal(ids('chapter[last()]', doc), 'c2');
    assert.equal(ids('chapter[title="Introduction"]', doc), 'c2');
    assert.equal(ids('chapter[title]', doc), 'c1 c2');
    assert.equal(ids('*[self::chapter or self::appendix]', doc), 'c1 c2 a1');
    assert.equal(ids('*[self::chapter or self::appendix][position()=last()]', doc), 'a1');
    assert.equal(ids('/doc/chapter[2]/section[1]', doc), 's1');
    assert.equal(ids('..', first('//section')), 'c2');
    assert.equal(ids('.', doc), 'd');
});

void test('section 2.4: predicates and the position of a reverse axis', () => {
    assert.equal(ids('//para[1]'), 'p1 p4 p5');
    assert.equal(ids('//para[last()]'), 'p3 p4 p5');
    assert.equal(ids('//chapter/para[position()>1]'), 'p2 p3');
    assert.equal(ids('//chapter/para[@type="warning"]'), 'p3');
    assert.equal(ids('//chapter/para[@type="warning"][1]'), 'p3');
    assert.equal(ids('//chapter/para[3][@type="warning"]'), 'p3');
    assert.equal(ids('//chapter/para[1][@type="warning"]'), '');
    // On a reverse axis the position counts from the context node outwards (section 2.4).
    const last = first('//para[@id="p3"]');
    assert.equal(ids('preceding-sibling::para[1]', last), 'p2');
    assert.equal(ids('preceding-sibling::*[1]', last), 'p2');
    assert.equal(ids('ancestor::*[1]', last), 'c1');
    assert.equal(ids('ancestor::*[2]', last), 'd');
});

void test('section 2.2: the axes', () => {
    const chapter = first('//chapter[@id="c1"]');
    assert.equal(ids('descendant::para', chapter), 'p1 p2 p3');
    assert.equal(ids('descendant-or-self::*', chapter), 'c1 title p1 p2 p3');
    assert.equal(ids('following-sibling::chapter[position()=1]', chapter), 'c2');
    assert.equal(ids('following-sibling::*', chapter), 'c2 a1');
    assert.equal(ids('preceding-sibling::chapter', first('//chapter[@id="c2"]')), 'c1');
    // following: not the descendants of the context node, but its following siblings and their subtrees.
    assert.equal(ids('following::para', chapter), 'p4 p5');
    assert.equal(ids('following::*', chapter), 'c2 title s1 p4 a1 p5');
    // The same through the positional (per context node) code path.
    assert.equal(ids('following::para[1]', chapter), 'p4');
    assert.equal(ids('following::*[2]', chapter), 'title');
    assert.equal(ids('following::*[last()]', chapter), 'p5');
    assert.equal(ids('following::*[position() <= 2]', chapter), 'c2 title');
    // For an attribute node the element's children follow it, then what follows the element.
    const typeAttribute = first('//para[@id="p3"]/@type');
    assert.equal(ids('following::*[1]', typeAttribute), 'c2');
    assert.equal(ids('following::para[1]', first('//chapter[@id="c2"]/@id')), 'p4');
    // preceding: not the ancestors.
    assert.equal(ids('preceding::*', first('//section')), 'c1 title p1 p2 p3 title');
    assert.equal(ids('preceding::para', first('//appendix')), 'p1 p2 p3 p4');
    // the five axes of one node partition the document with self (section 2.2).
    const section = first('//section');
    const count = (axis: string): number => {
        const found = run(`${axis}::node()`, section);
        assert.ok(Array.isArray(found));
        return found.length;
    };
    const total = run('count(//node())+1');
    assert.equal(count('ancestor') + count('descendant') + count('following') + count('preceding') + 1, total);
});

void test('section 5.3: attributes: namespace declarations are not attributes', () => {
    const declared = parseXml('<r xmlns:p="urn:p" xmlns="urn:d" a="1"><e/></r>');
    assert.equal(select('count(/*/@*)', declared, false, { mode: 'strict' }), 1);
    assert.equal(select('count(/*/attribute::*)', declared, false, { mode: 'strict' }), 1);
});

void test('section 5.4: namespace nodes', () => {
    const nested = parseXml(
        '<r xmlns:p="urn:p" xmlns:q="urn:q"><e xmlns:p="urn:other" xmlns="urn:d"><f xmlns=""/></e></r>'
    );
    const count = (expression: string): unknown => select(expression, nested, false, { mode: 'strict' });
    // xml, p, q on r; xml, p (redeclared), q, the default namespace on e; only xml, p, q on f (xmlns="" undeclares).
    assert.equal(count('count(/*/namespace::*)'), 3);
    assert.equal(count('count(/*/*/namespace::*)'), 4);
    assert.equal(count('count(/*/*/*/namespace::*)'), 3);
    // The nearest declaration of a prefix wins.
    assert.equal(count('string(/*/*/namespace::p)'), 'urn:other');
    // The expanded name of a namespace node is its prefix; the parent of a namespace node is its element.
    assert.equal(count('name(/*/namespace::p)'), 'p');
    assert.equal(count('name(/*/namespace::p/..)'), 'r');
    // A node-set holds a node once however it is reached.
    assert.equal(count('count(/*/namespace::p | /*/*/../namespace::p | //r/namespace::p)'), 1);
});

void test('section 4.1: id()', () => {
    assert.equal(ids('id("p1")'), 'p1');
    assert.equal(ids('id("p1 p3 missing")'), 'p1 p3');
    assert.equal(ids('id("p1")/following-sibling::para'), 'p2 p3');
    // The argument node-set: the tokens of each node's string-value.
    const holder = parseXml('<r><ref>c1 a1</ref><ref>p5</ref><e id="c1"/><e id="a1"/><e id="p5"/></r>');
    const found = select('id(/r/ref)', holder, false, { mode: 'strict' });
    assert.ok(Array.isArray(found));
    assert.equal(found.length, 3);
});

void test('section 4.2: string functions', () => {
    const s = (expression: string): unknown => run(expression);
    assert.equal(s('string(12)'), '12');
    assert.equal(s('string(true())'), 'true');
    assert.equal(s('concat("a","b","c")'), 'abc');
    assert.equal(s('starts-with("abc","ab")'), true);
    assert.equal(s('contains("abc","bc")'), true);
    assert.equal(s('substring-before("1999/04/01","/")'), '1999');
    assert.equal(s('substring-after("1999/04/01","/")'), '04/01');
    assert.equal(s('substring-after("1999/04/01","19")'), '99/04/01');
    assert.equal(s('substring("12345",1.5,2.5)'), '234');
    assert.equal(s('substring("12345",0,3)'), '12');
    assert.equal(s('substring("12345",0 div 0,3)'), '');
    assert.equal(s('substring("12345",1,0 div 0)'), '');
    assert.equal(s('substring("12345",-42,1 div 0)'), '12345');
    assert.equal(s('substring("12345",-1 div 0,1 div 0)'), '');
    assert.equal(s('substring("12345",2)'), '2345');
    assert.equal(s('string-length("abc")'), 3);
    assert.equal(s('normalize-space("  a   b  ")'), 'a b');
    assert.equal(s('translate("bar","abc","ABC")'), 'BAr');
    assert.equal(s('translate("--aaa--","abc-","ABC")'), 'AAA');
    // Only the first occurrence of a character in the second argument counts.
    assert.equal(s('translate("aab","aa","xy")'), 'xxb');
});

void test('section 4.2: a number as a string: no exponent, the sign kept, both zeros 0', () => {
    const s = (expression: string): unknown => run(expression);
    assert.equal(s('string(0 div 0)'), 'NaN');
    assert.equal(s('string(1 div 0)'), 'Infinity');
    assert.equal(s('string(-1 div 0)'), '-Infinity');
    assert.equal(s('string(0)'), '0');
    assert.equal(s('string(-0)'), '0');
    assert.equal(s('string(-1 div (1 div 0))'), '0');
    assert.equal(s('string(-42)'), '-42');
    assert.equal(s('string(1.5)'), '1.5');
    assert.equal(s('string(-0.00000001)'), '-0.00000001');
    assert.equal(s('string(0.0000001)'), '0.0000001');
    assert.equal(s('string(123456789012345678901234567890)'), '123456789012345680000000000000');
    assert.equal(s('string(1 div 3)'), '0.3333333333333333');
});

void test('section 4.4: a string as a number', () => {
    const n = (expression: string): number => {
        const value = run(expression);
        assert.equal(typeof value, 'number');
        return Number(value);
    };
    assert.equal(n('number("  12  ")'), 12);
    assert.equal(n('number("-1.5")'), -1.5);
    assert.equal(n('number(".5")'), 0.5);
    assert.equal(n('number("5.")'), 5);
    assert.ok(Number.isNaN(n('number("")')));
    assert.ok(Number.isNaN(n('number(".")')));
    assert.ok(Number.isNaN(n('number("+1")')));
    assert.ok(Number.isNaN(n('number("1e3")')));
    assert.ok(Number.isNaN(n('number("0x10")')));
    assert.ok(Number.isNaN(n('number("Infinity")')));
    assert.ok(Number.isNaN(n('number("abc")')));
    assert.ok(Number.isNaN(n('number(//nothing)')));
    assert.equal(n('number(true())'), 1);
    assert.equal(n('number(false())'), 0);
    assert.equal(n('number(/doc/chapter[1]/para[1]/@id = "p1")'), 1);
    assert.equal(n('sum(//nothing)'), 0);
});

void test('section 4.4: numeric functions', () => {
    const n = (expression: string): number => Number(run(expression));
    assert.equal(n('floor(-1.5)'), -2);
    assert.equal(n('ceiling(-1.5)'), -1);
    assert.equal(n('round(1.5)'), 2);
    assert.equal(n('round(2.5)'), 3);
    assert.equal(n('round(-2.5)'), -2);
    assert.ok(Object.is(n('round(-0.4)'), -0));
    assert.ok(Number.isNaN(n('round(0 div 0)')));
    assert.equal(n('round(1 div 0)'), Infinity);
    assert.equal(n('sum(//para/@id[false()])'), 0);
    assert.equal(n('5 mod 2'), 1);
    assert.equal(n('5 mod -2'), 1);
    assert.equal(n('-5 mod 2'), -1);
    assert.equal(n('5 div 2'), 2.5);
});

void test('section 4.3: lang()', () => {
    const marked = parseXml(
        '<doc><p id="a" xml:lang="en"/><div xml:lang="en"><p id="b"/></div><p id="c" xml:lang="EN"/><p id="d" xml:lang="en-us"/><p id="e" xml:lang="de"/><p id="f"/></doc>'
    );
    const found = select("//p[lang('en')]", marked, false, { mode: 'strict' });
    assert.ok(Array.isArray(found));
    assert.deepEqual(
        found.map((node: DomNode) => node.getAttribute?.('id')),
        ['a', 'b', 'c', 'd']
    );
});

void test('section 3.4: comparisons of node-sets', () => {
    assert.equal(run('//para/@id = "p3"'), true);
    assert.equal(run('//para/@id != "p3"'), true);
    assert.equal(run('//nothing = "x"'), false);
    assert.equal(run('//nothing != "x"'), false);
    assert.equal(run('//chapter/title = //section/@id'), false);
    assert.equal(run('count(//para) = 5'), true);
    assert.equal(run('//para = true()'), true);
    assert.equal(run('//nothing = false()'), true);
});

void test('section 3.1 and 3.2: the QName of an expression must resolve, whether or not a node is tested', () => {
    assert.throws(() => select('//nothing/q:x', DOC, false, { mode: 'strict' }));
    assert.throws(() => select('count(//nothing[q:x])', DOC, false, { mode: 'strict' }));
});

void test('section 3.7 (lexical structure): an unknown axis name and a NUL are syntax errors', () => {
    assert.throws(() => select('sideways::para', DOC, false, { mode: 'strict' }));
    assert.throws(() => select('para\u0000', DOC, false, { mode: 'strict' }));
});
