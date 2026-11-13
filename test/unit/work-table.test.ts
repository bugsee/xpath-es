// The work an evaluation is charged, for fixed expressions on a fixed document, exactly. A missing or an extra charge (a walk
// that is not counted, a string function that does not charge for its input) changes a number here, which no limit test
// notices: the limits stop only the evaluations that are expensive enough to reach them. If a charge is changed on purpose, update
// the table deliberately, after reading what moved. Both modes: they differ where the semantics do (id(), lang(),
// preceding::, string-length() and substring() count characters in strict mode).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { XPathProgram } from '../support/engine.ts';

const parseXml = loadDom('xmldom08');
const LONG = 'abcdefghij'.repeat(200);
const XML =
    `<r xml:lang="en-US"><a id="i1" x="1"><b>${LONG}</b><b>two</b><c/></a>` +
    '<a id="i2" x="2" xml:lang="de"><b>three</b><c><d/></c></a><e/></r>';

/** expression, work in strict mode, work in upstream mode */
const TABLE: readonly (readonly [string, number, number])[] = [
    ['//a//b', 25, 25],
    ['//b', 14, 14],
    ['/r/a/b', 13, 13],
    ['//a[@x="2"]', 27, 27],
    ['//a[b][c]', 32, 32],
    ["contains(string(/r/a/b), 'zzz')", 267, 267],
    ["//b[contains(., 'two')]", 279, 279],
    ['string-length(string(/r/a/b))', 392, 142],
    ['normalize-space(string(/r/a/b))', 267, 267],
    ["translate(string(/r/a/b), 'abc', 'xyz')", 267, 267],
    ['substring(string(/r/a/b), 5, 100)', 392, 142],
    ["substring-before(string(/r/a/b), 'j')", 267, 267],
    ["starts-with(string(/r/a/b), 'abc')", 142, 142],
    ['count(//c/ancestor::*)', 21, 21],
    ['//c/following-sibling::*', 16, 16],
    ['//d/preceding::*', 31, 28],
    ['//a[1]/following::*', 46, 45],
    ["id('i1 i2')", 33, 48],
    ["//*[lang('en')]", 50, 44],
    ['//a | //c', 46, 46],
    ['count(//*) + count(//@*)', 37, 37],
    ['//a[position() = last()]', 49, 49],
    ["concat(string(/r/a/b), 'x')", 392, 392],
    ['sum(//@x)', 23, 23]
];

// The one-pass axes of strict mode (src/ranked.ts) on a small tree where the context nodes end their ancestors: the work pins
// how often the stack of ancestors is pushed (an ancestor that is dropped and found again costs a push each time).
const TREE = '<r><a id="a1"><b id="b1"/><c id="c1"/></a><a id="a2" x="1"><b id="b2"/></a><b id="b3"/></r>';
const RANKED: readonly (readonly [string, number, number])[] = [
    ['//b/preceding::*[1]', 68, 25],
    ['//b/preceding::*[last()]', 66, 17],
    ['//b/following::*[last()]', 39, 26],
    ['//b/following::*[2]', 39, 19],
    ['//c/preceding::*[1]', 13, 10]
];

for (const [mode, column] of [
    ['strict', 1],
    ['upstream', 2]
] as const)
    void test(`work table (${mode} mode): every charge is accounted for`, () => {
        const wrong: string[] = [];
        for (const row of TABLE) {
            const expected = row[column];
            const { work } = new XPathProgram(row[0], { mode }).run({ node: parseXml(XML) });
            if (work !== expected) wrong.push(`${row[0]}: charged ${work}, expected ${expected}`);
        }
        for (const row of RANKED) {
            const expected = row[column];
            const { work } = new XPathProgram(row[0], { mode }).run({ node: parseXml(TREE) });
            if (work !== expected) wrong.push(`${row[0]} on the small tree: charged ${work}, expected ${expected}`);
        }
        assert.deepEqual(wrong, []);
    });
