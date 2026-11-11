// Worker for test/fuzz-expr.ts: evaluates a batch of expressions on one document with both engines and reports
// after each expression, so that the parent can stop an evaluation that does not come back (upstream is
// exponential in the number of steps for some random paths).

import { parentPort } from 'node:worker_threads';
import { allNodes, describe, errorText, isDomName, loadCandidate, loadDom, loadOracle } from './harness.ts';
import { isNamespaceDuplicate } from './support/classify.ts';
import type { DomNode } from './support/dom.ts';
import { loadInternedOracle } from './support/interned-oracle.ts';

/** `documented`: a difference in a documented class (CLASSIFY, see the README); it does not fail the run. */
export type Kind = 'equal' | 'message' | 'order' | 'mixed' | 'result' | 'documented';

export interface Job {
    readonly dom: string;
    readonly xml: string;
    readonly expressions: readonly string[];
    /** Two numbers in [0, 1) that pick the extra context nodes. */
    readonly picks: readonly [number, number];
}

export type Report =
    /** The candidate has answered expression `at` for every context; upstream is next. */
    | { readonly type: 'candidate-done'; readonly at: number }
    | {
          readonly type: 'expression-done';
          readonly at: number;
          readonly kinds: readonly Kind[];
          readonly shapes: readonly ('node-set' | 'scalar' | 'error')[];
          readonly sample: string | null;
      }
    | { readonly type: 'batch-done' };

export function isJob(value: unknown): value is Job {
    return (
        typeof value === 'object' &&
        value !== null &&
        'dom' in value &&
        'xml' in value &&
        'expressions' in value &&
        'picks' in value
    );
}

export function isReport(value: unknown): value is Report {
    return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

const members = (text: string): string[] => (text.startsWith('[') ? text.slice(1, -1).split(',').sort() : [text]);

function run(job: Job, send: (report: Report) => void): void {
    if (!isDomName(job.dom)) throw new Error(`unknown DOM ${job.dom}`);
    const upstream = loadOracle();
    const interned = loadInternedOracle();
    const classify = process.env['CLASSIFY'] ?? '';
    const candidate = loadCandidate();
    const doc = loadDom(job.dom)(job.xml);
    const nodes = allNodes(doc);
    const index = new Map<unknown, number>(nodes.map((node, i) => [node, i]));
    const attributeIds = new Set<string>();
    nodes.forEach((node, i) => {
        if (node.nodeType === 2) attributeIds.add(String(i));
    });
    const special = (text: string): boolean =>
        text.includes('ns:') || members(text).some((item) => attributeIds.has(item));
    const contexts: DomNode[] = [doc];
    for (const pick of job.picks) {
        const node = nodes[Math.floor(pick * nodes.length)];
        if (node !== undefined) contexts.push(node);
    }
    const attempt = (select: () => unknown): string => {
        try {
            return describe(select(), index);
        } catch (error) {
            return `ERR ${errorText(error)}`;
        }
    };
    job.expressions.forEach((expression, at) => {
        const actual = contexts.map((node) => attempt(() => candidate.select(expression, node)));
        send({ type: 'candidate-done', at });
        const kinds: Kind[] = [];
        const shapes: ('node-set' | 'scalar' | 'error')[] = [];
        let sample: string | null = null;
        contexts.forEach((node, c) => {
            const expected = attempt(() => upstream.select(expression, node));
            const got = actual[c] ?? '';
            const a = expected.startsWith('ERR');
            const b = got.startsWith('ERR');
            shapes.push(a ? 'error' : expected.startsWith('[') ? 'node-set' : 'scalar');
            let kind: Kind = 'result';
            if (expected === got) kind = 'equal';
            else if (a && b) kind = 'message';
            else if (!a && !b && members(expected).join() === members(got).join()) kind = 'order';
            else if (special(expected) || special(got) || node.nodeType === 2) kind = 'mixed';
            if (classify !== '' && (kind === 'result' || kind === 'mixed' || kind === 'order')) {
                // Class 5 (both DOMs that gate) and, for xmldom 0.9 (CLASSIFY=all), class 1: upstream throws on a
                // namespace node and the engine answers.
                const namespaceDuplicate = isNamespaceDuplicate(expression, expected, got, () =>
                    attempt(() => interned.select(expression, node))
                );
                const namespaceCrash = classify === 'all' && a && !b && expression.includes('namespace::');
                if (namespaceDuplicate || namespaceCrash) kind = 'documented';
            }
            kinds.push(kind);
            if (kind !== 'equal' && kind !== 'message' && kind !== 'documented' && sample === null) {
                sample = `${kind} @${node.nodeName}/${node.nodeType}\n     upstream:  ${expected.slice(0, 150)}\n     candidate: ${got.slice(0, 150)}`;
            }
        });
        send({ type: 'expression-done', at, kinds, shapes, sample });
    });
    send({ type: 'batch-done' });
}

parentPort?.on('message', (message: unknown) => {
    if (isJob(message)) run(message, (report) => parentPort?.postMessage(report));
});
