// Drop-in entry for code written against the `xpath` package (goto100/xpath 0.0.36): the same names, the same
// arguments, the same results. Only what is needed to measure and fuzz the engine against upstream is here;
// the rest of upstream's surface is not implemented.
//
// Typing note: upstream's declarations type results as lib.dom's `Node` (and `Element`, `Attr`, ... for the guards). The
// engine's own types are structural (`DomNode`), and this package's sources are compiled without the DOM library, so the
// result types below are looked up on `globalThis`: where the consumer's program has the DOM library they are lib.dom's
// interfaces (code written against upstream's declarations compiles unchanged), where it has not they are `DomNode`.
// Parameters keep the structural type, which every lib.dom `Node` is assignable to.

import {
    ATTRIBUTE_NODE,
    CDATA_SECTION_NODE,
    COMMENT_NODE,
    DOCUMENT_FRAGMENT_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    PROCESSING_INSTRUCTION_NODE,
    TEXT_NODE,
    isDomNode,
    isDomNodeArray
} from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathContextError, XPathError, XPathSyntaxError, XPathTypeError } from './errors.ts';
import { sortInDocumentOrder } from './order.ts';
import { lookupNamespaceInDom, parseMode, XPathProgram } from './program.ts';
import type { XPathMode } from './program.ts';
import type { RawEvaluateOptions } from './program.ts';
import { NodeSet, numberToString, stringToNumber, stringValueOf, toNumberValue } from './runtime.ts';
import type { CustomFunction, EvalState, FunctionLookup, NamespaceLookup, VariableLookup, XValue } from './runtime.ts';

type InstanceOf<Constructor, Fallback> = Constructor extends { readonly prototype: infer Instance }
    ? Instance
    : Fallback;
export type LibNode = typeof globalThis extends { Node: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibElement = typeof globalThis extends { Element: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibAttr = typeof globalThis extends { Attr: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibText = typeof globalThis extends { Text: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibCDATASection = typeof globalThis extends { CDATASection: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibProcessingInstruction = typeof globalThis extends { ProcessingInstruction: infer C }
    ? InstanceOf<C, DomNode>
    : DomNode;
export type LibComment = typeof globalThis extends { Comment: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibDocument = typeof globalThis extends { Document: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibDocumentType = typeof globalThis extends { DocumentType: infer C } ? InstanceOf<C, DomNode> : DomNode;
export type LibDocumentFragment = typeof globalThis extends { DocumentFragment: infer C }
    ? InstanceOf<C, DomNode>
    : DomNode;

// As upstream's declarations have them (a selection that finds nothing is `undefined` at run time, as upstream's is).
export type SelectedValue = LibNode | string | number | boolean | null;
export type SelectReturnType = LibNode[] | SelectedValue;
export type SelectSingleReturnType = SelectedValue;

/** As lib.dom's `XPathNSResolver`: a function of the prefix, or an object with `lookupNamespaceURI(prefix)`. */
export type XPathNSResolver =
    | ((prefix: string) => string | null | undefined)
    | { lookupNamespaceURI(prefix: string): string | null | undefined };

/** The lookup a resolver of either shape stands for; none when there is no resolver. */
function lookupOf(resolver: XPathNSResolver | null | undefined): NamespaceLookup {
    if (resolver == null) return () => null;
    return typeof resolver === 'function'
        ? (prefix) => resolver(prefix)
        : (prefix) => resolver.lookupNamespaceURI(prefix);
}

export interface XPathSelect {
    (expression: string, node?: DomNode | null, single?: false, options?: SelectOptions): SelectReturnType;
    (
        expression: string,
        node: DomNode | null | undefined,
        single: true,
        options?: SelectOptions
    ): SelectSingleReturnType;
}

// ---- value wrappers with upstream's method names ----

export class XString {
    readonly str: string;
    constructor(value: string) {
        this.str = value;
    }
    stringValue(): string {
        return this.str;
    }
    numberValue(): number {
        return stringToNumber(this.str);
    }
    booleanValue(): boolean {
        return this.str.length > 0;
    }
    toString(): string {
        return this.str;
    }
}

export class XNumber {
    readonly num: number;
    constructor(value: number | string) {
        this.num = typeof value === 'string' ? stringToNumber(value) : value;
    }
    stringValue(): string {
        return numberToString(this.num);
    }
    numberValue(): number {
        return this.num;
    }
    booleanValue(): boolean {
        return Boolean(this.num);
    }
    toString(): string {
        return numberToString(this.num);
    }
}

export class XBoolean {
    readonly b: boolean;
    constructor(value: boolean) {
        this.b = value;
    }
    stringValue(): string {
        return String(this.b);
    }
    numberValue(): number {
        return this.b ? 1 : 0;
    }
    booleanValue(): boolean {
        return this.b;
    }
    toString(): string {
        return String(this.b);
    }
}

/**
 * Upstream's node-set, usable on its own (`new XNodeSet(); add(); toArray()`). It holds no numbering: `toArray()`
 * numbers the tree for that one call.
 */
export class XNodeSet {
    readonly #members = new Set<DomNode>();
    // Q-SET-CACHE: upstream keeps the order it computed until the next add(), even if the DOM changes meanwhile.
    #sorted: DomNode[] | null = null;

    get size(): number {
        return this.#members.size;
    }

    add(node: DomNode): void {
        if (this.#members.has(node)) return;
        this.#members.add(node);
        this.#sorted = null;
    }

    addArray(nodes: readonly DomNode[]): void {
        for (const node of nodes) this.add(node);
    }

    toUnsortedArray(): DomNode[] {
        return [...this.#members];
    }

    toArray(): LibNode[] {
        this.#sorted ??= sortInDocumentOrder([...this.#members]);
        return this.#sorted.slice();
    }

    first(): LibNode | null {
        return this.toArray()[0] ?? null;
    }

    nodeset(): this {
        return this;
    }

    stringValue(): string {
        const first = this.first();
        return first === null ? '' : stringValueOf(first);
    }

    numberValue(): number {
        return Number(this.stringValue());
    }

    booleanValue(): boolean {
        return this.#members.size > 0;
    }

    toString(): string {
        return this.stringValue();
    }
}

export type XPathValueObject = XString | XNumber | XBoolean | XNodeSet;

function wrap(value: XValue): XPathValueObject {
    if (typeof value === 'string') return new XString(value);
    if (typeof value === 'number') return new XNumber(value);
    if (typeof value === 'boolean') return new XBoolean(value);
    const set = new XNodeSet();
    set.addArray(value.unordered);
    return set;
}

/** Upstream's convertValue(): what a variable or a custom function may hand back. */
function unwrap(value: unknown): XValue | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof XString) return value.str;
    if (value instanceof XNumber) return value.num;
    if (value instanceof XBoolean) return value.b;
    if (value instanceof XNodeSet) return new NodeSet(value.toUnsortedArray(), false);
    const nodes: unknown[] = Array.isArray(value) ? value : [value];
    if (!isDomNodeArray(nodes))
        throw new XPathTypeError(
            'A variable or function produced a value that is neither an XPath value nor DOM nodes'
        );
    return new NodeSet([...new Set(nodes)], false);
}

// ---- parse cache: expression text -> program. Holds no DOM state; bounded in entries and in bytes. ----

/**
 * A byte-bounded LRU. A program is far larger than its source (the tree, the closures): measured, 70 to 420 bytes per
 * character of source depending on the shape (a union of many names is the densest), so the cache is bounded by an
 * estimate of the memory it retains, ESTIMATED_BYTES_PER_CHAR for each character of source, not by the length of the
 * sources, and an expression longer than CACHEABLE_LENGTH is not cached at all (an attacker's 1 MB expression must not
 * pin 100 MB; such an expression is parsed again each time, which is linear).
 */
const CACHE_ENTRIES = 512;
const ESTIMATED_BYTES_PER_CHAR = 512;
const CACHE_TOTAL_BYTES = 16 << 20;
const CACHEABLE_LENGTH = 2048;
const programs = new Map<string, XPathProgram>();
let cachedLength = 0;

function programFor(expression: unknown, requested?: unknown): XPathProgram {
    const mode = parseMode(requested);
    if (!expression) throw new XPathSyntaxError('XPath expression unspecified.');
    if (typeof expression !== 'string') throw new XPathSyntaxError('XPath expression must be a string.');
    if (expression.length > CACHEABLE_LENGTH) return new XPathProgram(expression, { mode });
    const key = `${mode}:${expression}`;
    const cached = programs.get(key);
    if (cached !== undefined) {
        // Most recently used goes last.
        programs.delete(key);
        programs.set(key, cached);
        return cached;
    }
    const program = new XPathProgram(expression, { mode });
    programs.set(key, program);
    cachedLength += key.length;
    for (const [oldest, old] of programs) {
        if (programs.size <= CACHE_ENTRIES && cachedLength * ESTIMATED_BYTES_PER_CHAR <= CACHE_TOTAL_BYTES) break;
        if (old === program) break;
        programs.delete(oldest);
        cachedLength -= oldest.length;
    }
    return program;
}

/** Entries, characters and the estimate of the bytes they retain, held by the parse cache (for the tests). */
export function parseCacheSize(): {
    readonly entries: number;
    readonly length: number;
    readonly estimatedBytes: number;
} {
    return { entries: programs.size, length: cachedLength, estimatedBytes: cachedLength * ESTIMATED_BYTES_PER_CHAR };
}

function contextNodeOf(node: unknown): DomNode | null {
    if (node === null || node === undefined) return null;
    if (!isDomNode(node)) throw new XPathContextError('Context node does not appear to be a valid DOM node.');
    return node;
}

/**
 * Q-HTML: upstream's `select()` family asks the document whether it is an HTML DOM with
 * `implementation.hasFeature("HTML", "2.0")` and, on yes or on an exception, matches names case-insensitively.
 * xmldom >= 0.7, jsdom and browsers answer true for every feature, so there every name test is case-insensitive.
 */
function detectHtmlDom(node: DomNode | null): boolean {
    if (node === null) return false;
    const document = node.nodeType === DOCUMENT_NODE ? node : node.ownerDocument;
    try {
        const implementation = document?.implementation;
        if (implementation == null || implementation.hasFeature === undefined) return true;
        return Boolean(implementation.hasFeature('HTML', '2.0'));
    } catch {
        return true;
    }
}

/** What the select family takes besides the expression and the node: the limits of an evaluation, and the mode. */
export interface SelectOptions {
    /** Work limit; see DEFAULT_BUDGET. 0 turns it off. */
    readonly budget?: number | undefined;
    /** Wall-clock limit in milliseconds; see DEFAULT_TIMEOUT_MS. 0 turns it off. */
    readonly timeoutMs?: number | undefined;
    /** `strict` (the default) XPath 1.0, or `upstream`: the behaviour of xpath 0.0.36. */
    readonly mode?: XPathMode | undefined;
}

/** Resolvers made from a plain map (useNamespaces): data, not caller code, so they do not make an evaluation impure. */
const DATA_RESOLVERS = new WeakSet<XPathNSResolver>();

function runSelect(
    expression: unknown,
    node: unknown,
    resolver: XPathNSResolver | null | undefined,
    options: SelectOptions | undefined
): { readonly value: XValue; readonly state: EvalState } {
    const program = programFor(expression, options?.mode);
    const contextNode = contextNodeOf(node);
    const namespaces: NamespaceLookup = lookupOf(resolver);
    return program.runRaw({
        node: contextNode,
        namespaces,
        callbacks: { namespaces: resolver == null || !DATA_RESOLVERS.has(resolver) },
        caseInsensitive: program.mode === 'strict' ? isHtmlDocument(contextNode) : detectHtmlDom(contextNode),
        budget: options?.budget,
        timeoutMs: options?.timeoutMs
    });
}

/**
 * Strict mode: an HTML document (a browser's, jsdom's, ...) matches names without regard to ASCII case, as HTML does;
 * an XML document never does. Upstream decides with `implementation.hasFeature('HTML', '2.0')`, which every modern DOM
 * answers true for, so there an XML document is matched case-insensitively too (`detectHtmlDom`).
 */
function isHtmlDocument(node: DomNode | null): boolean {
    if (node === null) return false;
    const document = node.nodeType === DOCUMENT_NODE ? node : node.ownerDocument;
    return document?.contentType === 'text/html';
}

function selectOne(
    expression: unknown,
    node: unknown,
    resolver: XPathNSResolver | null | undefined,
    options?: SelectOptions
): SelectSingleReturnType | undefined {
    const { value, state } = runSelect(expression, node, resolver, options);
    return value instanceof NodeSet ? value.sorted(state)[0] : value;
}

function selectAll(
    expression: unknown,
    node: unknown,
    resolver: XPathNSResolver | null | undefined,
    options?: SelectOptions
): SelectReturnType {
    const { value, state } = runSelect(expression, node, resolver, options);
    return value instanceof NodeSet ? value.sorted(state).slice() : value;
}

export function selectWithResolver(
    expression: string,
    node?: DomNode | null,
    resolver?: XPathNSResolver | null,
    single?: false,
    options?: SelectOptions
): SelectReturnType;
export function selectWithResolver(
    expression: string,
    node: DomNode | null | undefined,
    resolver: XPathNSResolver | null | undefined,
    single: true,
    options?: SelectOptions
): SelectSingleReturnType;
export function selectWithResolver(
    expression: string,
    node?: DomNode | null,
    resolver?: XPathNSResolver | null,
    single?: boolean,
    options?: SelectOptions
): SelectReturnType | undefined {
    // Truthiness, as upstream tests it (`select('//a', doc, 1)` is the first element).
    return single ? selectOne(expression, node, resolver, options) : selectAll(expression, node, resolver, options);
}

export function select(
    expression: string,
    node?: DomNode | null,
    single?: false,
    options?: SelectOptions
): SelectReturnType;
export function select(
    expression: string,
    node: DomNode | null | undefined,
    single: true,
    options?: SelectOptions
): SelectSingleReturnType;
export function select(
    expression: string,
    node?: DomNode | null,
    single?: boolean,
    options?: SelectOptions
): SelectReturnType | undefined {
    // Truthiness, as upstream tests it.
    return single ? selectOne(expression, node, null, options) : selectAll(expression, node, null, options);
}

export function select1(expression: string, node?: DomNode | null, options?: SelectOptions): SelectSingleReturnType;
export function select1(
    expression: string,
    node?: DomNode | null,
    options?: SelectOptions
): SelectSingleReturnType | undefined {
    return selectOne(expression, node, null, options);
}

/**
 * Selection with prefix mappings. The mappings are looked up by own property only: a prefix called `constructor` or
 * `toString` is not a prototype member. `defaults` apply to every call of the returned function unless the call
 * passes its own options.
 */
export function useNamespaces(mappings: Readonly<Record<string, string>>, defaults?: SelectOptions): XPathSelect {
    if (defaults !== undefined) parseMode(defaults.mode);
    const resolver: XPathNSResolver = {
        lookupNamespaceURI: (prefix) => (Object.hasOwn(mappings, prefix) ? mappings[prefix] : undefined)
    };
    DATA_RESOLVERS.add(resolver);
    function selectWithMappings(
        expression: string,
        node?: DomNode | null,
        single?: false,
        options?: SelectOptions
    ): SelectReturnType;
    function selectWithMappings(
        expression: string,
        node: DomNode | null | undefined,
        single: true,
        options?: SelectOptions
    ): SelectSingleReturnType;
    function selectWithMappings(
        expression: string,
        node?: DomNode | null,
        single?: boolean,
        options?: SelectOptions
    ): SelectReturnType | undefined {
        const effective = options ?? defaults;
        // Truthiness, as upstream tests it.
        return single
            ? selectOne(expression, node, resolver, effective)
            : selectAll(expression, node, resolver, effective);
    }
    return selectWithMappings;
}

// ---- parse(): upstream's evaluator object ----

export interface XPathFunctionContext {
    readonly contextNode: DomNode;
    readonly contextPosition: number;
    readonly contextSize: number;
}
export type XPathFunction = (context: XPathFunctionContext, ...args: XPathValueObject[]) => unknown;

export interface XPathEvaluateOptions {
    node?: DomNode | null | undefined;
    namespaces?: unknown;
    variables?: unknown;
    functions?: unknown;
    position?: number | undefined;
    size?: number | undefined;
    allowAnyNamespaceForNoPrefix?: boolean | undefined;
    isHtml?: boolean | undefined;
    /** xpath-es extension (not in upstream): work limit, see EvaluateOptions.budget. */
    budget?: number | undefined;
    /** xpath-es extension (not in upstream): wall-clock limit in milliseconds, see EvaluateOptions.timeoutMs. */
    timeoutMs?: number | undefined;
    /** xpath-es extension (not in upstream): `strict` XPath 1.0 for this evaluation; the default is `strict`. */
    mode?: XPathMode | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

type AnyFunction = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is AnyFunction {
    return typeof value === 'function';
}

/** A resolver given as `{ method() }`, as a bare function, or as a map: returns a lookup and whether it is caller code. */
function lookupFrom(
    option: unknown,
    method: string
): { readonly call: AnyFunction; readonly callback: boolean } | null {
    if (isRecord(option)) {
        // A method of the object itself or of its class, but never of Object.prototype (toString, constructor, ...).
        const member = option[method];
        if (isFunction(member) && member !== Reflect.get(Object.prototype, method))
            return { call: (...args) => member.apply(option, args), callback: true };
    }
    if (isFunction(option)) return { call: option, callback: true };
    if (isRecord(option))
        return {
            // Own properties only: `{}` has no function called `toString` for an expression to call.
            call: (name) => (typeof name === 'string' && Object.hasOwn(option, name) ? option[name] : undefined),
            callback: false
        };
    return null;
}

function toEngineOptions(options: XPathEvaluateOptions | undefined): RawEvaluateOptions {
    if (options === undefined) return {};
    const namespaces = lookupFrom(options.namespaces, 'getNamespace');
    const variables = lookupFrom(options.variables, 'getVariable');
    const functions = lookupFrom(options.functions, 'getFunction');
    // A table of functions that is plain data names what it defines; a lookup function can define anything.
    const functionNames =
        functions !== null && !functions.callback && isRecord(options.functions)
            ? new Set(Object.getOwnPropertyNames(options.functions))
            : null;
    const namespaceLookup: NamespaceLookup | undefined =
        namespaces === null
            ? undefined
            : (prefix, node, charge) => {
                  const uri = namespaces.call(prefix, node);
                  return typeof uri === 'string' && uri !== '' ? uri : lookupNamespaceInDom(prefix, node, charge);
              };
    const variableLookup: VariableLookup | undefined =
        variables === null ? undefined : (name, namespace) => unwrap(variables.call(name, namespace));
    const functionLookup: FunctionLookup | undefined =
        functions === null
            ? undefined
            : (name, namespace) => {
                  const found = functions.call(name, namespace);
                  if (!isFunction(found)) return null;
                  const custom: CustomFunction = (focus, _state, args) => {
                      const context: XPathFunctionContext = {
                          contextNode: focus.node,
                          contextPosition: focus.position,
                          contextSize: focus.size
                      };
                      const result = unwrap(found(context, ...args.map(wrap)));
                      if (result === null) throw new XPathTypeError(`Function ${name} returned no value`);
                      return result;
                  };
                  return custom;
              };
    return {
        node: contextNodeOf(options.node),
        position: options.position,
        size: options.size,
        namespaces: namespaceLookup,
        variables: variableLookup,
        functions: functionLookup,
        callbacks: {
            namespaces: namespaces?.callback ?? false,
            variables: variables?.callback ?? false,
            ...(functionNames === null ? {} : { functionNames })
        },
        caseInsensitive: options.isHtml === true,
        allowAnyNamespaceForNoPrefix: options.allowAnyNamespaceForNoPrefix ?? options.isHtml === true,
        budget: options.budget,
        timeoutMs: options.timeoutMs
    };
}

export class XPathEvaluator {
    readonly #program: XPathProgram;

    constructor(program: XPathProgram) {
        this.#program = program;
    }

    /** The program for the mode an evaluation asks for (the parse cache makes a second program cheap). */
    #programFor(options: XPathEvaluateOptions | undefined): XPathProgram {
        const mode = options?.mode;
        return mode === undefined || mode === this.#program.mode
            ? this.#program
            : programFor(this.#program.source, mode);
    }

    evaluate(options?: XPathEvaluateOptions): XPathValueObject {
        return wrap(this.#programFor(options).runRaw(toEngineOptions(options)).value);
    }

    evaluateNumber(options?: XPathEvaluateOptions): number {
        return this.evaluate(options).numberValue();
    }

    evaluateString(options?: XPathEvaluateOptions): string {
        return this.evaluate(options).stringValue();
    }

    evaluateBoolean(options?: XPathEvaluateOptions): boolean {
        return this.evaluate(options).booleanValue();
    }

    evaluateNodeSet(options?: XPathEvaluateOptions): XNodeSet {
        const value = this.evaluate(options);
        if (!(value instanceof XNodeSet))
            throw new XPathTypeError(
                `Cannot convert ${value instanceof XString ? 'string' : value instanceof XNumber ? 'number' : 'boolean'} to nodeset`
            );
        return value;
    }

    select(options?: XPathEvaluateOptions): LibNode[] {
        const { value, state } = this.#programFor(options).runRaw(toEngineOptions(options));
        if (!(value instanceof NodeSet)) throw new XPathTypeError(`Cannot convert ${typeof value} to nodeset`);
        return value.sorted(state).slice();
    }

    select1(options?: XPathEvaluateOptions): LibNode | undefined {
        return this.select(options)[0];
    }
}

export function parse(expression: string, options?: Pick<SelectOptions, 'mode'>): XPathEvaluator {
    return new XPathEvaluator(programFor(expression, options?.mode));
}

// ---- DOM Level 3 XPath: evaluate() and XPathResult ----

export class XPathException extends XPathError {
    static readonly INVALID_EXPRESSION_ERR = 51;
    static readonly TYPE_ERR = 52;
    readonly exception: unknown;

    constructor(domCode: 51 | 52, exception?: unknown) {
        const detail =
            exception instanceof Error
                ? `: ${exception.name}: ${exception.message}`
                : typeof exception === 'string'
                  ? `: ${exception}`
                  : '';
        super(domCode === 51 ? 'SYNTAX' : 'TYPE', `${domCode === 51 ? 'Invalid expression' : 'Type error'}${detail}`);
        this.exception = exception;
    }
}

export class XPathResult {
    static readonly ANY_TYPE = 0;
    static readonly NUMBER_TYPE = 1;
    static readonly STRING_TYPE = 2;
    static readonly BOOLEAN_TYPE = 3;
    static readonly UNORDERED_NODE_ITERATOR_TYPE = 4;
    static readonly ORDERED_NODE_ITERATOR_TYPE = 5;
    static readonly UNORDERED_NODE_SNAPSHOT_TYPE = 6;
    static readonly ORDERED_NODE_SNAPSHOT_TYPE = 7;
    static readonly ANY_UNORDERED_NODE_TYPE = 8;
    static readonly FIRST_ORDERED_NODE_TYPE = 9;

    readonly resultType: number;
    readonly numberValue?: number;
    readonly stringValue?: string;
    readonly booleanValue?: boolean;
    readonly singleNodeValue?: DomNode | null;
    readonly nodes?: DomNode[];
    readonly snapshotLength?: number;
    readonly invalidIteratorState?: boolean;
    #iteratorIndex = 0;

    constructor(value: XPathValueObject, requested: number) {
        let type = requested;
        if (type === XPathResult.ANY_TYPE) {
            type =
                value instanceof XString
                    ? XPathResult.STRING_TYPE
                    : value instanceof XNumber
                      ? XPathResult.NUMBER_TYPE
                      : value instanceof XBoolean
                        ? XPathResult.BOOLEAN_TYPE
                        : XPathResult.UNORDERED_NODE_ITERATOR_TYPE;
        }
        this.resultType = type;
        if (type === XPathResult.NUMBER_TYPE) this.numberValue = value.numberValue();
        else if (type === XPathResult.STRING_TYPE) this.stringValue = value.stringValue();
        else if (type === XPathResult.BOOLEAN_TYPE) this.booleanValue = value.booleanValue();
        else if (!(value instanceof XNodeSet) || type < 4 || type > 9)
            throw new XPathException(XPathException.TYPE_ERR);
        else if (type >= 8) this.singleNodeValue = value.first();
        else {
            this.nodes = value.toArray();
            if (type >= 6) this.snapshotLength = this.nodes.length;
            else this.invalidIteratorState = false;
        }
    }

    iterateNext(): DomNode | undefined {
        if (
            this.resultType !== XPathResult.UNORDERED_NODE_ITERATOR_TYPE &&
            this.resultType !== XPathResult.ORDERED_NODE_ITERATOR_TYPE
        ) {
            throw new XPathException(XPathException.TYPE_ERR);
        }
        return this.nodes?.[this.#iteratorIndex++];
    }

    snapshotItem(index: number): DomNode | undefined {
        if (
            this.resultType !== XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE &&
            this.resultType !== XPathResult.ORDERED_NODE_SNAPSHOT_TYPE
        ) {
            throw new XPathException(XPathException.TYPE_ERR);
        }
        return this.nodes?.[index];
    }
}

export function evaluate(
    expression: string,
    contextNode: DomNode | null | undefined,
    resolver: XPathNSResolver | null | undefined,
    type: number,
    _result?: unknown,
    options?: Pick<SelectOptions, 'mode'>
): XPathResult {
    if (type < 0 || type > 9) throw new XPathTypeError('Request type not supported');
    let program: XPathProgram;
    try {
        program = programFor(expression, options?.mode);
    } catch (error) {
        throw new XPathException(XPathException.INVALID_EXPRESSION_ERR, error);
    }
    const node = contextNodeOf(contextNode);
    const namespaces: NamespaceLookup = lookupOf(resolver);
    const caseInsensitive = program.mode === 'strict' ? isHtmlDocument(node) : detectHtmlDom(node);
    const { value, state } = program.runRaw({ node, namespaces, caseInsensitive });
    // Strict: a node-set asked for as a number goes through the grammar of 4.4 (an empty node-set is NaN, `0x10` is
    // NaN), not through JavaScript's Number() as upstream does.
    if (type === XPathResult.NUMBER_TYPE && state.strict && value instanceof NodeSet)
        return new XPathResult(new XNumber(toNumberValue(value, state)), type);
    return new XPathResult(wrap(value), type);
}

// ---- guards ----

export const isNodeLike: (value: unknown) => value is LibNode = isDomNode;
export const isArrayOfNodes: (value: unknown) => value is LibNode[] = isDomNodeArray;
const ofType =
    (type: number) =>
    (value: unknown): value is DomNode =>
        isDomNode(value) && value.nodeType === type;
export const isElement: (value: unknown) => value is LibElement = ofType(ELEMENT_NODE);
export const isAttribute: (value: unknown) => value is LibAttr = ofType(ATTRIBUTE_NODE);
export const isTextNode: (value: unknown) => value is LibText = ofType(TEXT_NODE);
export const isCDATASection: (value: unknown) => value is LibCDATASection = ofType(CDATA_SECTION_NODE);
export const isProcessingInstruction: (value: unknown) => value is LibProcessingInstruction =
    ofType(PROCESSING_INSTRUCTION_NODE);
export const isComment: (value: unknown) => value is LibComment = ofType(COMMENT_NODE);
export const isDocumentNode: (value: unknown) => value is LibDocument = ofType(DOCUMENT_NODE);
export const isDocumentTypeNode: (value: unknown) => value is LibDocumentType = ofType(10);
export const isDocumentFragment: (value: unknown) => value is LibDocumentFragment = ofType(DOCUMENT_FRAGMENT_NODE);
