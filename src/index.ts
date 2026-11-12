// The package entry: the upstream-compatible API (select, parse, evaluate, the value classes and the `is*` guards)
// and the typed engine API (XPathProgram, the limits and the typed errors).

export * from './compat.ts';
export { XPathProgram, DEFAULT_BUDGET, DEFAULT_TIMEOUT_MS, lookupNamespaceInDom } from './program.ts';
export type { EvaluateOptions, ProgramOptions, XPathMode } from './program.ts';
export { DEFAULT_PARSE_LIMITS } from './parser.ts';
export type { ParseLimits } from './parser.ts';
export {
    XPathError,
    XPathSyntaxError,
    XPathTypeError,
    XPathResolveError,
    XPathOrderError,
    XPathLimitError,
    XPathBudgetError,
    XPathTimeoutError,
    XPathContextError
} from './errors.ts';
export type { XPathErrorCode } from './errors.ts';
