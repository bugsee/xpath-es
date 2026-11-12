// Checks on the built package (dist/), in plain JavaScript so that Node 20 runs them: the emitted code is ES2022 and
// nothing else, there is no TypeScript source and no Node-only import in it, the declarations do not pull in Node's
// typings, the exports map points at files that exist, and `npm pack` ships exactly the intended files.
//
//   npm run build && node --test test/dist/package.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist');
const files = readdirSync(dist);
const read = (name) => readFileSync(path.join(dist, name), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('dist is not empty and has every output kind', () => {
    for (const extension of ['.js', '.cjs', '.d.ts', '.d.cts', '.js.map', '.cjs.map'])
        assert.ok(
            files.some((name) => name.endsWith(extension)),
            `no ${extension} file in dist/`
        );
    assert.ok(files.includes('index.js') && files.includes('index.cjs'));
});

test('the emitted JavaScript parses as ES2022: modules for .js, scripts for .cjs', () => {
    for (const name of files.filter((file) => file.endsWith('.js'))) {
        assert.doesNotThrow(() => parse(read(name), { ecmaVersion: 2022, sourceType: 'module' }), name);
    }
    for (const name of files.filter((file) => file.endsWith('.cjs'))) {
        assert.doesNotThrow(() => parse(read(name), { ecmaVersion: 2022, sourceType: 'script' }), name);
    }
});

test('the parser is not lenient: ES2023+ and TypeScript syntax is rejected', () => {
    // A guard for the test above: if these parsed, "parses as ES2022" would prove nothing.
    assert.throws(() => parse('class A { static accessor x = 1 }', { ecmaVersion: 2022, sourceType: 'module' }));
    assert.throws(() => parse('const x: number = 1;', { ecmaVersion: 2022, sourceType: 'module' }));
    assert.throws(() => parse('import type { A } from "./a.js";', { ecmaVersion: 2022, sourceType: 'module' }));
    assert.throws(() => parse('using x = null;', { ecmaVersion: 2022, sourceType: 'module' }));
});

test('ES2022 features are kept, not down-levelled', () => {
    const runtime = read('runtime.js');
    assert.match(runtime, /#numbering/, 'private fields are down-levelled');
    assert.match(runtime, /^\s*static\s|\bclass\s/m, 'classes are down-levelled');
    assert.doesNotMatch(
        runtime,
        /__classPrivateField|_classPrivateField|WeakMap\(\)/,
        'private fields became WeakMaps'
    );
    assert.match(read('compat.js'), /\?\./, 'optional chaining is down-levelled');
});

test('no TypeScript source is shipped in dist', () => {
    const sources = files.filter((name) => /\.(ts|cts|mts|tsx)$/.test(name) && !/\.d\.(ts|cts|mts)$/.test(name));
    assert.deepEqual(sources, []);
    for (const name of files.filter((file) => file.endsWith('.js') || file.endsWith('.cjs')))
        assert.doesNotMatch(read(name), /\bfrom\s+['"][^'"]+\.ts['"]|require\(['"][^'"]+\.ts['"]\)/, name);
});

test('no Node-only import in the code, so the ES module entry is browser-safe', () => {
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    for (const name of files.filter((file) => file.endsWith('.js') || file.endsWith('.cjs'))) {
        const specifiers = [];
        const tree = parse(read(name), { ecmaVersion: 2022, sourceType: name.endsWith('.js') ? 'module' : 'script' });
        const visit = (node) => {
            if (typeof node !== 'object' || node === null) return;
            if (Array.isArray(node)) return node.forEach(visit);
            if (
                (node.type === 'ImportDeclaration' ||
                    node.type === 'ExportAllDeclaration' ||
                    (node.type === 'ExportNamedDeclaration' && node.source)) &&
                node.source
            )
                specifiers.push(node.source.value);
            if (node.type === 'ImportExpression' && node.source.type === 'Literal') specifiers.push(node.source.value);
            if (
                node.type === 'CallExpression' &&
                node.callee.type === 'Identifier' &&
                node.callee.name === 'require' &&
                node.arguments[0]?.type === 'Literal'
            )
                specifiers.push(node.arguments[0].value);
            for (const value of Object.values(node)) visit(value);
        };
        visit(tree);
        for (const specifier of specifiers) {
            assert.ok(!builtins.has(specifier), `${name} imports the Node built-in ${specifier}`);
            assert.ok(specifier.startsWith('./'), `${name} imports a package: ${specifier}`);
        }
        // Free references to Node globals would break in a browser.
        assert.doesNotMatch(
            read(name),
            /\b(process|Buffer|__dirname|__filename)\b(?!\s*:)/,
            `${name} uses a Node global`
        );
    }
});

test('the declarations do not reference Node typings and import only siblings', () => {
    for (const name of files.filter((file) => /\.d\.c?ts$/.test(file))) {
        const text = read(name);
        assert.doesNotMatch(text, /\/\/\/\s*<reference\s+(types|lib)=/, `${name} has a triple-slash reference`);
        assert.doesNotMatch(text, /(from|import\()\s*['"]node:/, `${name} imports node:`);
        assert.doesNotMatch(text, /import\(["'](?!\.\/)/, `${name} has an import type of a package`);
        for (const [, specifier] of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
            assert.ok(specifier.startsWith('./'), `${name} imports ${specifier}`);
            assert.ok(specifier.endsWith(name.endsWith('.d.cts') ? '.cjs' : '.js'), `${name}: ${specifier}`);
            assert.ok(existsSync(path.join(dist, specifier)), `${name}: ${specifier} does not exist`);
        }
    }
});

test('CommonJS output requires only .cjs siblings, and source maps name the right file', () => {
    for (const name of files.filter((file) => file.endsWith('.cjs'))) {
        for (const [, specifier] of read(name).matchAll(/require\(["']([^"']+)["']\)/g))
            assert.ok(specifier.endsWith('.cjs'), `${name} requires ${specifier}`);
        assert.match(read(name), new RegExp(`sourceMappingURL=${name.replace('.', '\\.')}\\.map`), name);
    }
    for (const name of files.filter((file) => file.endsWith('.map'))) {
        const map = JSON.parse(read(name));
        assert.equal(map.file, name.slice(0, -'.map'.length), name);
        assert.ok(Array.isArray(map.sourcesContent) && map.sourcesContent.length > 0, `${name} has no inlined sources`);
    }
});

test('package.json: exports, engines, files and sideEffects', () => {
    assert.equal(packageJson.sideEffects, false);
    assert.equal(packageJson.engines.node, '>=20');
    const entry = packageJson.exports['.'];
    assert.deepEqual(Object.keys(entry), ['import', 'require']);
    assert.deepEqual(Object.keys(entry.import), ['types', 'default']);
    assert.deepEqual(Object.keys(entry.require), ['types', 'default']);
    for (const target of [
        entry.import.types,
        entry.import.default,
        entry.require.types,
        entry.require.default,
        packageJson.main,
        packageJson.module,
        packageJson.types
    ])
        assert.ok(existsSync(path.join(root, target)), `${target} does not exist`);
    assert.ok(entry.import.default.endsWith('.js') && entry.require.default.endsWith('.cjs'));
    assert.ok(entry.import.types.endsWith('.d.ts') && entry.require.types.endsWith('.d.cts'));
});

test('npm pack ships the build, the licence and the readme, and nothing else', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    // `npm pack --json` prints an array of packages (npm 10, 11) or one package object (npm 12).
    const report = JSON.parse(pack.stdout);
    const { files: packed } = Array.isArray(report) ? report[0] : report;
    const names = packed.map((file) => file.path);
    for (const required of [
        'package.json',
        'LICENSE',
        'README.md',
        'dist/index.js',
        'dist/index.cjs',
        'dist/index.d.ts',
        'dist/index.d.cts'
    ])
        assert.ok(names.includes(required), `${required} is not packed`);
    const unexpected = names.filter(
        (file) =>
            !(
                file === 'package.json' ||
                file === 'LICENSE' ||
                file === 'README.md' ||
                /^dist\/[^/]+\.(js|cjs|d\.ts|d\.cts|map)$/.test(file)
            )
    );
    assert.deepEqual(unexpected, []);
    assert.ok(
        names.every((file) => !/\.ts$/.test(file) || /\.d\.c?ts$/.test(file)),
        'a TypeScript source is packed'
    );
});

test("the public declarations are only the API: nothing of the engine's internals can be reached from the entry", () => {
    // The declarations the entry reaches, directly or through each other, are the only declaration files shipped.
    for (const [entry, suffix] of [
        ['index.d.ts', '.d.ts'],
        ['index.d.cts', '.d.cts']
    ]) {
        const reachable = new Set([entry]);
        const pending = [entry];
        for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
            for (const [, name] of read(file).matchAll(/from\s+['"]\.\/([^'"]+)\.c?js['"]/g)) {
                const next = `${name}${suffix}`;
                if (!reachable.has(next)) {
                    reachable.add(next);
                    pending.push(next);
                }
            }
        }
        const shipped = files.filter((name) => name.endsWith(suffix));
        assert.deepEqual(
            [...shipped].sort(),
            [...reachable].sort(),
            `${suffix} files that are not reachable from ${entry}`
        );
        const internals =
            /\b(EvalState|NodeSet|Numbering|Focus|Compiled|forceSlowPath|RawEvaluateOptions|runRaw|userCodeRan|siteCaches|elementsById|sortFew|FEW_NODES)\b/;
        for (const name of reachable) assert.doesNotMatch(read(name), internals, `${name} exposes an engine internal`);
    }
});
