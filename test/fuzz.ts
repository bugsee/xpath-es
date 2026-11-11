// Differential fuzzer: upstream xpath 0.0.36 (the oracle) against the candidate (CANDIDATE, default the bugsee/xpath
// fork). Random documents, then the scenarios static, mutated, detached, fragment, two documents and pair ordering
// through XNodeSet, with the fuzz queries or the whole corpus (the consumers' expressions and the quirk probes).
// Every difference is classified: `result` (different members), `mixed` (different members among attribute or
// namespace nodes), `order` (same members, different order) and `message` (both throw, different text). All but
// `message` fail the run; TOLERATE=order,mixed lists kinds to let through, for a DOM known to differ.
//
//   node test/fuzz.ts <dom> <documents> [seed] [corpus: fuzz|all]
//   SAMPLES=1 node test/fuzz.ts ...        print one example of each kind of difference
//   CLASSIFY=all node test/fuzz.ts ...     the split gate (xmldom 0.9): a difference is allowed only when it falls in
//                                          one of the documented classes below; anything else fails the run
//   CLASSIFY=ns-duplicate node ...         the same with class 5 only (xmldom 0.8: everything else must be equal)
//   TOLERATE=order node test/fuzz.ts ...   do not fail on the listed kinds

import { CORPUS, FUZZ_QUERIES } from './corpus.ts';
import { documentText } from './generate.ts';
import {
    allNodes,
    call,
    candidateSpec,
    describe,
    errorText,
    isDomName,
    loadCandidate,
    loadDom,
    loadOracle,
    makeRandom
} from './harness.ts';
import { isNamespaceDuplicate } from './support/classify.ts';
import { isDomNode } from './support/dom.ts';
import { loadInternedOracle } from './support/interned-oracle.ts';
import type { DomNode } from './support/dom.ts';

const domName = process.argv[2] ?? 'xmldom08';
if (!isDomName(domName)) throw new Error(`unknown DOM ${domName}`);
const documents = Number(process.argv[3] ?? 200);
const random = makeRandom(Number(process.argv[4] ?? 12345));
const queries = process.argv[5] === 'all' ? CORPUS : FUZZ_QUERIES;
const parse = loadDom(domName);
const upstream = loadOracle();
const interned = loadInternedOracle();
const candidate = loadCandidate();

function pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(random() * items.length)];
}

type Scenario = 'static' | 'mutated' | 'detached' | 'fragment' | 'twodocs' | 'pairs' | 'pairs-two-trees';
type Kind = 'equal' | 'message' | 'order' | 'mixed' | 'result';
const tally = new Map<string, number>();
const samples = new Map<string, string>();
const classes = new Map<string, number>();
const unclassified: string[] = [];
let upstreamThrows = 0;

function indexOf(roots: readonly DomNode[]): Map<unknown, number> {
    const index = new Map<unknown, number>();
    for (const root of roots) for (const node of allNodes(root)) index.set(node, index.size);
    return index;
}

function attempt(run: () => unknown, index: ReadonlyMap<unknown, number>): string {
    try {
        return describe(run(), index);
    } catch (error) {
        return `ERR ${errorText(error)}`;
    }
}

/**
 * The documented classes of difference (CLASSIFY=1). All of them are cases where the oracle crashes on, or returns an
 * arbitrary order for, something the DOM's own `compareDocumentPosition` cannot handle (xmldom 0.9 dereferences a null
 * parent for a detached node and for upstream's synthetic namespace nodes), or where the engine refuses a node-set
 * that spans several trees. A difference in which both engines answer is never documented.
 */
const DOCUMENTED = [
    'namespace-nodes: upstream throws, engine answers',
    'detached-context: upstream throws, engine answers',
    'two-trees: engine throws XPathOrderError, upstream answers',
    'two-trees: upstream throws, engine answers',
    'namespace-axis: upstream repeats a namespace node for a duplicate context'
] as const;
const ORDER_ERROR = 'ERR Unexpected: could not determine node order';
const NAMESPACE_DUPLICATE = DOCUMENTED[4];

/** CLASSIFY=all allows every class; CLASSIFY=ns-duplicate only the last (class 5), for the DOMs that must otherwise be equal. */
const classifyValue = process.env['CLASSIFY'] ?? '';
const classifyMode = classifyValue !== '';
const allowed: ReadonlySet<string> =
    classifyValue === 'ns-duplicate' ? new Set<string>([NAMESPACE_DUPLICATE]) : new Set<string>(DOCUMENTED);

function classify(
    scenario: Scenario,
    what: string,
    expected: string,
    actual: string,
    interned: (() => string) | undefined
): string | null {
    const found = classifyAll(scenario, what, expected, actual, interned);
    return found !== null && allowed.has(found) ? found : null;
}

function classifyAll(
    scenario: Scenario,
    what: string,
    expected: string,
    actual: string,
    interned: (() => string) | undefined
): string | null {
    const upstreamThrows = expected.startsWith('ERR');
    const engineThrows = actual.startsWith('ERR');
    if (upstreamThrows === engineThrows) {
        return interned !== undefined && isNamespaceDuplicate(what, expected, actual, interned)
            ? NAMESPACE_DUPLICATE
            : null;
    }
    const twoTrees = scenario === 'twodocs' || scenario === 'pairs-two-trees';
    if (twoTrees) return engineThrows && actual === ORDER_ERROR ? DOCUMENTED[2] : upstreamThrows ? DOCUMENTED[3] : null;
    if (!upstreamThrows) return null;
    if (scenario === 'detached') return DOCUMENTED[1];
    return what.includes('namespace::') || actual.includes('ns:') ? DOCUMENTED[0] : null;
}

const members = (text: string): string[] => (text.startsWith('[') ? text.slice(1, -1).split(',').sort() : [text]);

function record(
    scenario: Scenario,
    what: string,
    expected: string,
    actual: string,
    special: (text: string) => boolean,
    interned?: () => string
): void {
    let kind: Kind = 'result';
    const a = expected.startsWith('ERR');
    const b = actual.startsWith('ERR');
    if (a) upstreamThrows++;
    if (expected === actual) kind = 'equal';
    else if (a && b) kind = 'message';
    else if (!a && !b && members(expected).join() === members(actual).join()) kind = 'order';
    else if (special(expected) || special(actual)) kind = 'mixed';
    const key = `${scenario}/${kind}`;
    if (kind === 'result' || kind === 'mixed' || kind === 'order') {
        const cls = classify(scenario, what, expected, actual, interned);
        const slot = cls ?? 'UNCLASSIFIED';
        classes.set(slot, (classes.get(slot) ?? 0) + 1);
        if (cls === null && unclassified.length < 8)
            unclassified.push(
                `${scenario}/${kind}: ${what}\n     upstream:  ${expected.slice(0, 140)}\n     candidate: ${actual.slice(0, 140)}`
            );
    }
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (kind !== 'equal' && !samples.has(key))
        samples.set(key, `${what}\n     upstream:  ${expected.slice(0, 140)}\n     candidate: ${actual.slice(0, 140)}`);
}

function specialTest(index: ReadonlyMap<unknown, number>, nodes: readonly DomNode[]): (text: string) => boolean {
    const attributeIds = new Set<string>();
    for (const node of nodes) if (node.nodeType === 2) attributeIds.add(String(index.get(node)));
    return (text) =>
        text.includes('ns:') || text.includes('UNKNOWN') || members(text).some((item) => attributeIds.has(item));
}

function compareQueries(
    scenario: Scenario,
    contexts: readonly (DomNode | undefined)[],
    index: ReadonlyMap<unknown, number>,
    nodes: readonly DomNode[]
): void {
    const special = specialTest(index, nodes);
    for (const query of queries) {
        for (const node of contexts) {
            if (node === undefined) continue;
            const expected = attempt(() => upstream.select(query, node), index);
            const actual = attempt(() => candidate.select(query, node), index);
            record(
                scenario,
                query,
                expected,
                actual,
                (text) => special(text) || node.nodeType === 2,
                () => attempt(() => interned.select(query, node), index)
            );
        }
    }
}

function comparePairs(scenario: Scenario, nodes: readonly DomNode[], index: ReadonlyMap<unknown, number>): void {
    const special = specialTest(index, nodes);
    for (let t = 0; t < 60; t++) {
        const a = pick(nodes);
        const b = pick(nodes);
        if (a === undefined || b === undefined) continue;
        const expected = attempt(() => upstream.orderPair(a, b), index);
        const actual = attempt(() => candidate.orderPair(a, b), index);
        record(scenario, `pair ${a.nodeName}/${a.nodeType} ${b.nodeName}/${b.nodeType}`, expected, actual, special);
    }
}

/** One random structural change; returns the subtree it removed, if it removed one. */
function mutate(doc: DomNode): DomNode | null {
    const root = doc.documentElement;
    const elements = allNodes(doc).filter((node) => node.nodeType === 1 && node !== root);
    const target = pick(elements);
    if (target === undefined) return null;
    const r = random();
    const parent = target.parentNode;
    try {
        if (r < 0.3) {
            call(parent, 'removeChild', target);
            return target;
        }
        if (r < 0.6) {
            if (parent != null && parent.firstChild !== target) call(parent, 'insertBefore', target, parent.firstChild);
            return null;
        }
        if (r < 0.8) {
            const to = pick(elements);
            for (let up: DomNode | null | undefined = to; up != null; up = up.parentNode)
                if (up === target) return null;
            call(to, 'appendChild', target);
            return null;
        }
        call(parent, 'insertBefore', call(doc, 'createElement', 'new'), target);
        return null;
    } catch {
        return null;
    }
}

const started = Date.now();
let done = 0;
let previous: DomNode | null = null;
for (let d = 0; d < documents; d++) {
    const xml = documentText(random);
    let doc: DomNode;
    try {
        doc = parse(xml);
    } catch {
        continue;
    }
    if (doc.documentElement == null) continue;
    let nodes = allNodes(doc);
    let index = indexOf([doc]);
    compareQueries('static', [doc, pick(nodes.filter((node) => node.nodeType !== 2)), pick(nodes)], index, nodes);
    comparePairs('pairs', nodes, index);
    if (previous !== null) {
        const both = indexOf([doc, previous]);
        const all = nodes.concat(allNodes(previous));
        comparePairs('pairs-two-trees', all, both);
        const variables = { a: pick(nodes), b: pick(allNodes(previous)), c: pick(nodes) };
        const expression = '$a | $b | $c | //a | $b/..';
        const expected = attempt(() => upstream.parseSelect(expression, { node: doc, variables }), both);
        const actual = attempt(() => candidate.parseSelect(expression, { node: doc, variables }), both);
        record('twodocs', expression, expected, actual, specialTest(both, all));
    }
    for (let round = 0; round < 3; round++) {
        const removed = mutate(doc);
        index = indexOf(removed === null ? [doc] : [doc, removed]);
        nodes = allNodes(doc);
        compareQueries('mutated', [doc, pick(nodes)], index, nodes);
        if (removed !== null) {
            const detached = allNodes(removed);
            compareQueries('detached', [removed], index, nodes.concat(detached));
            comparePairs('pairs-two-trees', nodes.concat(detached), index);
        }
    }
    if (d % 3 === 0) {
        let fragment: unknown;
        try {
            fragment = call(doc, 'createDocumentFragment');
        } catch {
            fragment = null;
        }
        if (isDomNode(fragment)) {
            const root = doc.documentElement;
            for (let child = root.firstChild; child != null; child = root.firstChild) {
                try {
                    call(fragment, 'appendChild', child);
                } catch {
                    call(root, 'removeChild', child);
                }
            }
            index = indexOf([doc, fragment]);
            const inFragment = allNodes(fragment);
            compareQueries('fragment', [fragment, pick(inFragment)], index, inFragment.concat(allNodes(doc)));
            comparePairs('pairs-two-trees', inFragment.concat(allNodes(doc)), index);
        }
    }
    previous = doc;
    done++;
}

const SCENARIOS: readonly Scenario[] = [
    'static',
    'mutated',
    'detached',
    'fragment',
    'twodocs',
    'pairs',
    'pairs-two-trees'
];
const KINDS: readonly Kind[] = ['equal', 'result', 'mixed', 'order', 'message'];
console.log(
    `${domName}: candidate ${candidateSpec()}, ${done} documents, ${queries.length} queries, ${Date.now() - started} ms; upstream threw in ${upstreamThrows} comparisons`
);
console.log(`| scenario | ${KINDS.join(' | ')} |`);
console.log(`|---|${KINDS.map(() => '---:').join('|')}|`);
const tolerated = new Set((process.env['TOLERATE'] ?? '').split(','));
let failures = 0;
for (const scenario of SCENARIOS) {
    console.log(`| ${scenario} | ${KINDS.map((kind) => tally.get(`${scenario}/${kind}`) ?? 0).join(' | ')} |`);
    if (classifyMode) continue;
    for (const kind of ['result', 'mixed', 'order'] as const)
        if (!tolerated.has(kind)) failures += tally.get(`${scenario}/${kind}`) ?? 0;
}
if (classifyMode) {
    for (const cls of DOCUMENTED) console.log(`documented  ${String(classes.get(cls) ?? 0).padStart(8)}  ${cls}`);
    console.log(`UNCLASSIFIED ${String(classes.get('UNCLASSIFIED') ?? 0).padStart(7)}`);
    for (const sample of unclassified) console.log(`  ${sample}`);
    failures = classes.get('UNCLASSIFIED') ?? 0;
}
if (process.env['SAMPLES'] !== undefined) for (const [key, sample] of samples) console.log(`  ${key}: ${sample}`);
process.exitCode = failures === 0 ? 0 : 1;
