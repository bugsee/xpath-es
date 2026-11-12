// What the default limits are measured against: the most work (in the engine's units, what the budget counts) one
// evaluation takes while samlify and xml-crypto check a signed login response, and what each hostile document of the gate
// costs. DEFAULT_BUDGET in src/program.ts is chosen from these numbers (README, "Limits").
//
//   npm run fixtures && node bench/limits.ts

import { createRequire } from 'node:module';
import { CASES } from './hostile-cases.ts';
import { readFixtures } from './saml-fixtures.ts';
import { call, loadDom } from '../test/harness.ts';
import { DEFAULT_BUDGET, DEFAULT_TIMEOUT_MS, XPathProgram, select } from '../src/index.ts';

const require = createRequire(import.meta.url);

let most = 0;
let where = '';
type Raw = ReturnType<XPathProgram['runRaw']>;
const isRaw = (value: unknown): value is Raw =>
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    typeof value.state === 'object' &&
    value.state !== null &&
    'work' in value.state;
const original: unknown = Reflect.get(XPathProgram.prototype, 'runRaw');
if (typeof original !== 'function') throw new Error('XPathProgram has no runRaw');
XPathProgram.prototype.runRaw = function runRaw(this: XPathProgram, options): Raw {
    const result: unknown = Reflect.apply(original, this, [options]);
    if (!isRaw(result)) throw new Error('runRaw did not return a result');
    if (result.state.work > most) {
        most = result.state.work;
        where = this.source.slice(0, 70);
    }
    return result;
};

// samlify and xml-crypto load `xpath`: give them this engine.
const file = require.resolve('xpath');
require(file);
const entry = require.cache[file];
if (entry === undefined) throw new Error('the xpath module is not in the require cache');
entry.exports = await import('../src/index.ts');

const saml: unknown = require('samlify');
call(saml, 'setSchemaValidator', { validate: (): Promise<string> => Promise.resolve('ok') });
const fixtures = readFixtures();
const idp = call(saml, 'IdentityProvider', { metadata: fixtures.idpMetadata });
const sp = call(saml, 'ServiceProvider', { metadata: fixtures.spMetadata });
console.log(`DEFAULT_BUDGET ${DEFAULT_BUDGET} units, DEFAULT_TIMEOUT_MS ${DEFAULT_TIMEOUT_MS} ms\n`);
console.log('| signed SAML login response | most work in one evaluation | the budget is |');
console.log('|---|---:|---:|');
for (const [name, body] of [
    ['4 KiB', fixtures.small],
    ['1,000 groups, 82 KiB', fixtures.large],
    ['2,000 groups, 161 KiB', fixtures.groups2000]
] as const) {
    most = 0;
    await call(sp, 'parseLoginResponse', idp, 'post', { body: { SAMLResponse: body } });
    console.log(
        `| ${name} | ${most} (${where.replace(/\|/g, '/')}) | ${Math.round(DEFAULT_BUDGET / most)} times that |`
    );
}

console.log('\n| hostile document (256 KiB at most) | units | the budget is |');
console.log('|---|---:|---:|');
const parse = loadDom('xmldom08');
let largest = 0;
for (const item of CASES) {
    if (item.engineOnly === true || item.namespaces !== undefined) continue;
    most = 0;
    select(item.expression, parse(item.xml()), false, { budget: 0, timeoutMs: 0 });
    largest = Math.max(largest, most);
    console.log(`| ${item.name} | ${most} | ${Math.round(DEFAULT_BUDGET / Math.max(most, 1))} times that |`);
}
console.log(`\nthe largest: ${largest} units; the budget is ${Math.round(DEFAULT_BUDGET / largest)} times that`);
