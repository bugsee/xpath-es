// The hostile documents: shapes that make a naive XPath engine superlinear (upstream xpath 0.0.36 is quadratic or
// worse on most of them), each with the expression that exposes it. Used by the gate (test/hostile.ts) and by the
// benchmark table (bench/hostile.ts). Every document is built on demand, so nothing is stored.

import type { DomNode } from '../test/support/dom.ts';

export const KiB = 1024;
export const fit = (pre: string, unit: string, post: string, bytes: number): string =>
    pre + unit.repeat(Math.floor((bytes - pre.length - post.length) / unit.length)) + post;

export interface Case {
    readonly name: string;
    readonly expression: string;
    readonly xml: () => string;
    /** A namespace resolver for the evaluation (useNamespaces): the prefixes the expression uses. */
    readonly namespaces?: Readonly<Record<string, string>>;
    /**
     * `answer` (the default): the engine must give the oracle's answer. `refuse`: the answer is a result nobody should be
     * made to build (a limit of the engine's, documented in the README): the engine must stop with a typed limit, budget
     * or timeout error within the bound; the oracle's answer is still recorded, so the case shows what was refused.
     */
    readonly expect?: 'answer' | 'refuse';
    /**
     * What the answer is, derived from the document by plain DOM code and never by an XPath engine. It stands in for the
     * oracle on a case upstream cannot finish (nested predicates are cubic in upstream), and is checked against the oracle
     * wherever the oracle does finish (test/hostile-digests.ts). Nodes, or a number, string or boolean.
     */
    readonly reference?: (doc: DomNode) => unknown;
    /**
     * The answer under the XPath 1.0 Recommendation (strict mode) where it differs from upstream's, derived the same way
     * (plain DOM code, from the text of section 2.2 and 5). The gate uses it instead of the oracle's digest for a
     * candidate run in strict mode (CANDIDATE_MODE=strict); it is recorded in baselines/strict-digests.json.
     */
    readonly strictReference?: (doc: DomNode) => unknown;
    /** Added with the engine's limits: not run for a candidate that has none (upstream xpath). */
    readonly engineOnly?: boolean;
}

/** The element children of a node, by plain DOM walking (the references below must not use an XPath engine). */
export function elementChildren(node: DomNode | null | undefined): DomNode[] {
    const out: DomNode[] = [];
    for (let child = node?.firstChild; child != null; child = child.nextSibling)
        if (child.nodeType === 1) out.push(child);
    return out;
}
function firstElementChild(node: DomNode | null | undefined): DomNode | null {
    return elementChildren(node)[0] ?? null;
}
/** Every element of a tree in document order, by plain DOM walking. */
export function allElements(root: DomNode | null | undefined): DomNode[] {
    const out: DomNode[] = [];
    const visit = (node: DomNode): void => {
        if (node.nodeType === 1) out.push(node);
        for (let child = node.firstChild; child != null; child = child.nextSibling) visit(child);
    };
    if (root != null) visit(root);
    return out;
}
const interleaved = (bytes: number): string => fit('<r>', '<a/><b/><c x="1"/>', '</r>', bytes);

export const CASES: readonly Case[] = [
    { name: '65k <a/> siblings', expression: '//*', xml: () => fit('<r>', '<a/>', '</r>', 256 * KiB) },
    { name: 'cousins: 23k <a><b/></a>', expression: '//*', xml: () => fit('<r>', '<a><b/></a>', '</r>', 256 * KiB) },
    {
        name: 'one element, 30k attributes (xml-crypto ID lookup)',
        expression: "//*[@*[local-name(.)='ID']='x']",
        xml: () => `<r ${Array.from({ length: 30000 }, (_, i) => `a${i}="1"`).join(' ')}/>`
    },
    {
        name: 'one element, 30k attributes, all selected',
        expression: '//@*',
        xml: () => `<r ${Array.from({ length: 30000 }, (_, i) => `a${i}="1"`).join(' ')}/>`
    },
    {
        name: '23k <a ID="y"/>, all attributes',
        expression: '//@*',
        xml: () => fit('<r>', '<a ID="y"/>', '</r>', 256 * KiB)
    },
    { name: 'chain 9,000 deep', expression: '//*', xml: () => '<a>'.repeat(9000) + '</a>'.repeat(9000) },
    {
        name: 'chain 9,000 deep, ancestors of all',
        expression: '//*/ancestor::*',
        xml: () => '<a>'.repeat(9000) + '</a>'.repeat(9000)
    },
    {
        name: '8k siblings, nearest preceding sibling',
        expression: '//a/preceding-sibling::*[1]',
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB),
        // Every child but the last is the nearest preceding sibling of the one after it.
        reference: (doc) => elementChildren(doc.documentElement).slice(0, -1)
    },
    {
        name: '8k siblings, all following siblings',
        expression: '//a/following-sibling::*',
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB)
    },
    {
        name: '8k siblings, count(preceding-sibling)',
        expression: '/*/*/*[count(preceding-sibling::*)=3]',
        xml: () => fit('<r><g>', '<a/>', '</g></r>', 32 * KiB)
    },
    {
        name: '65k siblings, count(preceding-sibling)',
        expression: '/*/*/*[count(preceding-sibling::*)=3]',
        xml: () => fit('<r><g>', '<a/>', '</g></r>', 256 * KiB),
        // The element with three siblings before it is the fourth child of g.
        reference: (doc) => elementChildren(firstElementChild(doc.documentElement)).slice(3, 4)
    },
    {
        name: '8k siblings, position() = last()',
        expression: '/*/*[position() = last()]',
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB)
    },
    { name: 'union of 3 sets, 14k each', expression: '//a | //b | //c', xml: () => interleaved(256 * KiB) },
    { name: 'union elements + attributes', expression: '//* | //@*', xml: () => interleaved(256 * KiB) },
    {
        name: 'union of the same 65k set twice',
        expression: '//a | //a',
        xml: () => fit('<r>', '<a/>', '</r>', 256 * KiB)
    },
    {
        name: '8k siblings, following of all',
        expression: '//a/following::*',
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB)
    },
    {
        name: '8k siblings, preceding of all',
        expression: '//a/preceding::*',
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB),
        // Section 2.2: the preceding nodes of an `a` are the earlier `a`s; the root is an ancestor, so it is not among them
        // (upstream's axis contains the ancestors, and its answer holds the root as well).
        strictReference: (doc) => elementChildren(doc.documentElement).slice(0, -1)
    },
    {
        name: '6k elements, each its own namespace',
        expression: "//*[namespace-uri()='urn:n5']",
        xml: () => `<r>${Array.from({ length: 6000 }, (_, i) => `<n${i}:a xmlns:n${i}="urn:n${i}"/>`).join('')}</r>`
    },
    {
        name: 'root with 3,000 namespace declarations, 20k children',
        expression: '//*/@*',
        xml: () =>
            `<r ${Array.from({ length: 3000 }, (_, i) => `xmlns:n${i}="urn:n${i}"`).join(' ')}>${'<n7:a x="1"/>'.repeat(20000)}</r>`,
        // Section 5.3: a namespace declaration is not an attribute of its element. The 3,000 declarations on the root, which
        // upstream returns as attributes, are not in the answer: only the `x` of each child is.
        strictReference: (doc) =>
            elementChildren(doc.documentElement).flatMap((element) => {
                const out: DomNode[] = [];
                for (let i = 0; i < (element.attributes?.length ?? 0); i++) {
                    const attribute = element.attributes?.item(i);
                    if (attribute != null && !String(attribute.name).startsWith('xmlns')) out.push(attribute);
                }
                return out;
            })
    },
    {
        name: 'samlify assertion-signature path, 7k <Assertion><Signature/></Assertion>',
        expression:
            "/*[contains(local-name(), 'Response') or contains(local-name(), 'Request')]/*[local-name(.)='Assertion']/*[local-name(.)='Signature']",
        xml: () => fit('<Response>', '<Assertion><Signature/></Assertion>', '</Response>', 256 * KiB)
    },
    {
        name: 'samlify wrapping check, 9k nested <Assertion/> in SubjectConfirmationData',
        expression:
            "/*[contains(local-name(), 'Response')]/*[local-name(.)='Assertion']/*[local-name(.)='Subject']/*[local-name(.)='SubjectConfirmation']/*[local-name(.)='SubjectConfirmationData']//*[local-name(.)='Assertion' or local-name(.)='Signature']",
        xml: () =>
            fit(
                '<Response><Assertion><Subject><SubjectConfirmation><SubjectConfirmationData>',
                '<Assertion><Signature/></Assertion>',
                '</SubjectConfirmationData></SubjectConfirmation></Subject></Assertion></Response>',
                256 * KiB
            )
    },
    // ---- Added with the engine's limits and its resolver and id() paths (review findings). The oracle answers or the
    // reference does; a candidate without limits is not judged on them (engineOnly). ----
    {
        name: 'resolver: 20k <a:x><a:y/><a:y/></a:x>, string(a:y) predicate',
        expression: '//a:x[string(a:y)="q"]',
        namespaces: { a: 'urn:x' },
        xml: () => `<r xmlns:a="urn:x">${'<a:x><a:y/><a:y/></a:x>'.repeat(20_000)}</r>`,
        reference: () => [],
        engineOnly: true
    },
    {
        name: 'resolver: 20k <a:x><a:y/><a:y/></a:x>, all selected by a positional predicate',
        expression: '//a:x[a:y[2]]',
        namespaces: { a: 'urn:x' },
        xml: () => `<r xmlns:a="urn:x">${'<a:x><a:y/><a:y/></a:x>'.repeat(20_000)}</r>`,
        reference: (doc) => elementChildren(doc.documentElement),
        engineOnly: true
    },
    {
        name: 'id(): 10,000 tokens that exist, 50k elements',
        expression: `id("${Array.from({ length: 10_000 }, (_, i) => `i${i}`).join(' ')}")`,
        xml: () => `<r>${Array.from({ length: 50_000 }, (_, i) => `<e id="i${i}"/>`).join('')}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, 10_000),
        engineOnly: true
    },
    {
        name: 'id(): 10,000 tokens that do not exist, 50k elements',
        expression: `id("${Array.from({ length: 10_000 }, (_, i) => `zz${i}`).join(' ')}")`,
        xml: () => `<r>${Array.from({ length: 50_000 }, (_, i) => `<e id="i${i}"/>`).join('')}</r>`,
        reference: () => [],
        engineOnly: true
    },
    {
        name: 'id(): 40,000 tokens (more than id() takes), 50k elements',
        expression: `id("${Array.from({ length: 40_000 }, (_, i) => `i${i}`).join(' ')}")`,
        xml: () => `<r>${Array.from({ length: 50_000 }, (_, i) => `<e id="i${i}"/>`).join('')}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, 40_000),
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'id(node-set): the text of 5,000 elements',
        expression: 'id(//t/text())',
        xml: () =>
            `<r>${Array.from({ length: 5000 }, (_, i) => `<e id="i${i}"/>`).join('')}${Array.from({ length: 5000 }, (_, i) => `<t>i${i}</t>`).join('')}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, 5000),
        engineOnly: true
    },
    {
        name: 'id(node-set): a chain 5,000 deep (every serialisation holds the chain below it)',
        expression: 'id(//*)',
        xml: () => '<a>'.repeat(5000) + '</a>'.repeat(5000),
        reference: () => [],
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'namespace axis: 4,000 nested elements, a new prefix at every level (8 million nodes)',
        expression: 'count(//namespace::*)',
        xml: () => {
            let open = '';
            let close = '';
            for (let i = 0; i < 4000; i++) {
                open += `<n${i} xmlns:p${i}="u${i}">`;
                close = `</n${i}>${close}`;
            }
            return open + close;
        },
        // Level d (1-based) has d declarations and xml in scope.
        reference: () => (4000 * 4001) / 2 + 4000,
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'nested predicates //a[//a[//a[//a]]], 3,000 <a><b/></a>',
        expression: '//a[//a[//a[//a]]]',
        xml: () => `<r>${'<a><b/></a>'.repeat(3000)}</r>`,
        reference: (doc) => elementChildren(doc.documentElement),
        engineOnly: true
    },
    {
        name: 'nested predicates with count(), 3,000 <a><b/></a>',
        expression: '//*[count(//*)>0][count(//*[count(//*)>0])>0]',
        xml: () => `<r>${'<a><b/></a>'.repeat(3000)}</r>`,
        reference: (doc) => allElements(doc.documentElement),
        engineOnly: true
    },
    {
        name: 'preceding::a[1] from every one of 3,000 <a><b/></a>',
        expression: '//a/preceding::a[1]',
        xml: () => `<r>${'<a><b/></a>'.repeat(3000)}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, -1),
        engineOnly: true
    },
    {
        name: '50k siblings, preceding-sibling::a[last()]',
        expression: '//a/preceding-sibling::a[last()]',
        xml: () => `<r>${'<a/>'.repeat(50_000)}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, 1),
        engineOnly: true
    },
    {
        name: 'a union of 1,500 operands over 2,000 elements',
        expression: Array.from({ length: 1500 }, (_, i) => `/r/e${i}`).join('|'),
        xml: () => `<r>${Array.from({ length: 2000 }, (_, i) => `<e${i}/>`).join('')}</r>`,
        reference: (doc) => elementChildren(doc.documentElement).slice(0, 1500),
        engineOnly: true
    },
    {
        name: 'a union of 20,000 operands over 2,000 elements (40 million units: more than the budget)',
        expression: Array.from({ length: 20_000 }, (_, i) => `/r/e${i % 2000}`).join('|'),
        xml: () => `<r>${Array.from({ length: 2000 }, (_, i) => `<e${i}/>`).join('')}</r>`,
        reference: (doc) => elementChildren(doc.documentElement),
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'strings: contains() of a 1M-character attribute and a 500k-character one that is not in it',
        expression: 'contains(/r/@a,/r/@b)',
        xml: () => `<r a="${'a'.repeat(1_000_000)}" b="${'a'.repeat(500_000)}b"/>`,
        reference: () => false,
        engineOnly: true
    },
    {
        name: 'strings: concat() doubling a 1M-character string eight times (256 million characters)',
        expression: ((): string => {
            let doubled = 'string(/r/@a)';
            for (let i = 0; i < 8; i++) doubled = `concat(${doubled},${doubled})`;
            return `string-length(${doubled})`;
        })(),
        xml: () => `<r a="${'a'.repeat(1_000_000)}"/>`,
        reference: () => 256_000_000,
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'strings: translate() and normalize-space() of a 1M-character attribute',
        expression: 'string-length(normalize-space(translate(/r/@a,"a","b")))',
        xml: () => `<r a="${'a'.repeat(1_000_000)}"/>`,
        reference: () => 1_000_000,
        engineOnly: true
    },
    // ---- cost that is in the expression, not in the document: nothing here walks the tree much, every predicate and
    // operand is evaluated for every node (the work limit must count them, and the clock must not wait for a count) ----
    {
        name: 'expression cost: 2,000 predicates [1=1] on //*, 65k elements (130 million evaluations)',
        expression: `//*${'[1=1]'.repeat(2000)}`,
        xml: () => fit('<r>', '<a/>', '</r>', 256 * KiB),
        reference: (doc) => allElements(doc.documentElement),
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'expression cost: a 20,000-operand `0 or 0 or ...` evaluated for each of 20k elements',
        expression: `//*[${Array.from({ length: 20_000 }, () => '0').join(' or ')}]`,
        xml: () => fit('<r>', '<a/>', '</r>', 80 * KiB),
        reference: () => [],
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'expression cost: a 20,000-term sum `1+1+...=0` evaluated for each of 20k elements',
        expression: `//*[${Array.from({ length: 20_000 }, () => '1').join('+')}=0]`,
        xml: () => fit('<r>', '<a/>', '</r>', 80 * KiB),
        reference: () => [],
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: 'expression cost: 20,000 calls of contains() on short strings for each of 20k elements',
        expression: `//*[${Array.from({ length: 20_000 }, () => "contains('a','b')").join(' or ')}]`,
        xml: () => fit('<r>', '<a/>', '</r>', 80 * KiB),
        reference: () => [],
        expect: 'refuse',
        engineOnly: true
    },
    {
        name: "id('x') in a predicate over 50k elements (a DOM that walks the document for each call)",
        expression: "//*[id('x')]",
        xml: () => `<r>${'<a/>'.repeat(50_000)}</r>`,
        reference: () => [],
        engineOnly: true
    }
];
