// Typed access to the untyped things the tests and benchmarks need: the xpath engines (the oracle, upstream
// xpath 0.0.36, and the candidate under test) and the DOM implementations. Everything enters as `unknown` and is
// narrowed by a guard; nothing here is cast.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDomNode } from './support/dom.ts';
import type { DomNode } from './support/dom.ts';

const require = createRequire(import.meta.url);

/** The oracle: upstream xpath, a devDependency pinned to an exact version. */
export const ORACLE_PACKAGE = 'xpath';
/** The candidate when CANDIDATE is not set: this engine. */
export const DEFAULT_CANDIDATE = './src/index.ts';

type Constructor = new (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isConstructor(value: unknown): value is Constructor {
    return typeof value === 'function';
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
    return typeof value === 'function';
}

export function member(owner: unknown, name: string): unknown {
    return isRecord(owner) ? owner[name] : undefined;
}

export function construct(owner: unknown, name: string, ...args: unknown[]): unknown {
    const ctor = member(owner, name);
    if (!isConstructor(ctor)) throw new TypeError(`${name} is not a constructor`);
    return new ctor(...args);
}

export function call(owner: unknown, name: string, ...args: unknown[]): unknown {
    const fn = member(owner, name);
    if (!isCallable(fn)) throw new TypeError(`${name} is not a function`);
    return fn.apply(owner, args);
}

/** What CANDIDATE names: a package name, or a path (starting with `.` or absolute) to a module file. */
export function candidateSpec(): string {
    return process.env['CANDIDATE'] ?? DEFAULT_CANDIDATE;
}

/**
 * Loads an xpath engine: CommonJS, or ES modules without top-level await (Node >= 22.12 can require() those).
 * A package name resolves from this repository's node_modules; a path resolves from the working directory.
 */
export function loadModule(spec: string): unknown {
    const isPath = spec.startsWith('.') || path.isAbsolute(spec);
    const target = isPath ? path.resolve(process.cwd(), spec) : spec;
    if (isPath && !existsSync(target)) throw new Error(`candidate module not found: ${target}`);
    const loaded: unknown = require(target);
    const inner = member(loaded, 'default');
    return member(loaded, 'select') === undefined && isRecord(inner) && member(inner, 'select') !== undefined
        ? inner
        : loaded;
}

export const loadOracleModule = (): unknown => loadModule(ORACLE_PACKAGE);
export const loadCandidateModule = (): unknown => loadModule(candidateSpec());

/** The part of an engine's legacy API the harness drives, over any module with that API. */
export interface XPathLike {
    /** `options` ({budget, timeoutMs}) are the engine's extension; upstream ignores them. */
    select(expression: string, node: unknown, single?: boolean, options?: Readonly<Record<string, unknown>>): unknown;
    parseSelect(expression: string, options: Record<string, unknown>): unknown;
    evaluateNodeSet(expression: string, options: Record<string, unknown>): { toArray(): unknown };
    evaluateString(expression: string, options: Record<string, unknown>): unknown;
    /** A node-set built directly from the given nodes, as `new XNodeSet()` plus `addArray`. */
    newSet(nodes: readonly unknown[]): { toArray(): unknown };
    /** The two nodes in the order the engine's own node-set sorts them. */
    orderPair(a: unknown, b: unknown): unknown;
    /** An XPathResult iterator (type 5) read to the end. */
    iterate(expression: string, node: unknown): unknown[];
    /** `useNamespaces(map)(expression, node)`: a selection with a namespace resolver. */
    selectWithNamespaces(expression: string, node: unknown, namespaces: Readonly<Record<string, string>>): unknown;
}

/**
 * The mode the harness asks an xpath-es candidate for. The differential gates compare against upstream, so the
 * default here is `upstream` even though the engine's own default is `strict`; CANDIDATE_MODE=strict asks for the
 * engine's default. Upstream ignores the extra option.
 */
export function candidateMode(): 'upstream' | 'strict' {
    return process.env['CANDIDATE_MODE'] === 'strict' ? 'strict' : 'upstream';
}

export function loadXPath(lib: unknown): XPathLike {
    const mode = { mode: candidateMode() };
    const newSet = (nodes: readonly unknown[]): { toArray(): unknown } => {
        const set = construct(lib, 'XNodeSet');
        call(set, 'addArray', nodes);
        return { toArray: () => call(set, 'toArray') };
    };
    return {
        select: (expression, node, single, options) =>
            call(lib, 'select', expression, node, single, { ...options, ...mode }),
        parseSelect: (expression, options) => call(call(lib, 'parse', expression, mode), 'select', options),
        evaluateNodeSet: (expression, options) => {
            const set = call(call(lib, 'parse', expression, mode), 'evaluateNodeSet', options);
            return { toArray: () => call(set, 'toArray') };
        },
        evaluateString: (expression, options) => call(call(lib, 'parse', expression, mode), 'evaluateString', options),
        newSet,
        orderPair: (a, b) => newSet([a, b]).toArray(),
        selectWithNamespaces: (expression, node, namespaces) => {
            const selector = call(lib, 'useNamespaces', namespaces, mode);
            if (!isCallable(selector)) throw new TypeError('useNamespaces did not return a function');
            return selector(expression, node);
        },
        iterate: (expression, node) => {
            const result = call(lib, 'evaluate', expression, node, null, 5, null, mode);
            const out: unknown[] = [];
            for (let next = call(result, 'iterateNext'); next != null; next = call(result, 'iterateNext'))
                out.push(next);
            return out;
        }
    };
}

export const loadOracle = (): XPathLike => loadXPath(loadOracleModule());
export const loadCandidate = (): XPathLike => loadXPath(loadCandidateModule());

export type DomName = 'xmldom08' | 'xmldom09' | 'jsdom' | 'happy' | 'linkedom';
export const DOM_NAMES: readonly DomName[] = ['xmldom08', 'xmldom09', 'jsdom', 'happy', 'linkedom'];

export function isDomName(value: string): value is DomName {
    return DOM_NAMES.some((name) => name === value);
}

export type XmlParser = (xml: string) => DomNode;

function asDocument(value: unknown): DomNode {
    if (!isDomNode(value)) throw new TypeError('The parser did not return a DOM node');
    return value;
}

export function loadDom(name: DomName): XmlParser {
    const silent = (): void => {};
    switch (name) {
        case 'xmldom08': {
            const lib: unknown = require('@xmldom/xmldom');
            return (xml) =>
                asDocument(
                    call(construct(lib, 'DOMParser', { errorHandler: silent }), 'parseFromString', xml, 'text/xml')
                );
        }
        case 'xmldom09': {
            const lib: unknown = require('xmldom09');
            return (xml) =>
                asDocument(call(construct(lib, 'DOMParser', { onError: silent }), 'parseFromString', xml, 'text/xml'));
        }
        case 'jsdom': {
            const lib: unknown = require('jsdom');
            const window = member(construct(lib, 'JSDOM', ''), 'window');
            return (xml) => asDocument(call(construct(window, 'DOMParser'), 'parseFromString', xml, 'text/xml'));
        }
        case 'happy': {
            const lib: unknown = require('happy-dom');
            const window = construct(lib, 'Window');
            return (xml) => asDocument(call(construct(window, 'DOMParser'), 'parseFromString', xml, 'text/xml'));
        }
        case 'linkedom': {
            const lib: unknown = require('linkedom');
            return (xml) => asDocument(call(construct(lib, 'DOMParser'), 'parseFromString', xml, 'text/xml'));
        }
    }
}

/** Every node of a tree in document order: element, its attributes, its children. */
export function allNodes(root: DomNode): DomNode[] {
    const out: DomNode[] = [];
    let node: DomNode | null | undefined = root;
    while (node != null) {
        out.push(node);
        const attributes = node.attributes;
        const count = attributes?.length ?? 0;
        for (let i = 0; i < count; i++) {
            const attribute = attributes?.item(i);
            if (attribute != null) out.push(attribute);
        }
        let next: DomNode | null | undefined = node.firstChild;
        while (next == null && node != null && node !== root) {
            next = node.nextSibling;
            if (next == null) node = node.parentNode;
        }
        node = next;
    }
    return out;
}

/** A printable identity for a result, the same for both engines: node -> its index in `index`. */
export function describe(value: unknown, index: ReadonlyMap<unknown, number>): string {
    if (Array.isArray(value)) return `[${value.map((item) => describe(item, index)).join(',')}]`;
    if (isRecord(value)) {
        if (value['isXPathNamespace'] === true)
            return `ns:${String(value['prefix'])}=${String(value['nodeValue'])}@${index.get(value['ownerElement']) ?? '?'}`;
        const at = index.get(value);
        return at === undefined ? `UNKNOWN:${String(value['nodeName'])}` : String(at);
    }
    // -0 and 0 print alike with String(); they are different numbers (1 div -0), so they must not compare equal.
    return `${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`;
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Deterministic generator shared by the fuzzers (a linear congruential generator, so a seed reproduces a run). */
export function makeRandom(seed: number): () => number {
    let state = seed;
    return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

export function milliseconds(run: () => void): number {
    const start = process.hrtime.bigint();
    run();
    return Number(process.hrtime.bigint() - start) / 1e6;
}
