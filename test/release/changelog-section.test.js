'use strict';
// changelog-section.test.js — the release workflow takes a GitHub Release body from CHANGELOG.md
// (src/release/changelog-section.ts) instead of `--generate-notes`, which listed nothing for a
// repository that merges locally. A missing or empty section must fail rather than publish an
// empty Release, and 1.2.1 must never match the 1.2.10 section.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changelogSection } = require('../../src/release/changelog-section.ts');
const { tempDir } = require('../helper/tmp');

const SCRIPT = path.resolve(__dirname, '../../src/release/changelog-section.ts');

const CHANGELOG = `# Changelog

## [Unreleased]

## [2.0.0-beta.1] - 2026-10-12

### Added
- prerelease body

## [1.2.10] - 2026-09-04

### Fixed
- the ten fix

## [1.2.1] - 2026-09-03

### Fixed
- the one fix

## [1.2.0]

### Added
- no-date heading body

## [1.1.0] - 2026-08-24

## [1.0.0] - 2026-08-21

### Added
- last section body
`;

function run(t, args, text = CHANGELOG) {
  const dir = tempDir(t, 'doflow-clsec-');
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, text);
  return spawnSync(process.execPath, [SCRIPT, ...args(file)], { encoding: 'utf8' });
}

test('a middle section is returned trimmed, bounded by the next heading', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.1'), '### Fixed\n- the one fix');
});

test('a leading v on the version is accepted', () => {
  assert.equal(changelogSection(CHANGELOG, 'v1.2.1'), '### Fixed\n- the one fix');
});

test('the last section runs to the end of the file', () => {
  assert.equal(changelogSection(CHANGELOG, '1.0.0'), '### Added\n- last section body');
});

test('a prerelease version resolves to its own section', () => {
  assert.equal(changelogSection(CHANGELOG, 'v2.0.0-beta.1'), '### Added\n- prerelease body');
});

test('a heading without a date still matches', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.0'), '### Added\n- no-date heading body');
});

test('1.2.1 does not match the 1.2.10 section, and 1.2.10 does not match 1.2.1', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.1'), '### Fixed\n- the one fix');
  assert.equal(changelogSection(CHANGELOG, '1.2.10'), '### Fixed\n- the ten fix');
  assert.equal(changelogSection(CHANGELOG, '1.2'), null);
});

test('an absent version and an empty section both return null', () => {
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), null);
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), null);
  assert.equal(changelogSection(CHANGELOG, '2.0.0-beta'), null);
});

test('CLI prints the section on stdout and exits 0', (t) => {
  const r = run(t, (file) => ['v1.2.1', file]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '### Fixed\n- the one fix\n');
});

test('CLI exits 1 with a one-line reason when the section is absent', (t) => {
  const r = run(t, (file) => ['v9.9.9', file]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no non-empty CHANGELOG section for 9\.9\.9/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('CLI exits 1 when the section is empty', (t) => {
  const r = run(t, (file) => ['1.1.0', file]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('CLI exits 1 when no version is given', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});
