// An independent reference for strict mode, written from the text of the XPath 1.0 Recommendation and sharing no code with
// the engine: the data model of section 5 over the DOM (one text node for a run of Text and CDATASection siblings, no node
// for the XML declaration, namespace nodes after their element and before its attributes), the thirteen axes of 2.2, the
// principal node type and the node tests of 2.3, positions and predicates of 2.4, and unions and filter paths. It
// evaluates random location paths on random documents and compares the node-set with strict mode, three ways (the plain-map
// namespace resolver, the function resolver on the fast paths, the function resolver on the slow path), so that a bug the
// engine's two paths share cannot hide (test/strict-axes-fuzz.ts compares the engine with itself).
//
//   node test/strict-oracle.ts [dom] [documents] [expressions per document] [seed]
//
// Exit 1 on any difference, when nothing was compared, or when more than 1% of the evaluations were refused by a limit
// (the refusals are counted and printed, never skipped silently).

import { documentText } from './generate.ts';
import { isDomName, loadDom, makeRandom } from './harness.ts';
import type { DomName } from './harness.ts';
import { parse, XPathError, XPathProgram } from '../src/index.ts';
import { isDomNode } from '../src/dom.ts';
import type { DomNode } from '../src/dom.ts';

const domName: DomName = ((): DomName => {
    const requested = process.argv[2] ?? 'xmldom08';
    if (!isDomName(requested)) throw new Error(`unknown DOM ${requested}`);
    return requested;
})();
const documents = Number(process.argv[3] ?? 40);
const perDocument = Number(process.argv[4] ?? 150);
const random = makeRandom(Number(process.argv[5] ?? 1));
const parseXml = loadDom(domName);
/** The mode asked of the engine: `strict`; STRICT_ORACLE_MODE=upstream is the harness self-test, which must find differences. */
const mode = process.env['STRICT_ORACLE_MODE'] === 'upstream' ? 'upstream' : 'strict';

const int = (n: number): number => Math.floor(random() * n);
const pick = <T>(items: readonly T[], fallback: T): T => items[int(items.length)] ?? fallback;

// ---- the data model ----

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const isText = (node: DomNode | null | undefined): boolean =>
    node != null && (node.nodeType === 3 || node.nodeType === 4);
const isDeclaration = (name: string): boolean => name === 'xmlns' || name.startsWith('xmlns:');

/** Not a node of the model: the continuation of a text run, the XML declaration, a document type. */
function inModel(node: DomNode): boolean {
    if (isText(node) && isText(node.previousSibling)) return false;
    if (node.nodeType === 7 && (node.target ?? node.nodeName) === 'xml') return false;
    return node.nodeType !== 10 && node.nodeType !== 5 && node.nodeType !== 6 && node.nodeType !== 12;
}

interface Model {
    /** Position of every node of the model in document order (namespace nodes after their element, then attributes). */
    readonly order: Map<DomNode, number>;
    readonly all: DomNode[];
    /** The namespace nodes of an element, in the order the engine documents: xml, its own declarations, the inherited. */
    readonly namespaces: Map<DomNode, DomNode[]>;
}

function declarationsOf(element: DomNode): { prefix: string; uri: string }[] {
    const out: { prefix: string; uri: string }[] = [];
    const attributes = element.attributes;
    for (let i = 0; i < (attributes?.length ?? 0); i++) {
        const attribute = attributes?.item(i);
        const name = String(attribute?.name ?? attribute?.nodeName ?? '');
        if (attribute == null || !isDeclaration(name)) continue;
        out.push({
            prefix: name === 'xmlns' ? '' : name.slice(6),
            uri: String(attribute.value ?? attribute.nodeValue ?? '')
        });
    }
    return out;
}

function buildModel(doc: DomNode, withNamespaces: boolean): Model {
    const order = new Map<DomNode, number>();
    const all: DomNode[] = [];
    const namespaces = new Map<DomNode, DomNode[]>();
    const add = (node: DomNode): void => {
        order.set(node, all.length);
        all.push(node);
    };
    const visit = (node: DomNode): void => {
        add(node);
        if (node.nodeType === 1) {
            if (withNamespaces) {
                // In scope: xml, then the element's own declarations, then those of each ancestor outwards; the nearest wins.
                const seen = new Set<string>(['xml']);
                const nodes: DomNode[] = [
                    {
                        nodeType: 13,
                        nodeName: 'xml',
                        localName: 'xml',
                        prefix: 'xml',
                        nodeValue: XML_NS,
                        ownerElement: node
                    }
                ];
                for (let up: DomNode | null | undefined = node; up != null && up.nodeType === 1; up = up.parentNode) {
                    for (const { prefix, uri } of declarationsOf(up)) {
                        if (seen.has(prefix)) continue;
                        seen.add(prefix);
                        if (prefix === '' && uri === '') continue;
                        nodes.push({
                            nodeType: 13,
                            nodeName: prefix,
                            localName: prefix,
                            prefix,
                            nodeValue: uri,
                            ownerElement: node
                        });
                    }
                }
                namespaces.set(node, nodes);
                for (const ns of nodes) add(ns);
            }
            const attributes = node.attributes;
            for (let i = 0; i < (attributes?.length ?? 0); i++) {
                const attribute = attributes?.item(i);
                if (attribute != null && !isDeclaration(String(attribute.name ?? attribute.nodeName))) add(attribute);
            }
        }
        for (let child = node.firstChild; child != null; child = child.nextSibling) if (inModel(child)) visit(child);
    };
    visit(doc);
    return { order, all, namespaces };
}

const isAttribute = (node: DomNode): boolean => node.nodeType === 2;
const isNamespace = (node: DomNode): boolean => node.nodeType === 13;
const parentOf = (node: DomNode): DomNode | null =>
    isAttribute(node) || isNamespace(node) ? (node.ownerElement ?? null) : (node.parentNode ?? null);
const isAncestor = (maybe: DomNode, node: DomNode): boolean => {
    for (let up = parentOf(node); up != null; up = parentOf(up)) if (up === maybe) return true;
    return false;
};
const modelSiblings = (node: DomNode, forward: boolean): DomNode[] => {
    const out: DomNode[] = [];
    if (isAttribute(node) || isNamespace(node)) return out;
    for (
        let sibling = forward ? node.nextSibling : node.previousSibling;
        sibling != null;
        sibling = forward ? sibling.nextSibling : sibling.previousSibling
    )
        if (inModel(sibling)) out.push(sibling);
    return out;
};

type Axis =
    | 'child'
    | 'descendant'
    | 'descendant-or-self'
    | 'parent'
    | 'ancestor'
    | 'ancestor-or-self'
    | 'following-sibling'
    | 'preceding-sibling'
    | 'following'
    | 'preceding'
    | 'attribute'
    | 'namespace'
    | 'self';

/** The nodes of an axis, in the order the axis is read: reverse axes nearest first (section 2.4). */
function axisNodes(model: Model, axis: Axis, context: DomNode): DomNode[] {
    const tree = model.all.filter((node) => !isAttribute(node) && !isNamespace(node));
    const at = model.order.get(context) ?? -1;
    switch (axis) {
        case 'self':
            return [context];
        case 'child': {
            const out: DomNode[] = [];
            if (!isAttribute(context) && !isNamespace(context))
                for (let child = context.firstChild; child != null; child = child.nextSibling)
                    if (inModel(child)) out.push(child);
            return out;
        }
        case 'descendant':
            return tree.filter((node) => isAncestor(context, node));
        case 'descendant-or-self':
            return [context, ...tree.filter((node) => isAncestor(context, node))];
        case 'parent': {
            const parent = parentOf(context);
            return parent === null ? [] : [parent];
        }
        case 'ancestor':
        case 'ancestor-or-self': {
            const out: DomNode[] = axis === 'ancestor' ? [] : [context];
            for (let up = parentOf(context); up != null; up = parentOf(up)) out.push(up);
            return out;
        }
        case 'following-sibling':
            return modelSiblings(context, true);
        case 'preceding-sibling':
            return modelSiblings(context, false);
        case 'following':
            return tree.filter((node) => (model.order.get(node) ?? -1) > at && !isAncestor(context, node));
        case 'preceding':
            return tree.filter((node) => (model.order.get(node) ?? -1) < at && !isAncestor(node, context)).reverse();
        case 'attribute': {
            const out: DomNode[] = [];
            const attributes = context.attributes;
            if (context.nodeType === 1)
                for (let i = 0; i < (attributes?.length ?? 0); i++) {
                    const attribute = attributes?.item(i);
                    if (attribute != null && !isDeclaration(String(attribute.name ?? attribute.nodeName)))
                        out.push(attribute);
                }
            return out;
        }
        case 'namespace':
            return model.namespaces.get(context) ?? [];
    }
}

const PREFIXES: Readonly<Record<string, string>> = { p: 'urn:p' };

function passes(axis: Axis, test: string, node: DomNode): boolean {
    // Section 2.3: `*` and a name select the principal node type of the axis.
    const principal = axis === 'attribute' ? 2 : axis === 'namespace' ? 13 : 1;
    switch (test) {
        case 'node()':
            return true;
        case 'text()':
            return isText(node);
        case 'comment()':
            return node.nodeType === 8;
        case 'processing-instruction()':
            return node.nodeType === 7;
        case '*':
            return node.nodeType === principal;
        case 'p:*':
            return node.nodeType === principal && node.namespaceURI === PREFIXES['p'];
        default: {
            if (node.nodeType !== principal) return false;
            const [prefix, local] = test.includes(':') ? test.split(':') : [null, test];
            const uri = prefix === null || prefix === undefined ? null : (PREFIXES[prefix] ?? null);
            return (node.localName ?? node.nodeName) === local && (node.namespaceURI || null) === uri;
        }
    }
}

// ---- expressions: a small grammar, and its meaning by the model ----

interface Predicate {
    readonly kind: 'index' | 'last' | 'lastMinus' | 'position' | 'path' | 'not' | 'count';
    readonly value?: number;
    readonly op?: string;
    readonly steps?: readonly Step[];
}
interface Step {
    readonly axis: Axis;
    readonly test: string;
    readonly predicates: readonly Predicate[];
}

function holds(model: Model, predicate: Predicate, node: DomNode, position: number, size: number): boolean {
    const value = predicate.value ?? 0;
    switch (predicate.kind) {
        case 'index':
            return position === value;
        case 'last':
            return position === size;
        case 'lastMinus':
            return position === size - value;
        case 'position':
            return predicate.op === '<'
                ? position < value
                : predicate.op === '>'
                  ? position > value
                  : position !== value;
        case 'path':
            return evaluate(model, [node], predicate.steps ?? []).length > 0;
        case 'not':
            return evaluate(model, [node], predicate.steps ?? []).length === 0;
        case 'count':
            return evaluate(model, [node], predicate.steps ?? []).length > value;
    }
}

function evaluate(model: Model, start: readonly DomNode[], steps: readonly Step[]): DomNode[] {
    let current: DomNode[] = [...start];
    for (const step of steps) {
        const out = new Set<DomNode>();
        for (const context of current) {
            let candidates = axisNodes(model, step.axis, context).filter((node) => passes(step.axis, step.test, node));
            for (const predicate of step.predicates) {
                const size = candidates.length;
                candidates = candidates.filter((node, i) => holds(model, predicate, node, i + 1, size));
            }
            for (const node of candidates) out.add(node);
        }
        current = [...out].sort((a, b) => (model.order.get(a) ?? 0) - (model.order.get(b) ?? 0));
    }
    return current;
}

let withNamespaces = false;
const AXES: readonly Axis[] = [
    'child',
    'descendant',
    'descendant-or-self',
    'parent',
    'ancestor',
    'ancestor-or-self',
    'following-sibling',
    'preceding-sibling',
    'following',
    'preceding',
    'attribute',
    'self'
];
const HOT: readonly Axis[] = ['following', 'preceding', 'following', 'preceding', 'descendant', 'ancestor'];
const TESTS = ['*', 'a', 'b', 'node()', 'text()', '*', 'p:a', 'p:*', 'comment()', 'c', 'x', 'processing-instruction()'];

function makePredicate(depth: number): Predicate {
    const r = random();
    if (r < 0.3) return { kind: 'index', value: 1 + int(4) };
    if (r < 0.45) return { kind: 'last' };
    if (r < 0.5) return { kind: 'lastMinus', value: 1 + int(2) };
    if (r < 0.6) return { kind: 'position', op: pick(['<', '>', '!='], '<'), value: 1 + int(3) };
    if (depth > 1) return { kind: 'index', value: 1 };
    if (r < 0.8) return { kind: 'path', steps: makeSteps(1 + int(2), depth + 1) };
    if (r < 0.9) return { kind: 'not', steps: makeSteps(1 + int(2), depth + 1) };
    return { kind: 'count', steps: makeSteps(1, depth + 1), value: int(3) };
}

function makeSteps(count: number, depth = 0): Step[] {
    const steps: Step[] = [];
    for (let i = 0; i < count; i++) {
        let axis = random() < 0.45 ? pick(HOT, 'following') : pick(AXES, 'child');
        if (withNamespaces && random() < 0.08) axis = 'namespace';
        const predicates: Predicate[] = [];
        const wanted = random() < 0.5 ? 0 : random() < 0.7 ? 1 : 2;
        for (let j = 0; j < wanted; j++) predicates.push(makePredicate(depth));
        steps.push({ axis, test: pick(TESTS, '*'), predicates });
    }
    return steps;
}

const text = (predicate: Predicate): string => {
    const inner = (steps: readonly Step[] | undefined): string => (steps ?? []).map(stepText).join('/');
    switch (predicate.kind) {
        case 'index':
            return `[${predicate.value}]`;
        case 'last':
            return '[last()]';
        case 'lastMinus':
            return `[last()-${predicate.value}]`;
        case 'position':
            return `[position()${predicate.op}${predicate.value}]`;
        case 'path':
            return `[${inner(predicate.steps)}]`;
        case 'not':
            return `[not(${inner(predicate.steps)})]`;
        case 'count':
            return `[count(${inner(predicate.steps)})>${predicate.value}]`;
    }
};
const stepText = (step: Step): string => `${step.axis}::${step.test}${step.predicates.map(text).join('')}`;
const stepsText = (steps: readonly Step[]): string => steps.map(stepText).join('/');

// ---- the comparison ----

/** What a node-set is, in a form that the model's nodes and the engine's agree on (namespace nodes by element and prefix). */
function describeSet(model: Model, nodes: readonly DomNode[]): string {
    return nodes
        .map((node) =>
            isNamespace(node)
                ? `ns:${model.order.get(node.ownerElement ?? node) ?? '?'}:${node.prefix ?? node.nodeName}`
                : String(model.order.get(node) ?? `?${node.nodeName}`)
        )
        .join(',');
}
const describeModel = (model: Model, nodes: readonly DomNode[]): string =>
    nodes
        .map((node) =>
            isNamespace(node)
                ? `ns:${model.order.get(node.ownerElement ?? node) ?? '?'}:${node.prefix ?? node.nodeName}`
                : String(model.order.get(node))
        )
        .join(',');

const resolver: Readonly<Record<string, string>> = PREFIXES;
let total = 0;
let mismatches = 0;
let refused = 0;
const shown: string[] = [];
withNamespaces = process.argv[6] === 'ns';

for (let d = 0; d < documents; d++) {
    const xml = documentText(random);
    let doc: DomNode;
    try {
        doc = parseXml(xml);
    } catch {
        continue;
    }
    const model = buildModel(doc, withNamespaces);
    for (let e = 0; e < perDocument; e++) {
        const steps = makeSteps(1 + int(4));
        const context = pick(
            model.all.filter((node) => !isNamespace(node)),
            doc
        );
        let source = stepsText(steps);
        let expected = evaluate(model, [context], steps);
        if (random() < 0.3) {
            source = `/${source}`;
            expected = evaluate(model, [doc], steps);
        }
        const form = random();
        if (form < 0.15) {
            const k = 1 + int(3);
            source = `(${source})[${k}]`;
            expected = expected.slice(k - 1, k);
        } else if (form < 0.25) {
            source = `(${source})[last()]`;
            expected = expected.slice(-1);
        } else if (form < 0.45) {
            const second = makeSteps(1 + int(3));
            source = `${source} | ${stepsText(second)}`;
            expected = [...new Set([...expected, ...evaluate(model, [context], second)])].sort(
                (a, b) => (model.order.get(a) ?? 0) - (model.order.get(b) ?? 0)
            );
        } else if (form < 0.55) {
            const second = makeSteps(1 + int(2));
            source = `(${source})/${stepsText(second)}`;
            expected = evaluate(model, expected, second);
        }
        const want = describeModel(model, expected);
        const attempt = (run: () => readonly DomNode[]): string => {
            try {
                return describeSet(model, run());
            } catch (error) {
                if (
                    error instanceof XPathError &&
                    (error.code === 'BUDGET' || error.code === 'TIMEOUT' || error.code === 'LIMIT')
                ) {
                    refused++;
                    return want;
                }
                return `ERR ${error instanceof Error ? error.message : String(error)}`;
            }
        };
        const viaFunction = (slow: boolean): string => {
            XPathProgram.forceSlowPath = slow;
            try {
                return attempt(() => {
                    const value = new XPathProgram(source, { mode }).run({
                        node: context,
                        namespaces: (prefix) => resolver[prefix] ?? null
                    }).value;
                    return Array.isArray(value) ? value.filter(isDomNode) : [];
                });
            } finally {
                XPathProgram.forceSlowPath = false;
            }
        };
        const viaMap = attempt(() => parse(source, { mode }).select({ node: context, namespaces: resolver }));
        const got = [viaMap, viaFunction(false), viaFunction(true)];
        total++;
        if (got.every((one) => one === want)) continue;
        mismatches++;
        if (shown.length < 8)
            shown.push(
                `${JSON.stringify({ xml: xml.slice(0, 400), at: `${context.nodeName}#${model.order.get(context)}`, source, want, map: got[0], fast: got[1], slow: got[2] })}`
            );
    }
}
console.log(
    `strict mode against the independent reference (${domName}): ${total} expressions, ${mismatches} differences, ${refused} refused by a limit (counted as agreeing)`
);
for (const sample of shown) console.log(`  ${sample}`);
// A limit is a policy, not an answer: more than a few refusals means the gate is not looking at much.
const refusedTooOften = refused > Math.max(2, total / 100);
if (refusedTooOften) console.log(`more than 1% of the evaluations were refused by a limit (${refused} of ${total})`);
process.exitCode = total === 0 || mismatches > 0 || refusedTooOften ? 1 : 0;
