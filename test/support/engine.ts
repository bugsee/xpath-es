// The engine the unit tests exercise. `npm run build:tests` compiles the tests to plain JavaScript and points this one
// module at the built package (dist/) instead of src/, so the same tests judge the shipped output.

export * from '../../src/index.ts';
export { stringToNumber } from '../../src/runtime.ts';
