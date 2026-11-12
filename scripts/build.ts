// Compiles src/ to plain JavaScript and declarations with the same compiler and the same strict options as the type
// check. Node >= 22.18 runs this script (type stripping); its output runs on Node >= 20 and in browsers.
//
//   node scripts/build.ts            dist/: ES modules (.js, .d.ts) and CommonJS (.cjs, .d.cts), flat, with source maps
//   node scripts/build.ts --tests    dist-tests/: the tests and benchmarks compiled to plain JavaScript, their engine
//                                    import pointed at dist/ (so Node 20, which cannot strip types, can run them)
//
// Both outputs are ES2022: nothing is down-levelled (classes, #private members, optional chaining and so on stay as
// written), and no TypeScript-only syntax survives (test/dist checks this: `npm run test:dist`).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(root, 'node_modules/typescript-7/bin/tsc');
const at = (...parts: string[]): string => path.join(root, ...parts);

function compile(config: string): void {
    const run = spawnSync(process.execPath, [tsc, '-p', config], { cwd: root, stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
}

/**
 * The declaration emit keeps the sources' `./x.ts` specifiers (only the JavaScript emit rewrites them), which a
 * consumer's compiler would not accept; they become `./x.js`, or `./x.cjs` for the CommonJS declarations.
 */
function retargetDeclarations(directory: string, extension: 'js' | 'cjs'): void {
    for (const name of readdirSync(directory)) {
        if (!name.endsWith('.d.ts')) continue;
        const file = path.join(directory, name);
        writeFileSync(file, readFileSync(file, 'utf8').replace(/(["'])(\.\/[^"']+)\.ts\1/g, `$1$2.${extension}$1`));
    }
}

/**
 * Ships only the declarations the entry can reach. The engine's internal modules (the evaluation state, the compiler, the
 * steps) have declarations of their own, and a consumer's editor would offer them; they are not part of the API, so only
 * the files that `index.d.ts` (or `index.d.cts`) imports, directly or through each other, stay. The JavaScript stays: it
 * is what the entry loads.
 */
function pruneDeclarations(directory: string, entry: string, extension: 'js' | 'cjs'): void {
    const suffix = extension === 'js' ? '.d.ts' : '.d.cts';
    const reachable = new Set<string>([entry]);
    const pending = [entry];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        const text = readFileSync(path.join(directory, file), 'utf8');
        for (const match of text.matchAll(/(?:from\s+|import\()["']\.\/([^"']+)\.(?:js|cjs)["']/g)) {
            const next = `${match[1] ?? ''}${suffix}`;
            if (!reachable.has(next) && existsSync(path.join(directory, next))) {
                reachable.add(next);
                pending.push(next);
            }
        }
    }
    for (const name of readdirSync(directory))
        if (name.endsWith(suffix) && !reachable.has(name)) rmSync(path.join(directory, name));
}

/** The CommonJS emit has `.js` / `.d.ts` / `.js.map` names and `./x.js` specifiers; dist/ wants `.cjs` / `.d.cts`. */
function convertCommonJs(from: string, to: string): void {
    const specifier = /(["'])(\.\/[^"']+)\.(?:js|ts)\1/g;
    for (const name of readdirSync(from)) {
        const source = readFileSync(path.join(from, name), 'utf8');
        if (name.endsWith('.d.ts')) {
            writeFileSync(
                path.join(to, `${name.slice(0, -'.d.ts'.length)}.d.cts`),
                source.replace(specifier, '$1$2.cjs$1')
            );
        } else if (name.endsWith('.js.map')) {
            const map: unknown = JSON.parse(source);
            if (typeof map !== 'object' || map === null) throw new Error(`${name} is not a source map`);
            const base = name.slice(0, -'.js.map'.length);
            writeFileSync(path.join(to, `${base}.cjs.map`), `${JSON.stringify({ ...map, file: `${base}.cjs` })}\n`);
        } else if (name.endsWith('.js')) {
            const base = name.slice(0, -'.js'.length);
            const code = source
                .replace(/require\((["'])(\.\/[^"']+)\.js\1\)/g, 'require($1$2.cjs$1)')
                .replace(`//# sourceMappingURL=${name}.map`, `//# sourceMappingURL=${base}.cjs.map`);
            writeFileSync(path.join(to, `${base}.cjs`), code);
        } else {
            throw new Error(`unexpected file in the CommonJS emit: ${name}`);
        }
    }
}

if (process.argv.includes('--tests')) {
    rmSync(at('dist-tests'), { recursive: true, force: true });
    compile('tsconfig.dist-tests.json');
    // The unit tests import the engine from test/support/engine: under src/ it is TypeScript, here it is the build.
    const engine = at('dist-tests/test/support/engine.js');
    const text = readFileSync(engine, 'utf8');
    if (!text.includes('../../src/')) throw new Error('test/support/engine.js does not import src/');
    writeFileSync(engine, text.replaceAll('../../src/', '../../../dist/'));
} else {
    rmSync(at('dist'), { recursive: true, force: true });
    rmSync(at('.build-cjs'), { recursive: true, force: true });
    compile('tsconfig.build.json');
    retargetDeclarations(at('dist'), 'js');
    compile('tsconfig.build.cjs.json');
    mkdirSync(at('dist'), { recursive: true });
    convertCommonJs(at('.build-cjs'), at('dist'));
    pruneDeclarations(at('dist'), 'index.d.ts', 'js');
    pruneDeclarations(at('dist'), 'index.d.cts', 'cjs');
    rmSync(at('.build-cjs'), { recursive: true, force: true });
}
