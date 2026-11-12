// Grammar-based differential fuzzer: random expressions on random documents, upstream against the candidate,
// through select() from the document node and from two random nodes.
//
// Each document's batch runs in a worker thread. An evaluation that does not return within the time limit is
// stopped and counted, with the engine that was running: upstream does not remove duplicates between steps, so a
// random path such as `//*/..//*/..//*` costs it n^k.
//
//   node test/fuzz-expr.ts <dom> <documents> <expressions per document> [seed] [ns] [limit ms]
//   TOLERATE=order,mixed lets those kinds of difference through, for a DOM known to differ
//   CLASSIFY=all|ns-duplicate  the split gate: differences in the documented classes (see test/fuzz.ts) are counted
//   apart and do not fail the run; every other difference does

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { isReport } from './fuzz-expr-worker.ts';
import type { Job, Kind } from './fuzz-expr-worker.ts';
import { documentText, makeExpressionGenerator } from './generate.ts';
import { isDomName, makeRandom } from './harness.ts';

const domName = process.argv[2] ?? 'xmldom08';
if (!isDomName(domName)) throw new Error(`unknown DOM ${domName}`);
const documents = Number(process.argv[3] ?? 100);
const perDocument = Number(process.argv[4] ?? 100);
const random = makeRandom(Number(process.argv[5] ?? 4242));
const nextExpression = makeExpressionGenerator(random, { namespaceAxis: process.argv[6] === 'ns' });
const limit = Number(process.argv[7] ?? 5000);

const tally: Record<Kind, number> = { equal: 0, message: 0, order: 0, mixed: 0, result: 0, documented: 0 };
const shapes = { 'node-set': 0, scalar: 0, error: 0 };
const samples = new Map<string, string>();
const slow = { upstream: 0, candidate: 0 };
const slowSamples: string[] = [];
let compared = 0;
let unparsable = 0;

/** Runs one batch; resolves with the index of the expression that timed out, or -1 when the batch finished. */
function runBatch(job: Job): Promise<number> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(`./fuzz-expr-worker${path.extname(import.meta.filename)}`, import.meta.url));
        let current = 0;
        let candidateDone = false;
        let timer = setTimeout(expire, limit);
        function expire(): void {
            if (candidateDone) slow.upstream++;
            else slow.candidate++;
            if (slowSamples.length < 5)
                slowSamples.push(`${candidateDone ? 'upstream' : 'candidate'}: ${job.expressions[current] ?? ''}`);
            void worker.terminate().then(() => resolve(current));
        }
        worker.on('message', (message: unknown) => {
            if (!isReport(message)) return;
            clearTimeout(timer);
            if (message.type === 'unparsable') {
                unparsable++;
                void worker.terminate().then(() => resolve(-1));
                return;
            }
            if (message.type === 'batch-done') {
                void worker.terminate().then(() => resolve(-1));
                return;
            }
            timer = setTimeout(expire, limit);
            if (message.type === 'candidate-done') {
                current = message.at;
                candidateDone = true;
                return;
            }
            candidateDone = false;
            current = message.at + 1;
            compared++;
            for (const kind of message.kinds) tally[kind]++;
            for (const shape of message.shapes) shapes[shape]++;
            const expression = job.expressions[message.at];
            if (message.sample !== null && expression !== undefined && samples.size < 12 && !samples.has(expression))
                samples.set(expression, message.sample);
        });
        worker.on('error', reject);
        worker.postMessage(job);
    });
}

const started = Date.now();
let generated = 0;
for (let d = 0; d < documents; d++) {
    const xml = documentText(random, { wide: 0.01 });
    let expressions: string[] = [];
    for (let e = 0; e < perDocument; e++) expressions.push(nextExpression());
    generated += expressions.length;
    const picks: readonly [number, number] = [random(), random()];
    while (expressions.length > 0) {
        // A worker that fails for any reason but an unparsable document (the oracle or the candidate cannot be loaded,
        // an exception outside an evaluation) rejects here and fails the whole run.
        const stoppedAt = await runBatch({ dom: domName, xml, expressions, picks });
        if (stoppedAt < 0) break;
        expressions = expressions.slice(stoppedAt + 1);
    }
}
console.log(
    `${domName}: ${documents} documents, ${generated} random expressions, ${compared} compared on 3 context nodes, ${Date.now() - started} ms; ` +
        `stopped after ${limit} ms: ${slow.upstream} in upstream, ${slow.candidate} in the candidate`
);
console.log(`upstream gave ${shapes['node-set']} node-sets, ${shapes.scalar} scalars, ${shapes.error} errors`);
console.log(
    `equal ${tally.equal}; differences: result ${tally.result}, mixed-kind sets ${tally.mixed}, order-only ${tally.order}, error-message-only ${tally.message}, documented classes ${tally.documented}`
);
for (const sample of slowSamples) console.log(`  slow ${sample.slice(0, 200)}`);
for (const [expression, sample] of samples) console.log(`  ${expression}\n     ${sample}`);
const tolerated = new Set((process.env['TOLERATE'] ?? '').split(','));
// A run that compared nothing proves nothing.
const comparedNothing = compared === 0 && documents > 0 && perDocument > 0;
if (comparedNothing) console.log(`no expression was compared (${unparsable} of ${documents} documents did not parse)`);
// Upstream is exponential in the number of steps on some random paths, so its timeouts are counted and tolerated. A
// candidate that does not come back is a defect: the run fails.
if (slow.candidate > 0)
    console.log(`the candidate did not come back within ${limit} ms on ${slow.candidate} expressions`);
const differences =
    (tolerated.has('result') ? 0 : tally.result) +
    (tolerated.has('mixed') ? 0 : tally.mixed) +
    (tolerated.has('order') ? 0 : tally.order);
process.exitCode = comparedNothing || slow.candidate > 0 || differences > 0 ? 1 : 0;
