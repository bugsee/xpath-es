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
    'two-trees: engine throws XPathOrderError, upstream answers',
    'two-trees: upstream throws, engine answers',
    'namespace-axis: upstream repeats a namespace node for a duplicate context'
] as const;
export const NAMESPACE_DUPLICATE: string = DOCUMENTED[4];

/** xmldom 0.9's `compareDocumentPosition` dereferences the parent of a node that has none. */
export const DOM_COMPARE_CRASH = "ERR Cannot read properties of null (reading 'childNodes')";
export const ORDER_ERROR = 'ERR Unexpected: could not determine node order';

/** The classes a CLASSIFY value allows: `ns-duplicate` only class 5, anything else non-empty all of them. */
export function allowedClasses(classify: string): ReadonlySet<string> {
    return classify === 'ns-duplicate' ? new Set<string>([NAMESPACE_DUPLICATE]) : new Set<string>(DOCUMENTED);
}

/** The documented class of a difference, or null when it falls in none (or in one that `allowed` does not list). */
export function classifyDifference(
    scenario: Scenario,
    expression: string,
    expected: string,
    actual: string,
    interned: (() => string) | undefined,
    allowed: ReadonlySet<string>
): string | null {
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
