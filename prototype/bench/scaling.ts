// Growth, memory and the work budget, for the prototype alone (xmldom 0.8):
//  1. the hostile shapes at 64, 128, 256 and 512 KiB: time, and the factor per doubling (linear is 2.0);
//  2. heap retained while a node-set that needed a numbering is alive;
//  3. a cubic expression with and without a work budget.
//
//   node --expose-gc bench/scaling.ts

import * as candidate from '../src/compat.ts';
import type { DomNode } from '../src/dom.ts';
import { XPathBudgetError } from '../src/errors.ts';
import { XPathProgram } from '../src/program.ts';
import { NodeSet } from '../src/runtime.ts';
import { errorText, loadDom, milliseconds } from '../test/harness.ts';

const KiB = 1024;
const parse = loadDom('xmldom08');
const fit = (pre: string, unit: string, post: string, bytes: number): string =>
    pre + unit.repeat(Math.floor((bytes - pre.length - post.length) / unit.length)) + post;

function median(run: () => void, runs: number): number {
    for (let i = 0; i < 3; i++) run();
    const times: number[] = [];
    for (let i = 0; i < runs; i++) times.push(milliseconds(run));
    times.sort((a, b) => a - b);
    return times[Math.floor(runs / 2)] ?? 0;
}

const SHAPES: readonly (readonly [string, string, (bytes: number) => string])[] = [
    ['siblings', '//*', (bytes) => fit('<r>', '<a/>', '</r>', bytes)],
    ['cousins', '//*', (bytes) => fit('<r>', '<a><b/></a>', '</r>', bytes)],
    ['attributes on one element', "//*[@*[local-name(.)='ID']='x']", (bytes) => fit('<r', ' a="1"', '/>', bytes).replace(/ a=/g, (_, at: number) => ` a${at}=`)],
    ['chain', '//*', (bytes) => '<a>'.repeat(Math.floor(bytes / 7)) + '</a>'.repeat(Math.floor(bytes / 7))],
    ['chain, ancestors', '//*/ancestor::*', (bytes) => '<a>'.repeat(Math.floor(bytes / 7)) + '</a>'.repeat(Math.floor(bytes / 7))],
    ['siblings, nearest preceding sibling', '//a/preceding-sibling::*[1]', (bytes) => fit('<r>', '<a/>', '</r>', bytes)],
    ['siblings, following siblings', '//a/following-sibling::*', (bytes) => fit('<r>', '<a/>', '</r>', bytes)],
    ['siblings, count(preceding-sibling)', '/*/*/*[count(preceding-sibling::*)=3]', (bytes) => fit('<r><g>', '<a/>', '</g></r>', bytes)],
    ['siblings, following', '//a/following::*', (bytes) => fit('<r>', '<a/>', '</r>', bytes)],
    ['siblings, preceding', '//a/preceding::*', (bytes) => fit('<r>', '<a/>', '</r>', bytes)],
    ['union', '//a | //b | //c', (bytes) => fit('<r>', '<a/><b/><c x="1"/>', '</r>', bytes)],
    ['union with attributes', '//* | //@*', (bytes) => fit('<r>', '<a/><b/><c x="1"/>', '</r>', bytes)],
    ['parents (needs a sort)', '//*/..', (bytes) => fit('<r>', '<a><b/></a>', '</r>', bytes)],
    ['string-values of a chain', "//*[. = 'x']", (bytes) => `${'<a>'.repeat(Math.floor(bytes / 28))}x${'</a>'.repeat(Math.floor(bytes / 28))}`]
];
const SIZES = [64, 128, 256, 512];

console.log(`### 1. Growth with document size (xpath-es, median of 9)\n\n| shape: expression | ${SIZES.map((kb) => `${kb} KiB`).join(' | ')} | factor per doubling |\n|---|${SIZES.map(() => '---:').join('|')}|---|`);
for (const [name, expression, build] of SHAPES) {
    const times = SIZES.map((kb) => {
        const doc = parse(build(kb * KiB));
        return median(() => void candidate.select(expression, doc), 9);
    });
    const factors = times.slice(1).map((time, i) => (time / (times[i] ?? time)).toFixed(1));
    console.log(`| ${name}: \`${expression}\` | ${times.map((time) => `${time.toFixed(2)} ms`).join(' | ')} | ${factors.join(', ')} |`);
}

const collect = globalThis.gc;
console.log('\n### 2. Memory\n');
if (collect === undefined) {
    console.log('run with --expose-gc to measure');
} else {
    const doc = parse(fit('<r>', '<a><b/></a>', '</r>', 256 * KiB));
    const program = new XPathProgram('//*/..');
    collect();
    const before = process.memoryUsage().heapUsed;
    const { value, state } = program.run({ node: doc });
    const sorted: readonly DomNode[] = value instanceof NodeSet ? value.sorted(state) : [];
    collect();
    const during = process.memoryUsage().heapUsed;
    console.log(`\`//*/..\` on 256 KiB of cousins (47,661 tree nodes), result of ${sorted.length} nodes, evaluation state still referenced: ${((during - before) / 1024).toFixed(0)} KiB of heap, ${((during - before) / 47661).toFixed(0)} bytes per tree node (numbering map and index array, result array)`);
    console.log(`charged work: ${state.work} node visits`);
}

console.log('\n### 3. Work budget\n');
{
    const doc = parse(`<r>${'<a/>'.repeat(2000)}</r>`);
    const cubic = new XPathProgram('//*[count(//*[count(//*) > 0]) > 0]');
    let outcome = '';
    const unlimited = milliseconds(() => {
        outcome = String(cubic.run({ node: doc }).state.work);
    });
    console.log(`\`//*[count(//*[count(//*) > 0]) > 0]\` on 2,001 elements, no budget: ${unlimited.toFixed(0)} ms, ${outcome} node visits`);
    const limited = milliseconds(() => {
        try {
            cubic.run({ node: doc, budget: 50_000_000 });
            outcome = 'finished';
        } catch (error) {
            outcome = error instanceof XPathBudgetError ? `XPathBudgetError (${errorText(error)})` : `other error: ${errorText(error)}`;
        }
    });
    console.log(`same, budget 50,000,000 visits: ${limited.toFixed(0)} ms -> ${outcome}`);
}
