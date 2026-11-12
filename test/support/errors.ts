// The category of an error message, for comparing two engines that both throw. Upstream throws plain `Error`s with its
// own wording, and accidental `TypeError`s and `ReferenceError`s from its own code; this engine throws typed errors. Two
// errors are "the same" when they fall in the same category: a syntax error, an unresolvable name, a type error, a
// document that has no order, a limit. The text may differ.

export type ErrorCategory = 'limit' | 'order' | 'resolve' | 'syntax' | 'type' | 'other';

/** `ERR <message>` as the fuzzers write a thrown error. */
export function categoryOfDescription(description: string): ErrorCategory {
    const text = description.startsWith('ERR ') ? description.slice(4) : description;
    if (/budget|time limit|longer than|nests deeper|would make|more than|too long/.test(text)) return 'limit';
    if (/could not determine node order/.test(text)) return 'order';
    if (/Cannot resolve QName|Unknown function|Undeclared variable|is not defined/.test(text)) return 'resolve';
    if (
        /parse error|Unexpected|Unknown axis|NUL character|expression unspecified|must be a string|Invalid expression/.test(
            text
        )
    )
        return 'syntax';
    if (
        /expects|Cannot convert|needs|must evaluate to a nodeset|is not a function|Cannot read properties|produced a value|returned no value|Context node|nodeset/.test(
            text
        )
    )
        return 'type';
    return 'other';
}
