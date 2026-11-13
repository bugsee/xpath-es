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
import { useNamespaces, XPathError } from '../src/index.ts';

const documents = Number(process.argv[2] ?? 60);
const perDocument = Number(process.argv[3] ?? 120);
const random = makeRandom(Number(process.argv[4] ?? 91));
const everything = process.env['MODE_AGREEMENT_ALL'] === '1';
const nextExpression = makeExpressionGenerator(random, { namespaceAxis: false });
const parse = loadDom('xmldom08');

// The prefixes the expressions use: both modes resolve them. (A prefix nobody declares is an error up front in strict mode and
// only when a node is tested in upstream mode, section 2.3: test/unit/modes.test.ts pins that.)
const NAMESPACES = { p: 'urn:p', q: 'urn:q', u: 'urn:u' };

const DEVIATING = [
    // The axes whose set semantics differ (Q-AXIS-3, Q-AXIS-4).
    /following::/,
    /preceding::/,
    // id() of a node-set (string-values against serialisations), lang(), and the conversions of strings and node-sets
    // to numbers and of numbers to strings.
    /\bid\((?!['"])/,
    /\bid\(""|id\(''/,
    // `$and` and the like (Q-LEX-1).
    /\$(?:and|or|mod|div)\b/,
    /\blang\(/,
    /\b(number|substring|sum)\(/,
    // local-name() of a node that has no expanded name (strict: empty; upstream: `#text`, `#document`).
    /\blocal-name\(/,
    // Arithmetic on a node-set (strict: an empty node-set is NaN), and `-` that may be a minus.
    / (\+|-|\*|div|mod) /,
    /(?:^|[\s([,|=<>!])-\S/,
    /(^|[^A-Za-z0-9_.)\]'"])\* /,
    // Lexical forms upstream rejects (Q-LEX-1, -3, -4): white space before `(` or `::`, `1.`, `,` before `*`.
    /[A-Za-z]\s+\(|\s::|\d\.(?!\d)|,\s*\*/,
    // The wildcards of the attribute and namespace axes (strict leaves out namespace declarations), names with an upper-case
    // letter (upstream mode matches names without regard to case), unknown axes, a `-` that may be a minus.
    /@\*/,
    /attribute::\*/,
    /namespace::/,
    /[A-Z]/,
    // Text runs and the XML declaration (strict: one text node for Text and CDATA siblings), node() (strict accepts
    // namespace nodes and fragments), and the principal node type (`self::*` of an attribute).
    /text\(\)/,
    /node\(\)/,
    /(?:^|[^.\d])\.(?![.\d])/,
    /(?:@|attribute::)[^|\]]*(?:self|-or-self|parent|ancestor)::\*/
];
/** An axis name that is not one of the thirteen: a syntax error in strict mode, an empty axis in upstream mode (Q-AXIS-5). */
const UNKNOWN_AXIS =
    /(?<![\w-])(?!(?:child|descendant|descendant-or-self|parent|ancestor|ancestor-or-self|following-sibling|preceding-sibling|attribute|self|following|preceding|namespace)::)[a-z][a-z-]*::/;
let unknownAxes = 0;
let unknownAxesRefused = 0;
const excludedBy = new Map<string, number>();
/**
 * A relational operator in the expression, other than a test of the position (`position() < 3`, `last() >= 2`): its operands
 * may be a boolean and a node-set, which the Recommendation compares as booleans in both orders and upstream (Q-CMP-1) does
 * not, when the boolean is on the left.
 */
const relational = (expression: string): boolean =>
    /[<>]/.test(expression.replace(/(?:position|last)\(\)\s*[<>]=?\s*\d+/g, ''));

const deviates = (expression: string): boolean => {
    if (relational(expression)) {
        excludedBy.set('relational operator', (excludedBy.get('relational operator') ?? 0) + 1);
        return true;
    }
    // Not a comparison but a check: strict mode refuses an unknown axis name.
    if (UNKNOWN_AXIS.test(expression)) {
        unknownAxes++;
        if (outcome('strict', expression, '<r/>') === 'ERR SYNTAX') unknownAxesRefused++;
        return true;
    }
    const found = DEVIATING.find((pattern) => pattern.test(expression));
    if (found !== undefined) excludedBy.set(String(found), (excludedBy.get(String(found)) ?? 0) + 1);
    return found !== undefined;
};

function outcome(mode: 'upstream' | 'strict', expression: string, xml: string): string {
    const doc = parse(xml);
    const index = new Map<unknown, number>(allNodes(doc).map((node, i) => [node, i]));
    try {
        return describe(useNamespaces(NAMESPACES, { mode })(expression, doc), index);
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
    // Upstream mode matches names without regard to case, so a document must not hold names that differ only in case (the
    // generator's `ID` attribute next to its `id`): the case deviation is checked in test/unit/modes.test.ts.
    const xml = documentText(random).replaceAll(' ID="I1"', '');
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
console.log(
    `mode agreement: ${compared} comparisons, ${skipped} excluded as deviating, ${differences} differences; ${unknownAxes} expressions with an unknown axis name, ${unknownAxesRefused} refused as a syntax error by strict mode`
);
if (process.env['MODE_AGREEMENT_WHY'] === '1')
    for (const [pattern, count] of [...excludedBy].sort((a, b) => b[1] - a[1])) console.log(`  ${count}\t${pattern}`);
for (const sample of shown) console.log(`  ${sample}`);
process.exitCode = differences === 0 && unknownAxes === unknownAxesRefused ? 0 : 1;
