// The built package, used the way a consumer uses it: `import 'xpath-es'` (ES module) and `require('xpath-es')`
// (CommonJS), both through the package's exports map. Plain JavaScript, so Node 20, 22 and 24 run it unchanged.
//
//   npm run build && node --test test/dist/smoke.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';

const require = createRequire(import.meta.url);
const esm = await import('xpath-es');
const cjs = require('xpath-es');

const XML =
    '<root xmlns:a="urn:a"><item id="1">one</item><item id="2">two</item><a:x>ns</a:x><item id="3">three</item></root>';
const parseXml = (xml) => new DOMParser().parseFromString(xml, 'text/xml');

for (const [kind, engine] of [
    ['ES module', esm],
    ['CommonJS', cjs]
]) {
    test(`${kind}: select, namespaces, string values and ordering`, () => {
        const doc = parseXml(XML);
        assert.equal(engine.select('//item', doc).length, 3);
        assert.equal(engine.select('string(//item[@id="2"])', doc), 'two');
        assert.equal(engine.select('count(//item) + 1', doc), 4);
        assert.deepEqual(
            engine.select('//item | //item[1]/following-sibling::*', doc).map((node) => node.nodeName),
            ['item', 'item', 'a:x', 'item']
        );
        const withNamespaces = engine.useNamespaces({ p: 'urn:a' });
        assert.equal(withNamespaces('//p:x', doc).length, 1);
        assert.equal(engine.select1('//item[last()]', doc).getAttribute('id'), '3');
    });

    test(`${kind}: the typed API, the limits and the typed errors`, () => {
        const doc = parseXml(XML);
        const program = new engine.XPathProgram('count(//item)');
        assert.equal(program.run({ node: doc }).value, 3);
        assert.throws(
            () => program.run({ node: doc, budget: 1 }),
            (error) =>
                error instanceof engine.XPathBudgetError &&
                error instanceof engine.XPathError &&
                error.code === 'BUDGET'
        );
        assert.throws(() => program.run({ node: doc, budget: Number.NaN }), engine.XPathContextError);
        assert.throws(() => new engine.XPathProgram('//['), engine.XPathSyntaxError);
        assert.ok(engine.DEFAULT_BUDGET > 0 && engine.DEFAULT_TIMEOUT_MS > 0);
    });
}

test('the ES module and CommonJS entries export the same names', () => {
    const names = (module) =>
        Object.keys(module)
            .filter((name) => name !== 'default' && name !== '__esModule')
            .sort();
    assert.deepEqual(names(esm), names(cjs));
    assert.ok(names(esm).length > 30);
});

test('the time limit works, and the engine still loads, where there is no performance object', () => {
    const script = `
        Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
        const engine = await import('xpath-es');
        const { DOMParser } = await import('@xmldom/xmldom');
        const doc = new DOMParser().parseFromString('<r>' + '<a>x</a>'.repeat(6000) + '</r>', 'text/xml');
        const program = new engine.XPathProgram('count(//a[count(preceding::a) >= 0])');
        try { program.run({ node: doc, budget: 0, timeoutMs: 30 }); console.log('no error'); }
        catch (error) { console.log(error instanceof engine.XPathTimeoutError ? 'timeout' : String(error)); }
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: process.cwd()
    });
    assert.equal(run.stdout.trim(), 'timeout', run.stderr);
});

// The clock gives Unix-epoch milliseconds whichever source answers: performance.timeOrigin + performance.now() where
// there is a performance object, Date.now() otherwise. A bare performance.now() (an offset such as 86423.4) is wrong.
function clockReading(performanceStub) {
    const script = `
        ${performanceStub}
        const { now } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'clock.js')).href)});
        console.log(JSON.stringify([now(), Date.now()]));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: process.cwd()
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim());
}

test('the clock returns epoch milliseconds with the real performance object', () => {
    const [reading, wall] = clockReading('');
    assert.ok(Math.abs(reading - wall) < 5000, `reading ${reading} is not near Date.now() ${wall}`);
});

test('the clock adds timeOrigin to performance.now() and does not use the bare offset', () => {
    const [reading, wall] = clockReading(
        "Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: 1794411376000, now: () => 976.5 }, configurable: true });"
    );
    assert.equal(reading, 1794411376976.5);
    assert.ok(wall > 0);
});

test('the clock falls back to Date.now() when there is no usable performance object', () => {
    for (const stub of [
        "Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });",
        "Object.defineProperty(globalThis, 'performance', { value: { now: () => 5 }, configurable: true });"
    ]) {
        const [reading, wall] = clockReading(stub);
        assert.ok(Math.abs(reading - wall) < 5000, `reading ${reading} is not near Date.now() ${wall}`);
    }
});

test('a namespace node made by one build is recognised by the other (a brand, not instanceof)', () => {
    // The bindings are declared on `a` itself, so that upstream's own ordering (kept by the node-set class) can order them.
    const doc = parseXml('<r><a xmlns:p="urn:p" xmlns:q="urn:q"/></r>');
    // Nodes made by the ES module build, put into a node-set of the CommonJS build and sorted there.
    const fromEsm = esm.select('/r/a/namespace::*', doc);
    assert.equal(fromEsm.length, 3);
    const set = new cjs.XNodeSet();
    set.addArray(fromEsm);
    set.add(doc.documentElement);
    assert.equal(set.toArray().length, 4);
    assert.equal(cjs.select('/r/a/namespace::*', doc).length, 3);
    const viaCjs = cjs.select('/r/a/namespace::* | /r/a', doc);
    assert.equal(viaCjs.length, 4);
    assert.equal(viaCjs[0].nodeName, 'a');
});

test('an error from one build is recognised by the other: isXPathError, code, and the documented instanceof caveat', () => {
    // The ES module build and the CommonJS build are two copies of the classes: `instanceof` is false across them.
    const doc = parseXml(XML);
    let fromEsm = null;
    try {
        new esm.XPathProgram('//item').run({ node: doc, budget: 1 });
    } catch (error) {
        fromEsm = error;
    }
    assert.ok(fromEsm instanceof esm.XPathBudgetError);
    assert.equal(
        fromEsm instanceof cjs.XPathBudgetError,
        false,
        'the two builds share a class: the hazard is gone, update the README'
    );
    assert.equal(cjs.isXPathError(fromEsm), true);
    assert.equal(esm.isXPathError(fromEsm), true);
    assert.equal(fromEsm.code, 'BUDGET');
    assert.equal(esm.isXPathError(new Error('x')), false);
    assert.equal(esm.isXPathError({ code: 'BUDGET' }), false);
    let timeout = null;
    try {
        new cjs.XPathProgram('count(//item[count(preceding::item) >= 0])').run({
            node: parseXml(`<r>${'<item/>'.repeat(6000)}</r>`),
            budget: 0,
            timeoutMs: 5
        });
    } catch (error) {
        timeout = error;
    }
    assert.equal(esm.isXPathError(timeout), true);
    assert.equal(timeout.code, 'TIMEOUT');
});
