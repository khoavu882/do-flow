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
const { changelogSection, releaseNotesBody, NOTES_CAP } = require('../../src/release/changelog-section.ts');
const { tempDir } = require('../helper/tmp.ts');

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

function run(t: any, args: any, text = CHANGELOG) {
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
  const r = run(t, (file: any) => ['v1.2.1', file]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '### Fixed\n- the one fix\n');
});

test('CLI exits 1 with a one-line reason when the section is absent', (t) => {
  const r = run(t, (file: any) => ['v9.9.9', file]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no non-empty CHANGELOG section for 9\.9\.9/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('CLI exits 1 when the section is empty', (t) => {
  const r = run(t, (file: any) => ['1.1.0', file]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('CLI exits 1 when no version is given', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

// ── releaseNotesBody: a section over GitHub's body limit is shortened, never refused ─────────────
const REPO = 'https://github.com/example/repo';
const LINK = 'Full notes: https://github.com/example/repo/blob/v9.0.0/CHANGELOG.md';
const body = (section: string, cap?: number): string => releaseNotesBody(section, 'v9.0.0', { repository: REPO, ...(cap ? { cap } : {}) });

// A section of `headings` headings with `entries` bullets each; every bullet has a long first line
// and a continuation line, a code span and a link near the 300-character cut.
function bigSection(headings: number, entries: number, firstLine = 700): string {
  const out: string[] = [];
  for (let h = 0; h < headings; h++) {
    out.push(`### Heading ${h}`, '');
    for (let e = 0; e < entries; e++) {
      const head = `- **Entry ${h}.${e}:** `;
      out.push(`${head}${'word '.repeat(Math.ceil(firstLine / 5))}`.trimEnd(), `  continuation ${h}.${e} that must not survive`, '');
    }
  }
  return out.join('\n').trim();
}

test('a section under the cap is returned unchanged, byte for byte', () => {
  const section = '### Fixed\n- the one fix\n  with a continuation\n\n### Added\n- another';
  assert.equal(body(section), section);
  assert.equal(body(section, section.length + 1), section);
});

test('the cap counts the newline the CLI prints after the body: a section one under it is kept, one at it is shortened', () => {
  const entries = (n: number) => `### A\n${'- filler line\n'.repeat(n)}`.trim();
  const section = entries(20);
  assert.equal(body(section, section.length + 1), section);
  const shortened = body(section, section.length);
  assert.notEqual(shortened, section);
  assert.ok(shortened.length + 1 <= section.length, `${shortened.length}`);
});

test('a section over the cap keeps every heading and every entry first line, with the link, under the cap', () => {
  const section = bigSection(4, 50); // about 140,000 characters
  assert.ok(section.length > 125000, `fixture is ${section.length}`);
  const out = body(section);
  assert.ok(out.length <= NOTES_CAP, `body is ${out.length}`);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('### ')), ['### Heading 0', '### Heading 1', '### Heading 2', '### Heading 3']);
  assert.equal(out.split('\n').filter((l) => l.startsWith('- **Entry ')).length, 200);
  assert.ok(out.includes('- **Entry 3.49:** word word'));
  assert.ok(!out.includes('continuation'));
  assert.ok(out.endsWith(`\n\n${LINK}`));
  assert.ok(!/more entr/.test(out));
});

test('a first line over 300 characters ends in an ellipsis; a shorter one is untouched', () => {
  const out = body(`### A\n- short one\n- ${'x '.repeat(400)}`, 700);
  const [, short, long] = out.split('\n');
  assert.equal(short, '- short one');
  assert.ok(long.endsWith('…') && long.length <= 301, `${long.length}`);
});

test('a cut never lands inside a link or a code span', () => {
  const link = '[the link text with spaces](https://example.com/a/very/long/path)';
  const span = '`a code span with spaces`';
  for (const middle of [link, span]) {
    for (let pad = 250; pad < 300; pad += 7) {
      const line = `- ${'a'.repeat(pad)} ${middle} ${'tail '.repeat(40)}`;
      const out = body(`### A\n${line}\n${'- filler\n'.repeat(20000)}`.trim());
      const kept = out.split('\n')[1];
      assert.ok(kept.endsWith('…'));
      const text = kept.slice(0, -1);
      assert.ok(text.includes(middle) || !text.includes(middle.slice(0, 6)), `cut inside ${middle}: ${kept.slice(-60)}`);
      assert.equal((text.match(/`/g) || []).length % 2, 0);
    }
  }
});

test('a link or code span right after the bullet is kept whole, so the entry keeps visible text', () => {
  const spans = [
    `[${'link text '.repeat(40)}](https://example.com/a)`,
    `\`${'code '.repeat(80)}\``,
    `**[${'link text '.repeat(40)}](https://example.com/a)**`,
  ];
  for (const span of spans) {
    for (const tail of [' and more words', '', ' ' + 'tail '.repeat(40)]) {
      const line = `- ${span}${tail}`;
      const out = body(`### A\n${line}\n${'- filler\n'.repeat(20000)}`.trim());
      const kept = out.split('\n')[1];
      assert.notEqual(kept, '-…');
      assert.ok(kept.startsWith('- ') && kept.includes(span.replace(/^\*\*/, '').replace(/\*\*$/, '')), kept.slice(0, 40));
      assert.ok(kept.endsWith('…') || kept === line, kept.slice(-40));
      assert.equal((kept.match(/`/g) || []).length % 2, 0);
      assert.equal((kept.match(/\*\*/g) || []).length % 2, 0);
    }
  }
  // A short link at the start with room to spare is not cut at the space before it.
  const short = body(`### A\n- [a](https://e.com) ${'word '.repeat(100)}\n${'- filler\n'.repeat(20000)}`.trim());
  assert.match(short.split('\n')[1], /^- \[a\]\(https:\/\/e\.com\) word/);
});

test('a bold title cut mid-way is closed, and a code span with ** inside does not count', () => {
  const cut = (line: string) => body(`### A\n${line}\n${'- filler\n'.repeat(20000)}`.trim()).split('\n')[1];
  const open = cut(`- **${'bold title '.repeat(40)}**: the rest`);
  assert.match(open, /^- \*\*bold title .*\*\*…$/);
  assert.equal((open.match(/\*\*/g) || []).length % 2, 0);
  const whole = cut(`- **short title:** ${'word '.repeat(80)}`);
  assert.match(whole, /^- \*\*short title:\*\* word .*[a-z]…$/);
  const withSpan = cut(`- **a \`**\` ${'bold title '.repeat(40)}**: the rest`);
  assert.match(withSpan, /^- \*\*a `\*\*` bold title .*\*\*…$/);
});

test('only a bare ** that opens at a word boundary is closed: not 2**10 or ***x, and an open _ inside it is closed too', () => {
  const cut = (line: string) => body(`### A\n${line}\n${'- filler\n'.repeat(20000)}`.trim()).split('\n')[1];
  const words = 'word '.repeat(80);
  const power = cut(`- 2**10 is ${words}`);
  assert.match(power, /^- 2\*\*10 is word .*word…$/);
  const triple = cut(`- ***x ${words}`);
  assert.match(triple, /^- \*\*\*x word .*word…$/);
  const italic = cut(`- **_${'title '.repeat(60)}_** rest`);
  assert.match(italic, /^- \*\*_title .*title_\*\*…$/);
  const closedItalic = cut(`- **_short_ ${words}`);
  assert.match(closedItalic, /^- \*\*_short_ word .*word\*\*…$/);
  for (const out of [italic, closedItalic]) assert.equal((out.match(/_/g) || []).length % 2, 0, out);
});

test('a fenced block and its stray heading lines are dropped, so no fence is left open', () => {
  const out = body(`### A\n\`\`\`\n### not a heading\n\`\`\`\n- kept\n${'- filler line\n'.repeat(20000)}`.trim(), 5000);
  assert.ok(!out.includes('not a heading') && !out.includes('```'));
  assert.ok(out.includes('- kept'));
});

test('an extreme section drops entries from the end of the longest headings and says how many', () => {
  const section = bigSection(3, 400, 400); // 1,200 entries, 600 characters each after the first-line cut
  const out = body(section);
  assert.ok(out.length <= NOTES_CAP, `body is ${out.length}`);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('### ')), ['### Heading 0', '### Heading 1', '### Heading 2']);
  const markers = out.split('\n').filter((l) => l.startsWith('- … and '));
  assert.equal(markers.length, 3);
  const shown = out.split('\n').filter((l) => l.startsWith('- **Entry '));
  const left = markers.reduce((sum, l) => sum + Number(l.match(/and (\d+) more/)![1]), 0);
  assert.equal(shown.length + left, 1200);
  assert.ok(shown.some((l) => l.startsWith('- **Entry 0.0:')) && !shown.some((l) => l.startsWith('- **Entry 0.399:')));
  const perHeading = markers.map((l) => Number(l.match(/and (\d+) more/)![1]));
  assert.ok(Math.max(...perHeading) - Math.min(...perHeading) <= 1, perHeading.join());
  assert.ok(out.endsWith(`\n\n${LINK}`));
});

test('a cap too small for any entry keeps the headings and says the entries were omitted', () => {
  const out = body(bigSection(2, 5), 140);
  assert.equal(out, `### Heading 0\n### Heading 1\n\n(entries omitted)\n\n${LINK}`);
  assert.ok(out.length + 1 <= 140);
  assert.ok(!/- /.test(out.replace(LINK, '')), 'no entry survives');
});

test('a cap too small for the headings too leaves the link alone', () => {
  assert.equal(body(bigSection(2, 5), 100), LINK);
});

test('the link is built from the package.json of the given repoRoot', (t) => {
  const root = tempDir(t, 'doflow-clsec-root-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ repository: { url: 'git+https://github.com/other/place.git' } }));
  const out = releaseNotesBody(bigSection(1, 400), 'v3.0.0', { repoRoot: root });
  assert.ok(out.endsWith('\n\nFull notes: https://github.com/other/place/blob/v3.0.0/CHANGELOG.md'), out.slice(-120));
});

test('the link is built from the package.json repository when none is given, and a missing v is added', () => {
  const out = releaseNotesBody(bigSection(1, 400), '2.5.0');
  assert.match(out, /\nFull notes: https:\/\/github\.com\/khoavu882\/do-flow\/blob\/v2\.5\.0\/CHANGELOG\.md$/);
});

test('CLI prints the shortened body of an oversized section and exits 0', (t) => {
  const text = `# Changelog\n\n## [9.0.0] - 2026-01-01\n\n${bigSection(4, 50)}\n\n## [8.0.0]\n\n### Added\n- old\n`;
  const r = run(t, (file: any) => ['v9.0.0', file], text);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length <= NOTES_CAP + 1);
  assert.match(r.stdout, /### Heading 3\n/);
  assert.match(r.stdout, /Full notes: https:\/\/github\.com\/khoavu882\/do-flow\/blob\/v9\.0\.0\/CHANGELOG\.md\n$/);
});
