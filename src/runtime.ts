// Values, the node-set, and the state of one evaluation.

import {
    DOCUMENT_FRAGMENT_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    ATTRIBUTE_NODE,
    CDATA_SECTION_NODE,
    TEXT_NODE
} from './dom.ts';
import { NamespaceNode } from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathBudgetError, XPathLimitError, XPathOrderError, XPathResolveError, XPathTimeoutError } from './errors.ts';
import { now } from './clock.ts';
import { FEW_NODES, Numbering, sortFew } from './order.ts';

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

/** A prefix resolver. `charge` accounts for the work of a lookup that walks the document (see EvalState.charge). */
export type NamespaceLookup = (
    prefix: string,
    node: DomNode,
    charge?: (units: number) => void
) => string | null | undefined;
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
    /**
     * The namespace resolver is caller code (a function). It is asked at every name test, as upstream does, but it is
     * not allowed to change the document (the contract, see the README), so it does not make the evaluation impure.
     */
    readonly namespaceCallback: boolean;
    /** XPath 1.0 as specified (mode `strict`), not as upstream implements it. */
    readonly strict: boolean;
    /** Keep the document-order numbering between calls. False only for the slow-path test switch. */
    readonly keepNumbering: boolean;
    /** Node visits allowed, or 0 for no limit. */
    readonly budget: number;
    /** Wall-clock milliseconds allowed, or 0 for no limit. Checked as work is charged, not on a timer. */
    readonly timeoutMs: number;
    /** Union strategy: merge ordered operands on document-order keys (true) or concatenate and sort lazily (false). */
    readonly mergeUnions: boolean;
}

/** What an evaluation may build: namespace nodes (a deep document with a new prefix per level makes N*N/2 of them). */
export const MAX_NAMESPACE_NODES: number = 1 << 18;
/** The work a namespace node costs (an object and its fields, against a node visit). */
const NAMESPACE_NODE_COST = 4;
/** The longest string an evaluation may build (concat() can double a string per level). */
export const MAX_STRING_LENGTH: number = 1 << 24;

/** Work units between two looks at the clock: rare enough to be free, frequent enough to stop within milliseconds. */
const CLOCK_CHECK_INTERVAL = 4096;

export class EvalState {
    readonly settings: EvalSettings;
    readonly pure: boolean;
    readonly caseInsensitive: boolean;
    readonly allowAnyNamespaceForNoPrefix: boolean;
    /** XPath 1.0 as specified (mode `strict`). */
    readonly strict: boolean;
    #numbering: Numbering | null = null;
    #work = 0;
    readonly #budget: number;
    readonly #timeoutMs: number;
    readonly #timed: boolean;
    /** In the units of `now()` (one clock for the whole run, see clock.ts): only compared with later readings of it. */
    readonly #deadline: number;
    #nextClockCheck = CLOCK_CHECK_INTERVAL;
    readonly #prefixes = new Map<string, string>();
    /** id -> first element, per document, built once per evaluation and dropped when caller code runs. */
    /** Strict: one namespace node per element and prefix per evaluation, so that a node-set holds each once. */
    readonly #namespaceNodeObjects = new Map<DomNode, Map<string, NamespaceNode>>();
    readonly #idIndexes = new Map<DomNode, ReadonlyMap<string, DomNode>>();
    /** Answers of document-only subexpressions (compile.ts `remembered`), per site and per document. */
    readonly #answers = new Map<object, Map<DomNode, XValue>>();
    /** The language of a node as lang() sees it (null: none), memoised so that a deep document stays linear. */
    readonly languages: Map<DomNode, string | null> = new Map<DomNode, string | null>();
    #namespaceNodes = 0;
    /** Per-site caches (sibling ranks). Only filled when `pure`, so they cannot outlive a change to the DOM. */
    readonly siteCaches: Map<object, Map<DomNode, number>> = new Map<object, Map<DomNode, number>>();

    constructor(settings: EvalSettings) {
        this.settings = settings;
        this.pure = settings.pure;
        this.strict = settings.strict;
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

    /**
     * Caller code that can change the document (a custom function, a variable resolver) has run: whatever was derived
     * from the document (the numbering, the sibling ranks) may be stale and is dropped. Nothing is dropped while no such
     * code runs, which is what keeps an evaluation with a namespace resolver linear.
     */
    userCodeRan(): void {
        this.#numbering = null;
        this.siteCaches.clear();
        this.#idIndexes.clear();
        this.#namespaceNodeObjects.clear();
        this.#answers.clear();
        this.languages.clear();
    }

    /**
     * The element with each `id` attribute of the document, first in document order: one walk per evaluation (the DOM's
     * own getElementById is a walk of the whole document in some implementations, once per token), charged as it goes.
     */
    elementsById(document: DomNode): ReadonlyMap<string, DomNode> {
        const known = this.#idIndexes.get(document);
        if (known !== undefined) return known;
        const index = new Map<string, DomNode>();
        let visits = 0;
        let node: DomNode | null | undefined = document.firstChild;
        while (node != null) {
            if (++visits % 4096 === 0) this.charge(4096);
            if (node.nodeType === ELEMENT_NODE && node.getAttribute !== undefined) {
                const id = node.getAttribute('id');
                const identifier = id ?? (this.strict ? node.getAttribute('xml:id') : null);
                if (identifier != null && identifier !== '' && !index.has(identifier)) index.set(identifier, node);
            }
            let next: DomNode | null | undefined = node.firstChild;
            while (next == null && node != null && node !== document) {
                next = node.nextSibling;
                if (next == null) node = node.parentNode;
            }
            node = next;
        }
        this.charge(visits % 4096);
        this.#idIndexes.set(document, index);
        return index;
    }

    /** The namespace node of an element for a prefix, made once per evaluation (strict mode). */
    internedNamespaceNode(
        owner: DomNode,
        prefix: string,
        attribute: DomNode | null,
        uri: string,
        local: number
    ): NamespaceNode {
        let byPrefix = this.#namespaceNodeObjects.get(owner);
        if (byPrefix === undefined) {
            byPrefix = new Map<string, NamespaceNode>();
            this.#namespaceNodeObjects.set(owner, byPrefix);
        }
        const known = byPrefix.get(prefix);
        if (known !== undefined && known.baseNode === attribute && known.nodeValue === uri) return known;
        const made = new NamespaceNode(prefix, attribute, uri, owner, local);
        byPrefix.set(prefix, made);
        return made;
    }

    answersOf(site: object): Map<DomNode, XValue> {
        let answers = this.#answers.get(site);
        if (answers === undefined) {
            answers = new Map<DomNode, XValue>();
            this.#answers.set(site, answers);
        }
        return answers;
    }

    /** Accounts for namespace nodes about to be made (the axis makes a node per binding per context node). */
    chargeNamespaceNodes(count: number): void {
        this.#namespaceNodes += count;
        if (this.#namespaceNodes > MAX_NAMESPACE_NODES)
            throw new XPathLimitError(`The namespace axis would make more than ${MAX_NAMESPACE_NODES} nodes`);
        this.charge(count * NAMESPACE_NODE_COST);
    }

    /** Document order for a duplicate-free array. Throws XPathOrderError when the nodes are not in one tree. */
    sort(nodes: readonly DomNode[]): DomNode[] {
        const first = nodes[0];
        if (first === undefined || nodes.length === 1) return nodes.slice();
        let numbering = this.#numbering;
        let sorted = numbering === null ? null : numbering.sort(nodes);
        // Caller code keeps invalidating the numbering (see userCodeRan): a few nodes are ordered locally, because
        // numbering the whole tree for each of them is what made such an evaluation quadratic.
        if (sorted === null && numbering === null && !this.pure && nodes.length <= FEW_NODES) {
            sorted = sortFew(nodes, (units) => {
                this.charge(units);
            });
            if (sorted !== null) return sorted;
        }
        if (sorted === null) {
            // No numbering yet, or it is for another tree.
            numbering = new Numbering(first);
            this.charge(numbering.size);
            sorted = numbering.sort(nodes);
            if (this.settings.keepNumbering) this.#numbering = numbering;
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
            if (this.settings.keepNumbering) this.#numbering = numbering;
        }
        this.charge(a.length + b.length);
        return merged;
    }

    /** Namespace URI for the prefix of a function or variable name, looked up from the current context node. */
    resolvePrefix(prefix: string, node: DomNode): string {
        const uri = this.settings.namespaces(prefix, node, (units) => {
            this.charge(units);
        });
        this.charge(1);
        if (uri == null) throw new XPathResolveError(`Cannot resolve QName ${prefix}`);
        return uri;
    }

    /** Namespace URI for the prefix of a name test: looked up from the node the evaluation started on. */
    resolveNameTestPrefix(prefix: string): string {
        if (!this.pure || this.settings.namespaceCallback) return this.resolvePrefix(prefix, this.settings.contextNode);
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

/**
 * XPath 1.0 section 4.4, strictly: optional white space (space, tab, CR, LF), an optional minus, a Number (digits with an
 * optional point and more digits, or a point and digits: `1.` and `.5` are numbers, a lone `.` is not), white space.
 * No `+`, no exponent, no hexadecimal, no `Infinity`, none of JavaScript's other white space.
 */
function isStrictNumberFormat(text: string): boolean {
    const length = text.length;
    const space = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
    let at = 0;
    while (at < length && space(text.charCodeAt(at))) at++;
    if (at < length && text.charCodeAt(at) === 0x2d) at++;
    const integerStart = at;
    while (at < length && isDigit(text.charCodeAt(at))) at++;
    let digits = at - integerStart;
    if (at < length && text.charCodeAt(at) === 0x2e) {
        at++;
        const fractionStart = at;
        while (at < length && isDigit(text.charCodeAt(at))) at++;
        digits += at - fractionStart;
    }
    if (digits === 0) return false;
    while (at < length && space(text.charCodeAt(at))) at++;
    return at === length;
}

/**
 * string -> number. Upstream (Q-NUM-1): its own pattern (no exponent, no leading `+`, JavaScript white space, and `1.`
 * is not a number). Strict: the Recommendation's grammar.
 */
export function stringToNumber(text: string, strict: boolean = false): number {
    if (strict) return isStrictNumberFormat(text) ? Number.parseFloat(text.trim()) : Number.NaN;
    return isNumberFormat(text) ? Number.parseFloat(text) : Number.NaN;
}

/**
 * number -> string. Upstream (Q-NUM-2): an exponent is expanded by padding digits, which mangles negative numbers
 * (-1e-7 is written 0.-1...). Strict (section 4.2): never an exponent, the sign kept, both zeros print
 * `0`, `NaN`, `Infinity`, `-Infinity`.
 */
export function numberToString(value: number, strict: boolean = false): string {
    const text = value.toString();
    if (strict) return text.includes('e') ? expandExponent(text) : text;
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

/** `-1.5e-7` -> `-0.00000015`, `1.2e+21` -> `1200000000000000000000`: the digits of JavaScript's shortest form, placed. */
function expandExponent(text: string): string {
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const at = unsigned.indexOf('e');
    const mantissa = unsigned.slice(0, at);
    const digits = mantissa.replace('.', '');
    const point = (mantissa.includes('.') ? mantissa.indexOf('.') : mantissa.length) + Number(unsigned.slice(at + 1));
    let placed: string;
    if (point <= 0) placed = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) placed = digits + '0'.repeat(point - digits.length);
    else placed = `${digits.slice(0, point)}.${digits.slice(point)}`;
    return negative ? `-${placed}` : placed;
}

export function toStringValue(value: XValue, state: EvalState): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return numberToString(value, state.strict);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const first = value.first(state);
    return first === null ? '' : stringValueOf(first, state);
}

/** Q-NUM-3: a node-set becomes a number through JavaScript's Number(), so '' is 0 and '0x10' is 16. */
export function toNumberValue(value: XValue, state: EvalState): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return stringToNumber(value, state.strict);
    if (typeof value === 'boolean') return value ? 1 : 0;
    // Upstream (Q-NUM-3) goes through JavaScript's Number(), so an empty node-set is 0 and '0x10' is 16. Strict: the
    // string-value of the first node, converted by the grammar: an empty node-set is NaN.
    if (state.strict) return stringToNumber(toStringValue(value, state), true);
    return Number(toStringValue(value, state));
}

export function toBooleanValue(value: XValue): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value.length > 0;
    return value.size > 0;
}
