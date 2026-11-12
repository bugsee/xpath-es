// Upstream mode (the default) and strict mode (XPath 1.0 as the Recommendation specifies it), pinned side by side.
// Every deviation the engine inherits from upstream xpath 0.0.36 is in the table below with what each mode answers; the
// README lists them under "Known deviations from XPath 1.0 inherited from upstream (default mode)". The strict answers
// are derived from the text of the Recommendation (16 November 1999), never from upstream.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { select, XPathError } from '../support/engine.ts';
import type { DomNode } from '../../src/dom.ts';

const parseXml = loadDom('xmldom08');

function show(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value
            .map((node: DomNode) => {
                if (node.nodeType === 2) return `@${String(node.nodeName)}`;
                if (node.nodeType === 13) return `ns:${String(node.nodeName)}`;
                if (node.nodeType === 3) return `"${String(node.nodeValue)}"`;
                const id = node.getAttribute?.('id');
                return `<${node.nodeName}${id != null && id !== '' ? `#${id}` : ''}>`;
            })
            .join(',')}]`;
    }
    return `${typeof value}:${String(value)}`;
}

function answer(mode: 'upstream' | 'strict', expression: string, xml: string): string {
    try {
        return show(select(expression, parseXml(xml), false, { mode }));
    } catch (error) {
        return error instanceof XPathError ? `${error.code}` : `OTHER ${String(error)}`;
    }
}

const DOC =
    '<r xmlns:p="urn:p"><a id="1"><b id="x"/><c/></a><a id="1"><b id="y"/></a><!--c--><?pi d?>t1<f xml:lang="de-AT"><g/></f><e/></r>';

interface Case {
    readonly name: string;
    readonly expression: string;
    readonly xml?: string;
    readonly upstream: string;
    readonly strict: string;
}

const CASES: readonly Case[] = [
    // D1: following:: (section 2.2: not the descendants, but the following siblings and their subtrees)
    {
        name: 'following of an element with children',
        expression: '/r/a[1]/following::e',
        upstream: '[]',
        strict: '[<e>]'
    },
    { name: 'count of following', expression: 'count(/r/a[1]/following::*)', upstream: 'number:2', strict: 'number:5' },
    {
        name: 'following of an element',
        expression: '//a[1]/following::*',
        upstream: '[<b#x>,<c>]',
        strict: '[<a#1>,<b#y>,<f>,<g>,<e>]'
    },
    // D2: preceding:: (section 2.2: ancestors excluded)
    {
        name: 'preceding excludes ancestors',
        expression: '//c/preceding::*',
        upstream: '[<r>,<a#1>,<b#x>]',
        strict: '[<b#x>]'
    },
    {
        name: 'preceding of the last element',
        expression: 'count(//e/preceding::*)',
        upstream: 'number:8',
        strict: 'number:7'
    },
    // D3: id() (section 4.1: tokens of the string-value of each node; one element per token)
    { name: 'id of attributes', expression: 'count(id(//@id))', upstream: 'number:1', strict: 'number:3' },
    { name: 'id of a string', expression: 'id("x y")', upstream: '[<b#x>,<b#y>]', strict: '[<b#x>,<b#y>]' },
    {
        name: 'id with a duplicate ID returns the first element',
        expression: 'count(id("1"))',
        upstream: 'number:1',
        strict: 'number:1'
    },
    // D4: name tests are case-sensitive in an XML document
    { name: 'name test case', expression: '//e/self::E', upstream: '[<e>]', strict: '[]' },
    // D5: the attribute axis has no namespace declarations (section 5.3)
    { name: 'attribute axis and xmlns', expression: 'count(/r/@*)', upstream: 'number:1', strict: 'number:0' },
    { name: 'attributes of the document', expression: 'count(//@*)', upstream: 'number:6', strict: 'number:5' },
    // D6: lang() climbs to ancestors, ignoring case (section 4.3)
    { name: 'lang inherited', expression: '//g[lang("de")]', upstream: '[]', strict: '[<g>]' },
    {
        name: 'lang ignores case and takes a sublanguage',
        expression: '//g[lang("DE-at")]',
        upstream: '[]',
        strict: '[<g>]'
    },
    // D7/D8: string -> number (section 4.4)
    { name: 'number of an empty node-set', expression: 'number(//zz)', upstream: 'number:0', strict: 'number:NaN' },
    { name: 'number of an empty element', expression: 'number(//e)', upstream: 'number:0', strict: 'number:NaN' },
    { name: 'number of "1."', expression: 'number("1.")', upstream: 'number:NaN', strict: 'number:1' },
    // D9: number -> string (section 4.2): no exponent, the sign kept
    {
        name: 'string of a tiny negative',
        expression: 'string(-0.00000001)',
        upstream: 'string:0.0000000-1',
        strict: 'string:-0.00000001'
    },
    {
        name: 'string of a tiny positive',
        expression: 'string(0.00000001)',
        upstream: 'string:0.00000001',
        strict: 'string:0.00000001'
    },
    // D10: substring (section 4.2)
    {
        name: 'substring with NaN start',
        expression: 'substring("12345", 0 div 0)',
        upstream: 'string:12345',
        strict: 'string:'
    },
    {
        name: 'substring with a negative length',
        expression: 'substring("12345", 3, -1)',
        upstream: 'string:2',
        strict: 'string:'
    },
    {
        name: 'substring of the specification',
        expression: 'substring("12345", 1.5, 2.5)',
        upstream: 'string:234',
        strict: 'string:234'
    },
    // D11: characters, not UTF-16 units
    {
        name: 'string-length of an astral character',
        expression: 'string-length("😀x")',
        upstream: 'number:3',
        strict: 'number:2'
    },
    {
        name: 'substring after an astral character',
        expression: 'string-length(substring("😀x", 2))',
        upstream: 'number:2',
        strict: 'number:1'
    },
    // D12: the namespace axis (section 5.4)
    {
        name: 'a namespace node is held once',
        expression: 'count(/r/namespace::p | /r/namespace::p)',
        upstream: 'number:2',
        strict: 'number:1'
    },
    {
        name: 'the parent of a namespace node',
        expression: 'name(/r/namespace::p/..)',
        upstream: 'string:',
        strict: 'string:r'
    },
    {
        name: 'ancestors of a namespace node',
        expression: 'count(/r/namespace::p/ancestor::*)',
        upstream: 'number:0',
        strict: 'number:1'
    },
    {
        name: 'an xmlns="" undeclaration makes no node',
        expression: 'count(/*/*/namespace::*)',
        xml: '<r xmlns="urn:d"><e xmlns=""/></r>',
        upstream: 'number:2',
        strict: 'number:1'
    },
    // D13: syntax
    { name: 'an unknown axis', expression: 'foo::bar', upstream: '[]', strict: 'SYNTAX' },
    // D14: an unresolvable prefix is an error whether or not a node is tested
    {
        name: 'a prefix on an empty axis',
        expression: '//e[count(following-sibling::d:z)=0]',
        upstream: '[<e>]',
        strict: 'RESOLVE'
    },
    // agreement
    { name: 'round half up', expression: 'round(-2.5)', upstream: 'number:-2', strict: 'number:-2' },
    { name: 'translate', expression: 'translate("--aaa--","abc-","ABC")', upstream: 'string:AAA', strict: 'string:AAA' }
];

for (const item of CASES) {
    void test(`${item.name}: ${item.expression}`, () => {
        const xml = item.xml ?? DOC;
        assert.equal(answer('upstream', item.expression, xml), item.upstream, 'upstream mode');
        assert.equal(answer('strict', item.expression, xml), item.strict, 'strict mode');
    });
}

void test('a NUL character is the end of the expression in upstream mode and a syntax error in strict mode', () => {
    assert.equal(answer('upstream', '1 + 2\u0000 garbage', DOC), 'number:3');
    assert.equal(answer('strict', '1 + 2\u0000 garbage', DOC), 'SYNTAX');
});

void test('the default mode is upstream', () => {
    assert.equal(show(select('count(/r/a[1]/following::*)', parseXml(DOC))), 'number:2');
});
