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
