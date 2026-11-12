// A TypeScript consumer of the CommonJS entry (resolved through the "require" condition to index.d.cts).
import { select, XPathProgram, XPathSyntaxError } from 'xpath-es';

const doc: Document = new DOMParser().parseFromString('<a/>', 'text/xml');
const result = select('//a', doc);
let rejected = false;
try {
    new XPathProgram('//[');
} catch (error) {
    rejected = error instanceof XPathSyntaxError;
}

export = { result, rejected };
