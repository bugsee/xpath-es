// AST -> closures. Each node becomes one function `(focus, state) => value`; evaluation is then a tree of direct
// calls with no dispatch on node kind. The alternative (walking the AST with a switch) is in interpret.ts for the
// measurement in bench/micro.ts.

import type { BinaryOp, Expr, StaticType, Step } from './ast.ts';
import { compareValues } from './compare.ts';
import { DOCUMENT_NODE } from './dom.ts';
import type { DomNode } from './dom.ts';
import { XPathContextError, XPathResolveError, XPathTypeError } from './errors.ts';
import { compileCoreFunction, CORE_RETURN_TYPES } from './functions.ts';
import { NodeSet, toBooleanValue, toNumberValue } from './runtime.ts';
import type { Compiled, Focus, XValue } from './runtime.ts';
import { applyDescendantPair, applyStep, compileNodeTest, filterByPredicates } from './steps.ts';
import type { CompiledPredicate, CompiledStep, NodeList } from './steps.ts';

/** Stands in for "no context node" (upstream accepts a null node and fails only when a path needs it). */
export const NO_NODE: DomNode = Object.freeze({ nodeType: 0, nodeName: '' });

// ---- static analysis ----

function isCoreCall(name: string): boolean {
    return !name.includes(':') && CORE_RETURN_TYPES.has(name);
}

export function staticType(expr: Expr): StaticType {
    switch (expr.kind) {
        case 'or':
        case 'and':
            return 'boolean';
        case 'chain': {
            const op = expr.rest.at(-1)?.op;
            return op === '+' || op === '-' || op === '*' || op === 'div' || op === 'mod' ? 'number' : 'boolean';
        }
        case 'negate':
        case 'number':
            return 'number';
        case 'union':
        case 'path':
            return 'node-set';
        case 'literal':
            return 'string';
        case 'call':
            return isCoreCall(expr.name) ? (CORE_RETURN_TYPES.get(expr.name) ?? 'unknown') : 'unknown';
        case 'variable':
            return 'unknown';
    }
}

/** Does the expression read the context position or size of the focus it is evaluated in? (Not of an inner one.) */
export function readsPosition(expr: Expr): boolean {
    switch (expr.kind) {
        case 'or':
        case 'and':
        case 'union':
            return expr.operands.some(readsPosition);
        case 'chain':
            return readsPosition(expr.first) || expr.rest.some((link) => readsPosition(link.operand));
        case 'negate':
            return readsPosition(expr.operand);
        case 'path':
            return expr.filter !== null && readsPosition(expr.filter);
        case 'call':
            // A function this engine does not know may read anything.
            return (
                expr.name === 'position' ||
                expr.name === 'last' ||
                !isCoreCall(expr.name) ||
                expr.args.some(readsPosition)
            );
        case 'literal':
        case 'number':
        case 'variable':
            return false;
    }
}

// ---- expressions ----

function typeName(value: XValue): string {
    return value instanceof NodeSet ? 'nodeset' : typeof value;
}

export function arithmetic(op: BinaryOp, a: number, b: number): number {
    switch (op) {
        case '+':
            return a + b;
        case '-':
            return a - b;
        case '*':
            return a * b;
        case 'div':
            return a / b;
        default:
            return a % b;
    }
}

export function isArithmetic(op: BinaryOp): boolean {
    return op === '+' || op === '-' || op === '*' || op === 'div' || op === 'mod';
}

export function compilePredicate(expr: Expr): CompiledPredicate {
    const type = staticType(expr);
    return {
        run: compile(expr),
        positional: type === 'number' || type === 'unknown' || readsPosition(expr),
        index: expr.kind === 'number' ? expr.value : null,
        isLast: expr.kind === 'call' && expr.name === 'last' && expr.args.length === 0
    };
}

function compileStep(step: Step): CompiledStep {
    const predicates = step.predicates.map(compilePredicate);
    return {
        axis: step.axis,
        match: compileNodeTest(step.test),
        predicates,
        positional: predicates.some((p) => p.positional)
    };
}

export function isDescendantOrSelfNode(step: Step): boolean {
    return step.axis === 'descendant-or-self' && step.test.kind === 'node' && step.predicates.length === 0;
}

export function documentRoot(node: DomNode): DomNode {
    if (node.nodeType === DOCUMENT_NODE) return node;
    // Q-ROOT: `/` is the owner document even for a node that is detached from it.
    const owner = node.ownerDocument;
    if (owner != null) return owner;
    let root = node;
    for (let up = root.parentNode; up != null; up = up.parentNode) root = up;
    return root;
}

function compilePath(expr: Extract<Expr, { kind: 'path' }>): Compiled {
    const filter = expr.filter === null ? null : compile(expr.filter);
    const filterPredicates = expr.filterPredicates.map(compilePredicate);
    const steps = expr.steps.map(compileStep);
    // pairs[i]: step i is `descendant-or-self::node()` and step i+1 can be fused with it.
    const pairs = expr.steps.map((step, i) => {
        const next = steps[i + 1];
        return (
            isDescendantOrSelfNode(step) &&
            next !== undefined &&
            !next.positional &&
            (next.axis === 'child' || next.axis === 'attribute')
        );
    });
    const { absolute } = expr;
    return (focus, state) => {
        const list: NodeList = { nodes: [], ordered: true, flat: true };
        if (filter === null) {
            if (focus.node === NO_NODE) {
                throw new XPathContextError(
                    absolute
                        ? 'Context node not found when determining document root.'
                        : 'Context node not found when evaluating XPath step'
                );
            }
            list.nodes = [absolute ? documentRoot(focus.node) : focus.node];
        } else {
            const value = filter(focus, state);
            if (!(value instanceof NodeSet)) {
                throw new XPathTypeError(
                    'Path expression filter must evaluate to a nodeset if predicates or location path are used'
                );
            }
            if (filterPredicates.length === 0) {
                list.nodes = value.unordered;
                list.ordered = value.ordered;
            } else {
                // XPath 1.0 section 3.3: a filter's predicates see the set in document order.
                const inner: Focus = { node: focus.node, position: 1, size: 1 };
                list.nodes = filterByPredicates(value.sorted(state), filterPredicates, 0, inner, state);
            }
            list.flat = list.nodes.length < 2;
        }
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step === undefined) break;
            if (pairs[i] === true) {
                const next = steps[i + 1];
                if (next !== undefined && applyDescendantPair(next, list, state)) {
                    i++;
                    continue;
                }
            }
            applyStep(step, list, state);
        }
        // "In document order" is a fact about the DOM. When caller code can run (and change the DOM) it is not carried
        // out of the path: whoever needs the order sorts then, as upstream does.
        return new NodeSet(list.nodes, state.pure && list.ordered);
    };
}

export function compileUnion(operands: readonly Compiled[]): Compiled {
    return (focus, state) => {
        let nodes: readonly DomNode[] = [];
        let ordered = true;
        let first = true;
        for (const operand of operands) {
            const value = operand(focus, state);
            if (!(value instanceof NodeSet)) throw new XPathTypeError(`Cannot convert ${typeName(value)} to nodeset`);
            if (first) {
                nodes = value.unordered;
                ordered = state.pure && value.ordered;
                first = false;
                continue;
            }
            const merged =
                state.pure && ordered && value.ordered && state.settings.mergeUnions
                    ? state.merge(nodes, value.unordered)
                    : null;
            if (merged !== null) {
                nodes = merged;
                continue;
            }
            // Concatenate, drop duplicates by identity in O(n + m), and leave the sort for whoever needs the order.
            const seen = new Set<DomNode>(nodes);
            const out = nodes.slice();
            for (const node of value.unordered) {
                if (seen.has(node)) continue;
                seen.add(node);
                out.push(node);
            }
            state.charge(out.length);
            nodes = out;
            ordered = false;
        }
        return new NodeSet(nodes, ordered);
    };
}

function splitQName(name: string): readonly [string | null, string] {
    const colon = name.indexOf(':');
    return colon === -1 ? [null, name] : [name.slice(0, colon), name.slice(colon + 1)];
}

export function compileCall(name: string, args: readonly Compiled[]): Compiled {
    const [prefix, localName] = splitQName(name);
    const core = prefix === null ? compileCoreFunction(localName, args) : null;
    return (focus, state) => {
        const lookup = state.settings.functions;
        if (lookup !== null || prefix !== null) {
            const namespace = prefix === null ? '' : state.resolvePrefix(prefix, focus.node);
            const custom = lookup === null ? null : lookup(localName, namespace);
            if (custom != null) {
                const values = args.map((arg) => arg(focus, state));
                return custom(focus, state, values);
            }
            if (prefix !== null) throw new XPathResolveError(`Unknown function ${name}`);
        }
        if (core === null) throw new XPathResolveError(`Unknown function ${name}`);
        return core(focus, state);
    };
}

/**
 * `count(preceding-sibling::T)` and `count(following-sibling::T)` without walking the siblings for every context
 * node: the first request for a child of some parent ranks all of that parent's children in one pass; the ranks
 * live in the evaluation state and only when no caller code can run (`state.pure`).
 */
function compileSiblingCount(step: CompiledStep, fallback: Compiled, site: object): Compiled {
    const preceding = step.axis === 'preceding-sibling';
    return (focus, state) => {
        const node = focus.node;
        const parent = node.parentNode;
        if (!state.pure || parent == null) return fallback(focus, state);
        let ranks = state.siteCaches.get(site);
        if (ranks === undefined) {
            ranks = new Map<DomNode, number>();
            state.siteCaches.set(site, ranks);
        }
        const known = ranks.get(node);
        if (known !== undefined) return known;
        let total = 0;
        let visits = 0;
        for (let child = parent.firstChild; child != null; child = child.nextSibling) {
            visits++;
            if (step.match(child, state)) total++;
        }
        let before = 0;
        for (let child = parent.firstChild; child != null; child = child.nextSibling) {
            const matches = step.match(child, state);
            ranks.set(child, preceding ? before : total - before - (matches ? 1 : 0));
            if (matches) before++;
        }
        state.charge(visits * 2);
        return ranks.get(node) ?? fallback(focus, state);
    };
}

function siblingCountStep(expr: Expr): Step | null {
    if (expr.kind !== 'call' || expr.name !== 'count' || expr.args.length !== 1) return null;
    const arg = expr.args[0];
    if (arg === undefined || arg.kind !== 'path' || arg.filter !== null || arg.absolute || arg.steps.length !== 1)
        return null;
    const step = arg.steps[0];
    if (step === undefined || step.predicates.length !== 0) return null;
    return step.axis === 'preceding-sibling' || step.axis === 'following-sibling' ? step : null;
}

export function compile(expr: Expr): Compiled {
    switch (expr.kind) {
        case 'literal': {
            const { value } = expr;
            return () => value;
        }
        case 'number': {
            const { value } = expr;
            return () => value;
        }
        case 'or': {
            const operands = expr.operands.map(compile);
            return (focus, state) => {
                for (const operand of operands) if (toBooleanValue(operand(focus, state))) return true;
                return false;
            };
        }
        case 'and': {
            const operands = expr.operands.map(compile);
            return (focus, state) => {
                for (const operand of operands) if (!toBooleanValue(operand(focus, state))) return false;
                return true;
            };
        }
        case 'chain': {
            const first = compile(expr.first);
            const rest = expr.rest.map((link) => ({ op: link.op, operand: compile(link.operand) }));
            const only = rest[0];
            if (rest.length === 1 && only !== undefined) {
                const { op, operand } = only;
                if (isArithmetic(op)) {
                    return (focus, state) =>
                        arithmetic(
                            op,
                            toNumberValue(first(focus, state), state),
                            toNumberValue(operand(focus, state), state)
                        );
                }
                return (focus, state) => compareValues(op, first(focus, state), operand(focus, state), state);
            }
            return (focus, state) => {
                let left = first(focus, state);
                for (const { op, operand } of rest) {
                    if (isArithmetic(op)) {
                        // Left operand to a number before the right operand is evaluated, as upstream orders it.
                        const a = toNumberValue(left, state);
                        left = arithmetic(op, a, toNumberValue(operand(focus, state), state));
                    } else {
                        left = compareValues(op, left, operand(focus, state), state);
                    }
                }
                return left;
            };
        }
        case 'negate': {
            const operand = compile(expr.operand);
            return (focus, state) => -toNumberValue(operand(focus, state), state);
        }
        case 'union':
            return compileUnion(expr.operands.map(compile));
        case 'path':
            return compilePath(expr);
        case 'call': {
            const generic = compileCall(expr.name, expr.args.map(compile));
            const sibling = siblingCountStep(expr);
            if (sibling === null) return generic;
            const fast = compileSiblingCount(compileStep(sibling), generic, expr);
            // Only when nothing can have replaced `count`.
            return (focus, state) => (state.settings.functions === null ? fast(focus, state) : generic(focus, state));
        }
        case 'variable': {
            const [prefix, localName] = splitQName(expr.name);
            const { name } = expr;
            return (focus, state) => {
                const namespace = prefix === null ? '' : state.resolvePrefix(prefix, focus.node);
                const value = state.settings.variables?.(localName, namespace);
                if (value == null) throw new XPathResolveError(`Undeclared variable: $${name}`);
                return value;
            };
        }
    }
}

export interface ExpressionFacts {
    /** Some name test, function name or variable name has a prefix (so a namespace resolver can be called). */
    readonly usesPrefixes: boolean;
    readonly usesVariables: boolean;
    readonly usesFunctions: boolean;
}

/** What caller-supplied code an expression can reach; decides whether an evaluation is `pure`. */
export function expressionFacts(root: Expr): ExpressionFacts {
    let usesPrefixes = false;
    let usesVariables = false;
    let usesFunctions = false;
    // Explicit work list: the AST can be wide, and this must not recurse.
    const pending: Expr[] = [root];
    for (let expr = pending.pop(); expr !== undefined; expr = pending.pop()) {
        switch (expr.kind) {
            case 'or':
            case 'and':
            case 'union':
                for (const operand of expr.operands) pending.push(operand);
                break;
            case 'chain':
                pending.push(expr.first);
                for (const link of expr.rest) pending.push(link.operand);
                break;
            case 'negate':
                pending.push(expr.operand);
                break;
            case 'path':
                if (expr.filter !== null) pending.push(expr.filter);
                for (const predicate of expr.filterPredicates) pending.push(predicate);
                for (const step of expr.steps) {
                    if (step.test.kind === 'prefixAny' || (step.test.kind === 'name' && step.test.prefix !== null))
                        usesPrefixes = true;
                    for (const predicate of step.predicates) pending.push(predicate);
                }
                break;
            case 'call':
                usesFunctions = true;
                if (expr.name.includes(':')) usesPrefixes = true;
                for (const arg of expr.args) pending.push(arg);
                break;
            case 'variable':
                usesVariables = true;
                if (expr.name.includes(':')) usesPrefixes = true;
                break;
            case 'literal':
            case 'number':
                break;
        }
    }
    return { usesPrefixes, usesVariables, usesFunctions };
}
