// Builds the legitimate SAML documents the benchmarks use: a signed login response from samlify's own identity
// provider, once small (two attributes, about 4 KiB) and once with 1,000 group values (about 83 KiB). The keys and
// the certificate are generated here (RSA 2048, self-signed, fake issuer); nothing real is involved. Written to
// results/saml so that every engine is measured on the same bytes.
//
//   node bench/saml-fixtures.ts
//
// The responses are valid for one hour (their NotOnOrAfter); rebuild them before a later run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { call, member } from '../test/harness.ts';

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
    return {
        idpMetadata: read('idp-metadata.xml'),
        spMetadata: read('sp-metadata.xml'),
        small: read('response-small.b64'),
        large: read('response-1000-groups.b64')
    };
}

function text(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('expected a string');
    return value;
}

const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const IDP_ENTITY_ID = 'https://idp.test/entity';
const ENTITY = 'https://sp.test/entity';
const ACS = 'https://sp.test/acs';
const GROUP_CLAIM = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';

interface KeyPair {
    readonly certificate: string;
    readonly privateKey: string;
}

/** A self-signed certificate and its private key, made with node-forge. */
function generateKeys(): KeyPair {
    const forge: unknown = require('node-forge');
    const pki = member(forge, 'pki');
    const rsa = member(pki, 'rsa');
    const keypair = call(rsa, 'generateKeyPair', { bits: 2048, e: 0x10001 });
    const cert = call(pki, 'createCertificate');
    Reflect.set(Object(cert), 'publicKey', member(keypair, 'publicKey'));
    Reflect.set(Object(cert), 'serialNumber', '01');
    const validity = member(cert, 'validity');
    Reflect.set(Object(validity), 'notBefore', new Date());
    Reflect.set(Object(validity), 'notAfter', new Date(Date.now() + 5 * 86_400_000));
    const subject = [{ name: 'commonName', value: 'xpath-es test identity provider' }];
    call(cert, 'setSubject', subject);
    call(cert, 'setIssuer', subject);
    const md = call(member(member(forge, 'md'), 'sha256'), 'create');
    call(cert, 'sign', member(keypair, 'privateKey'), md);
    return {
        certificate: text(call(pki, 'certificateToPem', cert)),
        privateKey: text(call(pki, 'privateKeyToPem', member(keypair, 'privateKey')))
    };
}

function stripPem(pem: string): string {
    return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

function spMetadataXml(certificate: string): string {
    return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${ENTITY}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${stripPem(certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleLogoutService Binding="${POST_BINDING}" Location="https://sp.test/sls"/>
    <md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="${POST_BINDING}" Location="${ACS}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

const attribute = (name: string, valueTag: string): Record<string, string> => ({
    name,
    valueTag,
    nameFormat: BASIC,
    valueXsiType: 'xs:string',
    valueXmlnsXs: 'http://www.w3.org/2001/XMLSchema',
    valueXmlnsXsi: 'http://www.w3.org/2001/XMLSchema-instance'
});

async function signedResponse(saml: unknown, idp: unknown, sp: unknown, groups: number): Promise<string> {
    const now = Date.now();
    const user = { email: 'user@example.test', name: 'Test User' };
    const build = (template: string): { readonly id: string; readonly context: string } => {
        const id = `_${Math.random().toString(16).slice(2)}${now}`;
        const instant = new Date(now).toISOString();
        let filled = template.replace(
            '{AuthnStatement}',
            `<saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${id}_s"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
        );
        if (groups > 0) {
            const values = Array.from(
                { length: groups },
                (_, i) =>
                    `<saml:AttributeValue>${(i + 0x1000).toString(16)}fad5b-d9cb-469f-a165-70867728950e</saml:AttributeValue>`
            );
            filled = filled.replace(
                '</saml:AttributeStatement>',
                `<saml:Attribute Name="${GROUP_CLAIM}">${values.join('')}</saml:Attribute></saml:AttributeStatement>`
            );
        }
        const context = call(member(saml, 'SamlLib'), 'replaceTagsByValue', filled, {
            ID: id,
            AssertionID: `_a${id}`,
            Destination: ACS,
            Audience: ENTITY,
            EntityID: ENTITY,
            SubjectRecipient: ACS,
            AssertionConsumerServiceURL: ACS,
            Issuer: IDP_ENTITY_ID,
            NameIDFormat: NAMEID_EMAIL,
            NameID: user.email,
            InResponseTo: '_request-1',
            StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
            IssueInstant: instant,
            ConditionsNotBefore: new Date(now - 60_000).toISOString(),
            ConditionsNotOnOrAfter: new Date(now + 3_600_000).toISOString(),
            SubjectConfirmationDataNotOnOrAfter: new Date(now + 3_600_000).toISOString(),
            attrEmail: user.email,
            attrName: user.name
        });
        return { id, context: text(context) };
    };
    const created = await call(
        idp,
        'createLoginResponse',
        sp,
        { extract: { request: { id: '_request-1' } } },
        'post',
        user,
        build
    );
    return text(member(created, 'context'));
}

async function build(): Promise<void> {
    const saml: unknown = require('samlify');
    call(saml, 'setSchemaValidator', { validate: (): Promise<string> => Promise.resolve('ok') });
    const keys = generateKeys();
    const idp = call(saml, 'IdentityProvider', {
        entityID: IDP_ENTITY_ID,
        signingCert: keys.certificate,
        privateKey: keys.privateKey,
        isAssertionEncrypted: false,
        nameIDFormat: [NAMEID_EMAIL],
        singleSignOnService: [
            { Binding: POST_BINDING, Location: 'https://idp.test/sso' },
            { Binding: REDIRECT_BINDING, Location: 'https://idp.test/sso' }
        ],
        singleLogoutService: [
            { Binding: POST_BINDING, Location: 'https://idp.test/slo' },
            { Binding: REDIRECT_BINDING, Location: 'https://idp.test/slo' }
        ],
        wantAuthnRequestsSigned: false,
        loginResponseTemplate: {
            context: member(member(member(saml, 'SamlLib'), 'defaultLoginResponseTemplate'), 'context'),
            attributes: [attribute('mail', 'email'), attribute('displayName', 'name')]
        }
    });
    const spMetadata = spMetadataXml(keys.certificate);
    const sp = call(saml, 'ServiceProvider', { metadata: spMetadata, nameIDFormat: NAMEID_EMAIL });
    const small = await signedResponse(saml, idp, sp, 0);
    const large = await signedResponse(saml, idp, sp, 1000);
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path.join(FIXTURE_DIR, 'idp-metadata.xml'), text(call(idp, 'getMetadata')));
    writeFileSync(path.join(FIXTURE_DIR, 'sp-metadata.xml'), spMetadata);
    writeFileSync(path.join(FIXTURE_DIR, 'response-small.b64'), small);
    writeFileSync(path.join(FIXTURE_DIR, 'response-1000-groups.b64'), large);
    const size = (b64: string): string => `${(Buffer.from(b64, 'base64').length / 1024).toFixed(1)} KiB`;
    console.log(
        `fixtures in ${path.relative(process.cwd(), FIXTURE_DIR)}: small ${size(small)}, 1,000 groups ${size(large)}`
    );
}

if (process.argv[1] === import.meta.filename) await build();
