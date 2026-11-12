// One measurement of one engine on one hostile case, in its own process, JSON on stdout. Used by the gate
// (test/hostile.ts) and by the table (bench/hostile.ts), which kill this process when it takes too long.
//
//   node bench/hostile-run.ts <engine> <case#>

import { createHash } from 'node:crypto';
import { allNodes, describe, errorText, loadDom, milliseconds } from '../test/harness.ts';
import { CASES } from './hostile-cases.ts';
import { isEngineName, loadEngine } from './engines.ts';
import type { EngineName } from './engines.ts';

export interface Measurement {
    readonly ms: number;
    readonly runs: number;
    readonly size: number;
    /** A short hash of the result, with every node written as its position in the document. */
    readonly digest: string;
    /** Set when the engine threw: the digest then hashes the error text, which no correct engine shares. */
    readonly error: string | null;
    /** The `code` of a typed engine error (LIMIT, BUDGET, TIMEOUT, ...), null for any other failure. */
    readonly errorCode: string | null;
}

export function isMeasurement(value: unknown): value is Measurement {
    return (
        typeof value === 'object' &&
        value !== null &&
        'ms' in value &&
        'digest' in value &&
        'size' in value &&
        'runs' in value
    );
}

export function measureOne(engine: EngineName, at: number): Measurement {
    const item = CASES[at];
    if (item === undefined) throw new Error(`no case ${at}`);
    const doc = loadDom('xmldom08')(item.xml());
    const select =
        engine === 'reference'
            ? (): unknown => {
                  if (item.reference === undefined) throw new Error(`case ${at} has no reference answer`);
                  return item.reference(doc);
              }
            : (
                  (load) => (): unknown =>
                      load(item.expression, doc, item.namespaces)
              )(loadEngine(engine));
    const times: number[] = [];
    let result: unknown;
    let error: string | null = null;
    let errorCode: string | null = null;
    const once = (): void => {
        times.push(
            milliseconds(() => {
                try {
                    result = select();
                } catch (thrown) {
                    error = errorText(thrown);
                    result = `ERR ${error}`;
                    const code: unknown =
                        typeof thrown === 'object' && thrown !== null ? Reflect.get(thrown, 'code') : null;
                    errorCode = typeof code === 'string' ? code : null;
                }
            })
        );
    };
    once();
    // Quick cases are repeated and the median reported; slow ones are measured once.
    if ((times[0] ?? 0) < 2000) for (let i = 0; i < 6; i++) once();
    times.sort((a, b) => a - b);
    const index = new Map<unknown, number>(allNodes(doc).map((node, i) => [node, i]));
    const text = describe(result, index);
    return {
        ms: times[Math.floor(times.length / 2)] ?? 0,
        runs: times.length,
        size: Array.isArray(result) ? result.length : 1,
        digest: createHash('sha256').update(text).digest('hex').slice(0, 12),
        error,
        errorCode
    };
}

if (process.argv[1] === import.meta.filename) {
    const engine = process.argv[2] ?? '';
    if (!isEngineName(engine)) throw new Error(`unknown engine ${engine}`);
    console.log(JSON.stringify(measureOne(engine, Number(process.argv[3]))));
}
