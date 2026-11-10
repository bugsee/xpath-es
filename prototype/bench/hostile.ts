// Hostile-document benchmark: upstream 0.0.36, the bugsee fork (0.0.36-bugsee.3) and the xpath-es prototype on the
// shapes that make upstream superlinear. Each (case, engine) runs in its own process with a time limit, straight
// from the TypeScript sources (node >= 22.18, type stripping; no build).
//
//   node bench/hostile.ts                 all cases, table on stdout
//   node bench/hostile.ts --one <engine> <case#>   one measurement, JSON on stdout (used by the driver)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { allNodes, describe, errorText, loadDom, milliseconds } from '../test/harness.ts';
import { ENGINE_NAMES, isEngineName, loadEngine } from './engines.ts';
import type { EngineName } from './engines.ts';

const KiB = 1024;
const TIME_LIMIT_MS = 60_000;
const fit = (pre: string, unit: string, post: string, bytes: number): string =>
    pre + unit.repeat(Math.floor((bytes - pre.length - post.length) / unit.length)) + post;

interface Case {
    readonly name: string;
    readonly expression: string;
    readonly xml: () => string;
}

const interleaved = (bytes: number): string => fit('<r>', '<a/><b/><c x="1"/>', '</r>', bytes);

const CASES: readonly Case[] = [
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
    { name: '23k <a ID="y"/>, all attributes', expression: '//@*', xml: () => fit('<r>', '<a ID="y"/>', '</r>', 256 * KiB) },
    { name: 'chain 9,000 deep', expression: '//*', xml: () => '<a>'.repeat(9000) + '</a>'.repeat(9000) },
    { name: 'chain 9,000 deep, ancestors of all', expression: '//*/ancestor::*', xml: () => '<a>'.repeat(9000) + '</a>'.repeat(9000) },
    { name: '8k siblings, nearest preceding sibling', expression: '//a/preceding-sibling::*[1]', xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB) },
    { name: '8k siblings, all following siblings', expression: '//a/following-sibling::*', xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB) },
    { name: '8k siblings, count(preceding-sibling)', expression: '/*/*/*[count(preceding-sibling::*)=3]', xml: () => fit('<r><g>', '<a/>', '</g></r>', 32 * KiB) },
    { name: '65k siblings, count(preceding-sibling)', expression: '/*/*/*[count(preceding-sibling::*)=3]', xml: () => fit('<r><g>', '<a/>', '</g></r>', 256 * KiB) },
    { name: '8k siblings, position() = last()', expression: '/*/*[position() = last()]', xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB) },
    { name: 'union of 3 sets, 14k each', expression: '//a | //b | //c', xml: () => interleaved(256 * KiB) },
    { name: 'union elements + attributes', expression: '//* | //@*', xml: () => interleaved(256 * KiB) },
    { name: 'union of the same 65k set twice', expression: '//a | //a', xml: () => fit('<r>', '<a/>', '</r>', 256 * KiB) },
    { name: '8k siblings, following of all', expression: '//a/following::*', xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB) },
    { name: '8k siblings, preceding of all', expression: '//a/preceding::*', xml: () => fit('<r>', '<a/>', '</r>', 32 * KiB) },
    {
        name: '6k elements, each its own namespace',
        expression: "//*[namespace-uri()='urn:n5']",
        xml: () => `<r>${Array.from({ length: 6000 }, (_, i) => `<n${i}:a xmlns:n${i}="urn:n${i}"/>`).join('')}</r>`
    },
    {
        name: 'root with 3,000 namespace declarations, 20k children',
        expression: '//*/@*',
        xml: () => `<r ${Array.from({ length: 3000 }, (_, i) => `xmlns:n${i}="urn:n${i}"`).join(' ')}>${'<n7:a x="1"/>'.repeat(20000)}</r>`
    },
    {
        name: 'samlify assertion-signature path, 7k <Assertion><Signature/></Assertion>',
        expression: "/*[contains(local-name(), 'Response') or contains(local-name(), 'Request')]/*[local-name(.)='Assertion']/*[local-name(.)='Signature']",
        xml: () => fit('<Response>', '<Assertion><Signature/></Assertion>', '</Response>', 256 * KiB)
    },
    {
        name: 'samlify wrapping check, 9k nested <Assertion/> in SubjectConfirmationData',
        expression: "/*[contains(local-name(), 'Response')]/*[local-name(.)='Assertion']/*[local-name(.)='Subject']/*[local-name(.)='SubjectConfirmation']/*[local-name(.)='SubjectConfirmationData']//*[local-name(.)='Assertion' or local-name(.)='Signature']",
        xml: () => fit('<Response><Assertion><Subject><SubjectConfirmation><SubjectConfirmationData>', '<Assertion><Signature/></Assertion>', '</SubjectConfirmationData></SubjectConfirmation></Subject></Assertion></Response>', 256 * KiB)
    }
];

interface Measurement {
    readonly ms: number;
    readonly runs: number;
    readonly size: number;
    readonly digest: string;
}

function measureOne(engine: EngineName, at: number): Measurement {
    const item = CASES[at];
    if (item === undefined) throw new Error(`no case ${at}`);
    const doc = loadDom('xmldom08')(item.xml());
    const select = loadEngine(engine);
    const times: number[] = [];
    let result: unknown;
    const once = (): void => {
        times.push(
            milliseconds(() => {
                try {
                    result = select(item.expression, doc);
                } catch (error) {
                    result = `ERR ${errorText(error)}`;
                }
            })
        );
    };
    once();
    // Quick cases are repeated and the median reported; slow ones are measured once.
    if ((times[0] ?? 0) < 2000) for (let i = 0; i < 6; i++) once();
    times.sort((a, b) => a - b);
    const index = new Map<unknown, number>(allNodes(doc).map((node, i) => [node, i]));
    const text = describe(result, index);
    return {
        ms: times[Math.floor(times.length / 2)] ?? 0,
        runs: times.length,
        size: Array.isArray(result) ? result.length : 1,
        digest: createHash('sha256').update(text).digest('hex').slice(0, 12)
    };
}

function isMeasurement(value: unknown): value is Measurement {
    return typeof value === 'object' && value !== null && 'ms' in value && 'digest' in value && 'size' in value && 'runs' in value;
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
    const engine = args[1] ?? '';
    if (!isEngineName(engine)) throw new Error(`unknown engine ${engine}`);
    console.log(JSON.stringify(measureOne(engine, Number(args[2]))));
} else {
    const script = process.argv[1] ?? '';
    // ENGINES=xpath-es limits the table to some engines (for before/after comparisons of the prototype alone).
    const chosen = (process.env['ENGINES'] ?? ENGINE_NAMES.join(',')).split(',').filter(isEngineName);
    const only = args[0] === undefined ? null : Number(args[0]);
    console.log(`| # | case | document | results | ${chosen.join(' | ')} | same result |`);
    console.log(`|---|---|---|---|${chosen.map(() => '---:').join('|')}|---|`);
    CASES.forEach((item, at) => {
        if (only !== null && only !== at) return;
        const cells: string[] = [];
        const digests = new Set<string>();
        let size = '?';
        for (const engine of chosen) {
            const child = spawnSync(process.execPath, [script, '--one', engine, String(at)], { timeout: TIME_LIMIT_MS, encoding: 'utf8' });
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(child.stdout);
            } catch {
                parsed = null;
            }
            if (isMeasurement(parsed)) {
                cells.push(`${parsed.ms < 10 ? parsed.ms.toFixed(2) : parsed.ms.toFixed(0)} ms`);
                digests.add(parsed.digest);
                size = String(parsed.size);
            } else {
                cells.push(child.error === undefined ? 'failed' : `> ${TIME_LIMIT_MS / 1000} s (killed)`);
            }
        }
        const same = digests.size === 1 ? (cells.every((cell) => cell.endsWith('ms')) ? 'yes' : 'yes (of those that finished)') : 'NO';
        console.log(`| ${at} | ${item.name}: \`${item.expression.length > 60 ? `${item.expression.slice(0, 57)}...` : item.expression}\` | ${(item.xml().length / KiB).toFixed(0)} KiB | ${size} | ${cells.join(' | ')} | ${same} |`);
    });
}
