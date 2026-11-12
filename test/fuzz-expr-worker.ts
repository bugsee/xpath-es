// Worker for test/fuzz-expr.ts: evaluates a batch of expressions on one document with both engines and reports
// after each expression, so that the parent can stop an evaluation that does not come back (upstream is
// exponential in the number of steps for some random paths).

import { parentPort } from 'node:worker_threads';
import { allNodes, describe, errorText, isDomName, loadCandidate, loadDom, loadOracle } from './harness.ts';
import type { XPathLike } from './harness.ts';
import { allowedClasses, classifyDifference } from './support/classify.ts';
import type { DomNode } from './support/dom.ts';
import { categoryOfDescription } from './support/errors.ts';
import { loadInternedOracle } from './support/interned-oracle.ts';

/** `documented`: a difference in a documented class (CLASSIFY, see the README); it does not fail the run. */
export type Kind = 'equal' | 'message' | 'order' | 'mixed' | 'result' | 'documented';

/**
 * Where the worker is, in memory the parent can read while the worker is busy (a timed-out evaluation cannot report):
 * Int32 slots [expression, phase, context] and Float64 slots [phase start, worker start, ready, candidate ms per context...].
 * The parent prints it when it stops an evaluation, so that a timeout says where the time went.
 */
export const PHASE_IDLE: number = 0;
export const PHASE_LOADING: number = 1;
export const PHASE_CANDIDATE: number = 2;
export const PHASE_UPSTREAM: number = 3;
export const PHASE_COMPARING: number = 4;
export const PROGRESS_BYTES: number = 32 + 8 * 64;

export function progressViews(buffer: SharedArrayBuffer): { ints: Int32Array; floats: Float64Array } {
    return { ints: new Int32Array(buffer, 0, 8), floats: new Float64Array(buffer, 32, 64) };
}

export interface Job {
    readonly dom: string;
    readonly progress: SharedArrayBuffer;
    readonly xml: string;
    readonly expressions: readonly string[];
    /** Two numbers in [0, 1) that pick the extra context nodes. */
    readonly picks: readonly [number, number];
}

export type Report =
    /** The document is parsed and both engines are loaded: the parent's clock starts here, not at worker start. */
    | { readonly type: 'ready' }
    /** The candidate has answered expression `at` for every context; upstream is next. */
    | { readonly type: 'candidate-done'; readonly at: number }
    | {
          readonly type: 'expression-done';
          readonly at: number;
          readonly kinds: readonly Kind[];
          readonly shapes: readonly ('node-set' | 'scalar' | 'error')[];
          readonly sample: string | null;
      }
    /** The document does not parse in this DOM: the only failure the parent skips. Anything else must fail the run. */
    | { readonly type: 'unparsable' }
    | { readonly type: 'batch-done' };

export function isJob(value: unknown): value is Job {
    return (
        typeof value === 'object' &&
        value !== null &&
        'dom' in value &&
        'progress' in value &&
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
    const { ints, floats } = progressViews(job.progress);
    const mark = (phase: number, at: number, context: number): void => {
        Atomics.store(ints, 0, at);
        Atomics.store(ints, 2, context);
        floats[0] = performance.timeOrigin + performance.now();
        Atomics.store(ints, 1, phase);
    };
    floats[1] = performance.timeOrigin + performance.now();
    mark(PHASE_LOADING, 0, 0);
    const upstream = loadOracle();
    const interned = loadInternedOracle();
    const classify = process.env['CLASSIFY'] ?? '';
    const allowed = allowedClasses(classify);
    const candidate = loadCandidate();
    const parse = loadDom(job.dom);
    let doc: DomNode;
    try {
        doc = parse(job.xml);
    } catch {
        send({ type: 'unparsable' });
        return;
    }
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
        // A document type, entity or notation is not a node of the XPath data model: upstream's string value of one is null.
        if (node !== undefined && ![5, 6, 10, 12].includes(node.nodeType)) contexts.push(node);
    }
    const attempt = (select: () => unknown): string => {
        try {
            return describe(select(), index);
        } catch (error) {
            return `ERR ${errorText(error)}`;
        }
    };
    // Expressions that use a variable, a custom function or a prefix are evaluated through the evaluator object, with the
    // same variables, functions and namespace resolver (a map, or a function, alternately) given to both engines. The
    // answer is the string value and, when it is a node-set, the nodes. This puts the engine's impure paths (caller code
    // that may change the document) and its resolver paths in front of the differential fuzzer.
    const extras = /\$[a-z]|\b[fg]\(|[A-Za-z]:[A-Za-z*]/;
    const evaluate = (
        engine: XPathLike,
        expression: string,
        node: DomNode,
        limits?: Readonly<Record<string, unknown>>
    ): unknown => {
        if (!extras.test(expression)) return engine.select(expression, node, false, limits);
        const resolver =
            expression.length % 2 === 0
                ? { p: 'urn:p', q: 'urn:q' }
                : {
                      getNamespace: (prefix: string): string | null =>
                          prefix === 'p' ? 'urn:p' : prefix === 'q' ? 'urn:q' : null
                  };
        const options = {
            node,
            variables: { v: 'x', n: 2, b: true },
            functions: { f: (): number => 3, g: (_context: unknown, value: unknown): unknown => value },
            namespaces: resolver,
            ...limits
        };
        const text = engine.evaluateString(expression, options);
        let nodes: string;
        try {
            nodes = describe(engine.parseSelect(expression, options), index);
        } catch (error) {
            nodes = `n/a: ${categoryOfDescription(`ERR ${errorText(error)}`)}`;
        }
        return `${String(text)} | ${nodes}`;
    };
    floats[2] = performance.timeOrigin + performance.now();
    send({ type: 'ready' });
    job.expressions.forEach((expression, at) => {
        const actual = contexts.map((node, c) => {
            mark(PHASE_CANDIDATE, at, c);
            const began = performance.now();
            const answer = attempt(() => evaluate(candidate, expression, node));
            if (c < 60) floats[3 + c] = performance.now() - began;
            return answer;
        });
        mark(PHASE_UPSTREAM, at, 0);
        send({ type: 'candidate-done', at });
        const kinds: Kind[] = [];
        const shapes: ('node-set' | 'scalar' | 'error')[] = [];
        let sample: string | null = null;
        contexts.forEach((node, c) => {
            mark(PHASE_UPSTREAM, at, c);
            const expected = attempt(() => evaluate(upstream, expression, node));
            mark(PHASE_COMPARING, at, c);
            const got = actual[c] ?? '';
            const a = expected.startsWith('ERR');
            const b = got.startsWith('ERR');
            shapes.push(a ? 'error' : expected.startsWith('[') ? 'node-set' : 'scalar');
            let kind: Kind = 'result';
            if (expected === got) kind = 'equal';
            else if (a && b)
                kind = categoryOfDescription(expected) === categoryOfDescription(got) ? 'message' : 'result';
            else if (!a && !b && members(expected).join() === members(got).join()) kind = 'order';
            else if (special(expected) || special(got) || node.nodeType === 2) kind = 'mixed';
            if (classify !== '' && (kind === 'result' || kind === 'mixed' || kind === 'order')) {
                // Class 5 (both gated DOMs) and, for xmldom 0.9 (CLASSIFY=all), class 1; each only for its documented cause.
                const documented = classifyDifference(
                    'static',
                    expression,
                    expected,
                    got,
                    () => attempt(() => interned.select(expression, node)),
                    allowed,
                    () => attempt(() => evaluate(candidate, expression, node, { budget: 0, timeoutMs: 0 }))
                );
                if (documented !== null) kind = 'documented';
            }
            kinds.push(kind);
            if (kind !== 'equal' && kind !== 'message' && kind !== 'documented' && sample === null) {
                sample = `${kind} @${node.nodeName}/${node.nodeType}\n     upstream:  ${expected.slice(0, 150)}\n     candidate: ${got.slice(0, 150)}`;
            }
        });
        mark(PHASE_IDLE, at, 0);
        send({ type: 'expression-done', at, kinds, shapes, sample });
    });
    send({ type: 'batch-done' });
}

parentPort?.on('message', (message: unknown) => {
    if (isJob(message)) run(message, (report) => parentPort?.postMessage(report));
});
