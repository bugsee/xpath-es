// Strict `following::` and `preceding::` over many context nodes, with `[k]` or `[last()]` as the first predicate, and
// strict `preceding::` over a whole node-set without a positional predicate.
//
// The position in a predicate is relative to each context node's own axis (XPath 1.0 section 2.4), so the answer is
// per context node. What is shared is the document-order numbering of the tree (one per evaluation, see Numbering): the
// tree nodes that pass the node test are listed once, in document order, and each context node's answer is a lookup in
// that list by number, not a walk of its axis.
//
//   following (section 2.2): the nodes after the context node in document order, its descendants excluded. For a tree
//     node that is every number greater than the end of its subtree; an attribute or namespace node stands after its
//     element and before the element's children, so for it every number greater than its element's. The k-th
//     match is `matches[first index above the threshold + k - 1]`, the last is the last of the list, if above it.
//   preceding: the nodes before the context node, its ancestors excluded. The matches below the context node's number,
//     minus the matching ancestors. The ancestors of a context node are kept on a stack while the context nodes are
//     taken in document order (each node is pushed once and popped once), and the k-th nearest match that is no ancestor
//     is found by counting past the ancestors' positions in the list (binary search).
//
// Contexts from more than one tree, or an attribute without an owner, are not answered here (null): the caller then
// evaluates each context node by walking its axis, which is the reference these functions are tested against
// (XPathProgram.forceSlowPath).

import { ATTRIBUTE_NODE, NAMESPACE_NODE } from './dom.ts';
import type { DomNode } from './dom.ts';
import type { EvalState } from './runtime.ts';

type Matcher = (node: DomNode, state: EvalState) => boolean;

/** The tree node an attribute or namespace node hangs from; a tree node is its own place. */
export function anchorOf(node: DomNode): DomNode {
    return node.nodeType === ATTRIBUTE_NODE || node.nodeType === NAMESPACE_NODE ? (node.ownerElement ?? node) : node;
}

const logCost = (n: number): number => 2 + (32 - Math.clz32(n));

/** Index of the first element of the ascending array that is greater than `value`. */
function firstAbove(values: readonly number[], value: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if ((values[middle] ?? 0) > value) high = middle;
        else low = middle + 1;
    }
    return low;
}

/**
 * For each context node, the k-th node of its `following` or `preceding` axis that passes the node test (k = null: the
 * last one in axis order), or null when there is none. Null overall when the contexts cannot be answered from one
 * numbering.
 */
export function positionalHits(
    axis: 'following' | 'preceding',
    match: Matcher,
    k: number | null,
    contexts: readonly DomNode[],
    state: EvalState
): (DomNode | null)[] | null {
    const count = contexts.length;
    const first = contexts[0];
    if (first === undefined) return [];
    const numbering = state.numberingFor(anchorOf(first));
    const total = numbering.size;
    const ranks: number[] = [];
    const isTree: boolean[] = [];
    for (const context of contexts) {
        const place = anchorOf(context);
        const rank = numbering.rankOf(place);
        if (rank === undefined) return null;
        ranks.push(rank);
        isTree.push(place === context);
    }
    // The matches, in document order (their numbers), charged for the pass over the tree.
    const matches: number[] = [];
    const positionOf = axis === 'preceding' ? new Int32Array(total).fill(-1) : null;
    for (let rank = 0; rank < total; rank++) {
        const node = numbering.nodeAt(rank);
        if (node === undefined || !match(node, state)) continue;
        if (positionOf !== null) positionOf[rank] = matches.length;
        matches.push(rank);
    }
    state.charge(total);
    const hits: (DomNode | null)[] = new Array<DomNode | null>(count).fill(null);
    const nodeOfMatch = (position: number): DomNode | null => {
        const rank = matches[position];
        return rank === undefined ? null : (numbering.nodeAt(rank) ?? null);
    };
    if (axis === 'following') {
        const { ends } = numbering;
        for (let c = 0; c < count; c++) {
            const rank = ranks[c] ?? 0;
            const threshold = isTree[c] === true ? (ends[rank] ?? rank) : rank;
            const above = firstAbove(matches, threshold);
            const position = k === null ? matches.length - 1 : above + k - 1;
            if (position >= above && position < matches.length) hits[c] = nodeOfMatch(position);
        }
        state.charge(count * logCost(matches.length));
        return hits;
    }
    // preceding: the context nodes in document order, with the stack of their ancestors.
    const { ends } = numbering;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0));
    state.charge(count * logCost(count));
    const chain: number[] = [];
    const savedLength: number[] = [];
    const ancestorPositions: number[] = [];
    let pushed = 0;
    for (const c of order) {
        const rank = ranks[c] ?? 0;
        const context = contexts[c];
        if (context === undefined) break;
        // The nodes on the stack that are not ancestors of this context node (a node before it, or its own number).
        while (chain.length > 0) {
            const top = chain[chain.length - 1] ?? 0;
            if (top < rank && (ends[top] ?? top) >= rank) break;
            chain.pop();
            ancestorPositions.length = savedLength.pop() ?? 0;
        }
        const known = chain.length > 0 ? (chain[chain.length - 1] ?? -1) : -1;
        const fresh: number[] = [];
        for (let up = anchorOf(context).parentNode; up != null; up = up.parentNode) {
            const upRank = numbering.rankOf(up);
            if (upRank === undefined || upRank <= known) break;
            fresh.push(upRank);
        }
        for (let at = fresh.length - 1; at >= 0; at--) {
            const upRank = fresh[at] ?? 0;
            savedLength.push(ancestorPositions.length);
            chain.push(upRank);
            const position = positionOf?.[upRank] ?? -1;
            if (position >= 0) ancestorPositions.push(position);
        }
        pushed += fresh.length;
        // Matches before this context node, less the matching ancestors, are its preceding matches.
        const below = firstAbove(matches, rank - 1);
        const available = below - ancestorPositions.length;
        if (available >= 1 && (k === null || k <= available)) {
            // The wanted match, counted from the far end (document order): the (far)-th that is no ancestor.
            const far = k === null ? 0 : available - k;
            let low = 0;
            let high = ancestorPositions.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if ((ancestorPositions[middle] ?? 0) - middle <= far) low = middle + 1;
                else high = middle;
            }
            hits[c] = nodeOfMatch(far + low);
        }
        state.charge(logCost(matches.length) + logCost(ancestorPositions.length));
    }
    state.charge(pushed);
    return hits;
}

/**
 * Strict `preceding::` of a whole node-set: the union over the context nodes is every node before the last of them
 * (in document order) that is not an ancestor of that last one. A node that is an ancestor of the last context node
 * contains every context node after it, so none of those precedes it. Calls `visit` on each such node, in document order
 * (it applies the node test and the predicates); false, with nothing visited, when the contexts cannot be answered from
 * one numbering.
 */
export function strictPrecedingOfSet(
    contexts: readonly DomNode[],
    state: EvalState,
    visit: (node: DomNode) => void
): boolean {
    const first = contexts[0];
    if (first === undefined) return true;
    const numbering = state.numberingFor(anchorOf(first));
    let last = -1;
    let lastNode: DomNode | null = null;
    for (const context of contexts) {
        const place = anchorOf(context);
        const rank = numbering.rankOf(place);
        if (rank === undefined) return false;
        if (rank > last) {
            last = rank;
            lastNode = place;
        }
    }
    const ancestors = new Set<DomNode>();
    for (let up = lastNode?.parentNode; up != null; up = up.parentNode) ancestors.add(up);
    state.charge(contexts.length + ancestors.size + last);
    for (let rank = 0; rank < last; rank++) {
        const node = numbering.nodeAt(rank);
        if (node !== undefined && !ancestors.has(node)) visit(node);
    }
    return true;
}
