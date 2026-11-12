// Strict mode must not regress: on every expression whose answer does not depend on a deviation that upstream mode
// inherits from upstream (the deviations are listed in the README), strict mode and upstream mode must agree, node for
// node and error class for error class, on random documents. An expression that uses a deviating feature (the following
// and preceding axes, id(), lang(), number conversions of node-sets, string() of numbers, substring(), string-length(),
// the attribute and namespace axes' wildcards, names with an upper-case letter (upstream mode matches names without regard to case)) is excluded by text, and
// MODE_AGREEMENT_ALL=1 turns the exclusion off, which must then find differences (the harness self-test checks that).
//
//   node test/mode-agreement.ts [documents] [expressions per document] [seed]

import { CORPUS } from './corpus.ts';
import { documentText, makeExpressionGenerator } from './generate.ts';
import { allNodes, describe, errorText, loadDom, makeRandom } from './harness.ts';
import { select, XPathError } from '../src/index.ts';

const documents = Number(process.argv[2] ?? 60);
const perDocument = Number(process.argv[3] ?? 120);
const random = makeRandom(Number(process.argv[4] ?? 91));
const everything = process.env['MODE_AGREEMENT_ALL'] === '1';
const nextExpression = makeExpressionGenerator(random, { namespaceAxis: false });
const parse = loadDom('xmldom08');

const DEVIATING = [
    /following::/,
    /preceding::/,
    /\bid\(/,
    /\blang\(/,
    /\b(number|floor|ceiling|round|string|substring|string-length|translate|normalize-space|sum)\(/,
    /@\*/,
    /attribute::\*/,
    /namespace::/,
    /[A-Z]/,
    /\b(?!(?:child|descendant|descendant-or-self|parent|ancestor|ancestor-or-self|following-sibling|preceding-sibling|attribute|self)::)[a-z-]+::/,
    /(?:^|[\s([,|=<>!])-\S/,
    / (\+|-|\*|div|mod) /,
    /(^|[^A-Za-z0-9_.)\]'"])\* /,
    /node\(\)/
];
const deviates = (expression: string): boolean => DEVIATING.some((pattern) => pattern.test(expression));

function outcome(mode: 'upstream' | 'strict', expression: string, xml: string): string {
    const doc = parse(xml);
    const index = new Map<unknown, number>(allNodes(doc).map((node, i) => [node, i]));
    try {
        return describe(select(expression, doc, false, { mode }), index);
    } catch (error) {
        return error instanceof XPathError ? `ERR ${error.code}` : `ERR other ${errorText(error)}`;
    }
}

let compared = 0;
let skipped = 0;
let differences = 0;
const shown: string[] = [];
const corpus = CORPUS.slice();
for (let d = 0; d < documents; d++) {
    const xml = documentText(random);
    const expressions = [...Array.from({ length: perDocument }, () => nextExpression()), ...corpus.splice(0, 8)];
    for (const expression of expressions) {
        if (!everything && deviates(expression)) {
            skipped++;
            continue;
        }
        compared++;
        const a = outcome('upstream', expression, xml);
        const b = outcome('strict', expression, xml);
        if (a === b) continue;
        differences++;
        if (shown.length < 8)
            shown.push(`${expression}\n     upstream mode: ${a.slice(0, 120)}\n     strict mode:   ${b.slice(0, 120)}`);
    }
}
console.log(`mode agreement: ${compared} comparisons, ${skipped} excluded as deviating, ${differences} differences`);
for (const sample of shown) console.log(`  ${sample}`);
process.exitCode = differences === 0 ? 0 : 1;
