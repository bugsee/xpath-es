// The DOM boundary of the harness.
//
// The harness never imports lib.dom. It reads a document through the small structural interface below, which xmldom
// 0.6/0.8/0.9, jsdom, happy-dom and linkedom all satisfy. Every member except `nodeType` and `nodeName` is optional,
// because not every DOM has every member on every node kind (an Attr has no `attributes`), and "absent",
// `undefined` and `null` are treated alike.
//
// `isDomNode` is the one place a host object is narrowed: it checks `nodeType` and `nodeName` at run time (the two
// properties upstream xpath's `isNodeLike` checks) and from then on the compiler believes the remaining optional
// members have their declared types. No `as` cast exists anywhere.

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;
/** `nodeType` of the synthetic namespace nodes upstream xpath creates. */
export const NAMESPACE_NODE = 13;

export const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

export interface DomAttrList {
    readonly length: number;
    item(index: number): DomNode | null | undefined;
}

export interface DomNode {
    readonly nodeType: number;
    readonly nodeName: string;
    readonly nodeValue?: string | null | undefined;
    readonly parentNode?: DomNode | null | undefined;
    readonly firstChild?: DomNode | null | undefined;
    readonly lastChild?: DomNode | null | undefined;
    readonly nextSibling?: DomNode | null | undefined;
    readonly previousSibling?: DomNode | null | undefined;
    readonly ownerDocument?: DomNode | null | undefined;
    readonly documentElement?: DomNode | null | undefined;
    /** Attr only. */
    readonly ownerElement?: DomNode | null | undefined;
    /** Element only. */
    readonly attributes?: DomAttrList | null | undefined;
    readonly localName?: string | null | undefined;
    readonly namespaceURI?: string | null | undefined;
    readonly prefix?: string | null | undefined;
    /** Attr only. */
    readonly name?: string | undefined;
    /** Attr only. */
    readonly value?: string | undefined;
    /** ProcessingInstruction only. */
    readonly target?: string | undefined;
    /** Set on upstream xpath's own namespace nodes. */
    readonly isXPathNamespace?: boolean | undefined;
    /** Document only. */
    readonly implementation?: { hasFeature?(feature: string, version: string): boolean } | null | undefined;
    getElementById?(id: string): DomNode | null | undefined;
    getAttribute?(name: string): string | null | undefined;
    getAttributeNS?(namespace: string | null, localName: string): string | null | undefined;
}

/**
 * The boundary guard. Same test as upstream's `isNodeLike`: a truthy object whose `nodeType` is an integer in 1..11
 * (or 13, a namespace node) and whose `nodeName` is a string.
 */
export function isDomNode(value: unknown): value is DomNode {
    if (typeof value !== 'object' || value === null) return false;
    if (!('nodeType' in value) || !('nodeName' in value)) return false;
    const { nodeType, nodeName } = value;
    if (typeof nodeName !== 'string' || typeof nodeType !== 'number') return false;
    return nodeType === NAMESPACE_NODE || (Number.isInteger(nodeType) && nodeType >= 1 && nodeType <= 11);
}

export function isDomNodeArray(value: unknown): value is DomNode[] {
    return Array.isArray(value) && value.every(isDomNode);
}
