// A TypeScript consumer of the ES module entry, with the DOM library (a browser) and no Node typings.
import { select, parse, XPathProgram, XPathBudgetError, XPathError, DEFAULT_BUDGET } from 'xpath-es';
import type { EvaluateOptions, SelectReturnType } from 'xpath-es';

const doc: Document = new DOMParser().parseFromString('<a><b/></a>', 'text/xml');
const found: SelectReturnType = select('//b', doc);
const options: EvaluateOptions = { node: doc, budget: DEFAULT_BUDGET, timeoutMs: 1000 };
const program = new XPathProgram('count(//b)');
const { value } = program.run(options);
const nodes = parse('//b').select({ node: doc });
const typed: number = nodes.length;

try {
    program.run({ node: doc, budget: 1 });
} catch (error) {
    if (error instanceof XPathBudgetError && error instanceof XPathError) console.log(error.code);
}

export { found, value, typed };
