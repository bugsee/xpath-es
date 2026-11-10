// Mocha preload: makes upstream's own test file (forks/xpath-up/test.js, run unmodified) load the prototype's compat
// entry when it asks for './xpath.js'.
//
//   node <mocha> --require test/upstream-suite-preload.ts <scratchpad>/forks/xpath-up/test.js

import { createRequire } from 'node:module';
import * as candidate from '../src/compat.ts';
import { FORK_PATH } from './harness.ts';

const require = createRequire(import.meta.url);
require(FORK_PATH);
const entry = require.cache[require.resolve(FORK_PATH)];
if (entry === undefined) throw new Error('the legacy module is not in the require cache');
entry.exports = candidate;
