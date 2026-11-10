// Type-level tests for the public API. Nothing here runs: the file passes when `tsc --noEmit -p tsconfig.types.json`
// reports no error, and each `@ts-expect-error` line is a call that must NOT type-check. This is the only place in
// the repository where `@ts-expect-error` is allowed. It is compiled with lib.dom, to prove that the DOM types
// callers actually hold are accepted by an engine that never imports lib.dom.

import { evaluate, isArrayOfNodes, isElement, parse, select, select1, selectWithResolver, useNamespaces, XNodeSet, XPathResult } from '../src/compat.ts';
import type { SelectReturnType, SelectSingleReturnType, XPathSelect, XPathValueObject } from '../src/compat.ts';
import type { Expr, Step } from '../src/ast.ts';
import type { DomNode } from '../src/dom.ts';
import { XPathError, XPathSyntaxError } from '../src/errors.ts';
import type { XPathErrorCode } from '../src/errors.ts';
import { XPathProgram } from '../src/program.ts';
import type { XValue } from '../src/runtime.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function expectTrue<T extends true>(): T;

declare const doc: Document;
declare const element: Element;
declare const attribute: Attr;
declare const text: Text;
declare const fragment: DocumentFragment;

// lib.dom nodes are DomNodes, with no cast.
const nodes: readonly DomNode[] = [doc, element, attribute, text, fragment];
void nodes;

// select family: return types and overloads.
expectTrue<Equal<ReturnType<typeof select1>, SelectSingleReturnType>>();
const all = select('//a', doc);
expectTrue<Equal<typeof all, SelectReturnType>>();
const one = select('//a', element, true);
expectTrue<Equal<typeof one, SelectSingleReturnType>>();
const viaResolver = selectWithResolver('//p:a', doc, { lookupNamespaceURI: (prefix) => (prefix === 'p' ? 'urn:p' : null) }, true);
expectTrue<Equal<typeof viaResolver, SelectSingleReturnType>>();
const withNamespaces = useNamespaces({ p: 'urn:p' });
expectTrue<Equal<typeof withNamespaces, XPathSelect>>();

// Narrowing a result.
if (isArrayOfNodes(all)) expectTrue<Equal<typeof all, DomNode[]>>();
if (isElement(one)) expectTrue<Equal<typeof one, DomNode>>();

// parse(): the evaluator.
const evaluator = parse('count(//a)');
expectTrue<Equal<ReturnType<typeof evaluator.evaluateNumber>, number>>();
expectTrue<Equal<ReturnType<typeof evaluator.select>, DomNode[]>>();
expectTrue<Equal<ReturnType<typeof evaluator.evaluate>, XPathValueObject>>();
expectTrue<Equal<ReturnType<typeof evaluator.evaluateNodeSet>, XNodeSet>>();

// DOM Level 3: result codes are numbers on the class, as in upstream.
expectTrue<Equal<typeof XPathResult.ANY_TYPE, 0>>();
expectTrue<Equal<typeof XPathResult.FIRST_ORDERED_NODE_TYPE, 9>>();
const result = evaluate('//a', doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
expectTrue<Equal<typeof result.snapshotLength, number | undefined>>();

// Values and errors are closed unions.
expectTrue<Equal<XValue extends string | number | boolean | object ? true : false, true>>();
expectTrue<Equal<XPathErrorCode, 'SYNTAX' | 'TYPE' | 'RESOLVE' | 'ORDER' | 'LIMIT' | 'BUDGET' | 'CONTEXT'>>();
expectTrue<Equal<XPathSyntaxError extends XPathError ? true : false, true>>();

// The AST is immutable and its union is exhaustive.
const program = new XPathProgram('/a');
function kindOf(expr: Expr): string {
    switch (expr.kind) {
        case 'or': case 'and': case 'chain': case 'negate': case 'union': case 'path': case 'literal': case 'number': case 'call': case 'variable':
            return expr.kind;
    }
}
void kindOf(program.ast);

// ---- must not compile ----

// @ts-expect-error a string is not a context node
select('//a', 'not a node');
// @ts-expect-error the expression is a string
select(1, doc);
// @ts-expect-error a resolver needs lookupNamespaceURI
selectWithResolver('//a', doc, { lookup: () => null });
// @ts-expect-error namespace maps hold strings
useNamespaces({ p: 1 });
// @ts-expect-error the AST cannot be reassigned
program.ast = program.ast;
function mutate(step: Step, expr: Extract<Expr, { kind: 'path' }>): void {
    // @ts-expect-error steps are readonly
    expr.steps.push(step);
    // @ts-expect-error fields are readonly
    step.axis = 'child';
}
void mutate;
// @ts-expect-error an object without nodeType/nodeName is not a DomNode
const bad: DomNode = { foo: 1 };
void bad;
