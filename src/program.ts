// The modern entry: parse once, evaluate many times. Nothing derived from a DOM is kept between evaluations.

import type { Expr } from './ast.ts';
import { compile, expressionFacts, NO_NODE } from './compile.ts';
import type { ExpressionFacts } from './compile.ts';
import { ATTRIBUTE_NODE, DOCUMENT_NODE, ELEMENT_NODE, XML_NAMESPACE_URI, XMLNS_NAMESPACE_URI } from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathContextError } from './errors.ts';
import { DEFAULT_PARSE_LIMITS, parseXPath } from './parser.ts';
import type { ParseLimits } from './parser.ts';
import { EvalState } from './runtime.ts';
import type { Compiled, FunctionLookup, NamespaceLookup, VariableLookup, XValue } from './runtime.ts';

export interface EvaluateOptions {
    /** Context node; omitted means "none" (an expression that needs one then fails). */
    readonly node?: DomNode | null | undefined;
    readonly position?: number | undefined;
    readonly size?: number | undefined;
    /** Prefix lookup. A plain map is data; a function is caller code (see `callbacks`). */
    readonly namespaces?: NamespaceLookup | undefined;
    readonly variables?: VariableLookup | undefined;
    readonly functions?: FunctionLookup | undefined;
    /** True when `namespaces` / `variables` are functions that may run arbitrary code (default true if given). */
    readonly callbacks?: { readonly namespaces?: boolean; readonly variables?: boolean } | undefined;
    readonly caseInsensitive?: boolean | undefined;
    readonly allowAnyNamespaceForNoPrefix?: boolean | undefined;
    /**
     * Work allowed, in node visits (and, for string functions, characters scanned in sixteenths): the evaluation
     * throws XPathBudgetError when it is exhausted. Omitted means DEFAULT_BUDGET; 0 means no limit.
     */
    readonly budget?: number | undefined;
    /** Wall-clock milliseconds allowed: XPathTimeoutError when exceeded. Omitted means DEFAULT_TIMEOUT_MS; 0 means none. */
    readonly timeoutMs?: number | undefined;
    /** Tuning knob for the benchmark; default true. */
    readonly mergeUnions?: boolean | undefined;
}

/** Looks a prefix up in the DOM, from `node` outwards, the way upstream's default resolver does. */
export const lookupNamespaceInDom: NamespaceLookup = (prefix, node) => {
    if (prefix === 'xml') return XML_NAMESPACE_URI;
    if (prefix === 'xmlns') return XMLNS_NAMESPACE_URI;
    let current: DomNode | null | undefined = node;
    if (current.nodeType === DOCUMENT_NODE) current = current.documentElement;
    else if (current.nodeType === ATTRIBUTE_NODE) current = current.ownerElement;
    else if (current.nodeType !== ELEMENT_NODE) current = current.parentNode;
    const wanted = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
    for (; current != null && current.nodeType === ELEMENT_NODE; current = current.parentNode) {
        const attributes = current.attributes;
        const count = attributes?.length ?? 0;
        for (let i = 0; i < count; i++) {
            const attribute = attributes?.item(i);
            if (attribute != null && (attribute.name || attribute.nodeName) === wanted)
                return String(attribute.value || attribute.nodeValue);
        }
    }
    return null;
};

/**
 * Limits applied when the caller gives none, so that no evaluation is unbounded by accident. The budget is the
 * deterministic limit (the same on every machine); the time limit is the backstop for work the budget does not
 * model. A caller with a larger legitimate document raises them; 0 turns a limit off.
 */
export const DEFAULT_BUDGET = 200_000_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

const isPositiveInteger = (value: number): boolean => value >= 1 && Math.floor(value) === value;

export class XPathProgram {
    /**
     * Test switch: treat every evaluation as impure, so that no fast path, no kept numbering and no order bit is
     * used. The differential suites run once with it off and once with it on (SLOW=1); both must equal upstream.
     */
    static forceSlowPath = false;

    readonly source: string;
    readonly ast: Expr;
    readonly facts: ExpressionFacts;
    readonly #run: Compiled;

    constructor(source: string, limits: ParseLimits = DEFAULT_PARSE_LIMITS) {
        this.source = source;
        this.ast = parseXPath(source, limits);
        this.facts = expressionFacts(this.ast);
        this.#run = compile(this.ast);
    }

    /** Evaluates and returns the raw value together with the state (needed to put a node-set in document order). */
    run(options: EvaluateOptions = {}): { readonly value: XValue; readonly state: EvalState } {
        const node = options.node ?? NO_NODE;
        const size = options.size ?? 1;
        const position = options.position ?? 1;
        if (!isPositiveInteger(size) || !isPositiveInteger(position) || position > size) {
            throw new XPathContextError(
                'Context position and size must be positive integers, with position no greater than size.'
            );
        }
        const { facts } = this;
        const namespaceCallback =
            options.namespaces !== undefined && (options.callbacks?.namespaces ?? true) && facts.usesPrefixes;
        const variableCallback =
            options.variables !== undefined && (options.callbacks?.variables ?? true) && facts.usesVariables;
        const functionCallback = options.functions !== undefined && facts.usesFunctions;
        const budget = options.budget ?? DEFAULT_BUDGET;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // NaN would silently turn a limit off (every comparison with it is false), and a negative value is no limit.
        if (!(budget >= 0) || !(timeoutMs >= 0)) {
            throw new XPathContextError('budget and timeoutMs must be numbers of at least 0 (0 turns a limit off).');
        }
        const state = new EvalState({
            contextNode: node,
            caseInsensitive: options.caseInsensitive ?? false,
            allowAnyNamespaceForNoPrefix: options.allowAnyNamespaceForNoPrefix ?? false,
            namespaces: options.namespaces ?? lookupNamespaceInDom,
            variables: options.variables ?? null,
            functions: options.functions ?? null,
            pure: !XPathProgram.forceSlowPath && !variableCallback && !functionCallback,
            namespaceCallback,
            keepNumbering: !XPathProgram.forceSlowPath,
            budget,
            timeoutMs,
            mergeUnions: options.mergeUnions ?? true
        });
        return { value: this.#run({ node, position, size }, state), state };
    }
}
