// A deliberately slow candidate, for the harness self-test (test/harness-selftest.ts): this engine's answers
// (correct, and fast on the hostile cases) after a quadratic amount of pointless work in the number of nodes
// of the document. The hostile gate must fail it for being slow, not for being wrong.

import { call, loadModule, member } from '../harness.ts';
import { isDomNode } from '../support/dom.ts';

const engine = loadModule('./src/index.ts');

function countNodes(from: unknown): number {
    if (!isDomNode(from)) return 0;
    let root = from;
    while (root.parentNode != null) root = root.parentNode;
    let count = 0;
    const stack = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        count++;
        for (let child = node.firstChild; child != null; child = child.nextSibling) stack.push(child);
    }
    return count;
}

let sink = 0;
function wastefulCopy(nodes: number): void {
    for (let i = 0; i < nodes; i++) for (let j = 0; j < nodes; j++) sink = (sink + (i ^ j)) | 0;
}

export const select: (expression: string, node: unknown, single?: boolean) => unknown = (expression, node, single) => {
    wastefulCopy(countNodes(node));
    return call(engine, 'select', expression, node, single);
};
export const select1: (expression: string, node: unknown) => unknown = (expression, node) => {
    wastefulCopy(countNodes(node));
    return call(engine, 'select1', expression, node);
};
export const parse: (expression: string) => unknown = (expression) => call(engine, 'parse', expression);
export const evaluate: (...args: unknown[]) => unknown = (...args) => call(engine, 'evaluate', ...args);
export const XNodeSet: unknown = member(engine, 'XNodeSet');
export const wasted: () => number = () => sink;
