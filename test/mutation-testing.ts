// Mutation testing of the suite itself: each mutant is a copy of the engine with one deliberately wrong change, planted
// where a fast path or a rarely-taken branch lives. The suite (the unit tests, the mutation scenarios, a short differential
// run) must FAIL on every mutant; a mutant that every check lets through is a hole in the suite. The first mutant is the
// one an adversarial reviewer planted in a copy of this repository: an off-by-one in the count(following-sibling::T) fast
// path that is active only when a parent has more than 3,000 children, which every gate then passed.
//
//   node test/mutation-testing.ts [name-fragment]     exit 1 when a mutant survives (or does not apply)

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

interface Mutant {
    readonly name: string;
    readonly file: string;
    /** Text that occurs exactly once in the file; a mutant that no longer applies is an error. */
    readonly find: string;
    readonly replace: string;
}

const MUTANTS: readonly Mutant[] = [
    {
        name: 'strict following[k]: the k-th match is one too far',
        file: 'src/ranked.ts',
        find: 'const position = k === null ? matches.length - 1 : above + k - 1;',
        replace: 'const position = k === null ? matches.length - 1 : above + k;'
    },
    {
        name: 'strict following: the subtree of a tree node is not skipped (its descendants follow it)',
        file: 'src/ranked.ts',
        find: 'const threshold = isTree[c] === true ? (ends[rank] ?? rank) : rank;',
        replace: 'const threshold = rank;'
    },
    {
        name: 'strict preceding[k]: the matching ancestors are not counted past',
        file: 'src/ranked.ts',
        find: 'if ((ancestorPositions[middle] ?? 0) - middle <= far) low = middle + 1;',
        replace: 'if ((ancestorPositions[middle] ?? 0) - middle < far) low = middle + 1;'
    },
    {
        name: 'strict preceding[k]: an ancestor stays on the stack for a context outside its subtree',
        file: 'src/ranked.ts',
        find: 'if (top < rank && (ends[top] ?? top) >= rank) break;',
        replace: 'if (top < rank) break;'
    },
    {
        name: 'strict preceding of a node-set: the ancestors of the last context are not excluded',
        file: 'src/ranked.ts',
        find: 'if (node !== undefined && !ancestors.has(node)) visit(node);',
        replace: 'if (node !== undefined) visit(node);'
    },
    {
        name: 'strict preceding of a node-set: the last context is taken by position in the list, not in the document',
        file: 'src/ranked.ts',
        find: 'if (rank > last) {',
        replace: 'if (lastNode === null) {'
    },
    {
        name: 'id(node-set) serialises with no charge and no length cap',
        file: 'src/functions.ts',
        find: 'function serialisedIds(set: NodeSet, state: EvalState): string {',
        replace:
            "function serialisedIds(set: NodeSet, real: EvalState): string {\n    return set.sorted(real).map((node) => stringify(node)).join(' ');\n}\n// @ts-expect-error unused\nfunction chargedSerialisedIds(set: NodeSet, state: EvalState): string {"
    },
    {
        name: "sibling-count fast path: off by one for a parent with more than 3,000 children (the reviewer's)",
        file: 'src/compile.ts',
        find: 'ranks.set(child, preceding ? before : total - before - (matches ? 1 : 0));',
        replace:
            'ranks.set(child, (preceding ? before : total - before - (matches ? 1 : 0)) + (total > 3000 && !preceding ? 1 : 0));'
    },
    {
        name: 'sweep (n * 8 > total) drops the last node',
        file: 'src/order.ts',
        find: 'if (marks[at] !== 1) continue;',
        replace: 'if (marks[at] !== 1 || at === total - 1) continue;'
    },
    {
        name: 'union merge keeps a node that both operands hold',
        file: 'src/order.ts',
        find: 'if (x === y) {',
        replace: 'if (false) {'
    },
    {
        name: 'following-sibling::T[last()] finds the nearest sibling instead of the farthest',
        file: 'src/steps.ts',
        find: 'context.parentNode?.lastChild;',
        replace: 'context.nextSibling;'
    },
    {
        name: 'reverse walk (preceding) loses the parent when there is no previous sibling',
        file: 'src/steps.ts',
        find: 'if (previous == null) return node.parentNode ?? null;',
        replace: 'if (previous == null) return null;'
    },
    {
        name: 'strict following skips the first following sibling',
        file: 'src/steps.ts',
        find: 'visits += walkSubtrees(place.nextSibling, step, state, out);',
        replace: 'visits += walkSubtrees(place.nextSibling?.nextSibling, step, state, out);'
    },
    {
        name: 'hoisting treats position() as document-only',
        file: 'src/compile.ts',
        find: "expr.name !== 'position' &&",
        replace: ''
    },
    {
        name: 'strict substring starts at position 0',
        file: 'src/functions.ts',
        find: 'const low = Math.max(first, 1);',
        replace: 'const low = Math.max(first, 0);'
    },
    {
        name: 'the id index keeps the last element of a duplicated id',
        file: 'src/runtime.ts',
        find: '&& !index.has(identifier)) index.set(identifier, node);',
        replace: ') index.set(identifier, node);'
    },
    {
        name: 'a custom function does not drop the numbering it may have made stale',
        file: 'src/runtime.ts',
        find: '    userCodeRan(): void {\n        this.#numbering = null;',
        replace: '    userCodeRan(): void {\n        this.#numbering = this.#numbering;'
    }
];

const only = process.argv[2];
const NETS: readonly { readonly name: string; readonly command: readonly string[] }[] = [
    {
        name: 'unit tests',
        command: [
            '--test',
            'test/unit/fast-paths.test.ts',
            'test/unit/modes.test.ts',
            'test/unit/strict-spec.test.ts',
            'test/unit/review-limits.test.ts',
            'test/unit/resolvers.test.ts',
            'test/unit/axes.test.ts',
            'test/unit/strict-axes.test.ts'
        ]
    },
    { name: 'strict axes fuzz', command: ['test/strict-axes-fuzz.ts', '12', '60', '5'] },
    { name: 'mutation scenarios', command: ['test/mutation.ts'] },
    { name: 'differential (xmldom 0.8)', command: ['test/fuzz.ts', 'xmldom08', '40', '5', 'all'] }
];

function mirror(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xpath-es-mutant-'));
    for (const entry of ['src', 'test', 'bench', 'baselines', 'package.json', 'tsconfig.json'])
        cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

function caughtBy(dir: string): string | null {
    for (const net of NETS) {
        const run = spawnSync(process.execPath, [...net.command], {
            cwd: dir,
            env: { ...process.env, CANDIDATE: './src/index.ts', CLASSIFY: 'ns-duplicate' },
            encoding: 'utf8',
            timeout: 600_000
        });
        if (run.status !== 0) return net.name;
    }
    return null;
}

let failures = 0;
// The unmutated copy must pass every net, or a failure below proves nothing.
const clean = mirror();
const baseline = caughtBy(clean);
rmSync(clean, { recursive: true, force: true });
if (baseline !== null) {
    console.log(`the unmutated copy fails "${baseline}": the nets are not a baseline`);
    process.exit(1);
}
for (const mutant of MUTANTS) {
    if (only !== undefined && !mutant.name.includes(only)) continue;
    const dir = mirror();
    try {
        const file = path.join(dir, mutant.file);
        const text = readFileSync(file, 'utf8');
        const at = text.indexOf(mutant.find);
        if (at === -1 || text.indexOf(mutant.find, at + 1) !== -1) {
            console.log(
                `ERROR  ${mutant.name}: the text to change occurs ${at === -1 ? 'nowhere' : 'twice'} in ${mutant.file}`
            );
            failures++;
            continue;
        }
        writeFileSync(
            file,
            text.replace(mutant.find, () => mutant.replace)
        );
        const net = caughtBy(dir);
        console.log(`${net === null ? 'SURVIVED' : 'killed  '} ${mutant.name}${net === null ? '' : `  (by ${net})`}`);
        if (net === null) failures++;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
console.log(failures === 0 ? 'every mutant was caught' : `${failures} mutant(s) not caught`);
process.exitCode = failures === 0 ? 0 : 1;
