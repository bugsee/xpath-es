// End to end, through samlify and xml-crypto: signature-wrapping attacks and other tampering with a signed SAML login
// response, each decided by upstream xpath and by the candidate, which must agree on accept or reject and, when the
// response is accepted, on every extracted value. The responses are synthetic: they are made from the fixture the
// benchmarks build (`npm run fixtures`: a throwaway key and fake .test names), never from customer data.
//
// A wrapping attack works when the verifier checks the signature of one element and reads the data of another. A
// candidate that selected a different node than upstream (a different XPath answer) could change which one is read, so
// an exact match with upstream on all of these is part of the adoption gate. The check is also an oracle in its own right:
// the unmodified response must be accepted, and every tampered response below must be rejected or must extract the
// signed (original) identity: an extraction of the forged identity by BOTH engines is reported as a verifier defect.
//
//   node bench/saml-wrapping.ts            table; exit 1 on any disagreement
//   node bench/saml-wrapping.ts --one <upstream|candidate>     JSON on stdout (used by the table)

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { call, errorText, loadCandidateModule } from '../test/harness.ts';
import { readFixtures } from './saml-fixtures.ts';

const require = createRequire(import.meta.url);
const FORGED = 'attacker@example.test';

interface Variant {
    readonly name: string;
    readonly build: (xml: string) => string;
}

function parts(xml: string): { readonly assertion: string; readonly signature: string; readonly id: string } {
    const assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)?.[0];
    const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(assertion ?? '')?.[0];
    const id = /<saml:Assertion[^>]* ID="([^"]+)"/.exec(xml)?.[1];
    if (assertion === undefined || signature === undefined || id === undefined)
        throw new Error('the fixture is not the shape this check expects');
    return { assertion, signature, id };
}

/** The signed assertion with its signature removed and the identity replaced: what an attacker wants read. */
const forged = (xml: string, withId?: string): string => {
    const { assertion, signature, id } = parts(xml);
    const evil = assertion.replace(signature, '').replace(/(<saml:NameID[^>]*>)[^<]*/, `$1${FORGED}`);
    return withId === undefined ? evil.replace(id, `${id}_evil`) : evil.replace(id, withId);
};

const VARIANTS: readonly Variant[] = [
    { name: 'unmodified', build: (xml) => xml },
    {
        name: 'forged assertion before the signed one',
        build: (xml) => xml.replace(parts(xml).assertion, `${forged(xml)}${parts(xml).assertion}`)
    },
    {
        name: 'forged assertion after the signed one',
        build: (xml) => xml.replace(parts(xml).assertion, `${parts(xml).assertion}${forged(xml)}`)
    },
    {
        name: "forged assertion with the signed one's ID, first, unsigned",
        build: (xml) => xml.replace(parts(xml).assertion, `${forged(xml, parts(xml).id)}${parts(xml).assertion}`)
    },
    {
        name: 'signed assertion moved into Extensions, forged one in its place',
        build: (xml) =>
            xml.replace(
                parts(xml).assertion,
                `<samlp:Extensions>${parts(xml).assertion}</samlp:Extensions>${forged(xml)}`
            )
    },
    {
        name: 'signed assertion wrapped in the Advice of a forged one',
        build: (xml) =>
            xml.replace(
                parts(xml).assertion,
                forged(xml).replace(
                    '</saml:Issuer>',
                    `</saml:Issuer><saml:Advice>${parts(xml).assertion}</saml:Advice>`
                )
            )
    },
    {
        name: 'the identity changed, the signature kept',
        build: (xml) => xml.replace(/(<saml:NameID[^>]*>)[^<]*/, `$1${FORGED}`)
    },
    {
        name: 'the issue instant changed, the signature kept',
        build: (xml) => xml.replace(/(<saml:Assertion[^>]* IssueInstant=")[^"]+/, '$12000-01-01T00:00:00.000Z')
    },
    {
        name: 'ID attribute renamed, so the reference resolves to nothing',
        build: (xml) => xml.replace(/(<saml:Assertion[^>]*) ID="/, '$1 Id="')
    },
    { name: 'signature dropped', build: (xml) => xml.replace(parts(xml).signature, '') },
    {
        name: 'signature moved out of the assertion into the response',
        build: (xml) =>
            xml
                .replace(parts(xml).signature, '')
                .replace('</saml:Issuer><samlp:Status>', `</saml:Issuer>${parts(xml).signature}<samlp:Status>`)
    },
    {
        name: 'signature duplicated inside the assertion',
        build: (xml) => xml.replace(parts(xml).signature, `${parts(xml).signature}${parts(xml).signature}`)
    },
    {
        name: "two elements with the signed assertion's ID (the forged one inside the response)",
        build: (xml) => xml.replace('<samlp:Status>', `<saml:Extension ID="${parts(xml).id}"/><samlp:Status>`)
    },
    {
        name: 'assertion wrapped in an extra element',
        build: (xml) => xml.replace(parts(xml).assertion, `<saml:Wrapper>${parts(xml).assertion}</saml:Wrapper>`)
    }
];

interface Outcome {
    readonly name: string;
    readonly accepted: boolean;
    readonly detail: string;
}

async function runOne(mode: 'upstream' | 'candidate'): Promise<Outcome[]> {
    if (mode === 'candidate') {
        const file = require.resolve('xpath');
        require(file);
        const entry = require.cache[file];
        if (entry === undefined) throw new Error('the xpath module is not in the require cache');
        entry.exports = loadCandidateModule();
    }
    const saml: unknown = require('samlify');
    call(saml, 'setSchemaValidator', { validate: (): Promise<string> => Promise.resolve('ok') });
    const fixtures = readFixtures();
    const idp = call(saml, 'IdentityProvider', { metadata: fixtures.idpMetadata });
    const sp = call(saml, 'ServiceProvider', { metadata: fixtures.spMetadata });
    const original = Buffer.from(fixtures.small, 'base64').toString('utf8');
    const outcomes: Outcome[] = [];
    for (const variant of VARIANTS) {
        const body = Buffer.from(variant.build(original), 'utf8').toString('base64');
        try {
            const parsed: unknown = await call(sp, 'parseLoginResponse', idp, 'post', { body: { SAMLResponse: body } });
            const extract: unknown =
                typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'extract') : null;
            outcomes.push({ name: variant.name, accepted: true, detail: JSON.stringify(extract) });
        } catch (error) {
            outcomes.push({ name: variant.name, accepted: false, detail: errorText(error).split('\n')[0] ?? '' });
        }
    }
    return outcomes;
}

function isOutcomeList(value: unknown): value is Outcome[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && 'accepted' in item)
    );
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
    const mode = args[1] === 'candidate' ? 'candidate' : 'upstream';
    console.log(JSON.stringify(await runOne(mode)));
} else {
    const results: Outcome[][] = [];
    for (const mode of ['upstream', 'candidate']) {
        const child = spawnSync(process.execPath, [process.argv[1] ?? '', '--one', mode], {
            encoding: 'utf8',
            timeout: 300_000
        });
        let parsed: unknown = null;
        try {
            const json: unknown = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '');
            parsed = json;
        } catch {
            parsed = null;
        }
        if (!isOutcomeList(parsed)) throw new Error(`${mode} failed:\n${child.stderr.slice(0, 600)}`);
        results.push(parsed);
    }
    const [upstream, candidate] = results;
    let disagreements = 0;
    let rejected = 0;
    let forgedAccepted = 0;
    console.log('| tampering | upstream | candidate | same |');
    console.log('|---|---|---|---|');
    for (const [i, variant] of VARIANTS.entries()) {
        const a = upstream?.[i];
        const b = candidate?.[i];
        if (a === undefined || b === undefined) throw new Error('a result is missing');
        const same = a.accepted === b.accepted && (!a.accepted || a.detail === b.detail);
        if (!same) disagreements++;
        if (variant.name !== 'unmodified' && !a.accepted) rejected++;
        if (variant.name !== 'unmodified' && a.accepted && a.detail.includes(FORGED)) forgedAccepted++;
        console.log(
            `| ${variant.name} | ${a.accepted ? 'accepted' : 'rejected'} | ${b.accepted ? 'accepted' : 'rejected'} | ${same ? 'yes' : 'NO'} |`
        );
    }
    const unmodified = upstream?.[0];
    console.log(
        `\n${VARIANTS.length} responses: ${disagreements} disagreements; ${rejected} tampered responses rejected by upstream; ${forgedAccepted} accepted with the forged identity`
    );
    const sane = unmodified?.accepted === true && rejected >= 5;
    if (!sane)
        console.log(
            'the check is not meaningful: the unmodified response must be accepted and most tampering rejected'
        );
    process.exitCode = disagreements === 0 && sane ? 0 : 1;
}
