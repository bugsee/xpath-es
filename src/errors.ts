// Typed error hierarchy. Messages of the compat-visible errors repeat upstream's wording, because callers
// (and the differential fuzzer) compare `error.message`.

export type XPathErrorCode = 'SYNTAX' | 'TYPE' | 'RESOLVE' | 'ORDER' | 'LIMIT' | 'BUDGET' | 'TIMEOUT' | 'CONTEXT';

/**
 * The package is built twice, as ES modules and as CommonJS, so a program that loads both has two copies of these
 * classes and `instanceof` is false across them. Every error carries a brand under a registered symbol, which both copies
 * share, and `isXPathError` tests for it; `code` is the same string in both.
 */
const BRAND: symbol = Symbol.for('xpath-es.XPathError');

/** Is the value an error of this package, from either build (ES module or CommonJS)? */
export function isXPathError(value: unknown): value is XPathError {
    return value instanceof Error && Reflect.get(value, BRAND) === true;
}

export class XPathError extends Error {
    readonly code: XPathErrorCode;

    constructor(code: XPathErrorCode, message: string) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        Reflect.defineProperty(this, BRAND, { value: true });
    }
}

/** The expression does not parse. */
export class XPathSyntaxError extends XPathError {
    constructor(message: string = 'XPath parse error') {
        super('SYNTAX', message);
    }
}

/** A value has the wrong XPath type for the operation (wrong arity, node-set expected, ...). */
export class XPathTypeError extends XPathError {
    constructor(message: string) {
        super('TYPE', message);
    }
}

/** A prefix, function or variable cannot be resolved. */
export class XPathResolveError extends XPathError {
    constructor(message: string) {
        super('RESOLVE', message);
    }
}

/** Document order is undefined for the node-set (nodes of several trees). */
export class XPathOrderError extends XPathError {
    constructor() {
        super('ORDER', 'Unexpected: could not determine node order');
    }
}

/** A fixed limit was exceeded: the expression's length or nesting depth, or the size of something an evaluation would build. */
export class XPathLimitError extends XPathError {
    constructor(message: string) {
        super('LIMIT', message);
    }
}

/** The per-evaluation work budget ran out. */
export class XPathBudgetError extends XPathError {
    constructor(limit: number) {
        super('BUDGET', `XPath evaluation exceeded its work budget of ${limit} node visits`);
    }
}

/** The per-evaluation wall-clock limit ran out. */
export class XPathTimeoutError extends XPathError {
    constructor(limitMs: number) {
        super('TIMEOUT', `XPath evaluation exceeded its time limit of ${limitMs} ms`);
    }
}

/** The context node, position or size is not usable. */
export class XPathContextError extends XPathError {
    constructor(message: string) {
        super('CONTEXT', message);
    }
}
