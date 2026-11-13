// The release checks: the tag, the version in package.json, the CHANGELOG section, the npm dist-tag.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogSection, checkRelease, distTagOf, versionOfTag } from '../../scripts/release-check.ts';

const CHANGELOG = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- not yet',
    '',
    '## [1.2.3] - 2026-12-01',
    '',
    '- a change',
    '',
    '## [1.2.3-rc.1] - 2026-11-20',
    '',
    '## [1.2.2] - 2026-11-01',
    '',
    '- older',
    ''
].join('\n');
const PACKAGE = { name: 'xpath-es', version: '1.2.3', private: undefined };

void test('a tag is v<major>.<minor>.<patch>[-<prerelease>] and nothing else', () => {
    assert.equal(versionOfTag('v1.2.3'), '1.2.3');
    assert.equal(versionOfTag('v1.2.3-rc.1'), '1.2.3-rc.1');
    assert.equal(versionOfTag('v1.2.3-rc.0'), '1.2.3-rc.0');
    assert.equal(versionOfTag('v1.2.3-0a'), '1.2.3-0a'); // not all digits: leading zero allowed
    for (const tag of [
        '1.2.3',
        'v1.2',
        'v1.2.3+build',
        'v01.2.3',
        'v1.2.3-01',
        'v1.2.3-rc.01',
        'v1.2.3-',
        'vx',
        'v1.2.3 ',
        'refs/tags/v1.2.3',
        ''
    ])
        assert.throws(() => versionOfTag(tag), Error, tag);
});

void test('a prerelease is published under next, a release under latest', () => {
    assert.equal(distTagOf('1.2.3'), 'latest');
    assert.equal(distTagOf('1.2.3-rc.1'), 'next');
    assert.equal(distTagOf('0.1.0-beta'), 'next');
});

void test('the CHANGELOG section is found by its version, and only that one', () => {
    assert.equal(changelogSection(CHANGELOG, '1.2.3'), '- a change');
    assert.equal(changelogSection(CHANGELOG, '1.2.2'), '- older');
    assert.equal(changelogSection(CHANGELOG, '1.2.3-rc.1'), '');
    assert.equal(changelogSection(CHANGELOG, '9.9.9'), null);
});

void test('a release needs a matching version, a CHANGELOG section with text, a public package, and is not 0.0.0', () => {
    assert.deepEqual(checkRelease('v1.2.3', PACKAGE, CHANGELOG), { version: '1.2.3', distTag: 'latest' });
    assert.throws(() => checkRelease('v1.2.4', { ...PACKAGE, version: '1.2.4' }, CHANGELOG), /CHANGELOG/);
    assert.throws(() => checkRelease('v1.2.3', { ...PACKAGE, version: '1.2.2' }, CHANGELOG), /package\.json says/);
    assert.throws(() => checkRelease('v1.2.3', { ...PACKAGE, private: true }, CHANGELOG), /private/);
    assert.throws(() => checkRelease('v1.2.3', { ...PACKAGE, name: 'other' }, CHANGELOG), /xpath-es/);
    assert.throws(() => checkRelease('v1.2.3-rc.1', { ...PACKAGE, version: '1.2.3-rc.1' }, CHANGELOG), /empty/);
    assert.throws(() => checkRelease('v0.0.0', { ...PACKAGE, version: '0.0.0' }, '## [0.0.0]\n\n- x\n'), /placeholder/);
});
