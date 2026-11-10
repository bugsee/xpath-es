// The DOM changes while a result is held, or while the expression is being evaluated (from a custom function).
// Each scenario runs on upstream (the oracle) and on the candidate; the outputs must be equal. Scenarios that need
// an engine's parser internals are not here.
//
//   node test/mutation.ts

import { call, candidateSpec, errorText, loadCandidate, loadDom, loadOracle } from './harness.ts';
import type { XPathLike } from './harness.ts';
import { isDomNode } from './support/dom.ts';
import type { DomNode } from './support/dom.ts';

const parse = loadDom('xmldom08');
const oracle = loadOracle();
const candidate = loadCandidate();
type Api = XPathLike;

const ids = (value: unknown): string =>
    Array.isArray(value)
        ? value
              .map((node: unknown) => (isDomNode(node) ? (node.getAttribute?.('id') ?? node.nodeName) : String(node)))
              .join(',')
        : String(value);

interface Fixture {
    readonly doc: DomNode;
    readonly root: DomNode;
    /** Moves the last child of the root to the front: a,b,c becomes c,a,b. */
    readonly rotate: () => void;
}

function fixture(): Fixture {
    const doc = parse('<r><a id="1"/><b id="2"/><c id="3"/></r>');
    const root = doc.documentElement;
    if (root == null) throw new Error('no root');
    return { doc, root, rotate: () => void call(root, 'insertBefore', root.lastChild, root.firstChild) };
}

const scenarios: readonly (readonly [string, (api: Api) => string])[] = [
    [
        'held node-set, sorted after the DOM was reordered',
        (api) => {
            const { doc, rotate } = fixture();
            const first = api.evaluateNodeSet('/r/*', { node: doc });
            api.evaluateNodeSet('/r/*', { node: doc }).toArray();
            rotate();
            return ids(first.toArray());
        }
    ],
    [
        'held node-set, sorted before and after the DOM was reordered',
        (api) => {
            const { doc, rotate } = fixture();
            const set = api.evaluateNodeSet('/r/c | /r/a', { node: doc });
            const before = ids(set.toArray());
            rotate();
            return `${before} then ${ids(set.toArray())}`;
        }
    ],
    [
        'XNodeSet used directly in two DOM states',
        (api) => {
            const { root, rotate } = fixture();
            const kids = [root.lastChild, root.firstChild, root.firstChild?.nextSibling].filter((node) => node != null);
            api.newSet(kids).toArray();
            rotate();
            return ids(api.newSet(kids).toArray());
        }
    ],
    [
        'custom function reorders the DOM in the middle of the evaluation',
        (api) => {
            const { doc, rotate } = fixture();
            let done = false;
            const f = (): boolean => {
                if (!done) {
                    done = true;
                    rotate();
                }
                return true;
            };
            return ids(
                api.parseSelect('(/r/*)[f(string((/r/c | /r/a)[1]/@id))] | /r/c | /r/a', {
                    node: doc,
                    functions: { f }
                })
            );
        }
    ],
    [
        'custom function: sort, mutate, sort again in one evaluation',
        (api) => {
            const { doc, rotate } = fixture();
            const m = (): string => {
                rotate();
                return '-';
            };
            return ids(
                api.evaluateString('concat(name((/r/c | /r/a)[1]), m(), name((/r/c | /r/a)[1]))', {
                    node: doc,
                    functions: { m }
                })
            );
        }
    ],
    [
        'custom function removes a node that a later step would visit',
        (api) => {
            const { doc, root } = fixture();
            const drop = (): boolean => {
                if (root.lastChild != null && root.lastChild !== root.firstChild)
                    call(root, 'removeChild', root.lastChild);
                return true;
            };
            return ids(api.parseSelect('/r/*[drop()]/following-sibling::*', { node: doc, functions: { drop } }));
        }
    ],
    [
        'custom function: count siblings, mutate, count again',
        (api) => {
            const { doc, rotate } = fixture();
            const m = (): string => {
                rotate();
                return '-';
            };
            return ids(
                api.evaluateString(
                    'concat(count(/r/a/preceding-sibling::*), m(), count(/r/a/preceding-sibling::*), m(), name(/r/*[count(preceding-sibling::*) = 1]))',
                    { node: doc, functions: { m } }
                )
            );
        }
    ],
    [
        're-entrant select() inside a custom function',
        (api) => {
            const { doc } = fixture();
            const g = (_context: unknown, set: unknown): boolean => {
                const first: unknown = call(set, 'first');
                return (
                    isDomNode(first) && ids(api.select('following-sibling::* | preceding-sibling::*', first)).length > 0
                );
            };
            return ids(api.parseSelect('(/r/c | /r/a | /r/b)[g(.)]', { node: doc, functions: { g } }));
        }
    ],
    [
        'XPathResult iterator read after the DOM changed',
        (api) => {
            const { doc, rotate } = fixture();
            const nodes = api.iterate('/r/c | /r/a', doc);
            rotate();
            return ids(nodes);
        }
    ],
    [
        'a function throws, then a new evaluation after the DOM changed',
        (api) => {
            const { doc, rotate } = fixture();
            const boom = (): never => {
                throw new Error('x');
            };
            try {
                api.parseSelect('(/r/c|/r/a)[boom((/r/c|/r/a)[1])]', { node: doc, functions: { boom } });
            } catch {
                // expected
            }
            rotate();
            return ids(api.select('/r/c | /r/a', doc));
        }
    ],
    [
        'held node-set, a member removed and appended, then sorted',
        (api) => {
            const { doc, root } = fixture();
            const first = api.evaluateNodeSet('/r/*', { node: doc });
            api.evaluateNodeSet('/r/*', { node: doc }).toArray();
            const a = root.firstChild;
            call(root, 'removeChild', a);
            call(root, 'appendChild', a);
            return ids(first.toArray());
        }
    ],
    [
        'variable resolver function mutates the DOM',
        (api) => {
            const { doc, rotate } = fixture();
            const variables = (name: string): unknown => {
                if (name === 'v') rotate();
                return 1;
            };
            return ids(api.parseSelect('(/r/c | /r/a)[$v] | (/r/b | /r/a)[$w]', { node: doc, variables }));
        }
    ]
];

let differences = 0;
for (const [name, run] of scenarios) {
    const [expected, actual] = [oracle, candidate].map((api) => {
        try {
            return run(api);
        } catch (error) {
            return `ERR ${errorText(error)}`;
        }
    });
    if (expected !== actual) differences++;
    console.log(
        `${expected === actual ? 'same' : 'DIFF'}  ${name}: upstream=${expected ?? ''}${expected === actual ? '' : `  candidate=${actual ?? ''}`}`
    );
}
console.log(`${scenarios.length} scenarios, ${differences} differences (candidate ${candidateSpec()})`);
process.exitCode = differences === 0 ? 0 : 1;
