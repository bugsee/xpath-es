// The engine with the pure fast paths switched off, as a CANDIDATE module: the differential suites run on it as well
// as on the engine itself, and both must equal upstream.

import { XPathProgram } from '../../src/index.ts';

XPathProgram.forceSlowPath = true;

export * from '../../src/index.ts';
