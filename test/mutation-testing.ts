// Mutation testing of the suite itself: each mutant is a copy of the engine with one deliberately wrong change, planted
// where a fast path or a rarely-taken branch lives. The suite (the unit tests, the mutation scenarios, a short differential
// run) must FAIL on every mutant; a mutant that every check lets through is a hole in the suite. The first mutant is the
// one an adversarial reviewer planted in a copy of this repository: an off-by-one in the count(following-sibling::T) fast
// path that is active only when a parent has more than 3,000 children, which every gate then passed.
//
//   node test/mutation-testing.ts [name-fragment]     exit 1 when a mutant survives (or does not apply)

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    // The planted bugs of the second review (P-numbers are the reviewer's): each passed every gate of the first PR.
    {
        name: 'reviewer P1: strict preceding[k] drops an ancestor whose subtree ends exactly at the context',
        file: 'src/ranked.ts',
        find: 'if (top < rank && (ends[top] ?? top) >= rank) break;',
        replace: 'if (top < rank && (ends[top] ?? top) > rank) break;'
    },
    {
        name: 'reviewer P2: strict preceding of a set does not skip the document node as an ancestor',
        file: 'src/ranked.ts',
        find: 'for (let up = lastNode?.parentNode; up != null; up = up.parentNode) ancestors.add(up);',
        replace:
            'for (let up = lastNode?.parentNode; up != null && up.nodeType !== 9; up = up.parentNode) ancestors.add(up);'
    },
    {
        name: 'reviewer P3: the ordered descendant walk is not charged',
        file: 'src/steps.ts',
        find: '                        visits.one();\n                        if (node === input[at]) at++;\n                        if (passesAll(node, step, focus, state)) out.push(node);',
        replace:
            '                        if (node === input[at]) at++;\n                        if (passesAll(node, step, focus, state)) out.push(node);'
    },
    {
        name: 'reviewer P3b: the string-value walk is not charged',
        file: 'src/runtime.ts',
        find: 'state?.charge(visits - charged + (text.length >> 4));',
        replace: 'state?.charge(1);'
    },
    {
        name: 'reviewer P5: context-defaulting calls (string(), name(), ...) are taken for document-only and hoisted',
        file: 'src/compile.ts',
        find: '                !(CONTEXT_DEFAULTING.has(expr.name) && expr.args.length === 0) &&\n',
        replace: ''
    },
    {
        name: 'reviewer P5b: the arity test of the context-defaulting calls is inverted',
        file: 'src/compile.ts',
        find: '!(CONTEXT_DEFAULTING.has(expr.name) && expr.args.length === 0) &&',
        replace: '!(CONTEXT_DEFAULTING.has(expr.name) && expr.args.length === 1) &&'
    },
    {
        name: 'reviewer P6: strict lang() matches a longer name that starts with the wanted one',
        file: 'src/functions.ts',
        find: 'return have === want || have.startsWith(`${want}-`);',
        replace: 'return have === want || have.startsWith(want);'
    },
    {
        name: "reviewer P9: strict following of a set: an attribute context does not get its element's children",
        file: 'src/steps.ts',
        find: 'if (place !== context && place.firstChild != null) starts.add(place.firstChild);',
        replace: ''
    },
    {
        name: 'reviewer P12: strict following[k] takes an attribute context for its element',
        file: 'src/ranked.ts',
        find: 'isTree.push(place === context);',
        replace: 'isTree.push(true);'
    },
    {
        name: 'reviewer P13: firstAbove is one short (binary search off by one)',
        file: 'src/ranked.ts',
        find: '    let high = values.length;\n    while (low < high) {\n        const middle = (low + high) >>> 1;\n        if ((values[middle] ?? 0) > value) high = middle;',
        replace:
            '    let high = values.length - 1;\n    while (low < high) {\n        const middle = (low + high) >>> 1;\n        if ((values[middle] ?? 0) > value) high = middle;'
    },
    {
        name: 'reviewer P15: contains() is not charged for its input',
        file: 'src/functions.ts',
        find: '                state.charge(text.length >> 4);\n                return state.strict ? indexOfCharacters(text, part) !== -1 : text.includes(part);',
        replace: '                return state.strict ? indexOfCharacters(text, part) !== -1 : text.includes(part);'
    },
    {
        name: 'C-1: a predicate evaluation is not charged',
        file: 'src/steps.ts',
        find: '        state.charge(current.length);\n        for (let at = 0; at < current.length; at++) {',
        replace: '        for (let at = 0; at < current.length; at++) {'
    },
    {
        name: 'C-1: the operands of an `or` chain are not charged',
        file: 'src/compile.ts',
        find: '                for (const operand of operands) {\n                    state.charge(1);\n                    if (toBooleanValue(operand(focus, state))) return true;',
        replace:
            '                for (const operand of operands) {\n                    if (toBooleanValue(operand(focus, state))) return true;'
    },
    {
        name: 'C-1: a function call is not charged',
        file: 'src/compile.ts',
        find: '        // One unit per call, so that a call on short strings (which charges nothing by length) is not free.\n        state.charge(1);\n',
        replace: ''
    },
    {
        name: 'C-2: upstream-mode id() asks the DOM for every evaluation and charges nothing',
        file: 'src/runtime.ts',
        find: '        this.charge(this.numberingFor(document).size);\n        const element = document.getElementById?.(id) ?? null;',
        replace: '        const element = document.getElementById?.(id) ?? null;'
    },
    {
        name: 'C-3: strict * and a name test accept every principal node type',
        file: 'src/steps.ts',
        find: '                if (state.strict) return type === principal;\n                return type === ELEMENT_NODE || type === ATTRIBUTE_NODE || type === NAMESPACE_NODE;',
        replace: '                return type === ELEMENT_NODE || type === ATTRIBUTE_NODE || type === NAMESPACE_NODE;'
    },
    {
        name: 'C-8: strict text() takes every DOM text node of a run',
        file: 'src/steps.ts',
        find: '!(state.strict && continuesATextRun(node));',
        replace: 'true;'
    },
    {
        name: 'C-11: strict mode asks the resolver at every name test again',
        file: 'src/runtime.ts',
        find: '        if (this.strict) return this.resolvePrefix(prefix, this.settings.contextNode);\n        if (!this.pure',
        replace: '        if (!this.pure'
    },
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
        find: 'isTreeNode(context) ? context.parentNode?.lastChild : null;',
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
        find: 'walkSubtrees(place.nextSibling, step, state, out, visits);',
        replace: 'walkSubtrees(place.nextSibling?.nextSibling, step, state, out, visits);'
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
        find: 'const low = Math.max(first, 1) - 1;',
        replace: 'const low = Math.max(first, 0) - 1;'
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
// Every unit test file is a net (they take seconds together): a mutant that no file notices is a hole in all of them.
const UNIT_TESTS = readdirSync(path.join(root, 'test/unit'))
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => `test/unit/${file}`);

const NETS: readonly { readonly name: string; readonly command: readonly string[] }[] = [
    { name: 'unit tests', command: ['--test', ...UNIT_TESTS] },
    { name: 'strict oracle', command: ['test/strict-oracle.ts', 'xmldom08', '15', '60', '5', 'ns'] },
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
