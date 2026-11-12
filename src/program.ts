// The modern entry: parse once, evaluate many times. Nothing derived from a DOM is kept between evaluations.

import type { Expr } from './ast.ts';
import { compile, expressionFacts, NO_NODE } from './compile.ts';
import type { ExpressionFacts } from './compile.ts';
import {
    ATTRIBUTE_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    isDomNodeArray,
    XML_NAMESPACE_URI,
    XMLNS_NAMESPACE_URI
} from './dom.ts';
import type { DomNode, NamespaceLookup } from './dom.ts';
import { XPathContextError, XPathTypeError } from './errors.ts';
import { DEFAULT_PARSE_LIMITS, parseXPath } from './parser.ts';
import type { ParseLimits } from './parser.ts';
import { EvalState, NodeSet } from './runtime.ts';
import type { Compiled, CustomFunction, FunctionLookup, VariableLookup, XValue } from './runtime.ts';

/** A value of the XPath 1.0 data model as the typed API hands it over: a node-set is an array in document order. */
export type XPathValue = string | number | boolean | readonly DomNode[];

/** The dynamic context of a custom function call (section 1): the context node, its position and the size. */
export interface FunctionContext {
    readonly node: DomNode;
    readonly position: number;
    readonly size: number;
}

/** A custom function: the arguments arrive as XPath values; the answer is an XPath value. */
export type XPathFunctionImplementation = (context: FunctionContext, ...args: XPathValue[]) => XPathValue;

/** What an evaluation of the typed API reports. */
export interface Evaluation {
    readonly value: XPathValue;
    /** The work the evaluation took, in the units the budget counts (a measure, for choosing limits). */
    readonly work: number;
}

export interface EvaluateOptions {
    /** Context node; omitted means "none" (an expression that needs one then fails). */
    readonly node?: DomNode | null | undefined;
    readonly position?: number | undefined;
    readonly size?: number | undefined;
    /** Prefix lookup. It is asked at every name test and must not change the document. */
    readonly namespaces?: NamespaceLookup | undefined;
    /** Variables: asked for each `$name`; null/undefined means undeclared. May run caller code that changes the document. */
    readonly variables?: ((localName: string, namespace: string) => XPathValue | null | undefined) | undefined;
    /** Custom functions, asked for each function call before the core library; may change the document. */
    readonly functions?:
        | ((localName: string, namespace: string) => XPathFunctionImplementation | null | undefined)
        | undefined;
    readonly caseInsensitive?: boolean | undefined;
    readonly allowAnyNamespaceForNoPrefix?: boolean | undefined;
    /**
     * Work allowed, in units (node visits, and characters scanned in sixteenths): the evaluation throws XPathBudgetError
     * when it is exhausted. Omitted means DEFAULT_BUDGET; 0 means no limit. Anything but a number of at least 0 is refused.
     */
    readonly budget?: number | undefined;
    /** Wall-clock milliseconds allowed: XPathTimeoutError when exceeded. Omitted means DEFAULT_TIMEOUT_MS; 0 means none. */
    readonly timeoutMs?: number | undefined;
}

/** @internal The options the engine itself takes (the compat entry and the tests): the lookups work on engine values. */
export interface RawEvaluateOptions {
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
export const lookupNamespaceInDom: NamespaceLookup = (prefix, node, charge) => {
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
        // A deep document with many attributes per level: the walk is as long as the document is deep.
        charge?.(count + 1);
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
 *
 * The numbers come from measurements (bench/limits.ts, README "Limits"): the most work one evaluation of a signed SAML
 * login response took was 8,004 units for a 2,000-value group list (4 units per value, under 1 ms), and the hostile
 * documents of the gate (256 KiB each) take at most 328,000 units (18 ms). The budget is 600 times the first and 15
 * times the second, so legitimate use passes with room, and a hostile expression is stopped after at most 5,000,000
 * units, which is a few hundred milliseconds; the time limit is the backstop for work the units do not model.
 */
export const DEFAULT_BUDGET: number = 5_000_000;
export const DEFAULT_TIMEOUT_MS: number = 1_000;

/**
 * `upstream` (the default) behaves as `xpath` 0.0.36 does, including where it departs from the Recommendation: that is
 * what existing consumers have always seen, and the adoption gate. `strict` follows the Recommendation (README,
 * "Known deviations from XPath 1.0 inherited from upstream"). The mode is fixed when the program is made, because
 * some differences are in how the expression parses.
 */
export type XPathMode = 'upstream' | 'strict';

export interface ProgramOptions {
    readonly limits?: ParseLimits | undefined;
    readonly mode?: XPathMode | undefined;
}

/** What a variable or function of the typed API may hand back, as an engine value; null when there is none. */
function toEngineValue(value: unknown): XValue | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value) && isDomNodeArray(value)) return new NodeSet([...new Set(value)], false);
    throw new XPathTypeError('A variable or function produced a value that is neither an XPath value nor DOM nodes');
}

function toPublicValue(value: XValue, state: EvalState): XPathValue {
    return value instanceof NodeSet ? [...value.sorted(state)] : value;
}

function adaptVariables(
    lookup: (localName: string, namespace: string) => XPathValue | null | undefined
): VariableLookup {
    return (localName, namespace) => toEngineValue(lookup(localName, namespace));
}

function adaptFunctions(
    lookup: (localName: string, namespace: string) => XPathFunctionImplementation | null | undefined
): FunctionLookup {
    return (localName, namespace) => {
        const implementation = lookup(localName, namespace);
        if (implementation == null) return null;
        const custom: CustomFunction = (focus, state, args) => {
            const result = toEngineValue(
                implementation(
                    { node: focus.node, position: focus.position, size: focus.size },
                    ...args.map((arg) => toPublicValue(arg, state))
                )
            );
            if (result === null) throw new XPathTypeError(`Function ${localName} returned no value`);
            return result;
        };
        return custom;
    };
}

const isPositiveInteger = (value: number): boolean => value >= 1 && Math.floor(value) === value;

export class XPathProgram {
    /**
     * @internal Test switch: treat every evaluation as impure, so that no fast path, no kept numbering and no order bit is
     * used. The differential suites run on `test/support/candidate-slow.ts`, which sets it; both must equal upstream.
     */
    static forceSlowPath = false;

    readonly source: string;
    /** `upstream`: the behaviour of xpath 0.0.36, quirks included (the default). `strict`: XPath 1.0 as specified. */
    readonly mode: XPathMode;
    /** @internal */
    readonly ast: Expr;
    /** @internal */
    readonly facts: ExpressionFacts;
    readonly #run: Compiled;

    constructor(source: string, options: ProgramOptions = {}) {
        this.source = source;
        this.mode = options.mode ?? 'strict';
        this.ast = parseXPath(source, options.limits ?? DEFAULT_PARSE_LIMITS, this.mode === 'strict');
        this.facts = expressionFacts(this.ast);
        this.#run = compile(this.ast);
    }

    /**
     * Evaluates the expression: the value (a node-set as an array in document order) and the work it took. Throws an
     * `XPathError` (syntax errors are thrown by the constructor): a typed budget, time or limit error when a limit is
     * reached.
     */
    run(options: EvaluateOptions = {}): Evaluation {
        const { value, state } = this.runRaw({
            ...options,
            variables: options.variables === undefined ? undefined : adaptVariables(options.variables),
            functions: options.functions === undefined ? undefined : adaptFunctions(options.functions)
        });
        return { value: value instanceof NodeSet ? [...value.sorted(state)] : value, work: state.work };
    }

    /** @internal Evaluates and returns the engine's value together with the state (to put a node-set in order). */
    runRaw(options: RawEvaluateOptions = {}): { readonly value: XValue; readonly state: EvalState } {
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
        const budget: unknown = options.budget === undefined ? DEFAULT_BUDGET : options.budget;
        const timeoutMs: unknown = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
        // A string such as '0' compares as a number, and NaN compares false with everything: either would silently
        // turn a limit off. Only a real number of at least 0 is a limit.
        if (typeof budget !== 'number' || typeof timeoutMs !== 'number' || !(budget >= 0) || !(timeoutMs >= 0)) {
            throw new XPathContextError(
                'budget and timeoutMs must be numbers of at least 0 (0 turns a limit off); got a different type or value.'
            );
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
            strict: this.mode === 'strict',
            budget,
            timeoutMs,
            mergeUnions: options.mergeUnions ?? true
        });
        if (this.mode === 'strict') {
            // Section 2.3: a prefix the expression context cannot resolve is an error, whether or not any node is ever
            // tested against it (upstream finds out only when it applies the test to a node).
            for (const prefix of facts.prefixes) state.resolvePrefix(prefix, node);
        }
        return { value: this.#run({ node, position, size }, state), state };
    }
}
