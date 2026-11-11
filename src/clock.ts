// The wall clock for the evaluation time limit. `performance.now()` is monotonic and exists in every browser, in
// Node and in workers, but it is not in the ES2022 language library and Node's typings must not leak into the public
// declarations, so it is looked up on `globalThis` at run time. Where it is absent the limit falls back to `Date.now()`.

export type Clock = () => number;

function resolveClock(): Clock {
    const performanceObject: unknown = Reflect.get(globalThis, 'performance');
    if (typeof performanceObject === 'object' && performanceObject !== null) {
        const now: unknown = Reflect.get(performanceObject, 'now');
        if (typeof now === 'function') {
            return (): number => {
                const reading: unknown = Reflect.apply(now, performanceObject, []);
                return typeof reading === 'number' ? reading : Date.now();
            };
        }
    }
    return (): number => Date.now();
}

/** Milliseconds from an arbitrary origin; only differences are meaningful. */
export const now: Clock = resolveClock();
