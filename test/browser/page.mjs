// Runs in the browser: the built ES module (dist/index.js, served as is) against documents from the browser's own
// DOMParser. Each check records { name, ok, detail } in window.__xpathEs; test/browser/run.mjs reads it.

import * as xpath from '/dist/index.js';

const results = [];
const check = (name, run) => {
    try {
        run();
        results.push({ name, ok: true, detail: '' });
    } catch (error) {
        results.push({ name, ok: false, detail: String(error?.stack ?? error) });
    }
};
const equal = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
const describe = (value) =>
    Array.isArray(value) ? `[${value.map((node) => node.nodeName).join(',')}]` : String(value);

const XML =
    '<root xmlns:a="urn:a"><item id="1">one</item><item id="2">two</item><a:x>ns</a:x><item id="3">three</item></root>';
const HTML = '<!doctype html><body><p id="a">x</p><P>y</P><div class="d"><span>s</span><span>t</span></div></body>';

check('the engine loads and exports its API', () => {
    equal(typeof xpath.select, 'function');
    equal(typeof xpath.XPathProgram, 'function');
});

check('select on a DOMParser document', () => {
    const doc = parseXml(XML);
    equal(xpath.select('//item', doc).length, 3);
    equal(xpath.select('string(//item[@id="2"])', doc), 'two');
    equal(xpath.select('count(//item) + 1', doc), 4);
    equal(
        xpath.select('//item | //item[1]/following-sibling::*', doc).map((node) => node.nodeName),
        ['item', 'item', 'a:x', 'item']
    );
});

check('namespaces', () => {
    const doc = parseXml(XML);
    equal(xpath.useNamespaces({ p: 'urn:a' })('//p:x', doc).length, 1);
    equal(xpath.select('//*[local-name() = "x" and namespace-uri() = "urn:a"]', doc).length, 1);
    // The typed API resolves a prefix from the document itself.
    equal(new xpath.XPathProgram('//a:x').run({ node: doc }).value.size, 1);
    // A prefix with no resolver is an error, as in upstream.
    let unresolved = null;
    try {
        xpath.select('//a:x', doc);
    } catch (error) {
        unresolved = error;
    }
    if (!(unresolved instanceof xpath.XPathError)) throw new Error('an unresolved prefix did not throw an XPathError');
});

check('the typed API: a program evaluated twice, and the typed errors', () => {
    const doc = parseXml(XML);
    const program = new xpath.XPathProgram('count(//item)');
    equal(program.run({ node: doc }).value, 3);
    equal(program.run({ node: doc }).value, 3);
    let syntax = null;
    try {
        new xpath.XPathProgram('//[');
    } catch (error) {
        syntax = error;
    }
    if (!(syntax instanceof xpath.XPathSyntaxError)) throw new Error('no XPathSyntaxError');
});

check('the work budget stops an evaluation with XPathBudgetError', () => {
    const doc = parseXml(XML);
    let caught = null;
    try {
        new xpath.XPathProgram('count(//item)').run({ node: doc, budget: 1 });
    } catch (error) {
        caught = error;
    }
    if (!(caught instanceof xpath.XPathBudgetError)) throw new Error(`got ${caught}`);
    equal(caught.code, 'BUDGET');
});

check('the time limit (performance.now in the browser) stops an evaluation with XPathTimeoutError', () => {
    const doc = parseXml(`<r>${'<a>x</a>'.repeat(8000)}</r>`);
    const started = performance.now();
    let caught = null;
    try {
        // string(/) walks the whole document for every candidate: quadratic work only the clock can stop.
        new xpath.XPathProgram('count(//a[contains(string(/), "y")])').run({ node: doc, budget: 0, timeoutMs: 20 });
    } catch (error) {
        caught = error;
    }
    if (!(caught instanceof xpath.XPathTimeoutError)) throw new Error(`got ${caught}`);
    if (performance.now() - started > 5000) throw new Error('the limit took far too long to fire');
});

check('an HTML document', () => {
    const doc = new DOMParser().parseFromString(HTML, 'text/html');
    equal(xpath.select('//*[local-name() = "p"]', doc).length, 2);
    // Name tests in the XHTML namespace need the isHtml option, as in upstream.
    equal(xpath.parse('//p').select({ node: doc, isHtml: true }).length, 2);
    equal(
        xpath
            .parse('//span')
            .select({ node: doc, isHtml: true })
            .map((node) => node.textContent),
        ['s', 't']
    );
});

// The same expressions through upstream xpath 0.0.36 (served from the oracle devDependency) and through the engine, on
// the same browser documents: identical nodes in identical order, identical scalars, an error in both or in neither.
const upstream = {};
new Function('exports', await (await fetch('/upstream/xpath.js')).text())(upstream);
const EXPRESSIONS = [
    '//*',
    '//p',
    '//*[@id]',
    '//div/span',
    '//span/ancestor::*',
    '//p | //span',
    '//span | //p | //div',
    '//body/following::*',
    '//span/preceding::*',
    '//*[position() = 2]',
    '//span[last()]',
    '//*[contains(local-name(), "iv")]',
    'count(//*)',
    'string(//span)',
    'normalize-space(string(//div))',
    'sum(//item/@id)',
    '//item[@id > 1]',
    '//item[2]/following-sibling::*',
    '//item/..',
    'name(/*)',
    '1 div 0',
    '//[',
    'foo()'
];
const DOCUMENTS = { html: new DOMParser().parseFromString(HTML, 'text/html'), xml: parseXml(XML) };
for (const [label, doc] of Object.entries(DOCUMENTS)) {
    check(`engine equals upstream xpath 0.0.36 in this browser, on the ${label} document`, () => {
        const outcome = (engine, expression) => {
            try {
                return { value: engine.select(expression, doc) };
            } catch (error) {
                return { error: String(error) };
            }
        };
        for (const expression of EXPRESSIONS) {
            const expected = outcome(upstream, expression);
            const actual = outcome(xpath, expression);
            if ('error' in expected || 'error' in actual) {
                if ('error' in expected !== 'error' in actual)
                    throw new Error(
                        `${expression}: upstream ${JSON.stringify(expected)}, engine ${JSON.stringify(actual)}`
                    );
                continue;
            }
            const left = expected.value;
            const right = actual.value;
            const same = Array.isArray(left)
                ? Array.isArray(right) && left.length === right.length && left.every((node, i) => node === right[i])
                : Object.is(left, right);
            if (!same) throw new Error(`${expression}: upstream ${describe(left)}, engine ${describe(right)}`);
        }
    });
}

window.__xpathEs = results;
document.getElementById('out').textContent = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`).join('\n');
