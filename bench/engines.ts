// The engines the benchmarks compare, under one signature: `upstream` (the oracle, xpath 0.0.36), `candidate` (the
// module CANDIDATE names, default the bugsee/xpath fork) and `fork` (the bugsee/xpath fork, for when CANDIDATE is
// something else and the fork is still wanted as a reference).

import { loadModule, loadOracle, loadCandidate, loadXPath, DEFAULT_CANDIDATE } from '../test/harness.ts';
import type { DomNode } from '../test/support/dom.ts';

export type EngineName = 'upstream' | 'fork' | 'candidate';
export const ENGINE_NAMES: readonly EngineName[] = ['upstream', 'candidate', 'fork'];
/** What the tables show when ENGINES is not set. */
export const DEFAULT_ENGINES: readonly EngineName[] = ['upstream', 'candidate'];
export type Select = (expression: string, node: DomNode) => unknown;

export function isEngineName(value: string): value is EngineName {
    return ENGINE_NAMES.some((name) => name === value);
}

export function chosenEngines(): readonly EngineName[] {
    const wanted = process.env['ENGINES'];
    return wanted === undefined ? DEFAULT_ENGINES : wanted.split(',').filter(isEngineName);
}

export function loadEngine(name: EngineName): Select {
    const legacy =
        name === 'upstream'
            ? loadOracle()
            : name === 'fork'
              ? loadXPath(loadModule(DEFAULT_CANDIDATE))
              : loadCandidate();
    return (expression, node) => legacy.select(expression, node);
}
