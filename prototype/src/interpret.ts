// The alternative to compile.ts, kept only to be measured against it (bench/micro.ts): evaluate by walking the AST
// with a switch on the node kind. Paths and function calls still need their steps and argument thunks prepared, so
// those are built on first use and remembered per AST node; everything else is dispatched on every evaluation.

import type { Expr } from './ast.ts';
import { compareValues } from './compare.ts';
import { arithmetic, compileCall, compilePredicate, compileUnion, documentRoot, isArithmetic, isDescendantOrSelfNode } from './compile.ts';
import { XPathResolveError, XPathTypeError } from './errors.ts';
import { NodeSet, toBooleanValue, toNumberValue } from './runtime.ts';
import type { Compiled, EvalState, Focus, XValue } from './runtime.ts';
import { applyDescendantPair, applyStep, compileNodeTest, filterByPredicates } from './steps.ts';
import type { CompiledPredicate, CompiledStep, NodeList } from './steps.ts';

type PathExpr = Extract<Expr, { kind: 'path' }>;

interface PreparedPath {
    readonly filterPredicates: readonly CompiledPredicate[];
    readonly steps: readonly CompiledStep[];
    readonly pairs: readonly boolean[];
}

const paths = new WeakMap<PathExpr, PreparedPath>();
const calls = new WeakMap<Expr, Compiled>();
const unions = new WeakMap<Expr, Compiled>();

/** A predicate whose body is interpreted: same shape as a compiled one, so the step code is shared. */
function interpretedPredicate(expr: Expr): CompiledPredicate {
    const compiled = compilePredicate(expr);
    return { ...compiled, run: (focus, state) => interpret(expr, focus, state) };
}

function prepare(expr: PathExpr): PreparedPath {
    let prepared = paths.get(expr);
    if (prepared === undefined) {
        const steps = expr.steps.map((step): CompiledStep => {
            const predicates = step.predicates.map(interpretedPredicate);
            return { axis: step.axis, match: compileNodeTest(step.test), predicates, positional: predicates.some((p) => p.positional) };
        });
        prepared = {
            filterPredicates: expr.filterPredicates.map(interpretedPredicate),
            steps,
            pairs: expr.steps.map((step, i) => {
                const next = steps[i + 1];
                return isDescendantOrSelfNode(step) && next !== undefined && !next.positional && (next.axis === 'child' || next.axis === 'attribute');
            })
        };
        paths.set(expr, prepared);
    }
    return prepared;
}

export function interpret(expr: Expr, focus: Focus, state: EvalState): XValue {
    switch (expr.kind) {
        case 'literal':
        case 'number':
            return expr.value;
        case 'or':
            for (const operand of expr.operands) if (toBooleanValue(interpret(operand, focus, state))) return true;
            return false;
        case 'and':
            for (const operand of expr.operands) if (!toBooleanValue(interpret(operand, focus, state))) return false;
            return true;
        case 'chain': {
            let left = interpret(expr.first, focus, state);
            for (const { op, operand } of expr.rest) {
                if (isArithmetic(op)) {
                    const a = toNumberValue(left, state);
                    left = arithmetic(op, a, toNumberValue(interpret(operand, focus, state), state));
                } else {
                    left = compareValues(op, left, interpret(operand, focus, state), state);
                }
            }
            return left;
        }
        case 'negate':
            return -toNumberValue(interpret(expr.operand, focus, state), state);
        case 'union': {
            let union = unions.get(expr);
            if (union === undefined) {
                union = compileUnion(expr.operands.map((operand): Compiled => (f, s) => interpret(operand, f, s)));
                unions.set(expr, union);
            }
            return union(focus, state);
        }
        case 'call': {
            let run = calls.get(expr);
            if (run === undefined) {
                run = compileCall(expr.name, expr.args.map((arg): Compiled => (f, s) => interpret(arg, f, s)));
                calls.set(expr, run);
            }
            return run(focus, state);
        }
        case 'variable': {
            const value = state.settings.variables?.(expr.name, '');
            if (value == null) throw new XPathResolveError(`Undeclared variable: $${expr.name}`);
            return value;
        }
        case 'path': {
            const prepared = prepare(expr);
            const list: NodeList = { nodes: [], ordered: true, flat: true };
            if (expr.filter === null) {
                list.nodes = [expr.absolute ? documentRoot(focus.node) : focus.node];
            } else {
                const value = interpret(expr.filter, focus, state);
                if (!(value instanceof NodeSet)) throw new XPathTypeError('Path expression filter must evaluate to a nodeset if predicates or location path are used');
                if (prepared.filterPredicates.length === 0) {
                    list.nodes = value.unordered;
                    list.ordered = value.ordered;
                } else {
                    list.nodes = filterByPredicates(value.sorted(state), prepared.filterPredicates, 0, { node: focus.node, position: 1, size: 1 }, state);
                }
                list.flat = list.nodes.length < 2;
            }
            const { steps, pairs } = prepared;
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
        }
    }
}
