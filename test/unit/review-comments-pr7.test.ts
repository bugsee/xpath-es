// Review comments on the safety changes: the function table's own properties, the cost of starts-with() and translate(),
// and the boundary of a strict prefix match.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDom } from '../harness.ts';
import { parse, select, XPathProgram } from '../support/engine.ts';

const parseXml = loadDom('xmldom08');

void test('a function that the table defines as a non-enumerable property is called and sees the current document', () => {
    // f() removes every <b> on its first call: the second <a> must see no <b>. (The set of names the table defines is
    // built from every own property, as the lookup is, so the evaluation is treated as one that runs caller code.)
    const doc = parseXml('<r><a><b/></a><a><b/></a></r>');
    const functions: Record<string, () => boolean> = {};
    let called = 0;
    Object.defineProperty(functions, 'f', {
        value: (): boolean => {
            if (called++ === 0)
                for (let a = doc.documentElement?.firstChild; a != null; a = a.nextSibling) {
                    const b = a.firstChild;
                    const remove: unknown = Reflect.get(a, 'removeChild');
                    if (b != null && typeof remove === 'function') Reflect.apply(remove, a, [b]);
                }
            return false;
        },
        enumerable: false
    });
    assert.equal(parse('//a[not(//b) or f()]').select({ node: doc, functions }).length, 1);
});

void test('strict starts-with(): compares the start of the text, and the end of the prefix must be on a character boundary', () => {
    const doc = parseXml('<r/>');
    const run = (expression: string, mode: 'strict' | 'upstream'): unknown => select(expression, doc, false, { mode });
    const pair = '\u{1F600}';
    assert.equal(run(`starts-with('${pair}x', '${pair}')`, 'strict'), true);
    assert.equal(run(`starts-with('${pair}x', '\ud83d')`, 'strict'), false);
    assert.equal(run(`starts-with('${pair}x', '\ud83d')`, 'upstream'), true);
    assert.equal(run("starts-with('abc', '')", 'strict'), true);
    assert.equal(run("starts-with('abc', 'bc')", 'strict'), false);
    // An absent prefix does not search the text: work is the same for a short and a long text.
    const short = new XPathProgram("starts-with('aaaa', 'z')", { mode: 'strict' }).run({ node: doc }).work;
    const long = new XPathProgram(`starts-with(${JSON.stringify('a'.repeat(1_000_000))}, 'z')`, { mode: 'strict' }).run(
        { node: doc }
    ).work;
    assert.ok(long - short < 100, `${short} -> ${long}`);
});

void test('translate(): the characters of `to` that no character of `from` uses are not looked at, and the mapping is unchanged', () => {
    const doc = parseXml('<r/>');
    for (const mode of ['strict', 'upstream'] as const) {
        const run = (expression: string): unknown => select(expression, doc, false, { mode });
        assert.equal(run('translate("abc", "", "xyz")'), 'abc');
        assert.equal(run('translate("abc", "a", "xyz")'), 'xbc');
        assert.equal(run('translate("abcabc", "abca", "xy")'), 'xyxy', mode);
        assert.equal(run('translate("aabb", "aab", "xyz")'), 'xxzz', mode);
        assert.equal(run('translate("abc", "abc", "")'), '', mode);
    }
    // A large `to` costs nothing when `from` is short.
    const big = 'x'.repeat(5_000_000);
    const started = performance.now();
    const result = parse('translate("abc", "", $big)').evaluateString({
        node: doc,
        variables: { big },
        mode: 'strict'
    });
    assert.equal(result, 'abc');
    assert.ok(performance.now() - started < 1000);
    assert.equal(select('translate("\u{1F600}a", "\u{1F600}", "b\u{1F601}")', doc, false, { mode: 'strict' }), 'ba');
});
