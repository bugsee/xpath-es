// Builds the legitimate SAML documents the benchmarks use, the way scratchpad/research/common.js does: a signed
// login response from samlify's own IdP, once small (2 attributes, about 4 KiB) and once with 1,000 group values
// (about 83 KiB). Written to results/ so that every engine is measured on the same bytes.
//
//   node bench/saml-fixtures.ts
//
// The responses are valid for one hour (their NotOnOrAfter); rebuild them before a later run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { call, SCRATCH } from '../test/harness.ts';

const require = createRequire(import.meta.url);
export const FIXTURE_DIR: string = path.resolve(import.meta.dirname, '../results/saml');

export interface Fixtures {
    readonly idpMetadata: string;
    readonly spMetadata: string;
    readonly small: string;
    readonly large: string;
}

export function readFixtures(): Fixtures {
    const read = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    return { idpMetadata: read('idp-metadata.xml'), spMetadata: read('sp-metadata.xml'), small: read('response-small.b64'), large: read('response-1000-groups.b64') };
}

function member(owner: unknown, name: string): unknown {
    return (typeof owner === 'object' || typeof owner === 'function') && owner !== null ? Reflect.get(owner, name) : undefined;
}

function text(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('expected a string');
    return value;
}

async function build(): Promise<void> {
    const common: unknown = require(path.join(SCRATCH, 'research/common.js'));
    const saml = member(common, 'saml');
    const samlUtils = member(common, 'samlUtils');
    call(saml, 'setSchemaValidator', { validate: (): Promise<string> => Promise.resolve('ok') });
    const keys = await call(samlUtils, 'generateSigningInfo', { organization: 'IdP', hash: 'sha256' });
    const idp = call(common, 'buildIdp', keys);
    const spMetadata = text(call(common, 'spMetadata', member(keys, 'certificate')));
    const sp = call(saml, 'ServiceProvider', { metadata: spMetadata, nameIDFormat: member(common, 'NAMEID_EMAIL') });
    const user = { email: 'user@example.test', name: 'Test User' };
    const small = text(await call(common, 'signedResponse', idp, sp, user, {}));
    const large = text(await call(common, 'signedResponse', idp, sp, user, { groups: 1000 }));
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path.join(FIXTURE_DIR, 'idp-metadata.xml'), text(call(idp, 'getMetadata')));
    writeFileSync(path.join(FIXTURE_DIR, 'sp-metadata.xml'), spMetadata);
    writeFileSync(path.join(FIXTURE_DIR, 'response-small.b64'), small);
    writeFileSync(path.join(FIXTURE_DIR, 'response-1000-groups.b64'), large);
    const size = (b64: string): string => `${(Buffer.from(b64, 'base64').length / 1024).toFixed(1)} KiB`;
    console.log(`fixtures in ${FIXTURE_DIR}: small ${size(small)}, 1,000 groups ${size(large)}`);
}

if (process.argv[1] === import.meta.filename) await build();
