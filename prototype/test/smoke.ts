// Fixed-corpus differential check: every expression on every context node, upstream vs the prototype.
// usage: node test/smoke.ts [dom]

import { XPathProgram } from '../src/program.ts';
import * as candidate from '../src/compat.ts';
import type { DomNode } from '../src/dom.ts';
import { allNodes, describe, errorText, isDomName, loadDom, loadXPath, UPSTREAM_PATH } from './harness.ts';
import { CORPUS } from './corpus.ts';

XPathProgram.forceSlowPath = process.env['SLOW'] === '1';
const domName = process.argv[2] ?? 'xmldom08';
if (!isDomName(domName)) throw new Error(`unknown DOM ${domName}`);
const parse = loadDom(domName);
const upstream = loadXPath(UPSTREAM_PATH);

const DOCS = [
    '<r xmlns:p="urn:p" xmlns:q="urn:q" k="1"><a id="1"><b>x</b><a id="2" ID="9"><b>y</b></a></a><c> 12 </c><a id="3"/><e></e><!--c--><?pi d?><p:d p:z="3">t<![CDATA[cd]]>u</p:d></r>',
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1"><saml:Issuer>i</saml:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="c14n"/><ds:SignatureMethod Algorithm="rsa"/><ds:Reference URI="#_r1"/></ds:SignedInfo><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature><samlp:Status><samlp:StatusCode Value="ok"><samlp:StatusCode Value="inner"/></samlp:StatusCode></samlp:Status><saml:Assertion ID="_a1"><saml:Issuer>i</saml:Issuer><saml:Subject><saml:NameID>u@x</saml:NameID><saml:SubjectConfirmation><saml:SubjectConfirmationData><saml:Assertion ID="_evil"/></saml:SubjectConfirmationData></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="1" NotOnOrAfter="2"><saml:AudienceRestriction><saml:Audience>aud</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="t" SessionIndex="s"/><saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>a@b</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>g1</saml:AttributeValue><saml:AttributeValue>g2</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>'
];

// A difference is put in the first class that fits:
//   message   both engines throw, with different wording
//   order     same members, different order (upstream's order comes from the DOM's compareDocumentPosition)
//   mixed     different members, and one side holds an attribute or a namespace node (or upstream threw on one)
//   result    anything else: different members among tree nodes, or one side throws
type Kind = 'message' | 'order' | 'mixed' | 'result';
const counts: Record<Kind, number> = { message: 0, order: 0, mixed: 0, result: 0 };
let comparisons = 0;
const seen = new Set<string>();
const members = (text: string): string[] => (text.startsWith('[') ? text.slice(1, -1).split(',').sort() : [text]);

for (const xml of DOCS) {
    const doc = parse(xml);
    const nodes = allNodes(doc);
    const index = new Map<unknown, number>(nodes.map((node, i) => [node, i]));
    const special = new Set<string>();
    nodes.forEach((node, i) => {
        if (node.nodeType === 2) special.add(String(i));
    });
    const hasSpecial = (text: string): boolean => text.includes('ns:') || members(text).some((item) => special.has(item));
    for (const expression of CORPUS) {
        for (const node of nodes) {
            const run = (select: (e: string, n: DomNode) => unknown): string => {
                try {
                    return describe(select(expression, node), index);
                } catch (error) {
                    return `ERR ${errorText(error)}`;
                }
            };
            const expected = run((e, n) => upstream.select(e, n));
            const actual = run((e, n) => candidate.select(e, n));
            comparisons++;
            if (expected === actual) continue;
            const upstreamThrew = expected.startsWith('ERR');
            const candidateThrew = actual.startsWith('ERR');
            let kind: Kind = 'result';
            if (upstreamThrew && candidateThrew) kind = 'message';
            else if (!upstreamThrew && !candidateThrew && members(expected).join() === members(actual).join()) kind = 'order';
            else if (hasSpecial(expected) || hasSpecial(actual) || node.nodeType === 2) kind = 'mixed';
            counts[kind]++;
            const key = `${kind} ${expression}`;
            if (seen.has(key) || seen.size > 40) continue;
            seen.add(key);
            console.log(`${kind.toUpperCase().padEnd(8)} ${expression}  @${index.get(node) ?? '?'} ${node.nodeName}\n   upstream:  ${expected.slice(0, 150)}\n   candidate: ${actual.slice(0, 150)}`);
        }
    }
}
console.log(
    `${domName}: ${CORPUS.length} expressions, ${comparisons} comparisons; differences: result ${counts.result}, mixed-kind sets ${counts.mixed}, order-only ${counts.order}, error-message-only ${counts.message}`
);
process.exitCode = counts.result === 0 ? 0 : 1;
