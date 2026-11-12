// The strict-mode fast paths for following:: and preceding:: (src/ranked.ts) against the strict slow path, which walks
// each context node's axis and is the reference (XPathProgram.forceSlowPath). Random documents (including a parent with
// thousands of children), random node-set contexts (elements, text, attributes, ancestors, unions, positional
// selections), and the two axes with node tests and positional predicates: [k], [last()], [0], [1.5], position() and
// last() arithmetic, a predicate before or after the positional one, nested inside other paths and set operators.
//
//   node test/strict-axes-fuzz.ts [documents] [expressions per document] [seed] [dom]
//   (test/mutation-testing.ts plants wrong answers in the fast paths and requires the unit tests or this run to find them)
//
// Exit 1 on any difference or when nothing was compared.

import { documentText } from './generate.ts';
import { allNodes, describe, errorText, isDomName, loadDom, makeRandom } from './harness.ts';
import { select, XPathError, XPathProgram } from '../src/index.ts';

const documents = Number(process.argv[2] ?? 60);
const perDocument = Number(process.argv[3] ?? 150);
const random = makeRandom(Number(process.argv[4] ?? 7));
const domName = process.argv[5] ?? 'xmldom08';
if (!isDomName(domName)) throw new Error(`unknown DOM ${domName}`);
const parse = loadDom(domName);

const pick = (items: readonly string[]): string => items[Math.floor(random() * items.length)] ?? '';

const CONTEXTS = [
    '//*',
    '//a',
    '//b',
    '//c',
    '//text()',
    '//comment()',
    '//node()',
    '//@*',
    '//@x',
    '//*/@*',
    '//a | //c',
    '//b | //@id',
    '//*[position() < 4]',
    '//*[last()]',
    '//a[1]',
    '/descendant::*[2]',
    '/r/*',
    '/r',
    '//*/ancestor::*',
    '//*/..',
    '(//a)[last()]',
    '//a/following-sibling::*',
    '//b/preceding-sibling::*',
    '//a/descendant::node()',
    '//*[@x]',
    '//processing-instruction()',
    '.',
    'descendant-or-self::node()',
    'ancestor-or-self::*',
    '//namespace::*',
    '//a/following::*',
    '//a/preceding::*',
    '//*/@x/..'
];
const TESTS = [
    '*',
    '*',
    'a',
    'b',
    'c',
    'node()',
    'node()',
    'text()',
    'comment()',
    'processing-instruction()',
    'd',
    'p:*'
];
const PREDICATES = [
    '',
    '',
    '[1]',
    '[2]',
    '[3]',
    '[7]',
    '[last()]',
    '[last()]',
    '[0]',
    '[1.5]',
    '[position() = 2]',
    '[position() < 3]',
    '[last() - 1]',
    '[position() = last()]',
    '[@x]',
    '[1][@x]',
    '[@x][1]',
    '[last()][1]',
    '[2][last()]',
    '[1][2]',
    '[1][last()]',
    '[. = "text1"]',
    '[string-length(.) > 0][1]',
    '[count(following::*) > 1][1]'
];
const TAILS = [
    '',
    '',
    '',
    '/..',
    '/@*',
    '/*',
    '/node()',
    '[1]',
    '[last()]',
    '/following::*[1]',
    '/preceding::*[last()]',
    '/self::a'
];
const WRAPS = [
    '%',
    '%',
    '%',
    'count(%)',
    'string(%)',
    'boolean(%)',
    'sum(%)',
    '(%)[1]',
    '(%)[last()]',
    '% | //b',
    'name(%)'
];

function expression(): string {
    const axis = pick(['following', 'preceding', 'preceding', 'following']);
    const test = pick(TESTS);
    const step = `${axis}::${test}${pick(PREDICATES)}`;
    const second = random() < 0.25 ? `/${pick(['following', 'preceding'])}::${pick(TESTS)}${pick(PREDICATES)}` : '';
    const path = `${pick(CONTEXTS)}/${step}${second}${pick(TAILS)}`;
    // Parenthesised so that a wrapper such as `% | //b` or `(%)[1]` applies to the whole path.
    return pick(WRAPS).replaceAll('%', () => path);
}

function outcome(
    slow: boolean,
    text: string,
    doc: ReturnType<typeof parse>,
    node: ReturnType<typeof parse>,
    index: Map<unknown, number>
): string {
    XPathProgram.forceSlowPath = slow;
    try {
        return describe(select(text, node, false, { mode: 'strict' }), index);
    } catch (error) {
        return error instanceof XPathError ? `ERR ${error.code}` : `ERR other ${errorText(error)}`;
    } finally {
        XPathProgram.forceSlowPath = false;
        void doc;
    }
}

let compared = 0;
let differences = 0;
let errors = 0;
let refusedFast = 0;
let refusedSlow = 0;
const shown: string[] = [];
const started = Date.now();
for (let d = 0; d < documents; d++) {
    const xml = documentText(random, { wide: 0.01 });
    let doc: ReturnType<typeof parse>;
    try {
        doc = parse(xml);
    } catch {
        continue;
    }
    const nodes = allNodes(doc);
    const index = new Map<unknown, number>(nodes.map((node, i) => [node, i]));
    const contexts = [
        doc,
        nodes[Math.floor(random() * nodes.length)] ?? doc,
        nodes[Math.floor(random() * nodes.length)] ?? doc
    ].filter((node) => ![5, 6, 10, 12].includes(node.nodeType));
    for (let e = 0; e < perDocument; e++) {
        const text = expression();
        for (const node of contexts) {
            const fast = outcome(false, text, doc, node, index);
            const slow = outcome(true, text, doc, node, index);
            // A limit (work budget, time, size) is a policy of the engine, and the two paths cost different amounts: the
            // pair is not an answer to compare. Counted, so that a path that refuses far more often shows.
            const refused = (text: string): boolean => /^ERR (BUDGET|TIMEOUT|LIMIT)/.test(text);
            if (refused(fast)) refusedFast++;
            if (refused(slow)) refusedSlow++;
            if (refused(fast) || refused(slow)) continue;
            compared++;
            if (fast.startsWith('ERR')) errors++;
            if (fast === slow) continue;
            differences++;
            if (shown.length < 6)
                shown.push(
                    `${text}  @${node.nodeName}\n     fast: ${fast.slice(0, 140)}\n     slow: ${slow.slice(0, 140)}`
                );
        }
    }
}
console.log(
    `strict following/preceding, fast path against slow path (${domName}): ${compared} comparisons, ${errors} errors (the same on both), ${differences} differences; refused by a limit: ${refusedFast} fast, ${refusedSlow} slow, ${Date.now() - started} ms`
);
for (const sample of shown) console.log(`  ${sample}`);
process.exitCode = compared === 0 || differences > 0 ? 1 : 0;
