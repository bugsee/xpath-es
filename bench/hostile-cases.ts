// The hostile documents: shapes that make a naive XPath engine superlinear (upstream xpath 0.0.36 is quadratic or
// worse on most of them), each with the expression that exposes it. Used by the gate (test/hostile.ts) and by the
// benchmark table (bench/hostile.ts). Every document is built on demand, so nothing is stored.

export const KiB = 1024;
export const fit = (pre: string, unit: string, post: string, bytes: number): string =>
    pre + unit.repeat(Math.floor((bytes - pre.length - post.length) / unit.length)) + post;

export interface Case {
    readonly name: string;
    readonly expression: string;
    readonly xml: () => string;
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
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB)
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
        xml: () => fit('<r><g>', '<a/>', '</g></r>', 256 * KiB)
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
        xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB)
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
            `<r ${Array.from({ length: 3000 }, (_, i) => `xmlns:n${i}="urn:n${i}"`).join(' ')}>${'<n7:a x="1"/>'.repeat(20000)}</r>`
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
    }
];
