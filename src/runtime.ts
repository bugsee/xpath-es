// Values, the node-set, and the state of one evaluation.

import {
    DOCUMENT_FRAGMENT_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    ATTRIBUTE_NODE,
    CDATA_SECTION_NODE,
    TEXT_NODE
} from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathBudgetError, XPathOrderError, XPathResolveError, XPathTimeoutError } from './errors.ts';
import { now } from './clock.ts';
import { Numbering } from './order.ts';

/**
 * A node-set: an array without duplicates plus one fact about it, whether it is known to be in document order.
 * Sorting is lazy, as in upstream (`count()` and `boolean()` never need the order).
 */
export class NodeSet {
    #nodes: readonly DomNode[];
    #ordered: boolean;

    constructor(nodes: readonly DomNode[], ordered: boolean) {
        this.#nodes = nodes;
        this.#ordered = ordered || nodes.length < 2;
    }

    get size(): number {
        return this.#nodes.length;
    }

    get ordered(): boolean {
        return this.#ordered;
    }

    /** The members in whatever order they are held. Do not mutate. */
    get unordered(): readonly DomNode[] {
        return this.#nodes;
    }

    /** The members in document order; sorts once and remembers. */
    sorted(state: EvalState): readonly DomNode[] {
        if (!this.#ordered) {
            this.#nodes = state.sort(this.#nodes);
            this.#ordered = true;
        }
        return this.#nodes;
    }

    first(state: EvalState): DomNode | null {
        return this.sorted(state)[0] ?? null;
    }
}

/** An XPath 1.0 value. The four types are told apart with `typeof` and `instanceof`; nothing is boxed. */
export type XValue = string | number | boolean | NodeSet;

/** The dynamic context of XPath 1.0 section 1: node, position, size. Mutable and reused inside one loop. */
export interface Focus {
    node: DomNode;
    position: number;
    size: number;
}

export type Compiled = (focus: Focus, state: EvalState) => XValue;

export type NamespaceLookup = (prefix: string, node: DomNode) => string | null | undefined;
export type VariableLookup = (localName: string, namespace: string) => XValue | null | undefined;
export type CustomFunction = (focus: Focus, state: EvalState, args: readonly XValue[]) => XValue;
export type FunctionLookup = (localName: string, namespace: string) => CustomFunction | null | undefined;

export interface EvalSettings {
    /** The node the expression was started on; prefixes are resolved against it (as upstream does). */
    readonly contextNode: DomNode;
    readonly caseInsensitive: boolean;
    readonly allowAnyNamespaceForNoPrefix: boolean;
    readonly namespaces: NamespaceLookup;
    readonly variables: VariableLookup | null;
    readonly functions: FunctionLookup | null;
    /**
     * True when no caller-supplied code can run during the evaluation (no function, variable or namespace callback).
     * Only then may the engine keep a numbering or a sibling index across steps, and trust the core functions' types.
     */
    readonly pure: boolean;
    /** Node visits allowed, or 0 for no limit. */
    readonly budget: number;
    /** Wall-clock milliseconds allowed, or 0 for no limit. Checked as work is charged, not on a timer. */
    readonly timeoutMs: number;
    /** Union strategy: merge ordered operands on document-order keys (true) or concatenate and sort lazily (false). */
    readonly mergeUnions: boolean;
}

/** Work units between two looks at the clock: rare enough to be free, frequent enough to stop within milliseconds. */
const CLOCK_CHECK_INTERVAL = 4096;

export class EvalState {
    readonly settings: EvalSettings;
    readonly pure: boolean;
    readonly caseInsensitive: boolean;
    readonly allowAnyNamespaceForNoPrefix: boolean;
    #numbering: Numbering | null = null;
    #work = 0;
    readonly #budget: number;
    readonly #timeoutMs: number;
    readonly #timed: boolean;
    /** In the units of `now()` (one clock for the whole run, see clock.ts): only compared with later readings of it. */
    readonly #deadline: number;
    #nextClockCheck = CLOCK_CHECK_INTERVAL;
    readonly #prefixes = new Map<string, string>();
    /** Per-site caches (sibling ranks). Only filled when `pure`, so they cannot outlive a change to the DOM. */
    readonly siteCaches: Map<object, Map<DomNode, number>> = new Map<object, Map<DomNode, number>>();

    constructor(settings: EvalSettings) {
        this.settings = settings;
        this.pure = settings.pure;
        this.caseInsensitive = settings.caseInsensitive;
        this.allowAnyNamespaceForNoPrefix = settings.allowAnyNamespaceForNoPrefix;
        this.#budget = settings.budget;
        this.#timeoutMs = settings.timeoutMs;
        this.#timed = settings.timeoutMs !== 0;
        this.#deadline = this.#timed ? now() + settings.timeoutMs : Number.POSITIVE_INFINITY;
    }

    /** Total node visits charged so far. */
    get work(): number {
        return this.#work;
    }

    /**
     * Charges work (node visits, or characters scanned) against the budget and, every CLOCK_CHECK_INTERVAL units,
     * against the wall-clock limit. Every loop whose length depends on the document or on a string calls this.
     */
    charge(visits: number): void {
        this.#work += visits;
        if (this.#budget !== 0 && this.#work > this.#budget) throw new XPathBudgetError(this.#budget);
        if (this.#work >= this.#nextClockCheck) {
            this.#nextClockCheck = this.#work + CLOCK_CHECK_INTERVAL;
            if (this.#timed && now() > this.#deadline) throw new XPathTimeoutError(this.#timeoutMs);
        }
    }

    /** Document order for a duplicate-free array. Throws XPathOrderError when the nodes are not in one tree. */
    sort(nodes: readonly DomNode[]): DomNode[] {
        const first = nodes[0];
        if (first === undefined || nodes.length === 1) return nodes.slice();
        let numbering = this.#numbering;
        let sorted = numbering === null ? null : numbering.sort(nodes);
        if (sorted === null) {
            // No numbering yet, or it is for another tree.
            numbering = new Numbering(first);
            this.charge(numbering.size);
            sorted = numbering.sort(nodes);
            if (this.pure) this.#numbering = numbering;
        }
        if (sorted === null) throw new XPathOrderError();
        this.charge(nodes.length);
        return sorted;
    }

    /** Merges two ordered, duplicate-free arrays; null when it cannot (no numbering yet for the tree, several trees). */
    merge(a: readonly DomNode[], b: readonly DomNode[]): DomNode[] | null {
        const first = a[0] ?? b[0];
        if (first === undefined) return [];
        let numbering = this.#numbering;
        let merged = numbering === null ? null : numbering.merge(a, b);
        if (merged === null) {
            numbering = new Numbering(first);
            this.charge(numbering.size);
            merged = numbering.merge(a, b);
            if (this.pure) this.#numbering = numbering;
        }
        this.charge(a.length + b.length);
        return merged;
    }

    /** Namespace URI for the prefix of a function or variable name, looked up from the current context node. */
    resolvePrefix(prefix: string, node: DomNode): string {
        const uri = this.settings.namespaces(prefix, node);
        if (uri == null) throw new XPathResolveError(`Cannot resolve QName ${prefix}`);
        return uri;
    }

    /** Namespace URI for the prefix of a name test: looked up from the node the evaluation started on. */
    resolveNameTestPrefix(prefix: string): string {
        if (!this.pure) return this.resolvePrefix(prefix, this.settings.contextNode);
        const known = this.#prefixes.get(prefix);
        if (known !== undefined) return known;
        const uri = this.resolvePrefix(prefix, this.settings.contextNode);
        this.#prefixes.set(prefix, uri);
        return uri;
    }
}

// ---- string-value (XPath 1.0 section 5) and conversions (section 4) as upstream implements them ----

/**
 * String-value of a node. Iterative. Q-STRVAL: text is collected from Text and CDATA children and from Element,
 * Document and DocumentFragment children recursively; an attribute gives `value || nodeValue`.
 */
export function stringValueOf(node: DomNode, state?: EvalState): string {
    const type = node.nodeType;
    if (type === ATTRIBUTE_NODE) return node.value || (node.nodeValue ?? '');
    if (type !== ELEMENT_NODE && type !== DOCUMENT_NODE && type !== DOCUMENT_FRAGMENT_NODE) return node.nodeValue ?? '';
    let text = '';
    let visits = 1;
    let current: DomNode | null | undefined = node.firstChild;
    while (current != null) {
        visits++;
        const kind = current.nodeType;
        let next: DomNode | null | undefined = null;
        if (kind === TEXT_NODE || kind === CDATA_SECTION_NODE) text += current.nodeValue ?? '';
        else if (kind === ELEMENT_NODE || kind === DOCUMENT_NODE || kind === DOCUMENT_FRAGMENT_NODE)
            next = current.firstChild;
        while (next == null && current != null && current !== node) {
            next = current.nextSibling;
            if (next == null) current = current.parentNode;
        }
        current = next;
    }
    state?.charge(visits + (text.length >> 4));
    return text;
}

/** JavaScript's `\s` (the white space of ECMAScript's WhiteSpace and LineTerminator productions). */
function isJavaScriptSpace(code: number): boolean {
    return (
        (code >= 0x09 && code <= 0x0d) ||
        code === 0x20 ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    );
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * Upstream's number pattern, `^\s*-?[0-9]*\.?[0-9]+\s*$`, as a single pass. The regular expression backtracks
 * quadratically on a long run of digits that is not followed by the end of the string ("0000...0x"): CodeQL's
 * js/polynomial-redos, and 7 s for 80,000 digits. Same language: white space, an optional minus, then either digits
 * (at least one) or optional digits, a dot and digits (at least one), then white space.
 */
function isNumberFormat(text: string): boolean {
    const length = text.length;
    let at = 0;
    while (at < length && isJavaScriptSpace(text.charCodeAt(at))) at++;
    if (at < length && text.charCodeAt(at) === 0x2d) at++;
    const integerStart = at;
    while (at < length && isDigit(text.charCodeAt(at))) at++;
    const integerDigits = at - integerStart;
    if (at < length && text.charCodeAt(at) === 0x2e) {
        at++;
        const fractionStart = at;
        while (at < length && isDigit(text.charCodeAt(at))) at++;
        if (at === fractionStart) return false;
    } else if (integerDigits === 0) {
        return false;
    }
    while (at < length && isJavaScriptSpace(text.charCodeAt(at))) at++;
    return at === length;
}

/** string -> number. Q-NUM-1: upstream's pattern (no exponent, no leading `+`, JavaScript `\s`). */
export function stringToNumber(text: string): number {
    return isNumberFormat(text) ? Number.parseFloat(text) : Number.NaN;
}

/** number -> string. Q-NUM-2: exponents are expanded by upstream's digit padding, which mangles negative numbers. */
export function numberToString(value: number): string {
    const text = value.toString();
    const small = text.indexOf('e-');
    if (small !== -1) {
        const exponent = Number(text.slice(small + 2));
        return `0.${'0'.repeat(Math.max(0, exponent - 1))}${text.slice(0, small).replace('.', '')}`;
    }
    const large = text.indexOf('e');
    if (large !== -1) {
        const base = text.slice(0, large).replace('.', '');
        const exponent = Number(text.slice(large + 1));
        return base + '0'.repeat(Math.max(0, exponent + 1 - base.length));
    }
    return text;
}

export function toStringValue(value: XValue, state: EvalState): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return numberToString(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const first = value.first(state);
    return first === null ? '' : stringValueOf(first, state);
}

/** Q-NUM-3: a node-set becomes a number through JavaScript's Number(), so '' is 0 and '0x10' is 16. */
export function toNumberValue(value: XValue, state: EvalState): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return stringToNumber(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return Number(toStringValue(value, state));
}

export function toBooleanValue(value: XValue): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value.length > 0;
    return value.size > 0;
}
