// Builds dist/esm (ES modules) and dist/cjs (CommonJS) from src/ with the same compiler and the same strict
// options as the type-check. Run: node scripts/build.ts

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(root, 'node_modules/typescript-7/bin/tsc');

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
for (const config of ['tsconfig.build.json', 'tsconfig.build.cjs.json']) {
    const run = spawnSync(process.execPath, [tsc, '-p', config], { cwd: root, stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
}
// The package is "type": "module", so the CommonJS output needs its own scope.
mkdirSync(path.join(root, 'dist/cjs'), { recursive: true });
writeFileSync(path.join(root, 'dist/cjs/package.json'), '{"type":"commonjs"}\n');
