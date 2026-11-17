// Class 5 of the documented differences (see the README): the namespace axis over duplicate contexts.

/**
 * True when a difference between upstream and the engine is explained by duplicate namespace nodes and nothing else:
 * the expression uses the namespace axis, both engines answer, and the engine's answer equals the answer of upstream
 * with its namespace nodes interned (`interned()` re-evaluates the same expression on that oracle). This holds for
 * node-sets and for scalars derived from them (count(), sum()), and fails for any other kind of difference.
 */
export function isNamespaceDuplicate(
    expression: string,
    expected: string,
    actual: string,
    interned: () => string
): boolean {
    if (!expression.includes('namespace::')) return false;
    if (expected === actual || expected.startsWith('ERR') || actual.startsWith('ERR')) return false;
    return interned() === actual;
}

export type Scenario = 'static' | 'mutated' | 'detached' | 'fragment' | 'twodocs' | 'pairs' | 'pairs-two-trees';

/**
 * The documented classes of difference (CLASSIFY=all). Classes 1, 2 and 4 are cases where the oracle crashes on a node
 * xmldom 0.9's own `compareDocumentPosition` cannot handle (a detached node, upstream's synthetic namespace nodes); the
 * crash must be that exact one, so that any other upstream error (an unknown function, a failing predicate) is never
 * excused. Class 3 is the engine refusing a node-set that spans several trees. Class 5 is the one case in which both
 * engines answer: upstream repeats a namespace node when its context is reached twice, verified against an oracle with
 * interned namespace nodes. Any other difference in which both engines answer is never documented.
 */
export const DOCUMENTED = [
    'namespace-nodes: upstream throws, engine answers',
    'detached-context: upstream throws, engine answers',
    'two-trees: engine throws XPathOrderError, upstream answers or crashes in the DOM',
    'two-trees: upstream throws, engine answers',
    'namespace-axis: upstream repeats a namespace node for a duplicate context',
    "limit: the engine stopped at a limit; with the limits off its answer equals upstream's (or upstream's with the duplicate namespace nodes interned)"
] as const;
export const NAMESPACE_DUPLICATE: string = DOCUMENTED[4];
export const LIMIT_POLICY: string = DOCUMENTED[5];
/** The engine's policy refusals: the work budget, the time limit and the cap on namespace nodes made by one evaluation. */
export const LIMIT_ERROR: RegExp =
    /exceeded its (work budget|time limit)|The namespace axis would make more than \d+ nodes/;

/** xmldom 0.9's `compareDocumentPosition` dereferences the parent of a node that has none. */
export const DOM_COMPARE_CRASH = "ERR Cannot read properties of null (reading 'childNodes')";
export const ORDER_ERROR = 'ERR Unexpected: could not determine node order';

/** The classes a CLASSIFY value allows: `ns-duplicate` only class 5, anything else non-empty all of them. */
export function allowedClasses(classify: string): ReadonlySet<string> {
    return classify === 'ns-duplicate'
        ? new Set<string>([NAMESPACE_DUPLICATE, LIMIT_POLICY])
        : new Set<string>(DOCUMENTED);
}

/**
 * Class 6: the engine stopped at one of its limits (a policy, not a result) and the same evaluation with the limits
 * off (`unlimited()`) gives upstream's answer exactly (an answer, or the same error: the engine can run out of budget
 * before it reaches the step where upstream fails), or, for an expression with the
 * namespace axis, the answer of upstream with its namespace nodes interned (the class 5 difference, which a refused
 * evaluation can hide). An answer that does not survive the limits being lifted is not this class, and neither is an
 * evaluation that still fails with them lifted.
 *
 * `unlimited()` must run an engine that is not itself refused by the limit: the cap on namespace nodes cannot be
 * lifted by an option, so the harness evaluates with the engine's fast paths on (`withFastPaths`; the nightly gates them
 * separately).
 */
export function isLimitPolicy(
    expression: string,
    expected: string,
    actual: string,
    unlimited: () => string,
    interned?: () => string
): boolean {
    if (!actual.startsWith('ERR') || !LIMIT_ERROR.test(actual)) return false;
    const lifted = unlimited();
    if (lifted === expected) return true;
    return interned !== undefined && isNamespaceDuplicate(expression, expected, lifted, interned);
}

/** The documented class of a difference, or null when it falls in none (or in one that `allowed` does not list). */
export function classifyDifference(
    scenario: Scenario,
    expression: string,
    expected: string,
    actual: string,
    interned: (() => string) | undefined,
    allowed: ReadonlySet<string>,
    unlimited?: () => string
): string | null {
    if (
        unlimited !== undefined &&
        allowed.has(LIMIT_POLICY) &&
        isLimitPolicy(expression, expected, actual, unlimited, interned)
    )
        return LIMIT_POLICY;
    const found = documentedClass(scenario, expression, expected, actual, interned);
    return found !== null && allowed.has(found) ? found : null;
}

function documentedClass(
    scenario: Scenario,
    expression: string,
    expected: string,
    actual: string,
    interned: (() => string) | undefined
): string | null {
    const upstreamThrows = expected.startsWith('ERR');
    const engineThrows = actual.startsWith('ERR');
    const twoTreesAtFirst = scenario === 'twodocs' || scenario === 'pairs-two-trees';
    // Both fail, differently: xmldom 0.9's own comparison crashes where the engine reports that the nodes have no order.
    if (twoTreesAtFirst && upstreamThrows && engineThrows && expected === DOM_COMPARE_CRASH && actual === ORDER_ERROR)
        return DOCUMENTED[2];
    if (upstreamThrows === engineThrows) {
        return interned !== undefined && isNamespaceDuplicate(expression, expected, actual, interned)
            ? NAMESPACE_DUPLICATE
            : null;
    }
    const twoTrees = scenario === 'twodocs' || scenario === 'pairs-two-trees';
    if (twoTrees) {
        if (engineThrows) return actual === ORDER_ERROR ? DOCUMENTED[2] : null;
        return expected === DOM_COMPARE_CRASH ? DOCUMENTED[3] : null;
    }
    if (!upstreamThrows || expected !== DOM_COMPARE_CRASH) return null;
    if (scenario === 'detached') return DOCUMENTED[1];
    return expression.includes('namespace::') || actual.includes('ns:') ? DOCUMENTED[0] : null;
}
