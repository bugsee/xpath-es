// Core function library (XPath 1.0 section 4), with upstream's behaviour where it departs from the Recommendation.
// Arity and type errors are raised when the call is evaluated, never when it is compiled (as upstream does), and
// carry upstream's messages.

import type { StaticType } from './ast.ts';
import {
    ATTRIBUTE_NODE,
    DOCUMENT_NODE,
    ELEMENT_NODE,
    NAMESPACE_NODE,
    PROCESSING_INSTRUCTION_NODE,
    XML_NAMESPACE_URI
} from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathLimitError, XPathTypeError } from './errors.ts';
import {
    MAX_STRING_LENGTH,
    NodeSet,
    stringToNumber,
    stringValueOf,
    toBooleanValue,
    toNumberValue,
    toStringValue
} from './runtime.ts';
import type { Compiled, EvalState, Focus } from './runtime.ts';

export const CORE_RETURN_TYPES: ReadonlyMap<string, StaticType> = new Map<string, StaticType>([
    ['last', 'number'],
    ['position', 'number'],
    ['count', 'number'],
    ['id', 'node-set'],
    ['local-name', 'string'],
    ['namespace-uri', 'string'],
    ['name', 'string'],
    ['string', 'string'],
    ['concat', 'string'],
    ['starts-with', 'boolean'],
    ['contains', 'boolean'],
    ['substring-before', 'string'],
    ['substring-after', 'string'],
    ['substring', 'string'],
    ['string-length', 'number'],
    ['normalize-space', 'string'],
    ['translate', 'string'],
    ['boolean', 'boolean'],
    ['not', 'boolean'],
    ['true', 'boolean'],
    ['false', 'boolean'],
    ['lang', 'boolean'],
    ['number', 'number'],
    ['sum', 'number'],
    ['floor', 'number'],
    ['ceiling', 'number'],
    ['round', 'number']
]);

const expects = (name: string, signature: string): XPathTypeError =>
    new XPathTypeError(`Function ${name} expects ${signature}`);

/** The node a `(node-set?)` function is about: the context node, or the first node of the argument in document order. */
function targetNode(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): DomNode | null {
    const arg = args[0];
    if (arg === undefined) return focus.node;
    const value = args.length === 1 ? arg(focus, state) : null;
    if (!(value instanceof NodeSet)) throw expects(name, '(node-set?)');
    return value.first(state);
}

function stringArgs(
    name: string,
    signature: string,
    count: number,
    args: readonly Compiled[],
    focus: Focus,
    state: EvalState
): string[] {
    if (args.length !== count) throw expects(name, signature);
    return args.map((arg) => toStringValue(arg(focus, state), state));
}

function optionalString(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): string {
    const arg = args[0];
    if (arg === undefined) return stringValueOf(focus.node, state);
    if (args.length !== 1) throw expects(name, '(string?)');
    return toStringValue(arg(focus, state), state);
}

function oneNumber(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): number {
    const arg = args[0];
    if (arg === undefined || args.length !== 1) throw expects(name, '(number)');
    return toNumberValue(arg(focus, state), state);
}

function oneNodeSet(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): NodeSet {
    const arg = args[0];
    const value = arg === undefined || args.length !== 1 ? null : arg(focus, state);
    if (!(value instanceof NodeSet)) throw expects(name, '(node-set)');
    return value;
}

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;

/**
 * normalize-space(): trims and collapses runs of space, tab, CR and LF. One pass; upstream's two regular
 * expressions (`^\s+|\s+$` and a run collapse) backtrack quadratically on a long string that has inner runs of spaces.
 */
function normalizeSpace(text: string): string {
    // The words are copied out as slices and joined once: appending a character at a time keeps a string of ropes alive
    // (hundreds of megabytes for a 15-million-character input).
    const words: string[] = [];
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        if (isSpace(text.charCodeAt(i))) {
            if (start >= 0) words.push(text.slice(start, i));
            start = -1;
        } else if (start < 0) start = i;
    }
    if (start >= 0) words.push(text.slice(start));
    return words.join(' ');
}

/** Code units gathered before a piece of a translate() result is made into a string. */
const TRANSLATE_CHUNK = 8192;
const SURROGATE = /[\ud800-\udfff]/;

/** Index of `part` in `text` at or after `from`, where a match may not begin or end inside a surrogate pair (strict: characters). */
function indexOfCharacters(text: string, part: string, from = 0): number {
    let at = text.indexOf(part, from);
    if (!SURROGATE.test(part)) return at;
    const half = (position: number): boolean => {
        const next = text.charCodeAt(position);
        const before = text.charCodeAt(position - 1);
        return position > 0 && next >= 0xdc00 && next <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
    };
    while (at !== -1 && (half(at) || half(at + part.length))) at = text.indexOf(part, at + 1);
    return at;
}

/** The characters (code points) of the text, as slices: the unit strict mode counts in. */
function characterAt(text: string, i: number): number {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

/** String(value) without the lint's worry: a DOM node's own toString() is what Q-FN-ID wants. */
const stringify: (value: unknown) => string = String;
const ID_SEPARATOR = /[\r\n\t ]+/;
/** Distinct tokens one id() call may look up. */
const MAX_ID_TOKENS = 10_000;
/** Up to this many tokens go to the DOM's getElementById; more use one index of the document. */
const FEW_ID_TOKENS = 8;

/** The string-values of a node-set, joined by spaces (strict id(), section 4.1). */
function stringValues(set: NodeSet, state: EvalState): string {
    const parts: string[] = [];
    let length = 0;
    for (const node of set.sorted(state)) {
        const text = stringValueOf(node, state);
        length += text.length + 1;
        if (length > MAX_STRING_LENGTH) throw new XPathLimitError('id() argument is too long');
        parts.push(text);
    }
    return parts.join(' ');
}

/**
 * The text id() takes from a node-set: the nodes' serialisations, joined by spaces (Q-FN-ID). Serialising an element
 * walks its subtree, so the walk is charged first, and a document whose nodes nest deeply (every serialisation holds
 * the whole chain below it) runs out of budget instead of building gigabytes.
 */
function serialisedIds(set: NodeSet, state: EvalState): string {
    const parts: string[] = [];
    let length = 0;
    for (const node of set.sorted(state)) {
        let size = 1;
        for (let walk: DomNode | null | undefined = node.firstChild; walk != null;) {
            if (++size % 4096 === 0) state.charge(4096);
            let next: DomNode | null | undefined = walk.firstChild;
            while (next == null && walk != null && walk !== node) {
                next = walk.nextSibling;
                if (next == null) walk = walk.parentNode;
            }
            walk = next;
        }
        state.charge(size % 4096);
        const text = stringify(node);
        length += text.length + 1;
        if (length > MAX_STRING_LENGTH) throw new XPathLimitError('id() argument is too long');
        state.charge(text.length >> 3);
        parts.push(text);
    }
    return parts.join(' ');
}

/**
 * Q-FN-LANG: the first ancestor-or-self whose getAttributeNS() answers anything but null decides, so on a DOM that
 * answers '' for a missing attribute only the context node is ever looked at. The answer for a node is that of the
 * nearest decided ancestor, so each node is looked at once per evaluation (a deep document with lang() on every node
 * is linear, not quadratic), and each step is charged.
 */
function languageOf(start: DomNode, state: EvalState): string | null {
    const walked: DomNode[] = [];
    let language: string | null = null;
    for (
        let node: DomNode | null | undefined = start;
        node != null && node.nodeType !== DOCUMENT_NODE;
        node = node.parentNode
    ) {
        const known = state.languages.get(node);
        if (known !== undefined) {
            language = known;
            break;
        }
        state.charge(1);
        if (node.getAttributeNS === undefined) throw new XPathTypeError('Function lang needs an element context');
        walked.push(node);
        const value = node.getAttributeNS(XML_NAMESPACE_URI, 'lang');
        if (value != null) {
            language = String(value);
            break;
        }
    }
    for (const node of walked) state.languages.set(node, language);
    return language;
}

/**
 * Section 4.3 (strict): the xml:lang attribute of the nearest ancestor-or-self element decides; an attribute or
 * namespace node is looked at from its element. Each element is looked at once per evaluation.
 */
function strictLanguageOf(start: DomNode, state: EvalState): string | null {
    const walked: DomNode[] = [];
    let language: string | null = null;
    let node: DomNode | null | undefined =
        start.nodeType === ATTRIBUTE_NODE || start.nodeType === NAMESPACE_NODE ? start.ownerElement : start;
    for (; node != null && node.nodeType !== DOCUMENT_NODE; node = node.parentNode) {
        const known = state.languages.get(node);
        if (known !== undefined) {
            language = known;
            break;
        }
        walked.push(node);
        const attributes = node.attributes;
        const count = attributes?.length ?? 0;
        state.charge(count + 1);
        let found: string | null = null;
        for (let i = 0; i < count && found === null; i++) {
            const attribute = attributes?.item(i);
            if (attribute != null && String(attribute.name ?? attribute.nodeName) === 'xml:lang')
                found = String(attribute.value ?? attribute.nodeValue ?? '');
        }
        if (found !== null) {
            language = found;
            break;
        }
    }
    for (const visited of walked) state.languages.set(visited, language);
    return language;
}

/**
 * Section 4.2 (strict), from the text of the Recommendation: the characters from position round(start) up to, not
 * including, round(start) + round(length) (to the end without a length); NaN gives the empty string; the arithmetic is
 * done on doubles, so -Infinity and +Infinity clamp to the ends. `substring("12345", 1.5, 2.5)` is "234",
 * `substring("12345", 0, 3)` is "12", `substring("12345", 0 div 0)` is "".
 */
export function strictSubstring(text: string, start: number, length: number | undefined): string {
    const first = Math.round(start);
    if (Number.isNaN(first)) return '';
    let end = Number.POSITIVE_INFINITY;
    if (length !== undefined) {
        end = first + Math.round(length);
        if (Number.isNaN(end)) return '';
    }
    // Walk the string once, by characters, to the offsets of the first and the last wanted one: no array of characters.
    const low = Math.max(first, 1) - 1;
    const high = end - 1;
    if (!(low < high)) return '';
    let startOffset = text.length;
    let endOffset = text.length;
    let index = 0;
    for (let i = 0; i < text.length; i += characterAt(text, i), index++) {
        if (index === low) startOffset = i;
        if (index === high) {
            endOffset = i;
            break;
        }
    }
    return startOffset < endOffset ? text.slice(startOffset, endOffset) : '';
}

export function compileCoreFunction(name: string, args: readonly Compiled[]): Compiled | null {
    switch (name) {
        case 'last':
            return (focus) => {
                if (args.length !== 0) throw expects(name, '()');
                return focus.size;
            };
        case 'position':
            return (focus) => {
                if (args.length !== 0) throw expects(name, '()');
                return focus.position;
            };
        case 'count':
            return (focus, state) => oneNodeSet(name, args, focus, state).size;
        case 'id':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined || args.length !== 1) throw expects(name, '(object)');
                const value = arg(focus, state);
                // Upstream (Q-FN-ID) joins a node-set's nodes' own toString() (their serialisation); strict uses their
                // string-values, as section 4.1 says.
                const text =
                    value instanceof NodeSet
                        ? state.strict
                            ? stringValues(value, state)
                            : serialisedIds(value, state)
                        : toStringValue(value, state);
                if (text.length > MAX_STRING_LENGTH) throw new XPathLimitError('id() argument is too long');
                state.charge((text.length >> 3) + 1);
                const document = focus.node.nodeType === DOCUMENT_NODE ? focus.node : focus.node.ownerDocument;
                if (document == null || document.getElementById === undefined)
                    throw new XPathTypeError('Function id needs a document with getElementById');
                const tokens = new Set<string>(text.split(ID_SEPARATOR));
                if (tokens.size > MAX_ID_TOKENS)
                    throw new XPathLimitError(`id() with more than ${MAX_ID_TOKENS} distinct tokens`);
                state.charge(tokens.size);
                const found = new Set<DomNode>();
                if (tokens.size <= FEW_ID_TOKENS && !state.strict) {
                    // A few tokens: the DOM's own lookup, so that its rules for what an ID is stay its own.
                    for (const id of tokens) {
                        const element = state.elementById(document, id);
                        if (element != null) found.add(element);
                    }
                } else {
                    // One element per distinct token, the first in document order (a duplicate ID is an error in the
                    // document; id() does not report it, and browsers do not either).
                    const index = state.elementsById(document);
                    for (const id of tokens) {
                        // The empty token (from a leading separator) is the DOM's own business: xmldom's getElementById('')
                        // answers the first element, since a missing id attribute reads as ''. Upstream asks the DOM.
                        const element = id === '' && !state.strict ? state.elementById(document, '') : index.get(id);
                        if (element != null) found.add(element);
                    }
                }
                return new NodeSet([...found], false);
            };
        case 'local-name':
            return (focus, state) => {
                const node = targetNode(name, args, focus, state);
                return node === null ? '' : node.localName || node.target || node.nodeName || '';
            };
        case 'namespace-uri':
            return (focus, state) => targetNode(name, args, focus, state)?.namespaceURI || '';
        case 'name':
            return (focus, state) => {
                const node = targetNode(name, args, focus, state);
                if (node === null) return '';
                if (node.nodeType === ELEMENT_NODE) return node.nodeName;
                if (node.nodeType === ATTRIBUTE_NODE) return node.name || node.nodeName;
                if (node.nodeType === PROCESSING_INSTRUCTION_NODE) return node.target || node.nodeName;
                return node.localName ?? '';
            };
        case 'string':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined) return stringValueOf(focus.node, state);
                if (args.length !== 1) throw expects(name, '(object?)');
                return toStringValue(arg(focus, state), state);
            };
        case 'concat':
            return (focus, state) => {
                if (args.length < 2) throw expects(name, '(string, string[, string]*)');
                let text = '';
                for (const arg of args) {
                    const part = toStringValue(arg(focus, state), state);
                    // Before the string is built: nested concat() can double a string per level.
                    if (text.length + part.length > MAX_STRING_LENGTH)
                        throw new XPathLimitError(`concat() would make a string longer than ${MAX_STRING_LENGTH}`);
                    text += part;
                }
                state.charge(text.length >> 3);
                return text;
            };
        case 'starts-with':
            return (focus, state) => {
                const [text = '', prefix = ''] = stringArgs('startsWith', '(string, string)', 2, args, focus, state);
                state.charge(prefix.length >> 4);
                return state.strict ? indexOfCharacters(text, prefix) === 0 : text.startsWith(prefix);
            };
        case 'contains':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                state.charge(text.length >> 4);
                return state.strict ? indexOfCharacters(text, part) !== -1 : text.includes(part);
            };
        case 'substring-before':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                state.charge(text.length >> 4);
                // Strict: a match is of characters, so it cannot start or end inside a surrogate pair.
                if (state.strict) {
                    const at = indexOfCharacters(text, part);
                    return at === -1 ? '' : text.substring(0, at);
                }
                return text.substring(0, text.indexOf(part));
            };
        case 'substring-after':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                state.charge(text.length >> 4);
                const at = state.strict ? indexOfCharacters(text, part) : text.indexOf(part);
                return at === -1 ? '' : text.substring(at + part.length);
            };
        case 'substring':
            return (focus, state) => {
                const [textArg, startArg, lengthArg] = args;
                if (textArg === undefined || startArg === undefined || args.length > 3)
                    throw expects(name, '(string, number, number?)');
                const text = toStringValue(textArg(focus, state), state);
                if (state.strict) {
                    const from = toNumberValue(startArg(focus, state), state);
                    const count = lengthArg === undefined ? undefined : toNumberValue(lengthArg(focus, state), state);
                    state.charge(text.length >> 3);
                    return strictSubstring(text, from, count);
                }
                // Q-FN-SUBSTRING: JavaScript's substring() on rounded bounds (it swaps reversed bounds and reads NaN as 0).
                const start = Math.round(toNumberValue(startArg(focus, state), state)) - 1;
                if (lengthArg === undefined) return text.substring(start);
                return text.substring(start, start + Math.round(toNumberValue(lengthArg(focus, state), state)));
            };
        case 'string-length':
            return (focus, state) => {
                const text = optionalString(name, args, focus, state);
                if (!state.strict) return text.length;
                // Strict: characters, not UTF-16 units: a character outside the Basic Multilingual Plane counts once.
                state.charge(text.length >> 3);
                let characters = 0;
                for (const _ of text) characters++;
                return characters;
            };
        case 'normalize-space':
            return (focus, state) => {
                const text = optionalString(name, args, focus, state);
                state.charge(text.length >> 4);
                return normalizeSpace(text);
            };
        case 'translate':
            return (focus, state) => {
                const [text = '', from = '', to = ''] = stringArgs(
                    name,
                    '(string, string, string)',
                    3,
                    args,
                    focus,
                    state
                );
                state.charge((text.length + from.length) >> 4);
                // Strict: the characters of the Recommendation (code points); upstream mode: UTF-16 units, as upstream.
                const unit = (source: string, i: number): string =>
                    state.strict ? source.slice(i, i + characterAt(source, i)) : source.charAt(i);
                const map = new Map<string, string>();
                const targets: string[] = [];
                for (let i = 0; i < to.length; i += state.strict ? characterAt(to, i) : 1) targets.push(unit(to, i));
                for (let i = 0, at = 0; i < from.length; i += state.strict ? characterAt(from, i) : 1, at++) {
                    const ch = unit(from, i);
                    if (!map.has(ch)) map.set(ch, targets[at] ?? '');
                }
                // The result is written as code units into a small buffer that is turned into a string every few thousand
                // units, and the strings are joined once: a string grown by appending keeps a rope per character alive.
                const chunks: string[] = [];
                const buffer = new Uint16Array(TRANSLATE_CHUNK + 2);
                let used = 0;
                let changed = false;
                const flush = (): void => {
                    chunks.push(String.fromCharCode(...buffer.subarray(0, used)));
                    used = 0;
                };
                for (let i = 0; i < text.length;) {
                    const width = state.strict ? characterAt(text, i) : 1;
                    const replacement = map.get(width === 1 ? text.charAt(i) : text.slice(i, i + width));
                    if (replacement === undefined) {
                        for (let k = 0; k < width; k++) buffer[used++] = text.charCodeAt(i + k);
                    } else {
                        changed = true;
                        for (let k = 0; k < replacement.length; k++) buffer[used++] = replacement.charCodeAt(k);
                    }
                    if (used >= TRANSLATE_CHUNK) flush();
                    i += width;
                }
                if (!changed) return text;
                flush();
                return chunks.join('');
            };
        case 'boolean':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined || args.length !== 1) throw expects(name, '(object)');
                return toBooleanValue(arg(focus, state));
            };
        case 'not':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined || args.length !== 1) throw expects(name, '(object)');
                return !toBooleanValue(arg(focus, state));
            };
        case 'true':
        case 'false':
            return () => {
                if (args.length !== 0) throw expects(name, '()');
                return name === 'true';
            };
        case 'lang':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined || args.length !== 1) throw expects(name, '(string)');
                const language = state.strict ? strictLanguageOf(focus.node, state) : languageOf(focus.node, state);
                if (language === null) return false;
                const wanted = toStringValue(arg(focus, state), state);
                if (state.strict) {
                    // Section 4.3: equal, or equal up to a `-` suffix, ignoring case.
                    const have = language.toLowerCase();
                    const want = wanted.toLowerCase();
                    return have === want || have.startsWith(`${want}-`);
                }
                return (
                    language.startsWith(wanted) &&
                    (language.length === wanted.length || language.charAt(wanted.length) === '-')
                );
            };
        case 'number':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined) return stringToNumber(stringValueOf(focus.node, state), state.strict);
                if (args.length !== 1) throw expects(name, '(object?)');
                return toNumberValue(arg(focus, state), state);
            };
        case 'sum':
            return (focus, state) => {
                const set = oneNodeSet(name, args, focus, state);
                state.charge(set.size);
                let total = 0;
                for (const node of set.unordered) total += stringToNumber(stringValueOf(node, state), state.strict);
                return total;
            };
        case 'floor':
            return (focus, state) => Math.floor(oneNumber(name, args, focus, state));
        case 'ceiling':
            return (focus, state) => Math.ceil(oneNumber(name, args, focus, state));
        case 'round':
            return (focus, state) => Math.round(oneNumber(name, args, focus, state));
        default:
            return null;
    }
}
