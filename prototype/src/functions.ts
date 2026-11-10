// Core function library (XPath 1.0 section 4), with upstream's behaviour where it departs from the Recommendation.
// Arity and type errors are raised when the call is evaluated, never when it is compiled (as upstream does), and
// carry upstream's messages.

import type { StaticType } from './ast.ts';
import { ATTRIBUTE_NODE, DOCUMENT_NODE, ELEMENT_NODE, PROCESSING_INSTRUCTION_NODE, XML_NAMESPACE_URI } from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathTypeError } from './errors.ts';
import { NodeSet, stringToNumber, stringValueOf, toBooleanValue, toNumberValue, toStringValue } from './runtime.ts';
import type { Compiled, EvalState, Focus } from './runtime.ts';

export const CORE_RETURN_TYPES: ReadonlyMap<string, StaticType> = new Map<string, StaticType>([
    ['last', 'number'], ['position', 'number'], ['count', 'number'], ['id', 'node-set'], ['local-name', 'string'],
    ['namespace-uri', 'string'], ['name', 'string'], ['string', 'string'], ['concat', 'string'], ['starts-with', 'boolean'],
    ['contains', 'boolean'], ['substring-before', 'string'], ['substring-after', 'string'], ['substring', 'string'],
    ['string-length', 'number'], ['normalize-space', 'string'], ['translate', 'string'], ['boolean', 'boolean'],
    ['not', 'boolean'], ['true', 'boolean'], ['false', 'boolean'], ['lang', 'boolean'], ['number', 'number'],
    ['sum', 'number'], ['floor', 'number'], ['ceiling', 'number'], ['round', 'number']
]);

const expects = (name: string, signature: string): XPathTypeError => new XPathTypeError(`Function ${name} expects ${signature}`);

/** The node a `(node-set?)` function is about: the context node, or the first node of the argument in document order. */
function targetNode(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): DomNode | null {
    const arg = args[0];
    if (arg === undefined) return focus.node;
    const value = args.length === 1 ? arg(focus, state) : null;
    if (!(value instanceof NodeSet)) throw expects(name, '(node-set?)');
    return value.first(state);
}

function stringArgs(name: string, signature: string, count: number, args: readonly Compiled[], focus: Focus, state: EvalState): string[] {
    if (args.length !== count) throw expects(name, signature);
    return args.map((arg) => toStringValue(arg(focus, state), state));
}

function optionalString(name: string, args: readonly Compiled[], focus: Focus, state: EvalState): string {
    const arg = args[0];
    if (arg === undefined) return stringValueOf(focus.node);
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

const SPACE_RUN = /[ \t\r\n]+/g;
const SPACE_EDGES = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const ID_SEPARATOR = /[\r\n\t ]+/;

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
                // Q-FN-ID: for a node-set upstream joins the nodes' own toString() (their serialisation), not their
                // string-values.
                const text = value instanceof NodeSet ? value.sorted(state).map(String).join(' ') : toStringValue(value, state);
                const document = focus.node.nodeType === DOCUMENT_NODE ? focus.node : focus.node.ownerDocument;
                if (document == null || document.getElementById === undefined) throw new XPathTypeError('Function id needs a document with getElementById');
                const found = new Set<DomNode>();
                for (const id of text.split(ID_SEPARATOR)) {
                    const element = document.getElementById(id);
                    if (element != null) found.add(element);
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
                if (arg === undefined) return stringValueOf(focus.node);
                if (args.length !== 1) throw expects(name, '(object?)');
                return toStringValue(arg(focus, state), state);
            };
        case 'concat':
            return (focus, state) => {
                if (args.length < 2) throw expects(name, '(string, string[, string]*)');
                let text = '';
                for (const arg of args) text += toStringValue(arg(focus, state), state);
                return text;
            };
        case 'starts-with':
            return (focus, state) => {
                const [text = '', prefix = ''] = stringArgs('startsWith', '(string, string)', 2, args, focus, state);
                return text.startsWith(prefix);
            };
        case 'contains':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                return text.includes(part);
            };
        case 'substring-before':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                return text.substring(0, text.indexOf(part));
            };
        case 'substring-after':
            return (focus, state) => {
                const [text = '', part = ''] = stringArgs(name, '(string, string)', 2, args, focus, state);
                const at = text.indexOf(part);
                return at === -1 ? '' : text.substring(at + part.length);
            };
        case 'substring':
            return (focus, state) => {
                const [textArg, startArg, lengthArg] = args;
                if (textArg === undefined || startArg === undefined || args.length > 3) throw expects(name, '(string, number, number?)');
                const text = toStringValue(textArg(focus, state), state);
                // Q-FN-SUBSTRING: JavaScript's substring() on rounded bounds (it swaps reversed bounds and reads NaN as 0).
                const start = Math.round(toNumberValue(startArg(focus, state), state)) - 1;
                if (lengthArg === undefined) return text.substring(start);
                return text.substring(start, start + Math.round(toNumberValue(lengthArg(focus, state), state)));
            };
        case 'string-length':
            return (focus, state) => optionalString(name, args, focus, state).length;
        case 'normalize-space':
            return (focus, state) => optionalString(name, args, focus, state).replace(SPACE_EDGES, '').replace(SPACE_RUN, ' ');
        case 'translate':
            return (focus, state) => {
                const [text = '', from = '', to = ''] = stringArgs(name, '(string, string, string)', 3, args, focus, state);
                const map = new Map<string, string>();
                for (let i = 0; i < from.length; i++) {
                    const ch = from.charAt(i);
                    if (!map.has(ch)) map.set(ch, to.charAt(i));
                }
                let out = '';
                for (let i = 0; i < text.length; i++) {
                    const ch = text.charAt(i);
                    out += map.get(ch) ?? ch;
                }
                return out;
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
                // Q-FN-LANG: the first ancestor-or-self whose getAttributeNS() answers anything but null decides, so
                // on a DOM that answers '' for a missing attribute only the context node is ever looked at.
                let language: string | null = null;
                for (let node: DomNode | null | undefined = focus.node; node != null && node.nodeType !== DOCUMENT_NODE; node = node.parentNode) {
                    if (node.getAttributeNS === undefined) throw new XPathTypeError('Function lang needs an element context');
                    const value = node.getAttributeNS(XML_NAMESPACE_URI, 'lang');
                    if (value != null) {
                        language = String(value);
                        break;
                    }
                }
                if (language === null) return false;
                const wanted = toStringValue(arg(focus, state), state);
                return language.startsWith(wanted) && (language.length === wanted.length || language.charAt(wanted.length) === '-');
            };
        case 'number':
            return (focus, state) => {
                const arg = args[0];
                if (arg === undefined) return stringToNumber(stringValueOf(focus.node));
                if (args.length !== 1) throw expects(name, '(object?)');
                return toNumberValue(arg(focus, state), state);
            };
        case 'sum':
            return (focus, state) => {
                const set = oneNodeSet(name, args, focus, state);
                state.charge(set.size);
                let total = 0;
                for (const node of set.unordered) total += stringToNumber(stringValueOf(node));
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
