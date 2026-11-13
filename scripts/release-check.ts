// The checks a release has to pass before anything is published, in one place so that the workflow and a person run the
// same ones.
//
//   node scripts/release-check.ts v1.2.3            the tag against package.json and CHANGELOG.md; prints the npm dist-tag
//   node scripts/release-check.ts --notes 1.2.3     the CHANGELOG section of a version (the release notes)
//   node scripts/release-check.ts --prepublish      what `npm publish` from a working tree runs (prepublishOnly): refuses
//                                                   anything that is not the release workflow
//
// With GITHUB_OUTPUT set, `version` and `dist_tag` are also written for the workflow's later steps.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export interface ReleaseFacts {
    readonly version: string;
    readonly distTag: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `v1.2.3` or `v1.2.3-rc.1` to the version; anything else (a branch-like tag, a build suffix, a leading zero) is refused. */
export function versionOfTag(tag: string): string {
    if (!tag.startsWith('v')) throw new Error(`the tag "${tag}" does not start with v`);
    const version = tag.slice(1);
    const match = SEMVER.exec(version);
    if (match === null) throw new Error(`the tag "${tag}" is not v<major>.<minor>.<patch>[-<prerelease>]`);
    // Semantic Versioning: no leading zeros in the three numbers, nor in a prerelease identifier that is all digits
    // (1.2.3-rc.01 is not a version; npm would read the manifest and publish something else than the tag says).
    const numbers = [match[1], match[2], match[3], ...(match[4] ?? '').split('.').filter((part) => /^\d+$/.test(part))];
    for (const part of numbers)
        if (part !== undefined && part.length > 1 && part.startsWith('0'))
            throw new Error(`the tag "${tag}" has a number with a leading zero`);
    return version;
}

/** A release is `latest`; a prerelease (1.0.0-rc.1) is published under the dist-tag `next`, never `latest`. */
export function distTagOf(version: string): string {
    return SEMVER.exec(version)?.[4] === undefined ? 'latest' : 'next';
}

/** The CHANGELOG section of a version: the text under `## [version]` up to the next `## `; null if there is none. */
export function changelogSection(changelog: string, version: string): string | null {
    const lines = changelog.split('\n');
    const heading = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    if (heading === -1) return null;
    const rest = lines.slice(heading + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

interface PackageFields {
    readonly name: unknown;
    readonly version: unknown;
    readonly private: unknown;
}

function readPackage(): PackageFields {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('package.json is not an object');
    return {
        name: Reflect.get(parsed, 'name'),
        version: Reflect.get(parsed, 'version'),
        private: Reflect.get(parsed, 'private')
    };
}

/** Everything that must hold for the tag to be released; throws with the first reason it cannot be. */
export function checkRelease(tag: string, pkg: PackageFields, changelog: string): ReleaseFacts {
    const version = versionOfTag(tag);
    if (pkg.name !== 'xpath-es') throw new Error(`package.json names "${String(pkg.name)}", not xpath-es`);
    if (pkg.private === true) throw new Error('package.json is private: true');
    if (pkg.version !== version) throw new Error(`the tag is ${version} and package.json says ${String(pkg.version)}`);
    if (version === '0.0.0') throw new Error('0.0.0 is a placeholder, not a release');
    const section = changelogSection(changelog, version);
    if (section === null) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
    if (section === '') throw new Error(`the CHANGELOG.md section of ${version} is empty`);
    return { version, distTag: distTagOf(version) };
}

function main(argv: readonly string[]): void {
    if (argv[0] === '--prepublish') {
        // `npm publish` in a working tree would put whatever is on the disk on the registry. Only the release workflow
        // (a tag on GitHub Actions) may; it publishes the tarball its earlier job made and checked.
        if (process.env['GITHUB_ACTIONS'] !== 'true' || process.env['GITHUB_REF_TYPE'] !== 'tag')
            throw new Error('publish only from the release workflow (see RELEASING.md), not from a working tree');
        checkRelease(
            process.env['GITHUB_REF_NAME'] ?? '',
            readPackage(),
            readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
        );
        return;
    }
    if (argv[0] === '--notes') {
        // The release notes: the CHANGELOG section of the version, on standard output.
        const version = argv[1];
        const section =
            version === undefined
                ? null
                : changelogSection(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
        if (section === null || section === '') throw new Error('no CHANGELOG.md section for that version');
        console.log(section);
        return;
    }
    const tag = argv[0];
    if (tag === undefined) throw new Error('usage: node scripts/release-check.ts v<version>');
    const facts = checkRelease(tag, readPackage(), readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
    console.log(`release ${facts.version}, npm dist-tag ${facts.distTag}`);
    const output = process.env['GITHUB_OUTPUT'];
    if (output !== undefined) appendFileSync(output, `version=${facts.version}\ndist_tag=${facts.distTag}\n`);
}

if (process.argv[1] === import.meta.filename) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(`release check failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
