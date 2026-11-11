// The wall clock for the evaluation time limit.
//
// ONE clock is chosen when the module loads and used for the whole run: `performance.now()` where there is
// a performance object (every browser, Node, workers), `Date.now()` otherwise. The two are never mixed: they have
// different origins (an offset from `performance.timeOrigin` against the Unix epoch), so a deadline taken from one
// and compared with a reading of the other would fire at once or never. Only differences between readings of this
// one clock are used (`deadline = now() + limit`, `now() > deadline`); an absolute reading is never printed or kept.
//
// `performance.now()` is not in the ES2022 language library and Node's typings must not leak into the public
// declarations, so the object is looked up on `globalThis` once, here, and narrowed by a type guard. A reading is not
// validated: a clock that answers something other than a number is a broken platform, not an input.

export type Clock = () => number;

interface Timer {
    now(): number;
}

function isTimer(value: unknown): value is Timer {
    return typeof value === 'object' && value !== null && 'now' in value && typeof value.now === 'function';
}

function chooseClock(): Clock {
    const performanceObject: unknown = Reflect.get(globalThis, 'performance');
    return isTimer(performanceObject) ? (): number => performanceObject.now() : (): number => Date.now();
}

/** Milliseconds from an arbitrary origin; only differences between two readings are meaningful. */
export const now: Clock = chooseClock();
