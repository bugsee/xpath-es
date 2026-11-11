// The oracle with one change: upstream's namespace axis makes a new XPathNamespace object on every evaluation, so a
// context that is reached twice yields the same namespace node twice, and a node-set built from them holds
// duplicates (upstream's own duplicate removal compares objects, and on xmldom 0.9 its ordering function cannot
// compare synthetic nodes). Here the objects are interned per (element, prefix, declaration), so a document that is
// changed between two evaluations never gets a stale namespace node. Everything else is upstream's source,
// untouched.
//
// It exists to classify a difference rigorously: when the engine's answer equals this oracle's answer, the only thing
// separating the engine from upstream on that evaluation was the duplicate namespace nodes (`isNamespaceDuplicate`).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadXPath } from '../harness.ts';
import type { XPathLike } from '../harness.ts';

const require = createRequire(import.meta.url);

const SITES = [
    'new XPathNamespace("xml", null, XPath.XML_NAMESPACE_URI, xpc.contextNode)',
    'new XPathNamespace(pre, attr, attr.value, xpc.contextNode)'
] as const;

const HELPER = `
var __internedNamespaces = new WeakMap();
function __internNamespace(Constructor, pre, node, uri, owner) {
    var byPrefix = __internedNamespaces.get(owner);
    if (byPrefix === undefined) { byPrefix = new Map(); __internedNamespaces.set(owner, byPrefix); }
    var made = byPrefix.get(pre);
    // An entry made for another declaration (the element was reparented, or the attribute changed) is stale.
    if (made === undefined || made.baseNode !== node || made.nodeValue !== uri) { made = new Constructor(pre, node, uri, owner); byPrefix.set(pre, made); }
    return made;
}
`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

function isModuleConstructor(
    value: unknown
): value is new (id: string) => { _compile(source: string, file: string): void; exports: unknown } {
    return typeof value === 'function';
}

let cached: XPathLike | null = null;

/** upstream xpath's source with the two namespace-node creation sites interned; throws if upstream's source changed. */
export function loadInternedOracle(): XPathLike {
    if (cached !== null) return cached;
    const file = require.resolve('xpath');
    let source = readFileSync(file, 'utf8');
    for (const site of SITES) {
        if (!source.includes(site)) throw new Error(`upstream xpath no longer contains: ${site}`);
        const args = site.slice('new XPathNamespace('.length, -1);
        source = source.replace(site, `__internNamespace(XPathNamespace, ${args})`);
    }
    const moduleConstructor: unknown = require('node:module');
    if (!isModuleConstructor(moduleConstructor)) throw new Error('node:module is not constructible');
    const patched = new moduleConstructor(file);
    patched._compile(HELPER + source, file);
    if (!isRecord(patched.exports)) throw new Error('the patched oracle did not export an object');
    cached = loadXPath(patched.exports);
    return cached;
}
