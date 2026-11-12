// Document order by numbering, not by pairwise comparison.
//
// One pre-order walk of the tree gives every tree node an integer. Attributes and namespace nodes get a key between
// their element's integer and its first child's: XPath 1.0 section 5 orders an element, then its namespace nodes,
// then its attributes, then its children. Attribute keys are computed per owner element, the first time an attribute
// of that element is asked for, so a tree is never charged for attributes nobody sorts.
//
// Keys never leave this class (no branded number type: a brand needs an `as` cast, which the code base bans).
// A Numbering is valid only while the tree does not change; the owner (EvalState) decides how long it lives.

import { ATTRIBUTE_NODE, isNamespaceNode, treeRoot, XML_NAMESPACE_URI } from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathOrderError } from './errors.ts';

export class Numbering {
    readonly #root: DomNode;
    readonly #index = new Map<DomNode, number>();
    readonly #byIndex: DomNode[] = [];
    readonly #attributeKeys = new Map<DomNode, number>();

    constructor(anyNode: DomNode) {
        const root = treeRoot(anyNode);
        this.#root = root;
        const index = this.#index;
        const byIndex = this.#byIndex;
        let node: DomNode | null | undefined = root;
        // Iterative pre-order walk through parent pointers: no recursion, no stack array, any depth.
        while (node != null) {
            index.set(node, byIndex.length);
            byIndex.push(node);
            let next: DomNode | null | undefined = node.firstChild;
            while (next == null && node != null && node !== root) {
                next = node.nextSibling;
                if (next == null) node = node.parentNode;
            }
            node = next;
        }
    }

    /** Number of tree nodes numbered: the cost of building this numbering. */
    get size(): number {
        return this.#byIndex.length;
    }

    get root(): DomNode {
        return this.#root;
    }

    #keyOf(node: DomNode): number | undefined {
        const own = this.#index.get(node);
        if (own !== undefined) return own;
        if (isNamespaceNode(node)) {
            const base = this.#index.get(node.ownerElement);
            if (base === undefined) return undefined;
            const count = node.ownerElement.attributes?.length ?? 0;
            // `xml` first, then the bindings declared on the element in attribute order, then inherited ones.
            const slot =
                node.nodeValue === XML_NAMESPACE_URI ? 0 : node.localIndex >= 0 ? node.localIndex + 1 : count + 1;
            return base + (0.25 * (slot + 1)) / (count + 3);
        }
        if (node.nodeType !== ATTRIBUTE_NODE) return undefined;
        const cached = this.#attributeKeys.get(node);
        if (cached !== undefined) return cached;
        const owner = node.ownerElement;
        if (owner == null) return undefined;
        const base = this.#index.get(owner);
        const attributes = owner.attributes;
        if (base === undefined || attributes == null) return undefined;
        const count = attributes.length;
        for (let i = 0; i < count; i++) {
            const attribute = attributes.item(i);
            if (attribute != null) this.#attributeKeys.set(attribute, base + 0.25 + (0.5 * (i + 1)) / (count + 1));
        }
        return this.#attributeKeys.get(node);
    }

    /**
     * Returns the nodes in document order, or null when one of them is not in this tree.
     * The input must be free of duplicates. O(n log n) on numeric keys, or O(N + n) by a sweep when n is a large
     * share of the tree (N tree nodes).
     */
    sort(nodes: readonly DomNode[]): DomNode[] | null {
        const n = nodes.length;
        const keys = new Float64Array(n);
        let integral = true;
        let namespaces = false;
        for (let i = 0; i < n; i++) {
            const node = nodes[i];
            if (node === undefined) break;
            // Tree nodes (the common case) are answered by one Map lookup; the rest take the slow path.
            const key = this.#index.get(node) ?? this.#keyOf(node);
            if (key === undefined) return null;
            if (!Number.isInteger(key)) {
                integral = false;
                if (isNamespaceNode(node)) namespaces = true;
            }
            keys[i] = key;
        }
        const byIndex = this.#byIndex;
        const out: DomNode[] = [];
        if (integral) {
            const total = byIndex.length;
            if (n * 8 > total) {
                const marks = new Uint8Array(total);
                for (let i = 0; i < n; i++) {
                    const key = keys[i];
                    if (key !== undefined) marks[key] = 1;
                }
                for (let at = 0; at < total; at++) {
                    if (marks[at] !== 1) continue;
                    const node = byIndex[at];
                    if (node !== undefined) out.push(node);
                }
                return out;
            }
            keys.sort();
            for (let i = 0; i < n; i++) {
                const key = keys[i];
                if (key === undefined) break;
                const node = byIndex[key];
                if (node !== undefined) out.push(node);
            }
            return out;
        }
        const byKey = new Map<number, DomNode>();
        let collision = false;
        for (let i = 0; i < n; i++) {
            const key = keys[i];
            const node = nodes[i];
            if (key === undefined || node === undefined) break;
            if (byKey.has(key)) collision = true;
            byKey.set(key, node);
        }
        if (!collision) {
            keys.sort();
            for (let i = 0; i < n; i++) {
                const key = keys[i];
                if (key === undefined) break;
                const node = byKey.get(key);
                if (node !== undefined) out.push(node);
            }
        } else {
            // Two namespace-node objects for one binding share a key; keep both, in a stable order.
            const order = Array.from(nodes.keys());
            order.sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0) || a - b);
            for (const at of order) {
                const node = nodes[at];
                if (node !== undefined) out.push(node);
            }
        }
        if (namespaces) assertNamespaceOrderDefined(out);
        return out;
    }

    /**
     * Union of two arrays that are each in document order and free of duplicates: a two-pointer merge on the keys,
     * O(n + m). Null when a node is not in this tree, or is a namespace node (those must go through `sort`, which
     * checks that their order is defined).
     */
    merge(a: readonly DomNode[], b: readonly DomNode[]): DomNode[] | null {
        const out: DomNode[] = [];
        let i = 0;
        let j = 0;
        let x = a[0];
        let y = b[0];
        let kx = x === undefined || isNamespaceNode(x) ? undefined : this.#keyOf(x);
        let ky = y === undefined || isNamespaceNode(y) ? undefined : this.#keyOf(y);
        while (x !== undefined && y !== undefined) {
            if (kx === undefined || ky === undefined) return null;
            if (kx <= ky) {
                out.push(x);
                if (x === y) {
                    y = b[++j];
                    ky = y === undefined || isNamespaceNode(y) ? undefined : this.#keyOf(y);
                }
                x = a[++i];
                kx = x === undefined || isNamespaceNode(x) ? undefined : this.#keyOf(x);
            } else {
                out.push(y);
                y = b[++j];
                ky = y === undefined || isNamespaceNode(y) ? undefined : this.#keyOf(y);
            }
        }
        // The rest of one array; its nodes must still belong to this tree.
        for (; x !== undefined; x = a[++i]) {
            if (isNamespaceNode(x) || this.#keyOf(x) === undefined) return null;
            out.push(x);
        }
        for (; y !== undefined; y = b[++j]) {
            if (isNamespaceNode(y) || this.#keyOf(y) === undefined) return null;
            out.push(y);
        }
        return out;
    }
}

// Q-NS-ORDER: upstream cannot order two namespace nodes of one element when both bindings are declared on an
// ancestor (and neither is `xml`): its comparison looks for the declaring attribute among the element's own
// attributes, finds neither and throws. A sort always compares neighbours, so the error is certain whenever two
// such nodes are in one sorted set. Mirrored, so that a set upstream refuses is refused here too.
function assertNamespaceOrderDefined(sorted: readonly DomNode[]): void {
    let previous: DomNode | undefined;
    for (const node of sorted) {
        if (
            previous !== undefined &&
            isNamespaceNode(node) &&
            isNamespaceNode(previous) &&
            node.ownerElement === previous.ownerElement &&
            node.localIndex < 0 &&
            previous.localIndex < 0 &&
            node.nodeValue !== XML_NAMESPACE_URI &&
            previous.nodeValue !== XML_NAMESPACE_URI
        ) {
            throw new XPathOrderError();
        }
        previous = node;
    }
}

/** Sorts with a numbering made for this one call. For callers that hold no evaluation state. */
export function sortInDocumentOrder(nodes: readonly DomNode[]): DomNode[] {
    const first = nodes[0];
    if (first === undefined || nodes.length === 1) return nodes.slice();
    const sorted = new Numbering(first).sort(nodes);
    if (sorted === null) throw new XPathOrderError();
    return sorted;
}

/** How many nodes `sortFew` takes: more than that and numbering the tree (one walk, then keys) is the better price. */
export const FEW_NODES = 32;

/**
 * Document order for a handful of tree nodes without numbering the whole tree: each node's chain of ancestors is
 * compared, and two branches under their common ancestor are ordered by walking forward from one of them. The cost
 * is the depth and the width of the branching parents, not the size of the document, which is what an evaluation
 * that keeps being interrupted by caller code (so keeps losing its numbering) needs. `charge` is told what was
 * walked. Null when a node is not a plain tree node (an attribute or a namespace node) or the nodes are not in one
 * tree; the caller then numbers the tree (which also reports a set that has no order).
 */
export function sortFew(nodes: readonly DomNode[], charge: (units: number) => void): DomNode[] | null {
    const chains: DomNode[][] = [];
    for (const node of nodes) {
        if (node.nodeType === ATTRIBUTE_NODE || isNamespaceNode(node)) return null;
        const chain: DomNode[] = [];
        for (let up: DomNode | null | undefined = node; up != null; up = up.parentNode) chain.push(up);
        chain.reverse();
        charge(chain.length);
        const root = chains[0]?.[0];
        if (root !== undefined && chain[0] !== root) return null;
        chains.push(chain);
    }
    const chainOf = new Map<DomNode, DomNode[]>();
    nodes.forEach((node, i) => {
        const chain = chains[i];
        if (chain !== undefined) chainOf.set(node, chain);
    });
    const before = (a: DomNode, b: DomNode): number => {
        const left = chainOf.get(a);
        const right = chainOf.get(b);
        if (left === undefined || right === undefined) return 0;
        const shared = Math.min(left.length, right.length);
        let at = 0;
        while (at < shared && left[at] === right[at]) at++;
        if (at === shared) return left.length - right.length;
        const branch = right[at];
        let steps = 0;
        let found = false;
        for (let sibling: DomNode | null | undefined = left[at]; sibling != null; sibling = sibling.nextSibling) {
            steps++;
            if (sibling === branch) {
                found = true;
                break;
            }
        }
        charge(steps);
        return found ? -1 : 1;
    };
    return nodes.slice().sort(before);
}
