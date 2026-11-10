// What `noUncheckedIndexedAccess` costs in a hot loop, measured with one variant per process so that one variant's
// JIT feedback cannot colour another's (bench/micro.ts section 2 showed that it does).
//
//   node bench/index-access.ts            all variants, table
//   node bench/index-access.ts <variant>  one variant, milliseconds on stdout

import { spawnSync } from 'node:child_process';
import { milliseconds } from '../test/harness.ts';

const N = 1_000_000;

function typedForOf(keys: Float64Array): number {
    let total = 0;
    for (const key of keys) total += key;
    return total;
}

function typedNullish(keys: Float64Array): number {
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += keys[i] ?? 0;
    return total;
}

function typedGuard(keys: Float64Array): number {
    let total = 0;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === undefined) break;
        total += key;
    }
    return total;
}

interface Item {
    readonly value: number;
}

function arrayForOf(items: readonly Item[]): number {
    let total = 0;
    for (const item of items) total += item.value;
    return total;
}

function arrayGuard(items: readonly Item[]): number {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === undefined) break;
        total += item.value;
    }
    return total;
}

function arrayOptional(items: readonly Item[]): number {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += items[i]?.value ?? 0;
    return total;
}

const keys = new Float64Array(N);
for (let i = 0; i < N; i++) keys[i] = (i * 7919) % 1000;
const items: Item[] = Array.from({ length: N }, (_, i) => ({ value: i & 7 }));

const VARIANTS: ReadonlyMap<string, () => number> = new Map<string, () => number>([
    ['Float64Array, for-of', () => typedForOf(keys)],
    ['Float64Array, keys[i] ?? 0', () => typedNullish(keys)],
    ['Float64Array, undefined guard', () => typedGuard(keys)],
    ['object[], for-of', () => arrayForOf(items)],
    ['object[], undefined guard', () => arrayGuard(items)],
    ['object[], items[i]?.value ?? 0', () => arrayOptional(items)]
]);

const wanted = process.argv[2];
if (wanted !== undefined) {
    const run = VARIANTS.get(wanted);
    if (run === undefined) throw new Error(`unknown variant ${wanted}`);
    let sink = 0;
    for (let i = 0; i < 30; i++) sink += run();
    const times: number[] = [];
    for (let i = 0; i < 41; i++) times.push(milliseconds(() => void (sink += run())));
    times.sort((a, b) => a - b);
    console.log(`${(times[20] ?? 0).toFixed(3)} ${sink}`);
} else {
    console.log(`| loop over ${N.toLocaleString('en-US')} elements | median of 41 runs | per element |\n|---|---:|---:|`);
    for (const name of VARIANTS.keys()) {
        const child = spawnSync(process.execPath, [process.argv[1] ?? '', name], { encoding: 'utf8' });
        const ms = Number(child.stdout.split(' ')[0]);
        console.log(`| ${name} | ${ms.toFixed(3)} ms | ${((ms * 1e6) / N).toFixed(2)} ns |`);
    }
}
