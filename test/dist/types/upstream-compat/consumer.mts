// Code as a consumer writes it against upstream xpath's declarations, which type results as lib.dom's `Node`, `Element`, ...
// It must compile, unchanged, against both declaration files (test/dist/types/upstream-compat/tsconfig.*.json): upstream's
// (xpath/xpath.d.ts) and this package's built one. The DOM library is on, no Node typings, nothing skipped.
import * as xpath from 'xpath';

declare const doc: Document;

const one = xpath.select1("//*[local-name(.)='X509Certificate']", doc);
if (xpath.isNodeLike(one)) {
    const node: Node = one;
    console.log(node.textContent);
}
const many = xpath.select('//*', doc);
if (xpath.isArrayOfNodes(many)) {
    const first: Node | undefined = many[0];
    many.forEach((member: Node) => member.parentNode);
    console.log(first?.nodeName);
}
// The narrowing is to lib.dom's Element: getAttribute answers string | null, not possibly undefined.
if (xpath.isElement(one)) {
    const id: string | null = one.getAttribute('Id');
    console.log(id);
}
if (xpath.isAttribute(one)) console.log(one.value);
if (xpath.isTextNode(one)) console.log(one.data);
if (xpath.isDocumentNode(one)) console.log(one.documentElement.nodeName);
const resolved = xpath.selectWithResolver('//a', doc, { lookupNamespaceURI: () => null });
if (xpath.isArrayOfNodes(resolved)) resolved.map((node: Node) => node.nodeType);
const select = xpath.useNamespaces({ ds: 'urn:x' });
const result: xpath.SelectReturnType = select('//ds:a', doc);
function takesNode(node: Node): void {
    void node;
}
if (!Array.isArray(result) && xpath.isNodeLike(result)) takesNode(result);
const value: xpath.SelectedValue = xpath.select1('//a', doc);
console.log(value);
const evaluator = xpath.parse('//a');
const selected: Node[] = evaluator.select({ node: doc });
const first1: Node | undefined = evaluator.select1({ node: doc });
console.log(selected.length, first1);
