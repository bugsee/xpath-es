// The three engines under one signature, for the benchmarks.

import * as candidate from '../src/compat.ts';
import type { DomNode } from '../src/dom.ts';
import { FORK_PATH, loadXPath, UPSTREAM_PATH } from '../test/harness.ts';

export type EngineName = 'upstream' | 'fork' | 'xpath-es';
export const ENGINE_NAMES: readonly EngineName[] = ['upstream', 'fork', 'xpath-es'];
export type Select = (expression: string, node: DomNode) => unknown;

export function isEngineName(value: string): value is EngineName {
    return ENGINE_NAMES.some((name) => name === value);
}

export function loadEngine(name: EngineName): Select {
    if (name === 'xpath-es') return (expression, node) => candidate.select(expression, node);
    const legacy = loadXPath(name === 'upstream' ? UPSTREAM_PATH : FORK_PATH);
    return (expression, node) => legacy.select(expression, node);
}
