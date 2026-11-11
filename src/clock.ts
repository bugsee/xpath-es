// The clock for the evaluation time limit: milliseconds since the Unix epoch, like `Date.now()`, but taken from the
// high-resolution monotonic timer where there is one.
//
// `performance.now()` alone is an offset from `performance.timeOrigin` (a value such as 86423.4), not an epoch
// timestamp, so the origin is added: `performance.timeOrigin + performance.now()` (a value such as 1794411376976.4).
// Where there is no performance object with a numeric `timeOrigin`, `Date.now()` is used instead. Both choices give
// epoch milliseconds, so every reading means the same thing whichever clock answers; the choice is made once, when the
// module loads, and never changes per reading.
//
// `performance` is not in the ES2022 language library and Node's typings must not leak into the public declarations,
// so the object is looked up on `globalThis` once, here, and narrowed by a type guard.

export type Clock = () => number;

interface Timer {
    now(): number;
    readonly timeOrigin: number;
}

function isTimer(value: unknown): value is Timer {
    return (
        typeof value === 'object' &&
        value !== null &&
        'now' in value &&
        typeof value.now === 'function' &&
        'timeOrigin' in value &&
        typeof value.timeOrigin === 'number'
    );
}

function chooseClock(): Clock {
    const performanceObject: unknown = Reflect.get(globalThis, 'performance');
    if (!isTimer(performanceObject)) return (): number => Date.now();
    const origin = performanceObject.timeOrigin;
    return (): number => origin + performanceObject.now();
}

/** Milliseconds since the Unix epoch (high resolution where `performance` is available). */
export const now: Clock = chooseClock();
