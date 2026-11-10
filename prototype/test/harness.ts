// Typed access to the untyped things the tests and benchmarks need: the legacy `xpath` builds (upstream 0.0.36 and
// the bugsee fork) and the DOM implementations. Everything enters as `unknown` and is narrowed by a guard; nothing
// here is cast.

import { createRequire } from 'node:module';
import path from 'node:path';
import { isDomNode } from '../src/dom.ts';
import type { DomNode } from '../src/dom.ts';

const require = createRequire(import.meta.url);

export const SCRATCH: string = path.resolve(import.meta.dirname, '../../..');
export const UPSTREAM_PATH: string = path.join(SCRATCH, 'forks/xpath.upstream.js');
export const FORK_PATH: string = path.join(SCRATCH, 'forks/xpath-up/xpath.js');
const DOMS = path.join(SCRATCH, 'forks/review/doms/node_modules');
const APP_XMLDOM = '/Volumes/External2TB/Projects/Bugsee/appserver/node_modules/@xmldom/xmldom';

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

function member(owner: unknown, name: string): unknown {
    return isRecord(owner) ? owner[name] : undefined;
}

function construct(owner: unknown, name: string, ...args: unknown[]): unknown {
    const ctor = member(owner, name);
    if (!isConstructor(ctor)) throw new TypeError(`${name} is not a constructor`);
    return new ctor(...args);
}

export function call(owner: unknown, name: string, ...args: unknown[]): unknown {
    const fn = member(owner, name);
    if (!isCallable(fn)) throw new TypeError(`${name} is not a function`);
    return fn.apply(owner, args);
}

/** The part of the legacy package's API the harness drives. */
export interface XPathLike {
    select(expression: string, node: unknown, single?: boolean): unknown;
    parseEvaluate(expression: string, options: unknown): unknown;
    parseSelect(expression: string, options: unknown): unknown;
    orderPair(a: unknown, b: unknown): unknown;
}

/** The legacy module itself, untyped, for tests that need more of its API than XPathLike. */
export function loadRaw(file: string): unknown {
    return require(file);
}

export function loadXPath(file: string): XPathLike {
    const lib: unknown = require(file);
    return {
        select: (expression, node, single) => call(lib, 'select', expression, node, single),
        parseEvaluate: (expression, options) => call(call(lib, 'parse', expression), 'evaluate', options),
        parseSelect: (expression, options) => call(call(lib, 'parse', expression), 'select', options),
        orderPair: (a, b) => {
            const set = construct(lib, 'XNodeSet');
            call(set, 'add', a);
            call(set, 'add', b);
            return call(set, 'toArray');
        }
    };
}

export type DomName = 'xmldom08' | 'xmldom09' | 'xmldom06' | 'jsdom' | 'happy' | 'linkedom';
export const DOM_NAMES: readonly DomName[] = ['xmldom08', 'xmldom09', 'xmldom06', 'jsdom', 'happy', 'linkedom'];

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
            const lib: unknown = require(APP_XMLDOM);
            return (xml) => asDocument(call(construct(lib, 'DOMParser', { errorHandler: silent }), 'parseFromString', xml, 'text/xml'));
        }
        case 'xmldom09': {
            const lib: unknown = require(path.join(DOMS, 'xmldom09'));
            return (xml) => asDocument(call(construct(lib, 'DOMParser', { onError: silent }), 'parseFromString', xml, 'text/xml'));
        }
        case 'xmldom06': {
            const lib: unknown = require(path.join(DOMS, 'xmldom'));
            return (xml) => asDocument(call(construct(lib, 'DOMParser', { errorHandler: silent }), 'parseFromString', xml, 'text/xml'));
        }
        case 'jsdom': {
            const lib: unknown = require(path.join(DOMS, 'jsdom'));
            const window = member(construct(lib, 'JSDOM', ''), 'window');
            return (xml) => asDocument(call(construct(window, 'DOMParser'), 'parseFromString', xml, 'text/xml'));
        }
        case 'happy': {
            const lib: unknown = require(path.join(DOMS, 'happy-dom'));
            const window = construct(lib, 'Window');
            return (xml) => asDocument(call(construct(window, 'DOMParser'), 'parseFromString', xml, 'text/xml'));
        }
        case 'linkedom': {
            const lib: unknown = require(path.join(DOMS, 'linkedom'));
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
        if (value['isXPathNamespace'] === true) return `ns:${String(value['prefix'])}=${String(value['nodeValue'])}@${index.get(value['ownerElement']) ?? '?'}`;
        const at = index.get(value);
        return at === undefined ? `UNKNOWN:${String(value['nodeName'])}` : String(at);
    }
    return `${typeof value}:${String(value)}`;
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Deterministic generator shared by the fuzzers (same recurrence as forks/review/fuzz2.js). */
export function makeRandom(seed: number): () => number {
    let state = seed;
    return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

export function milliseconds(run: () => void): number {
    const start = process.hrtime.bigint();
    run();
    return Number(process.hrtime.bigint() - start) / 1e6;
}
