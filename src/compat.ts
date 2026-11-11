// Drop-in entry for code written against the `xpath` package (goto100/xpath 0.0.36): the same names, the same
// arguments, the same results. Only what is needed to measure and fuzz the engine against upstream is here;
// the rest of upstream's surface is not implemented.
//
// Typing note: upstream's declarations use lib.dom's `Node`. This entry uses the structural `DomNode`, which every
// `Node` is assignable to; results come back as `DomNode` and the `is*` guards narrow them.

import { NO_NODE } from './compile.ts';
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
import { lookupNamespaceInDom, XPathProgram } from './program.ts';
import type { EvaluateOptions } from './program.ts';
import { NodeSet, numberToString, stringToNumber, stringValueOf } from './runtime.ts';
import type { CustomFunction, FunctionLookup, NamespaceLookup, VariableLookup, XValue } from './runtime.ts';

export type SelectedValue = DomNode | string | number | boolean | null | undefined;
export type SelectReturnType = DomNode[] | SelectedValue;
export type SelectSingleReturnType = SelectedValue;

export interface XPathNSResolver {
    lookupNamespaceURI(prefix: string): string | null | undefined;
}

export interface XPathSelect {
    (expression: string, node?: DomNode | null, single?: false): SelectReturnType;
    (expression: string, node: DomNode | null | undefined, single: true): SelectSingleReturnType;
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

    toArray(): DomNode[] {
        this.#sorted ??= sortInDocumentOrder([...this.#members]);
        return this.#sorted.slice();
    }

    first(): DomNode | null {
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

// ---- parse cache: expression text -> program. Holds no DOM state; bounded. ----

const PROGRAM_CACHE_LIMIT = 512;
const programs = new Map<string, XPathProgram>();

function programFor(expression: unknown): XPathProgram {
    if (!expression) throw new XPathSyntaxError('XPath expression unspecified.');
    if (typeof expression !== 'string') throw new XPathSyntaxError('XPath expression must be a string.');
    const cached = programs.get(expression);
    if (cached !== undefined) return cached;
    const program = new XPathProgram(expression);
    if (programs.size >= PROGRAM_CACHE_LIMIT) programs.clear();
    programs.set(expression, program);
    return program;
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

function selectOne(
    expression: unknown,
    node: unknown,
    resolver: XPathNSResolver | null | undefined
): SelectSingleReturnType {
    const program = programFor(expression);
    const contextNode = contextNodeOf(node);
    const namespaces: NamespaceLookup = resolver == null ? () => null : (prefix) => resolver.lookupNamespaceURI(prefix);
    const { value, state } = program.run({
        node: contextNode,
        namespaces,
        caseInsensitive: detectHtmlDom(contextNode)
    });
    return value instanceof NodeSet ? value.sorted(state)[0] : value;
}

function selectAll(expression: unknown, node: unknown, resolver: XPathNSResolver | null | undefined): SelectReturnType {
    const program = programFor(expression);
    const contextNode = contextNodeOf(node);
    const namespaces: NamespaceLookup = resolver == null ? () => null : (prefix) => resolver.lookupNamespaceURI(prefix);
    const { value, state } = program.run({
        node: contextNode,
        namespaces,
        caseInsensitive: detectHtmlDom(contextNode)
    });
    return value instanceof NodeSet ? value.sorted(state).slice() : value;
}

export function selectWithResolver(
    expression: string,
    node?: DomNode | null,
    resolver?: XPathNSResolver | null,
    single?: false
): SelectReturnType;
export function selectWithResolver(
    expression: string,
    node: DomNode | null | undefined,
    resolver: XPathNSResolver | null | undefined,
    single: true
): SelectSingleReturnType;
export function selectWithResolver(
    expression: string,
    node?: DomNode | null,
    resolver?: XPathNSResolver | null,
    single?: boolean
): SelectReturnType {
    return single === true ? selectOne(expression, node, resolver) : selectAll(expression, node, resolver);
}

export function select(expression: string, node?: DomNode | null, single?: false): SelectReturnType;
export function select(expression: string, node: DomNode | null | undefined, single: true): SelectSingleReturnType;
export function select(expression: string, node?: DomNode | null, single?: boolean): SelectReturnType {
    return single === true ? selectOne(expression, node, null) : selectAll(expression, node, null);
}

export function select1(expression: string, node?: DomNode | null): SelectSingleReturnType {
    return selectOne(expression, node, null);
}

export function useNamespaces(mappings: Readonly<Record<string, string>>): XPathSelect {
    const resolver: XPathNSResolver = { lookupNamespaceURI: (prefix) => mappings[prefix] };
    function selectWithMappings(expression: string, node?: DomNode | null, single?: false): SelectReturnType;
    function selectWithMappings(
        expression: string,
        node: DomNode | null | undefined,
        single: true
    ): SelectSingleReturnType;
    function selectWithMappings(expression: string, node?: DomNode | null, single?: boolean): SelectReturnType {
        return single === true ? selectOne(expression, node, resolver) : selectAll(expression, node, resolver);
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
        const member = option[method];
        if (isFunction(member)) return { call: (...args) => member.apply(option, args), callback: true };
    }
    if (isFunction(option)) return { call: option, callback: true };
    if (isRecord(option))
        return { call: (name) => (typeof name === 'string' ? option[name] : undefined), callback: false };
    return null;
}

function toEngineOptions(options: XPathEvaluateOptions | undefined): EvaluateOptions {
    if (options === undefined) return {};
    const namespaces = lookupFrom(options.namespaces, 'getNamespace');
    const variables = lookupFrom(options.variables, 'getVariable');
    const functions = lookupFrom(options.functions, 'getFunction');
    const namespaceLookup: NamespaceLookup | undefined =
        namespaces === null
            ? undefined
            : (prefix, node) => {
                  const uri = namespaces.call(prefix, node);
                  return typeof uri === 'string' && uri !== '' ? uri : lookupNamespaceInDom(prefix, node);
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
        callbacks: { namespaces: namespaces?.callback ?? false, variables: variables?.callback ?? false },
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

    evaluate(options?: XPathEvaluateOptions): XPathValueObject {
        return wrap(this.#program.run(toEngineOptions(options)).value);
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

    select(options?: XPathEvaluateOptions): DomNode[] {
        const { value, state } = this.#program.run(toEngineOptions(options));
        if (!(value instanceof NodeSet)) throw new XPathTypeError(`Cannot convert ${typeof value} to nodeset`);
        return value.sorted(state).slice();
    }

    select1(options?: XPathEvaluateOptions): DomNode | undefined {
        return this.select(options)[0];
    }
}

export function parse(expression: string): XPathEvaluator {
    return new XPathEvaluator(programFor(expression));
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
    _result?: unknown
): XPathResult {
    if (type < 0 || type > 9) throw new XPathTypeError('Request type not supported');
    let program: XPathProgram;
    try {
        program = programFor(expression);
    } catch (error) {
        throw new XPathException(XPathException.INVALID_EXPRESSION_ERR, error);
    }
    const node = contextNodeOf(contextNode);
    const namespaces: NamespaceLookup = resolver == null ? () => null : (prefix) => resolver.lookupNamespaceURI(prefix);
    const { value } = program.run({ node, namespaces, caseInsensitive: detectHtmlDom(node) });
    return new XPathResult(wrap(value), type);
}

// ---- guards ----

export const isNodeLike: (value: unknown) => value is DomNode = isDomNode;
export const isArrayOfNodes: (value: unknown) => value is DomNode[] = isDomNodeArray;
const ofType =
    (type: number) =>
    (value: unknown): value is DomNode =>
        isDomNode(value) && value.nodeType === type;
export const isElement: (value: unknown) => value is DomNode = ofType(ELEMENT_NODE);
export const isAttribute: (value: unknown) => value is DomNode = ofType(ATTRIBUTE_NODE);
export const isTextNode: (value: unknown) => value is DomNode = ofType(TEXT_NODE);
export const isCDATASection: (value: unknown) => value is DomNode = ofType(CDATA_SECTION_NODE);
export const isProcessingInstruction: (value: unknown) => value is DomNode = ofType(PROCESSING_INSTRUCTION_NODE);
export const isComment: (value: unknown) => value is DomNode = ofType(COMMENT_NODE);
export const isDocumentNode: (value: unknown) => value is DomNode = ofType(DOCUMENT_NODE);
export const isDocumentTypeNode: (value: unknown) => value is DomNode = ofType(10);
export const isDocumentFragment: (value: unknown) => value is DomNode = ofType(DOCUMENT_FRAGMENT_NODE);

export { NO_NODE };
