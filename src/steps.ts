// Location steps (XPath 1.0 section 2). The hot path.
//
// A step is applied to the whole context list at once whenever its predicates do not depend on the context position
// ("set mode"): every axis then costs O(nodes visited + output) for the list, not per context node. A step with a
// positional predicate is applied per context node ("focus mode"), with shortcuts for `[k]` and `[last()]` that
// stop walking as soon as the answer is known.
//
// The list carries two facts: `ordered` (document order) and `flat` (no member is an ancestor of another). They decide
// whether the output of the next step is in document order by construction, so most paths never sort at all.
//
// Axis behaviour follows upstream where upstream departs from the Recommendation; each place is marked Q-AXIS-n.

import type { Axis, NodeTest } from './ast.ts';
import {
    ATTRIBUTE_NODE,
    CDATA_SECTION_NODE,
    COMMENT_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    NAMESPACE_NODE,
    NamespaceNode,
    PROCESSING_INSTRUCTION_NODE,
    TEXT_NODE,
    XML_NAMESPACE_URI
} from './dom.ts';
import type { DomNode } from './dom.ts';
import type { Compiled, EvalState, Focus } from './runtime.ts';
import { toBooleanValue } from './runtime.ts';

export type Matcher = (node: DomNode, state: EvalState) => boolean;

export interface CompiledPredicate {
    readonly run: Compiled;
    /** May depend on the context position or size (or its type is not known statically). */
    readonly positional: boolean;
    /** The predicate is the number literal k: `[k]`. */
    readonly index: number | null;
    /** The predicate is exactly `last()`. */
    readonly isLast: boolean;
}

export interface CompiledStep {
    readonly axis: Axis;
    readonly match: Matcher;
    readonly predicates: readonly CompiledPredicate[];
    readonly positional: boolean;
}

/** The context list between steps. */
export interface NodeList {
    nodes: readonly DomNode[];
    ordered: boolean;
    flat: boolean;
}

// ---- node tests (XPath 1.0 section 2.3) ----

function hasPrefix(node: DomNode): boolean {
    return Boolean(node.prefix) || node.nodeName.includes(':');
}

/**
 * Q-TEST-1: a name test accepts elements, attributes and namespace nodes on every axis (upstream has no notion of
 * the principal node type), `node()` does not accept namespace nodes, and an unprefixed name matches only a node
 * with no namespace URI (or, with allowAnyNamespaceForNoPrefix, any node without a prefix).
 */
export function compileNodeTest(test: NodeTest): Matcher {
    switch (test.kind) {
        case 'any':
            return (node) => {
                const type = node.nodeType;
                return type === ELEMENT_NODE || type === ATTRIBUTE_NODE || type === NAMESPACE_NODE;
            };
        case 'node':
            return (node) => {
                const type = node.nodeType;
                return (
                    (type >= ELEMENT_NODE && type <= CDATA_SECTION_NODE) ||
                    (type >= PROCESSING_INSTRUCTION_NODE && type <= DOCUMENT_NODE)
                );
            };
        case 'text':
            return (node) => node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
        case 'comment':
            return (node) => node.nodeType === COMMENT_NODE;
        case 'pi':
            return (node) => node.nodeType === PROCESSING_INSTRUCTION_NODE;
        case 'piTarget': {
            const { target } = test;
            return (node) => node.nodeType === PROCESSING_INSTRUCTION_NODE && (node.target || node.nodeName) === target;
        }
        case 'prefixAny': {
            const { prefix } = test;
            return (node, state) => {
                const type = node.nodeType;
                if (type !== ELEMENT_NODE && type !== ATTRIBUTE_NODE) return false;
                return state.resolveNameTestPrefix(prefix) === (node.namespaceURI || '');
            };
        }
        case 'name': {
            const { prefix, localName } = test;
            const lower = localName.toLowerCase();
            const localMatches = (node: DomNode, state: EvalState): boolean => {
                const actual = node.localName || node.nodeName;
                return state.caseInsensitive ? actual.toLowerCase() === lower : actual === localName;
            };
            if (prefix === null) {
                return (node, state) => {
                    const type = node.nodeType;
                    if (type !== ELEMENT_NODE && type !== ATTRIBUTE_NODE && type !== NAMESPACE_NODE) return false;
                    if (node.namespaceURI && !(state.allowAnyNamespaceForNoPrefix && !hasPrefix(node))) return false;
                    return localMatches(node, state);
                };
            }
            return (node, state) => {
                const type = node.nodeType;
                if (type !== ELEMENT_NODE && type !== ATTRIBUTE_NODE && type !== NAMESPACE_NODE) return false;
                if (state.resolveNameTestPrefix(prefix) !== (node.namespaceURI || '')) return false;
                return localMatches(node, state);
            };
        }
        case 'never':
            return () => false;
    }
}

// ---- helpers ----

function isTreeNode(node: DomNode): boolean {
    return node.nodeType !== ATTRIBUTE_NODE && node.nodeType !== NAMESPACE_NODE;
}

/** Parent on the parent/ancestor axes: an attribute's owner element; Q-AXIS-1: a namespace node has none. */
function axisParent(node: DomNode, strict: boolean): DomNode | null {
    if (node.nodeType === ATTRIBUTE_NODE) return node.ownerElement ?? null;
    // Q-AXIS-1: upstream's namespace node has no parent. XPath 1.0 section 5.4: its parent is the element.
    if (strict && node.nodeType === NAMESPACE_NODE) return node.ownerElement ?? null;
    return node.parentNode ?? null;
}

/** The node an attribute or namespace node hangs from; a tree node is its own place in the tree. */
function anchorOf(node: DomNode): DomNode {
    return node.nodeType === ATTRIBUTE_NODE || node.nodeType === NAMESPACE_NODE ? (node.ownerElement ?? node) : node;
}

/** Strict: a namespace declaration (`xmlns`, `xmlns:p`) is not an attribute of the element (section 5.3). */
function isNamespaceDeclaration(attribute: DomNode): boolean {
    const name = String(attribute.name ?? attribute.nodeName);
    return name === 'xmlns' || name.startsWith('xmlns:');
}

/** Next node of a pre-order walk that stays inside the subtree of `root`. */
function following(node: DomNode, root: DomNode): DomNode | null {
    const child = node.firstChild;
    if (child != null) return child;
    let current = node;
    while (current !== root) {
        const sibling = current.nextSibling;
        if (sibling != null) return sibling;
        const parent = current.parentNode;
        if (parent == null) return null;
        current = parent;
    }
    return null;
}

/**
 * The node before `node` in document order: the deepest last descendant of its previous sibling, else its parent. A
 * reverse axis is read this way, nearest first, so `preceding::x[1]` stops at the nearest x instead of walking the
 * document from its root and reversing the list.
 */
function before(node: DomNode): DomNode | null {
    let previous = node.previousSibling;
    if (previous == null) return node.parentNode ?? null;
    for (let last = previous.lastChild; last != null; last = previous.lastChild) previous = last;
    return previous;
}

/** The ancestors of a node (the preceding axis of section 2.2 does not contain them). */
function ancestorsOf(node: DomNode): Set<DomNode> {
    const ancestors = new Set<DomNode>();
    for (let up = node.parentNode; up != null; up = up.parentNode) ancestors.add(up);
    return ancestors;
}

/** Next node of a pre-order walk that skips the subtree of `node`. */
function followingSkippingSubtree(node: DomNode, root: DomNode): DomNode | null {
    let current = node;
    while (current !== root) {
        const sibling = current.nextSibling;
        if (sibling != null) return sibling;
        const parent = current.parentNode;
        if (parent == null) return null;
        current = parent;
    }
    return null;
}

function prefixOfDeclaration(attribute: DomNode): string | null {
    const name = String(attribute.name ?? attribute.nodeName);
    if (name === 'xmlns') return '';
    return name.startsWith('xmlns:') ? name.slice(6) : null;
}

/**
 * The namespace axis. Q-AXIS-2: `xml` first, then every `xmlns` attribute from the element outwards, nearest
 * declaration of a prefix winning; an `xmlns=""` undeclaration still yields a node; each call makes new node objects.
 */
function namespaceNodes(element: DomNode, state: EvalState): NamespaceNode[] {
    const out: NamespaceNode[] = [];
    if (element.nodeType !== ELEMENT_NODE) return out;
    const seen = new Set<string>(['xml']);
    // The bindings first (charging the walk), the nodes after: a deep document with a new prefix per level has N bindings
    // in scope at the deepest element, and every element on the way down makes a node for each of them.
    const declarations: { prefix: string; attribute: DomNode; local: number }[] = [];
    for (
        let current: DomNode | null | undefined = element;
        current != null && current.nodeType === ELEMENT_NODE;
        current = current.parentNode
    ) {
        const attributes = current.attributes;
        const count = attributes?.length ?? 0;
        state.charge(count + 1);
        for (let i = 0; i < count; i++) {
            const attribute = attributes?.item(i);
            if (attribute == null) continue;
            const prefix = prefixOfDeclaration(attribute);
            if (prefix === null || seen.has(prefix)) continue;
            seen.add(prefix);
            declarations.push({ prefix, attribute, local: current === element ? i : -1 });
        }
    }
    state.chargeNamespaceNodes(declarations.length + 1);
    if (state.strict) {
        // Section 5.4: one node per binding in scope, made once (a node-set holds it once however it is reached), and
        // no node for `xmlns=""`, which says there is no default namespace.
        out.push(state.internedNamespaceNode(element, 'xml', null, XML_NAMESPACE_URI, -1));
        for (const { prefix, attribute, local } of declarations) {
            const uri = attribute.value ?? '';
            if (prefix === '' && uri === '') continue;
            out.push(state.internedNamespaceNode(element, prefix, attribute, uri, local));
        }
        return out;
    }
    out.push(new NamespaceNode('xml', null, XML_NAMESPACE_URI, element, -1));
    for (const { prefix, attribute, local } of declarations)
        out.push(new NamespaceNode(prefix, attribute, attribute.value ?? '', element, local));
    return out;
}

// ---- one context node: the axis in axis order (reverse axes nearest first) ----

const REVERSE_AXES: ReadonlySet<Axis> = new Set<Axis>([
    'ancestor',
    'ancestor-or-self',
    'parent',
    'preceding',
    'preceding-sibling'
]);

function walkSubtrees(start: DomNode | null | undefined, step: CompiledStep, state: EvalState, out: DomNode[]): number {
    // `start` and each of its following siblings, with their subtrees, in document order.
    let visits = 0;
    for (let top: DomNode | null | undefined = start; top != null; top = top.nextSibling) {
        for (let node: DomNode | null = top; node !== null; node = following(node, top)) {
            visits++;
            if (step.match(node, state)) out.push(node);
        }
    }
    return visits;
}

function axisOf(step: CompiledStep, context: DomNode, state: EvalState, out: DomNode[]): void {
    const { match } = step;
    let visits = 1;
    switch (step.axis) {
        case 'child':
            for (let node = context.firstChild; node != null; node = node.nextSibling) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        case 'attribute': {
            const attributes = context.attributes;
            const count = attributes?.length ?? 0;
            for (let i = 0; i < count; i++) {
                const attribute = attributes?.item(i);
                if (
                    attribute != null &&
                    match(attribute, state) &&
                    !(state.strict && isNamespaceDeclaration(attribute))
                )
                    out.push(attribute);
            }
            visits += count;
            break;
        }
        case 'self':
            if (match(context, state)) out.push(context);
            break;
        case 'parent': {
            const parent = axisParent(context, state.strict);
            if (parent !== null && match(parent, state)) out.push(parent);
            break;
        }
        case 'ancestor':
        case 'ancestor-or-self':
            for (
                let node = step.axis === 'ancestor' ? axisParent(context, state.strict) : context;
                node !== null;
                node = axisParent(node, state.strict)
            ) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        case 'descendant-or-self':
        case 'descendant': {
            if (step.axis === 'descendant-or-self' && match(context, state)) out.push(context);
            const first = context.firstChild;
            for (let node: DomNode | null = first ?? null; node !== null; node = following(node, context)) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        }
        case 'following-sibling':
            for (let node = context.nextSibling; node != null; node = node.nextSibling) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        case 'preceding-sibling':
            for (let node = context.previousSibling; node != null; node = node.previousSibling) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        case 'following': {
            // Q-AXIS-3: upstream starts at the first child when there is one (so the context's own descendants are
            // "following" and its following siblings are not), else at the next sibling; then, for every ancestor
            // below the document node, at that ancestor's next sibling.
            if (state.strict) {
                // Section 2.2: everything after the context in document order except its descendants: the following
                // siblings of the node and of each ancestor, with their subtrees. An attribute or namespace node
                // comes after its element and before the element's children, so for it the children are following.
                const place = anchorOf(context);
                if (place !== context) visits += walkSubtrees(place.firstChild, step, state, out);
                visits += walkSubtrees(place.nextSibling, step, state, out);
                for (let up = place.parentNode; up != null && up.nodeType !== DOCUMENT_NODE; up = up.parentNode) {
                    visits += walkSubtrees(up.nextSibling, step, state, out);
                }
                break;
            }
            visits += walkSubtrees(context.firstChild ?? context.nextSibling, step, state, out);
            for (let up = context.parentNode; up != null && up.nodeType !== DOCUMENT_NODE; up = up.parentNode) {
                visits += walkSubtrees(up.nextSibling, step, state, out);
            }
            break;
        }
        case 'preceding': {
            // Q-AXIS-4: everything before the context in document order, ancestors and the root included; nothing
            // for an attribute or a namespace node (they are their own root here). Nearest first, as the axis is read.
            if (state.strict) {
                // Section 2.2: before the context in document order, ancestors excluded; an attribute or a namespace
                // node stands where its element stands.
                const place = anchorOf(context);
                const ancestors = ancestorsOf(place);
                visits += ancestors.size;
                for (let node = before(place); node !== null; node = before(node)) {
                    visits++;
                    if (!ancestors.has(node) && match(node, state)) out.push(node);
                }
                break;
            }
            for (let node = before(context); node !== null; node = before(node)) {
                visits++;
                if (match(node, state)) out.push(node);
            }
            break;
        }
        case 'namespace':
            for (const node of namespaceNodes(context, state)) if (match(node, state)) out.push(node);
            break;
        case 'unknown':
            break;
    }
    state.charge(visits);
}

/** The k-th node (1-based) of the axis that passes the test, walking no further than needed. */
function nthOnAxis(step: CompiledStep, context: DomNode, k: number, state: EvalState): DomNode | null {
    const { match } = step;
    let left = k;
    let visits = 1;
    let found: DomNode | null = null;
    switch (step.axis) {
        case 'child':
            for (let node = context.firstChild; node != null; node = node.nextSibling) {
                visits++;
                if (match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        case 'following-sibling':
            for (let node = context.nextSibling; node != null; node = node.nextSibling) {
                visits++;
                if (match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        case 'preceding-sibling':
            for (let node = context.previousSibling; node != null; node = node.previousSibling) {
                visits++;
                if (match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        case 'ancestor':
        case 'ancestor-or-self':
            for (
                let node = step.axis === 'ancestor' ? axisParent(context, state.strict) : context;
                node !== null;
                node = axisParent(node, state.strict)
            ) {
                visits++;
                if (match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        case 'descendant':
        case 'descendant-or-self': {
            if (step.axis === 'descendant-or-self' && match(context, state) && --left === 0) {
                found = context;
                break;
            }
            for (
                let node: DomNode | null = context.firstChild ?? null;
                node !== null;
                node = following(node, context)
            ) {
                visits++;
                if (match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        }
        case 'preceding': {
            const place = state.strict ? anchorOf(context) : context;
            const ancestors = state.strict ? ancestorsOf(place) : null;
            visits += ancestors?.size ?? 0;
            for (let node = before(place); node !== null; node = before(node)) {
                visits++;
                if (ancestors?.has(node) !== true && match(node, state) && --left === 0) {
                    found = node;
                    break;
                }
            }
            break;
        }
        default: {
            const all: DomNode[] = [];
            axisOf(step, context, state, all);
            found = all[k - 1] ?? null;
            break;
        }
    }
    state.charge(visits);
    return found;
}

/** Axes whose last node in axis order can be found from the far end, without listing the whole axis. */
const LAST_FROM_THE_FAR_END: ReadonlySet<Axis> = new Set<Axis>([
    'child',
    'descendant',
    'following-sibling',
    'preceding-sibling',
    'preceding'
]);

/**
 * The last node of the axis (in axis order) that passes the test, searched from the end that is cheap: the far
 * siblings, the far end of the document before the context, the last descendants. `[last()]` is then a walk to the
 * first hit from that end, not a listing of the axis.
 */
function lastOnAxis(step: CompiledStep, context: DomNode, state: EvalState): DomNode | null {
    let visits = 1;
    let found: DomNode | null = null;
    const { match } = step;
    switch (step.axis) {
        case 'child':
            for (let node = context.lastChild; node != null; node = node.previousSibling) {
                visits++;
                if (match(node, state)) {
                    found = node;
                    break;
                }
            }
            break;
        case 'following-sibling':
            for (
                let node = context.parentNode?.lastChild;
                node != null && node !== context;
                node = node.previousSibling
            ) {
                visits++;
                if (match(node, state)) {
                    found = node;
                    break;
                }
            }
            break;
        case 'preceding-sibling':
            // Axis order is nearest first, so the last is the first sibling of the parent that matches.
            for (let node = context.parentNode?.firstChild; node != null && node !== context; node = node.nextSibling) {
                visits++;
                if (match(node, state)) {
                    found = node;
                    break;
                }
            }
            break;
        case 'descendant': {
            let end: DomNode = context;
            for (let last = end.lastChild; last != null; last = end.lastChild) end = last;
            for (let node: DomNode | null = end; node !== null && node !== context; node = before(node)) {
                visits++;
                if (match(node, state)) {
                    found = node;
                    break;
                }
            }
            break;
        }
        case 'preceding': {
            // The farthest node before the context is the first matching one from the top of its tree.
            let root = context;
            for (let up = root.parentNode; up != null; up = up.parentNode) root = up;
            for (let node: DomNode | null = root; node !== null && node !== context; node = following(node, root)) {
                visits++;
                if (match(node, state)) {
                    found = node;
                    break;
                }
            }
            break;
        }
        default:
            break;
    }
    state.charge(visits);
    return found;
}

// ---- predicates (XPath 1.0 section 2.4) ----

function holds(predicate: CompiledPredicate, focus: Focus, state: EvalState): boolean {
    const value = predicate.run(focus, state);
    return typeof value === 'number' ? focus.position === value : toBooleanValue(value);
}

/** Applies the predicates from `from` on, in order, to candidates given in axis order. */
export function filterByPredicates(
    candidates: readonly DomNode[],
    predicates: readonly CompiledPredicate[],
    from: number,
    focus: Focus,
    state: EvalState
): readonly DomNode[] {
    let current = candidates;
    for (let p = from; p < predicates.length && current.length > 0; p++) {
        const predicate = predicates[p];
        if (predicate === undefined) break;
        const kept: DomNode[] = [];
        focus.size = current.length;
        for (let at = 0; at < current.length; at++) {
            const node = current[at];
            if (node === undefined) break;
            focus.node = node;
            focus.position = at + 1;
            if (holds(predicate, focus, state)) kept.push(node);
        }
        current = kept;
    }
    return current;
}

function passesAll(node: DomNode, step: CompiledStep, focus: Focus, state: EvalState): boolean {
    if (!step.match(node, state)) return false;
    const { predicates } = step;
    // Indexed, with the bounds check written as a guard the compiler can see (see bench/index-access.ts).
    for (let p = 0; p < predicates.length; p++) {
        const predicate = predicates[p];
        if (predicate === undefined) break;
        focus.node = node;
        focus.position = 1;
        focus.size = 1;
        if (!toBooleanValue(predicate.run(focus, state))) return false;
    }
    return true;
}

// ---- focus mode: per context node ----

function applyPerContext(step: CompiledStep, list: NodeList, state: EvalState): void {
    const input = list.nodes;
    const { axis, predicates } = step;
    const single = input.length === 1;
    const focus: Focus = { node: input[0] ?? state.settings.contextNode, position: 1, size: 1 };
    const first = predicates[0];
    const out: DomNode[] = [];
    // Different context nodes can reach the same node on every axis but these.
    const distinct = single || axis === 'child' || axis === 'attribute' || axis === 'self' || axis === 'namespace';
    const seen = distinct ? null : new Set<DomNode>();
    const emit = (node: DomNode): void => {
        if (seen === null) out.push(node);
        else if (!seen.has(node)) {
            seen.add(node);
            out.push(node);
        }
    };
    const shortcut =
        state.pure &&
        first !== undefined &&
        axis !== 'namespace' &&
        (first.index !== null ||
            (first.isLast && LAST_FROM_THE_FAR_END.has(axis) && !(state.strict && axis === 'preceding')));
    for (let c = 0; c < input.length; c++) {
        const context = input[c];
        if (context === undefined) break;
        let kept: readonly DomNode[];
        if (shortcut && first !== undefined) {
            const k = first.index;
            const hit =
                k === null
                    ? lastOnAxis(step, context, state)
                    : Number.isInteger(k) && k >= 1
                      ? nthOnAxis(step, context, k, state)
                      : // No node can be the k-th, but upstream still applies the node test to the candidates (and fails
                        // on a prefix it cannot resolve), so the first one is tested.
                        (nthOnAxis(step, context, 1, state), null);
            kept = hit === null ? [] : filterByPredicates([hit], predicates, 1, focus, state);
        } else {
            const candidates: DomNode[] = [];
            axisOf(step, context, state, candidates);
            // Upstream sorts the candidates before it applies the predicates, which is where it fails on namespace nodes.
            if (axis === 'namespace' && predicates.length > 0 && candidates.length > 1) state.sort(candidates);
            kept = filterByPredicates(candidates, predicates, 0, focus, state);
        }
        for (let k = 0; k < kept.length; k++) {
            const node = kept[k];
            if (node !== undefined) emit(node);
        }
    }
    if (single) {
        if (REVERSE_AXES.has(axis)) out.reverse();
        list.ordered = axis !== 'namespace';
    } else {
        list.ordered =
            (axis === 'child' && list.ordered && list.flat) ||
            ((axis === 'attribute' || axis === 'self') && list.ordered);
    }
    list.flat =
        axis === 'self'
            ? list.flat
            : axis === 'attribute' || (axis === 'child' && list.flat) || (single && isFlatAxis(axis));
    list.nodes = out;
}

function isFlatAxis(axis: Axis): boolean {
    return (
        axis === 'child' ||
        axis === 'attribute' ||
        axis === 'parent' ||
        axis === 'following-sibling' ||
        axis === 'preceding-sibling' ||
        axis === 'unknown'
    );
}

// ---- set mode: the whole context list at once ----

function applyToSet(step: CompiledStep, list: NodeList, state: EvalState): void {
    const input = list.nodes;
    const { axis } = step;
    const single = input.length === 1;
    const focus: Focus = { node: input[0] ?? state.settings.contextNode, position: 1, size: 1 };
    const out: DomNode[] = [];
    let visits = input.length;
    switch (axis) {
        case 'child':
            for (let c = 0; c < input.length; c++) {
                const context = input[c];
                if (context === undefined) break;
                for (let node = context.firstChild; node != null; node = node.nextSibling) {
                    visits++;
                    if (passesAll(node, step, focus, state)) out.push(node);
                }
            }
            list.ordered = list.ordered && list.flat;
            break;
        case 'attribute':
            for (let c = 0; c < input.length; c++) {
                const context = input[c];
                if (context === undefined) break;
                const attributes = context.attributes;
                const count = attributes?.length ?? 0;
                visits += count;
                for (let i = 0; i < count; i++) {
                    const attribute = attributes?.item(i);
                    if (
                        attribute != null &&
                        !(state.strict && isNamespaceDeclaration(attribute)) &&
                        passesAll(attribute, step, focus, state)
                    )
                        out.push(attribute);
                }
            }
            list.flat = true;
            break;
        case 'self':
            for (const context of input) if (passesAll(context, step, focus, state)) out.push(context);
            break;
        case 'descendant':
        case 'descendant-or-self': {
            const orSelf = axis === 'descendant-or-self';
            if (list.ordered && input.every(isTreeNode)) {
                // Ordered contexts: a context inside the subtree being walked is met by the walk, in order, and is
                // then already covered. One pass, output in document order.
                let at = 0;
                while (at < input.length) {
                    const context = input[at++];
                    if (context === undefined) break;
                    if (orSelf && passesAll(context, step, focus, state)) out.push(context);
                    for (
                        let node: DomNode | null = context.firstChild ?? null;
                        node !== null;
                        node = following(node, context)
                    ) {
                        visits++;
                        if (node === input[at]) at++;
                        if (passesAll(node, step, focus, state)) out.push(node);
                    }
                }
                list.ordered = true;
            } else {
                // Any order: remember what was walked and never walk a subtree twice.
                const walked = new Set<DomNode>();
                for (const context of input) {
                    if (orSelf && !walked.has(context)) {
                        walked.add(context);
                        if (passesAll(context, step, focus, state)) out.push(context);
                    }
                    let node: DomNode | null = context.firstChild ?? null;
                    while (node !== null) {
                        visits++;
                        if (walked.has(node)) {
                            node = followingSkippingSubtree(node, context);
                            continue;
                        }
                        walked.add(node);
                        if (passesAll(node, step, focus, state)) out.push(node);
                        node = following(node, context);
                    }
                }
                list.ordered = false;
            }
            list.flat = false;
            break;
        }
        case 'parent': {
            const seen = new Set<DomNode>();
            for (const context of input) {
                const parent = axisParent(context, state.strict);
                if (parent === null || seen.has(parent)) continue;
                seen.add(parent);
                if (passesAll(parent, step, focus, state)) out.push(parent);
            }
            list.ordered = single;
            list.flat = single;
            break;
        }
        case 'ancestor':
        case 'ancestor-or-self': {
            // Climb from each context and stop at the first node an earlier climb already passed.
            const climbed = new Set<DomNode>();
            for (const context of input) {
                for (
                    let node = axis === 'ancestor' ? axisParent(context, state.strict) : context;
                    node !== null && !climbed.has(node);
                    node = axisParent(node, state.strict)
                ) {
                    visits++;
                    climbed.add(node);
                    if (passesAll(node, step, focus, state)) out.push(node);
                }
            }
            if (single) out.reverse();
            list.ordered = single;
            list.flat = false;
            break;
        }
        case 'following-sibling':
        case 'preceding-sibling': {
            const forward = axis === 'following-sibling';
            const walked = single ? null : new Set<DomNode>();
            for (const context of input) {
                for (
                    let node = forward ? context.nextSibling : context.previousSibling;
                    node != null;
                    node = forward ? node.nextSibling : node.previousSibling
                ) {
                    visits++;
                    if (walked !== null) {
                        if (walked.has(node)) break;
                        walked.add(node);
                    }
                    if (passesAll(node, step, focus, state)) out.push(node);
                }
            }
            if (single && !forward) out.reverse();
            list.ordered = single;
            list.flat = single;
            break;
        }
        case 'following':
            visits += followingOfSet(step, input, focus, state, out);
            list.ordered = true;
            list.flat = false;
            break;
        case 'preceding':
            visits += precedingOfSet(step, input, focus, state, out, list);
            list.flat = false;
            break;
        case 'namespace':
            for (const context of input) {
                // Upstream sorts the nodes that pass the node test before it applies the predicates, which is where it
                // fails on namespace nodes (Q-NS-ORDER): the test first, then the sort, then the predicates.
                const candidates = namespaceNodes(context, state).filter((node) => step.match(node, state));
                if (step.predicates.length > 0 && candidates.length > 1) state.sort(candidates);
                for (const node of candidates) if (passesAll(node, step, focus, state)) out.push(node);
            }
            list.ordered = false;
            list.flat = true;
            break;
        case 'unknown':
            break;
    }
    state.charge(visits);
    list.nodes = out;
}

/**
 * following:: for a whole list in one walk of the tree (upstream's meaning of the axis, see Q-AXIS-3). Each context
 * contributes "start" nodes; a node is selected when it, or one of its ancestors, is a start or a later sibling of one.
 */
function followingOfSet(
    step: CompiledStep,
    input: readonly DomNode[],
    focus: Focus,
    state: EvalState,
    out: DomNode[]
): number {
    const starts = new Set<DomNode>();
    const climbed = new Set<DomNode>();
    let anchor: DomNode | null = null;
    for (const context of input) {
        // Strict (section 2.2): the following siblings, not the descendants; an attribute or namespace node stands
        // before its element's children, which therefore follow it.
        const place = state.strict ? anchorOf(context) : context;
        if (state.strict) {
            if (place !== context && place.firstChild != null) starts.add(place.firstChild);
            if (place.nextSibling != null) starts.add(place.nextSibling);
        } else {
            const start = context.firstChild ?? context.nextSibling;
            if (start != null) starts.add(start);
        }
        if (anchor === null && isTreeNode(place)) anchor = place;
        for (
            let up = place.parentNode;
            up != null && up.nodeType !== DOCUMENT_NODE && !climbed.has(up);
            up = up.parentNode
        ) {
            climbed.add(up);
            const sibling = up.nextSibling;
            if (sibling != null) starts.add(sibling);
        }
    }
    if (anchor === null || starts.size === 0) return 0;
    let root = anchor;
    for (let up = root.parentNode; up != null; up = up.parentNode) root = up;
    // Pre-order walk with one flag per depth: "the siblings from here on, at this depth, are selected".
    let visits = 0;
    let found = 0;
    let depth = 0;
    let tail: boolean[] = [false];
    let node: DomNode | null = root;
    // `inherited[d]` is true when an ancestor at a smaller depth is selected.
    let inherited: boolean[] = [false];
    while (node !== null) {
        visits++;
        if (starts.has(node)) {
            tail[depth] = true;
            found++;
        }
        const selected = inherited[depth] === true || tail[depth] === true;
        if (selected && passesAll(node, step, focus, state)) out.push(node);
        const child: DomNode | null | undefined = node.firstChild;
        if (child != null) {
            depth++;
            inherited[depth] = selected;
            tail[depth] = false;
            node = child;
            continue;
        }
        let next: DomNode | null = null;
        let current: DomNode = node;
        while (current !== root) {
            const sibling = current.nextSibling;
            if (sibling != null) {
                next = sibling;
                break;
            }
            const parent = current.parentNode;
            if (parent == null) break;
            current = parent;
            depth--;
        }
        node = next;
    }
    if (found !== starts.size) {
        // Contexts from more than one tree: fall back to one walk per context.
        out.length = 0;
        tail = [];
        inherited = [];
        const seen = new Set<DomNode>();
        for (const context of input) {
            const each: DomNode[] = [];
            axisOf(step, context, state, each);
            for (const candidate of each) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                if (passesAll(candidate, step, focus, state)) out.push(candidate);
            }
        }
    }
    return visits;
}

/** preceding:: for a whole list (Q-AXIS-4): everything before the last context in document order, in one walk. */
function precedingOfSet(
    step: CompiledStep,
    input: readonly DomNode[],
    focus: Focus,
    state: EvalState,
    out: DomNode[],
    list: NodeList
): number {
    const pending = new Set<DomNode>();
    for (const context of input) if (isTreeNode(context)) pending.add(context);
    let visits = 0;
    let trees = 0;
    // One walk per tree; contexts of one tree (the only case that occurs in practice) need exactly one.
    for (const context of input) {
        if (!pending.has(context)) continue;
        let root = context;
        for (let up = root.parentNode; up != null; up = up.parentNode) root = up;
        trees++;
        let cut = out.length;
        for (let node: DomNode | null = root; node !== null; node = following(node, root)) {
            visits++;
            if (pending.delete(node)) {
                cut = out.length;
                // The last context is not before itself: its predicates must not be evaluated on it (upstream
                // never does, and a predicate such as lang() can throw on a node that is no candidate).
                if (pending.size === 0) break;
            }
            if (passesAll(node, step, focus, state)) out.push(node);
        }
        out.length = cut;
    }
    list.ordered = trees < 2;
    return visits;
}

const isNodeTestNode = compileNodeTest({ kind: 'node' });

/**
 * `//T` and `//@T`: the pair `descendant-or-self::node()/child::T` (or `/attribute::T`) in one ordered walk, when T's
 * predicates are not positional. Not rewritten to `descendant::T`: upstream's `node()` rejects a DocumentFragment, a
 * DocumentType and an EntityReference, so their children are not reached through `//` (Q-TEST-2); the walk checks the
 * parent the same way. Returns false when the list is not an ordered list of tree nodes; the caller then applies the
 * two steps one after the other.
 */
export function applyDescendantPair(step: CompiledStep, list: NodeList, state: EvalState): boolean {
    const input = list.nodes;
    if (!state.pure || step.positional || !list.ordered || !input.every(isTreeNode)) return false;
    const focus: Focus = { node: input[0] ?? state.settings.contextNode, position: 1, size: 1 };
    const out: DomNode[] = [];
    const attributes = step.axis === 'attribute';
    let visits = input.length;
    const emitAttributes = (owner: DomNode): void => {
        const map = owner.attributes;
        const count = map?.length ?? 0;
        visits += count;
        for (let i = 0; i < count; i++) {
            const attribute = map?.item(i);
            if (
                attribute != null &&
                !(state.strict && isNamespaceDeclaration(attribute)) &&
                passesAll(attribute, step, focus, state)
            )
                out.push(attribute);
        }
    };
    let at = 0;
    while (at < input.length) {
        const context = input[at++];
        if (context === undefined) break;
        if (attributes && isNodeTestNode(context, state)) emitAttributes(context);
        for (let node: DomNode | null = context.firstChild ?? null; node !== null; node = following(node, context)) {
            visits++;
            if (node === input[at]) at++;
            if (attributes) {
                if (isNodeTestNode(node, state)) emitAttributes(node);
            } else {
                const parent = node.parentNode;
                if (parent != null && isNodeTestNode(parent, state) && passesAll(node, step, focus, state))
                    out.push(node);
            }
        }
    }
    state.charge(visits);
    list.nodes = out;
    list.ordered = true;
    list.flat = attributes;
    return true;
}

/** Applies one step to the list, in place. */
export function applyStep(step: CompiledStep, list: NodeList, state: EvalState): void {
    if (list.nodes.length === 0) return;
    // Strict: the preceding axis excludes ancestors, which the one-sweep set form (upstream's meaning of the axis) does not.
    if (step.positional || !state.pure || (state.strict && step.axis === 'preceding'))
        applyPerContext(step, list, state);
    else applyToSet(step, list, state);
}
