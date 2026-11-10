// Measurements behind the design choices that are not obvious. Run straight from the sources:
//   node bench/micro.ts
// Every figure is the best of three medians of 15 runs, after warm-up, on xmldom 0.8.

import { compile } from '../src/compile.ts';
import type { DomNode } from '../src/dom.ts';
import { interpret } from '../src/interpret.ts';
import { parseXPath } from '../src/parser.ts';
import { lookupNamespaceInDom, XPathProgram } from '../src/program.ts';
import { EvalState, NodeSet } from '../src/runtime.ts';
import type { EvalSettings, Focus, XValue } from '../src/runtime.ts';
import { CONSUMER_EXPRESSIONS } from '../test/corpus.ts';
import { call, loadDom, loadRaw, milliseconds, UPSTREAM_PATH } from '../test/harness.ts';
import { readFixtures } from './saml-fixtures.ts';

const parse = loadDom('xmldom08');
const LONG = Array.from({ length: 12500 }, (_, i) => `@a${i % 10}='v${i % 7}'`).join(' or ');

function median(run: () => void): number {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) times.push(milliseconds(run));
    times.sort((a, b) => a - b);
    return times[7] ?? 0;
}

/** Warms every variant first, then measures them in three rounds and keeps each variant's best median. */
function compare(variants: readonly (readonly [string, () => void, string?])[]): void {
    for (let round = 0; round < 3; round++) for (const [, run] of variants) for (let i = 0; i < 5; i++) run();
    const best = variants.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < 3; round++) {
        variants.forEach(([, run], at) => {
            best[at] = Math.min(best[at] ?? Number.POSITIVE_INFINITY, median(run));
        });
    }
    variants.forEach(([label, , note], at) => console.log(`| ${label} | ${(best[at] ?? 0).toFixed(3)} ms | ${note ?? ''} |`));
}

function bestOf(run: () => void): number {
    for (let i = 0; i < 5; i++) run();
    return Math.min(median(run), median(run), median(run));
}

let sink = 0;

// ---- 1. how to iterate an axis: inline loop, callback, generator ----
{
    const doc = parse(`<r>${'<a/>'.repeat(65000)}</r>`);
    const root = doc.documentElement;
    if (root == null) throw new Error('no root');
    const isElement = (node: DomNode): boolean => node.nodeType === 1;
    function* children(parent: DomNode): Generator<DomNode, void, undefined> {
        for (let node = parent.firstChild; node != null; node = node.nextSibling) yield node;
    }
    const eachChild = (parent: DomNode, visit: (node: DomNode) => void): void => {
        for (let node = parent.firstChild; node != null; node = node.nextSibling) visit(node);
    };
    console.log('\n### 1. Axis iteration over 65,000 children (collect the elements)\n\n| variant | time | note |\n|---|---:|---|');
    const adapter = { firstChild: (node: DomNode) => node.firstChild, nextSibling: (node: DomNode) => node.nextSibling, type: (node: DomNode) => node.nodeType };
    compare([
        ['inline loop', (): void => {
            const out: DomNode[] = [];
            for (let node = root.firstChild; node != null; node = node.nextSibling) if (isElement(node)) out.push(node);
            sink += out.length;
        }, 'what steps.ts does'],
        ['callback per node', (): void => {
            const out: DomNode[] = [];
            eachChild(root, (node) => {
                if (isElement(node)) out.push(node);
            });
            sink += out.length;
        }],
        ['generator + for-of', (): void => {
            const out: DomNode[] = [];
            for (const node of children(root)) if (isElement(node)) out.push(node);
            sink += out.length;
        }],
        ['inline loop through an adapter object', (): void => {
            const out: DomNode[] = [];
            for (let node = adapter.firstChild(root); node != null; node = adapter.nextSibling(node)) if (adapter.type(node) === 1) out.push(node);
            sink += out.length;
        }, 'accessor functions instead of properties']
    ]);
}

// ---- 2. what noUncheckedIndexedAccess costs in a hot loop ----
{
    const keys = new Float64Array(1_000_000);
    for (let i = 0; i < keys.length; i++) keys[i] = (i * 7919) % 1000;
    console.log('\n### 2. Summing 1,000,000 elements under noUncheckedIndexedAccess\n\n| variant | time | note |\n|---|---:|---|');
    const nodes = Array.from({ length: 1_000_000 }, (_, i) => ({ value: i & 7 }));
    compare([
        ['typed array, for-of', (): void => {
            let total = 0;
            for (const key of keys) total += key;
            sink += total;
        }, 'no index, no undefined'],
        ['typed array, index with `?? 0`', (): void => {
            let total = 0;
            for (let i = 0; i < keys.length; i++) total += keys[i] ?? 0;
            sink += total;
        }],
        ['typed array, index with an undefined guard', (): void => {
            let total = 0;
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                if (key === undefined) break;
                total += key;
            }
            sink += total;
        }],
        ['object array, for-of', (): void => {
            let total = 0;
            for (const node of nodes) total += node.value;
            sink += total;
        }],
        ['object array, index with an undefined guard', (): void => {
            let total = 0;
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                if (node === undefined) break;
                total += node.value;
            }
            sink += total;
        }]
    ]);
}

// ---- 3. closures against an AST interpreter; 4. the work budget; 5. union strategy ----
function settings(node: DomNode, overrides: Partial<EvalSettings> = {}): EvalSettings {
    return {
        contextNode: node, caseInsensitive: true, allowAnyNamespaceForNoPrefix: false, namespaces: lookupNamespaceInDom,
        variables: null, functions: null, pure: true, budget: 0, mergeUnions: true, ...overrides
    };
}

function size(value: XValue, state: EvalState): number {
    return value instanceof NodeSet ? value.sorted(state).length : 1;
}

{
    const fixtures = readFixtures();
    const saml = parse(Buffer.from(fixtures.large, 'base64').toString());
    const wide = parse(`<r>${'<a/><b/><c x="1"/>'.repeat(14000)}</r>`);
    const expressions: readonly (readonly [string, string, DomNode])[] = [
        ['samlify wrapping check, 82 KiB response', "/*[contains(local-name(), 'Response')]/*[local-name(.)='Assertion']/*[local-name(.)='Subject']/*[local-name(.)='SubjectConfirmation']/*[local-name(.)='SubjectConfirmationData']//*[local-name(.)='Assertion' or local-name(.)='Signature']", saml],
        ['xml-crypto ID lookup, 82 KiB response', "//*[@*[local-name(.)='ID']='_nope']", saml],
        ['attribute values, 82 KiB response', "//*[local-name(.)='AttributeValue']/text()", saml],
        ['predicate-heavy, 42k elements', "//*[local-name(.)='a' or local-name(.)='c' and @x='1']", wide],
        ['positional predicate, 42k elements', '//*[position() mod 3 = 1 and not(@x)]', wide]
    ];
    console.log('\n### 3. Compiled closures against an AST interpreter (same step code, same DOM)\n\n| expression | closures | interpreter | ratio |\n|---|---:|---:|---:|');
    for (const [label, source, doc] of expressions) {
        const ast = parseXPath(source);
        const compiled = compile(ast);
        const focusOf = (): Focus => ({ node: doc, position: 1, size: 1 });
        const a = bestOf(() => {
            const state = new EvalState(settings(doc));
            sink += size(compiled(focusOf(), state), state);
        });
        const b = bestOf(() => {
            const state = new EvalState(settings(doc));
            sink += size(interpret(ast, focusOf(), state), state);
        });
        console.log(`| ${label} | ${a.toFixed(3)} ms | ${b.toFixed(3)} ms | ${(b / a).toFixed(2)}x |`);
    }

    console.log('\n### 4. Work budget: the same evaluation with and without a limit\n\n| expression | no budget | budget 10,000,000 visits | visits charged |\n|---|---:|---:|---:|');
    for (const [label, source, doc] of expressions) {
        const compiled = compile(parseXPath(source));
        let visits = 0;
        const off = bestOf(() => {
            const state = new EvalState(settings(doc));
            sink += size(compiled({ node: doc, position: 1, size: 1 }, state), state);
        });
        const on = bestOf(() => {
            const state = new EvalState(settings(doc, { budget: 10_000_000 }));
            sink += size(compiled({ node: doc, position: 1, size: 1 }, state), state);
            visits = state.work;
        });
        console.log(`| ${label} | ${off.toFixed(3)} ms | ${on.toFixed(3)} ms | ${visits} |`);
    }

    console.log('\n### 5. Union: merge on document-order keys against concatenate + lazy sort\n\n| expression (42k elements, 14k attributes) | merge | concatenate, sort when asked |\n|---|---:|---:|');
    for (const source of ['//a | //b | //c', '//c | //b | //a', '//* | //@*', 'count(//a | //b | //c)', '//a | //a', '//a/.. | //b']) {
        const compiled = compile(parseXPath(source));
        const run = (mergeUnions: boolean): number =>
            bestOf(() => {
                const state = new EvalState(settings(wide, { mergeUnions }));
                sink += size(compiled({ node: wide, position: 1, size: 1 }, state), state);
            });
        console.log(`| \`${source}\` | ${run(true).toFixed(3)} ms | ${run(false).toFixed(3)} ms |`);
    }
}

// ---- 6. parsing ----
{
    const upstream = loadRaw(UPSTREAM_PATH);
    console.log(`\n### 6. Parsing the ${CONSUMER_EXPRESSIONS.length} consumer expressions (no evaluation)\n\n| variant | time | note |\n|---|---:|---|`);
    compare([
        ['xpath-es: tokenize + parse + compile to closures', (): void => {
            for (const expression of CONSUMER_EXPRESSIONS) sink += new XPathProgram(expression).source.length;
        }, 'done once per distinct expression (bounded cache)'],
        ['upstream: parse()', (): void => {
            for (const expression of CONSUMER_EXPRESSIONS) sink += call(upstream, 'parse', expression) === undefined ? 0 : 1;
        }, 'select() does this on every call, with a new parser object'],
        ['one expression of 250,000 characters (a chain of `or`)', (): void => {
            sink += new XPathProgram(LONG).source.length;
        }, 'linear in the length']
    ]);
}
console.log(`\n(checksum ${sink})`);
