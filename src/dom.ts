// The DOM adapter boundary.
//
// xpath-es never imports lib.dom. It reads a DOM through the small structural interface below, which xmldom
// 0.6/0.8/0.9, jsdom, happy-dom, linkedom and browsers all satisfy. Every member except `nodeType` and `nodeName`
// is optional, because not every DOM has every member on every node kind (xmldom 0.8 has no `ownerElement` on a
// Document; an Attr has no `attributes`), and the engine treats "absent", `undefined` and `null` alike.
//
// THE ONLY UNSOUND STEP IN THE CODE BASE is `isDomNode` below: it checks `nodeType` and `nodeName` at run time (the
// two properties upstream's `isNodeLike` checks) and from then on the compiler believes the remaining optional
// members have their declared types. Nothing else narrows a host object, and no `as` cast exists anywhere.

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;
/** `nodeType` of the synthetic namespace nodes (same number upstream uses). */
export const NAMESPACE_NODE = 13;

/**
 * A prefix resolver: the namespace URI a prefix stands for at `node`, or null/undefined when it stands for none.
 * `charge` accounts for the work of a lookup that walks the document (the engine passes it; a caller's own resolver
 * ignores it).
 */
export type NamespaceLookup = (
    prefix: string,
    node: DomNode,
    charge?: (units: number) => void
) => string | null | undefined;

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
    /** Set on the engine's own namespace nodes. */
    readonly isXPathNamespace?: boolean | undefined;
    /** Document only: the MIME type the DOM parsed it as (browsers, jsdom, linkedom, happy-dom). */
    readonly contentType?: string | undefined;
    /** Document only; read once per `select()` to mirror upstream's HTML detection. */
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

/**
 * A namespace node. XPath has them, the DOM does not, so the engine makes them. The property names are upstream's
 * (`isXPathNamespace`, `baseNode`, `ownerElement`, `prefix`, `nodeValue`), since callers read them.
 */
export class NamespaceNode implements DomNode {
    readonly isXPathNamespace = true;
    readonly nodeType: number = NAMESPACE_NODE;
    readonly nodeName: string;
    readonly prefix: string;
    readonly localName: string;
    readonly namespaceURI: null = null;
    readonly nodeValue: string;
    readonly ownerElement: DomNode;
    readonly ownerDocument: DomNode | null | undefined;
    /** The `xmlns` attribute that declares the binding; null for the implicit `xml` binding. */
    readonly baseNode: DomNode | null;
    /** Index of `baseNode` in `ownerElement.attributes`, or -1 when it is declared on an ancestor (or is `xml`). */
    readonly localIndex: number;
    /**
     * Strict mode: the place of this binding among the element's namespace nodes (`xml` first, then the declarations of
     * the element, then those inherited from its parent outwards), which is their document order. -1 for the nodes upstream
     * mode makes, whose order is as upstream's (and undefined between two inherited ones).
     */
    readonly ordinal: number;

    constructor(
        prefix: string,
        baseNode: DomNode | null,
        uri: string,
        owner: DomNode,
        localIndex: number,
        ordinal = -1
    ) {
        this.nodeName = prefix;
        this.prefix = prefix;
        this.localName = prefix;
        this.nodeValue = uri;
        this.ownerElement = owner;
        this.ownerDocument = owner.ownerDocument;
        this.baseNode = baseNode;
        this.localIndex = localIndex;
        this.ordinal = ordinal;
    }

    toString(): string {
        return `{ "${this.prefix}", "${String(this.namespaceURI)}" }`;
    }
}

export function isNamespaceNode(node: DomNode): node is NamespaceNode {
    return node instanceof NamespaceNode;
}

/** Parent in the XPath data model as upstream walks it: `parentNode`, else `ownerElement`. */
export function xpathParent(node: DomNode): DomNode | null {
    return node.parentNode ?? node.ownerElement ?? null;
}

/** Topmost node of the tree that holds `node` (an attribute or namespace node belongs to its element's tree). */
export function treeRoot(node: DomNode): DomNode {
    let current = node;
    for (;;) {
        const parent = xpathParent(current);
        if (parent === null) return current;
        current = parent;
    }
}
