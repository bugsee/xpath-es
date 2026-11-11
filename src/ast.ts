// Immutable AST. Every node is a member of a discriminated union on `kind`; every array is readonly.
// W3C XPath 1.0 (16 Nov 1999) section 3 (expressions) and section 2 (location paths).

export type Axis =
    | 'ancestor'
    | 'ancestor-or-self'
    | 'attribute'
    | 'child'
    | 'descendant'
    | 'descendant-or-self'
    | 'following'
    | 'following-sibling'
    | 'namespace'
    | 'parent'
    | 'preceding'
    | 'preceding-sibling'
    | 'self'
    /** An AxisName token that names no axis. Upstream accepts it and the step selects nothing (quirk Q-AXIS). */
    | 'unknown';

export type NodeTest =
    | { readonly kind: 'any' }
    | { readonly kind: 'prefixAny'; readonly prefix: string }
    | { readonly kind: 'name'; readonly prefix: string | null; readonly localName: string; readonly name: string }
    | { readonly kind: 'text' }
    | { readonly kind: 'comment' }
    | { readonly kind: 'node' }
    | { readonly kind: 'pi' }
    | { readonly kind: 'piTarget'; readonly target: string }
    /** A NodeType token upstream's grammar accepts but does not know; matches nothing. */
    | { readonly kind: 'never' };

export interface Step {
    readonly axis: Axis;
    readonly test: NodeTest;
    readonly predicates: readonly Expr[];
}

export type BinaryOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | 'div' | 'mod';

export interface ChainLink {
    readonly op: BinaryOp;
    readonly operand: Expr;
}

export type Expr =
    | { readonly kind: 'or'; readonly operands: readonly Expr[] }
    | { readonly kind: 'and'; readonly operands: readonly Expr[] }
    /** A left-associative run of binary operators of one precedence level: `a - b + c`. Flat, so a long run is not deep. */
    | { readonly kind: 'chain'; readonly first: Expr; readonly rest: readonly ChainLink[] }
    | { readonly kind: 'negate'; readonly operand: Expr }
    | { readonly kind: 'union'; readonly operands: readonly Expr[] }
    | {
          readonly kind: 'path';
          /** The FilterExpr the path starts from, or null for a plain location path. */
          readonly filter: Expr | null;
          readonly filterPredicates: readonly Expr[];
          readonly absolute: boolean;
          readonly steps: readonly Step[];
      }
    | { readonly kind: 'literal'; readonly value: string }
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'call'; readonly name: string; readonly args: readonly Expr[] }
    | { readonly kind: 'variable'; readonly name: string };

export type StaticType = 'boolean' | 'number' | 'string' | 'node-set' | 'unknown';
