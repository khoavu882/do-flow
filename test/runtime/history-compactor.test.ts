'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { compactHistory, POINTER } = require('../../src/runtime/history-compactor.ts');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'decision-register');
const SLUG = '001-demo';

/** Builds a feature folder holding the named fixtures at the given feature-relative paths. */
function feature(layout: any) {
  const repoRoot = suiteTempDir('doflow-history-compactor-');
  const featureDir = path.join(repoRoot, 'agent-docs', 'doflow', SLUG);
  const paths: any = {};
  for (const [key, [rel, fixture]] of Object.entries(layout)) {
    const file = path.join(featureDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, fixture), file);
    paths[key] = path.relative(repoRoot, file);
  }
  return { repoRoot, featureDir, paths };
}

const read = (file: any) => fs.readFileSync(file, 'utf8');
const DATE = '2026-10-03';

test('a section 9 History moves into the archive and leaves the comment and one pointer', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const original = read(path.join(f.featureDir, 'plan.md'));
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'compacted');
  assert.deepEqual(result.moved, [{ artifact: 'plan.md', path: 'plan.md', archive: 'decisions/history/plan.md', lines: 5 }]);

  const after = read(path.join(f.featureDir, 'plan.md'));
  const history = after.slice(after.indexOf('## 9. History'));
  assert.equal(history, [
    '## 9. History',
    '',
    '<!-- History template: one row per change; detail below. -->',
    '',
    'Earlier entries: [decisions/history/plan.md](decisions/history/plan.md).',
    '',
  ].join('\n'));
  // Everything before the History heading, tombstone rows included, is byte-identical.
  assert.equal(after.slice(0, after.indexOf('## 9. History')), original.slice(0, original.indexOf('## 9. History')));
  assert.match(after, /\| T-003 \| Tombstone — replaced by T-002 \|/);

  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.ok(archive.startsWith('# History archive: plan.md\n'));
  assert.ok(archive.includes(`## Compacted ${DATE} from plan.md §9\n\n| Date | ID | Change | Replaced by |`));
  assert.ok(archive.includes('- **T-001** — said X; changed because Y; now Z.'));
});

test('a section 2 History in specs keeps the section after it and links relative to design/', () => {
  const f = feature({ specs: ['design/specs.md', 'history-2-specs.md'] });
  const original = read(path.join(f.featureDir, 'design', 'specs.md'));
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.moved[0].path, 'design/specs.md');
  const after = read(path.join(f.featureDir, 'design', 'specs.md'));
  assert.ok(after.includes('## 2. History\n\nEarlier entries: [decisions/history/specs.md](../decisions/history/specs.md).\n\n## 3. Notes\n\nNotes stay put.\n'));
  assert.ok(POINTER.test('Earlier entries: [decisions/history/specs.md](../decisions/history/specs.md).'));
  // The tombstone row in the index is untouched.
  assert.ok(after.includes('| IC-001 | old shape | Tombstone — see IC-002 |'));
  assert.equal(after.slice(0, after.indexOf('## 2. History')), original.slice(0, original.indexOf('## 2. History')));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'specs.md'));
  assert.ok(archive.includes(`## Compacted ${DATE} from design/specs.md §2`));
});

test('a section 3 History in the data model drops the initial-version literal once content moves', () => {
  const f = feature({ data_model: ['design/data-model.md', 'history-3-data-model-revised.md'] });
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'compacted');
  const after = read(path.join(f.featureDir, 'design', 'data-model.md'));
  assert.ok(!after.includes('None — initial version.'));
  assert.ok(after.includes('## 3. History\n\nEarlier entries: [decisions/history/data-model.md](../decisions/history/data-model.md).\n'));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'data-model.md'));
  assert.ok(archive.includes('| 2026-08-02 | E-001 | Field renamed | E-002 |'));
  assert.ok(!archive.includes('None — initial version.'));
});

test('an initial-version History, with or without a template comment, is left alone', () => {
  const f = feature({
    data_model: ['design/data-model.md', 'history-3-data-model.md'],
    design: ['design/design.md', 'history-9-initial.md'],
  });
  const before: any = {
    dm: read(path.join(f.featureDir, 'design', 'data-model.md')),
    design: read(path.join(f.featureDir, 'design', 'design.md')),
  };
  const result = compactHistory({ ...f, date: DATE });
  assert.deepEqual(result, { status: 'unchanged', moved: [], failed: [] });
  assert.equal(read(path.join(f.featureDir, 'design', 'data-model.md')), before.dm);
  assert.equal(read(path.join(f.featureDir, 'design', 'design.md')), before.design);
  assert.ok(!fs.existsSync(path.join(f.featureDir, 'decisions')));
});

test('a second run finds nothing to move and changes no byte', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'], specs: ['design/specs.md', 'history-2-specs.md'] });
  compactHistory({ ...f, date: DATE });
  const snapshot: any = [
    read(path.join(f.featureDir, 'plan.md')),
    read(path.join(f.featureDir, 'design', 'specs.md')),
    read(path.join(f.featureDir, 'decisions', 'history', 'plan.md')),
    read(path.join(f.featureDir, 'decisions', 'history', 'specs.md')),
  ];
  const second = compactHistory({ ...f, date: '2026-10-04' });
  assert.deepEqual(second, { status: 'unchanged', moved: [], failed: [] });
  assert.deepEqual([
    read(path.join(f.featureDir, 'plan.md')),
    read(path.join(f.featureDir, 'design', 'specs.md')),
    read(path.join(f.featureDir, 'decisions', 'history', 'plan.md')),
    read(path.join(f.featureDir, 'decisions', 'history', 'specs.md')),
  ], snapshot);
});

test('entries added after a compaction move in a second chunk behind the same single pointer', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  compactHistory({ ...f, date: DATE });
  fs.appendFileSync(file, '| 2026-10-05 | T-004 | Added later | T-005 |\n');
  const second = compactHistory({ ...f, date: '2026-10-05' });
  assert.equal(second.moved[0].lines, 1);
  const after = read(file);
  assert.equal(after.match(/^Earlier entries:/gm).length, 1);
  assert.ok(!after.includes('T-004'));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.equal(archive.match(/^## Compacted /gm).length, 2);
  assert.ok(archive.includes('## Compacted 2026-10-05 from plan.md §9\n\n| 2026-10-05 | T-004 | Added later | T-005 |\n'));
});

test('the archive chunks plus the pointed artifact reproduce every original History line, in order', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const original = read(path.join(f.featureDir, 'plan.md')).split('\n');
  const start = original.findIndex((l: any) => l.startsWith('## 9. History'));
  const originalLines = original.slice(start + 1).filter((l: any) => l.trim() !== '');
  compactHistory({ ...f, date: DATE });
  const after = read(path.join(f.featureDir, 'plan.md')).split('\n').slice(start + 1).filter((l: any) => l.trim() !== '');
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md')).split('\n')
    .filter((l: any) => l.trim() !== '' && !l.startsWith('# History archive') && !l.startsWith('## Compacted'));
  assert.deepEqual([...after.filter((l: any) => l.startsWith('<!--')), ...archive], originalLines);
});

test('an artifact with no History section is left alone', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\nNo history here.\n');
  assert.deepEqual(compactHistory({ ...f, date: DATE }), { status: 'unchanged', moved: [], failed: [] });
  assert.equal(read(file), '# Plan\n\nNo history here.\n');
});

test('an artifact path that does not exist, or is null, is skipped', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const paths: any = { ...f.paths, design: 'agent-docs/doflow/001-demo/design/design.md', specs: null };
  const result = compactHistory({ ...f, paths, date: DATE });
  assert.equal(result.moved.length, 1);
});

/** fs whose renameSync into `target` fails: a simulated append failure. */
function failingRename(target: any) {
  return {
    ...fs,
    renameSync(from: any, to: any) {
      if (to === target) throw new Error('disk full');
      return fs.renameSync(from, to);
    },
  };
}

test('a failed archive append leaves the artifact byte-identical and names it', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const before = fs.readFileSync(file);
  const archive = path.join(f.featureDir, 'decisions', 'history', 'plan.md');
  const result = compactHistory({ ...f, date: DATE, fsImpl: failingRename(archive) });
  assert.equal(result.status, 'partial');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].artifact, 'plan.md');
  assert.match(result.failed[0].message, /plan\.md/);
  assert.ok(fs.readFileSync(file).equals(before));
  assert.ok(!fs.existsSync(archive));
  assert.deepEqual(fs.readdirSync(path.join(f.featureDir, 'decisions', 'history')), []);
});

test('an archive that does not hold the block after the write stops before the artifact is rewritten', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const before = fs.readFileSync(file);
  const lying: any = {
    ...fs,
    readFileSync(p: any, enc: any) {
      return p.includes(`${path.sep}history${path.sep}`) ? '# History archive: plan.md\n' : fs.readFileSync(p, enc);
    },
  };
  assert.equal(compactHistory({ ...f, date: DATE, fsImpl: lying }).failed[0].artifact, 'plan.md');
  assert.ok(fs.readFileSync(file).equals(before));
});

test('a failed artifact rewrite keeps the block in the archive and the next run does not duplicate it', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const before = fs.readFileSync(file);
  assert.equal(compactHistory({ ...f, date: DATE, fsImpl: failingRename(file) }).status, 'partial');
  assert.ok(fs.readFileSync(file).equals(before));
  const archive = path.join(f.featureDir, 'decisions', 'history', 'plan.md');
  assert.ok(fs.existsSync(archive));
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'compacted');
  assert.equal(read(archive).match(/^## Compacted /gm).length, 1);
  assert.ok(read(file).includes('Earlier entries:'));
});

test('artifacts compacted around a failure stay compacted and the failure is reported beside them', () => {
  const f = feature({ design: ['design/design.md', 'history-9-initial.md'], plan: ['plan.md', 'history-9-plan.md'], specs: ['design/specs.md', 'history-2-specs.md'] });
  const planArchive = path.join(f.featureDir, 'decisions', 'history', 'plan.md');
  const result = compactHistory({ ...f, date: DATE, fsImpl: failingRename(planArchive) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failed.map((x: any) => x.artifact), ['plan.md']);
  assert.deepEqual(result.moved.map((x: any) => [x.artifact, x.path]), [['specs.md', 'design/specs.md']]);
});

// ── fenced code blocks ─────────────────────────────────────────────────────────────────────────

test('a History heading quoted inside a code fence is not the History section', () => {
  const f = feature({ plan: ['plan.md', 'history-9-fenced-example.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const original = read(file);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.moved[0].lines, 1);
  const after = read(file);
  // The fenced example in section 1 is byte-identical; only the real History changed.
  assert.equal(after.slice(0, after.lastIndexOf('## 9. History')), original.slice(0, original.lastIndexOf('## 9. History')));
  assert.ok(after.includes('```markdown\n## 9. History\n\n- example line\n```'));
  assert.ok(after.endsWith('## 9. History\n\nEarlier entries: [decisions/history/plan.md](decisions/history/plan.md).\n'));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.ok(archive.includes('\n\n- real\n'));
  assert.ok(!archive.includes('example line'));
});

test('fenced content inside History moves whole, and a ## line in a fence does not end the section', () => {
  const f = feature({ plan: ['plan.md', 'history-9-fenced-content.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  compactHistory({ ...f, date: DATE });
  const after = read(file);
  assert.equal(after, [
    '# Plan: demo', '', '## 9. History', '',
    'Earlier entries: [decisions/history/plan.md](decisions/history/plan.md).', '',
    '## 10. Appendix', '', 'Appendix text stays.', '',
  ].join('\n'));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.ok(archive.includes('````markdown\n```\nnested fence line\n```\n\n## 10. Not a heading\n\nafter a blank line\n````\n'));
  assert.ok(archive.includes('~~~\ntilde block\n\n## 11. Also not a heading\n~~~\n'));
});

test('a code fence that never closes is reported and the artifact is left unchanged', () => {
  const f = feature({ plan: ['plan.md', 'history-9-open-fence.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const before = fs.readFileSync(file);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'partial');
  assert.ok(result.failed[0].artifact === 'plan.md' && /fence/.test(result.failed[0].message));
  assert.ok(fs.readFileSync(file).equals(before));
  assert.ok(!fs.existsSync(path.join(f.featureDir, 'decisions')));
});

// ── dedupe of an interrupted run ───────────────────────────────────────────────────────────────

test('a block that only prefixes an earlier chunk is still appended, so nothing is lost', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n- one\n- two\n');
  compactHistory({ ...f, date: DATE });
  fs.appendFileSync(file, '- one\n');
  const second = compactHistory({ ...f, date: DATE });
  assert.equal(second.status, 'compacted');
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.equal(archive.match(/^## Compacted /gm).length, 2);
  assert.ok(archive.endsWith(`## Compacted ${DATE} from plan.md §9\n\n- one\n`));
  assert.ok(!read(file).includes('- one'));
});

test('recovery on a later day does not append a second copy of an interrupted chunk', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  assert.equal(compactHistory({ ...f, date: '2026-10-03', fsImpl: failingRename(file) }).status, 'partial');
  const result = compactHistory({ ...f, date: '2026-10-04' });
  assert.equal(result.status, 'compacted');
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.equal(archive.match(/^## Compacted /gm).length, 1);
  assert.ok(read(file).includes('Earlier entries:'));
});

// ── line endings ───────────────────────────────────────────────────────────────────────────────

test('a CRLF artifact is rewritten with CRLF throughout and gets a CRLF archive', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, read(file).replace(/\n/g, '\r\n'));
  compactHistory({ ...f, date: DATE });
  const after = read(file);
  assert.equal((after.match(/\n/g) || []).length, (after.match(/\r\n/g) || []).length);
  assert.ok(after.endsWith('<!-- History template: one row per change; detail below. -->\r\n\r\nEarlier entries: [decisions/history/plan.md](decisions/history/plan.md).\r\n'));
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.equal((archive.match(/\n/g) || []).length, (archive.match(/\r\n/g) || []).length);
  assert.ok(archive.includes('- **T-001** — said X; changed because Y; now Z.\r\n'));
  // A second run on the CRLF files changes nothing.
  assert.equal(compactHistory({ ...f, date: DATE }).status, 'unchanged');
});

// ── review fixes ───────────────────────────────────────────────────────────────────────────────

test('a fenced "## Compacted" line in History compacts once and a second run is unchanged', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n```\n## Compacted 2026-01-01 from plan.md §9\n\nquoted\n```\n\n- tail\n');
  const first = compactHistory({ ...f, date: DATE });
  assert.equal(first.status, 'compacted');
  const archiveFile = path.join(f.featureDir, 'decisions', 'history', 'plan.md');
  const archive = read(archiveFile);
  assert.equal(archive.match(/^## Compacted /gm).length, 2); // one real header, one quoted in the fence
  assert.equal(archive.split('\n').filter((l: any) => l.startsWith('## Compacted 2026-10-03')).length, 1);
  const snapshotAfter: any = [archive, read(file)];
  const second = compactHistory({ ...f, date: DATE });
  assert.deepEqual(second, { status: 'unchanged', moved: [], failed: [] });
  assert.deepEqual([read(archiveFile), read(file)], snapshotAfter);
});

test('an interrupted run whose block quotes a chunk header is still recognised on re-run', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n```\n## Compacted 2026-01-01 from plan.md §9\n```\n');
  assert.equal(compactHistory({ ...f, date: DATE, fsImpl: failingRename(file) }).status, 'partial');
  compactHistory({ ...f, date: '2026-10-04' });
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.equal(archive.split('\n').filter((l: any) => /^## Compacted 2026-10-0\d/.test(l)).length, 1);
});

test('a second pointer-shaped line is content and moves, only the canonical pointer stays', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const canonical = 'Earlier entries: [decisions/history/plan.md](decisions/history/plan.md).';
  const other = 'Earlier entries: [decisions/history/other.md](elsewhere/other.md). Real text after it.';
  fs.writeFileSync(file, `# Plan\n\n## 9. History\n\n${canonical}\n\n${other}\n\n- entry\n`);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.moved[0].lines, 2);
  assert.equal(read(file), `# Plan\n\n## 9. History\n\n${canonical}\n`);
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md'));
  assert.ok(archive.includes(`${other}\n- entry\n`));
  // A History holding only the canonical pointer is already compacted.
  assert.equal(compactHistory({ ...f, date: DATE }).status, 'unchanged');
});

test('a History holding only a non-canonical pointer line moves it and gets the canonical one', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\nEarlier entries: [decisions/history/plan.md](wrong/link.md).\n');
  assert.equal(compactHistory({ ...f, date: DATE }).status, 'compacted');
  assert.ok(read(file).endsWith('Earlier entries: [decisions/history/plan.md](decisions/history/plan.md).\n'));
  assert.ok(read(path.join(f.featureDir, 'decisions', 'history', 'plan.md')).includes('(wrong/link.md)'));
});

test('an HTML comment that never closes is refused and the artifact is left unchanged', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n- entry\n\n<!-- never closed\n\n## 10. Appendix\n\nText.\n');
  const before = fs.readFileSync(file);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'partial');
  assert.ok(result.failed[0].artifact === 'plan.md' && /comment/.test(result.failed[0].message));
  assert.ok(fs.readFileSync(file).equals(before));
  assert.ok(!fs.existsSync(path.join(f.featureDir, 'decisions')));
});

// ── an unclosed construct matters only when it opens before History ends (FR-001, FR-002) ───────

test('one refused artifact does not stop the others, and the refused one is byte-identical', () => {
  const f = feature({ requirement: ['intention/requirement.md', 'history-9-plan.md'], plan: ['plan.md', 'history-9-plan.md'] });
  const requirement = path.join(f.featureDir, 'intention', 'requirement.md');
  fs.writeFileSync(requirement, '# Req\n\n## 9. History\n\n- entry\n\n<!-- never closed\n');
  const before = fs.readFileSync(requirement);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.moved.map((m: any) => m.artifact), ['plan.md']);
  assert.deepEqual(result.failed.map((x: any) => [x.artifact, x.path]), [['requirement.md', 'intention/requirement.md']]);
  assert.deepEqual(result.moved.map((m: any) => [m.artifact, m.path]), [['plan.md', 'plan.md']]);
  assert.ok(fs.readFileSync(requirement).equals(before));
  assert.ok(read(path.join(f.featureDir, 'plan.md')).includes('Earlier entries:'));
});

test('an unclosed comment after the History section is ignored and History compacts', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n- entry\n\n## 10. Appendix\n\n<!-- never closed\n\nText.\n');
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'compacted');
  assert.deepEqual(result.failed, []);
  assert.equal(read(file), '# Plan\n\n## 9. History\n\nEarlier entries: [decisions/history/plan.md](decisions/history/plan.md).\n\n## 10. Appendix\n\n<!-- never closed\n\nText.\n');
});

test('an unclosed fence after the History section is ignored too', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## 9. History\n\n- entry\n\n## 10. Appendix\n\n```\nnever closed\n');
  assert.equal(compactHistory({ ...f, date: DATE }).status, 'compacted');
});

test('an artifact with no History section is unchanged whatever it leaves unclosed', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n<!-- never closed\n\n- text\n');
  const before = fs.readFileSync(file);
  assert.deepEqual(compactHistory({ ...f, date: DATE }), { status: 'unchanged', moved: [], failed: [] });
  assert.ok(fs.readFileSync(file).equals(before));
});

test('an unclosed construct that opens before History, swallowing its heading, is refused', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n<!-- never closed\n\n## 9. History\n\n- entry\n');
  const before = fs.readFileSync(file);
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'partial');
  assert.match(result.failed[0].message, /comment/);
  assert.ok(fs.readFileSync(file).equals(before));
});

// ── an artifact edited while it is being compacted (FU-1jbmm3) ─────────────────────────────────

/** An fs whose `writeFileSync` to a path ending in `suffix` first edits `file`, as a concurrent editor would. */
function editingDuring(suffix: any, file: any, edit: any, atTop: any = false) {
  let done = false;
  return {
    ...fs,
    writeFileSync(p: any, data: any, enc: any) {
      if (!done && String(p).includes(suffix)) {
        done = true;
        if (atTop) fs.writeFileSync(file, edit + fs.readFileSync(file, 'utf8'));
        else fs.appendFileSync(file, edit);
      }
      return fs.writeFileSync(p, data, enc);
    },
  };
}

test('an artifact edited after it was read and before the archive is written is not overwritten', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const edit = '\nconcurrent edit by someone else\n';
  const result = compactHistory({ ...f, date: DATE, fsImpl: editingDuring(`${path.sep}history${path.sep}`, file, edit) });
  assert.equal(result.status, 'partial');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].artifact, 'plan.md');
  assert.match(result.failed[0].message, /changed while it was being compacted/);
  assert.ok(read(file).endsWith(edit), 'the concurrent edit is still there');
  assert.ok(!read(file).includes('Earlier entries:'), 'the artifact was not rewritten');
  assert.deepEqual(fs.readdirSync(f.featureDir).filter((n: any) => n.endsWith('.tmp')), [], 'no temp file is left');
});

test('an artifact edited between the temp write and the rename is not overwritten', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const edit = '\nlate edit\n';
  const result = compactHistory({ ...f, date: DATE, fsImpl: editingDuring(`plan.md.${process.pid}.tmp`, file, edit) });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].message, /changed while it was being compacted/);
  assert.ok(read(file).endsWith(edit));
  assert.ok(!read(file).includes('Earlier entries:'));
  assert.deepEqual(fs.readdirSync(f.featureDir).filter((n: any) => n.endsWith('.tmp')), []);
});

test('after a refused overwrite the next run compacts the edited artifact once', () => {
  const f = feature({ plan: ['plan.md', 'history-9-plan.md'] });
  const file = path.join(f.featureDir, 'plan.md');
  const archive = path.join(f.featureDir, 'decisions', 'history', 'plan.md');
  // The edit is above the History section, so the block to move is the one already archived.
  compactHistory({ ...f, date: DATE, fsImpl: editingDuring(`${path.sep}history${path.sep}`, file, 'top edit\n\n', true) });
  assert.ok(read(file).startsWith('top edit\n'));
  const result = compactHistory({ ...f, date: DATE });
  assert.equal(result.status, 'compacted');
  assert.equal(read(archive).match(/^## Compacted /gm).length, 1);
  assert.ok(read(file).includes('Earlier entries:'));
  assert.ok(read(file).startsWith('top edit\n'));
});

// ── closed-points mode (IC-004, IC-008, IC-009, IC-013) ─────────────────────────────────────────
// Written from specs.md alone. Artifacts are built inline: the shape of the Open Points section is
// what each case is about, so the text sits beside its assertion.

const CP_DATE = '2026-11-26';
const CP_HEADING = '## 7. Open Points for Review';
const DESIGN_POINTER = 'Closed points: [decisions/history/design-closed.md](../decisions/history/design-closed.md).';

/** A feature folder holding the given text at design/design.md, design/specs.md, design/data-model.md. */
function closedFeature(files: any) {
  const repoRoot = suiteTempDir('doflow-closed-points-');
  const featureDir = path.join(repoRoot, 'agent-docs', 'doflow', SLUG);
  const rels: any = { design: 'design/design.md', specs: 'design/specs.md', data_model: 'design/data-model.md' };
  const paths: any = {};
  for (const [key, text] of Object.entries(files)) {
    const file = path.join(featureDir, rels[key]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text as string);
    paths[key] = path.relative(repoRoot, file);
  }
  return { repoRoot, featureDir, paths, file: (key: any) => path.join(featureDir, rels[key]) };
}

const closedRun = (f: any, extra: any = {}) => compactHistory({ repoRoot: f.repoRoot, featureDir: f.featureDir, paths: f.paths, date: CP_DATE, mode: 'closed-points', ...extra });
const designArchive = (f: any) => path.join(f.featureDir, 'decisions', 'history', 'design-closed.md');
const doc = (...lines: any[]) => `${lines.join('\n')}\n`;

test('closed-points: a labelled bullet moves to the archive and the section ends with the pointer (exact shape)', () => {
  const f = closedFeature({ design: doc(
    '# Design', '', CP_HEADING, '',
    '- **Decided (DEC-001):** use X.', '  second line of the answer',
    '- Is the cache needed?',
    '- **Rejected:** option B.', '',
    '## 8. History', '', 'None.',
  ) });
  const result = closedRun(f);
  assert.equal(result.status, 'compacted');
  assert.deepEqual(result.moved, [{ artifact: 'design.md', path: 'design/design.md', archive: 'decisions/history/design-closed.md', lines: 3, items: 2 }]);
  assert.deepEqual(result.failed, []);
  assert.equal(read(f.file('design')), doc(
    '# Design', '', CP_HEADING, '',
    '- Is the cache needed?', '', DESIGN_POINTER, '',
    '## 8. History', '', 'None.',
  ));
  assert.equal(read(designArchive(f)), doc(
    '# Closed points archive: design/design.md', '',
    `## Compacted ${CP_DATE} from design/design.md §7`, '',
    '- **Decided (DEC-001):** use X.', '  second line of the answer', '',
    '- **Rejected:** option B.',
  ));
});

for (const [label, line] of [
  ['Decided', '- **Decided:** a.'],
  ['Decided with a reference', '- **Decided (DEC-012):** a.'],
  ['Rejected with a detail', '- **Rejected (option B):** a.'],
  ['Round', '- **Round 2:** a.'],
  ['Round with a file', '- **Round 3 (design-03-question.md):** a.'],
] as any) {
  test(`closed-points: the opener form "${label}" is matched and moved`, () => {
    const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', line, '- keep me', '') });
    const result = closedRun(f);
    assert.equal(result.status, 'compacted');
    assert.equal(result.moved[0].items, 1);
    assert.ok(read(designArchive(f)).includes(`\n${line}\n`));
    assert.ok(!read(f.file('design')).includes(line));
    assert.ok(read(f.file('design')).includes('- keep me'));
  });
}

for (const [label, line] of [
  ['colon outside the bold', '- **Decided** a.'],
  ['no bold', '- Decided: a.'],
  ['a bold question', '- **Is this decided?** a.'],
  ['an unknown label', '- **Postponed:** a.'],
  ['a round without a number', '- **Round:** a.'],
  ['an indented opener with no matching parent', '  - **Decided:** a.'],
  ['a bold sentence mid-line', 'Note: - **Decided:** a.'],
] as any) {
  test(`closed-points: ${label} is not an opener, so the artifact is byte-identical and not written`, () => {
    const text = doc('# D', '', CP_HEADING, '', line, '- another', '', '## 8. History', '', 'None.');
    const f = closedFeature({ design: text });
    const result = closedRun(f);
    assert.deepEqual(result, { status: 'unchanged', moved: [], failed: [] });
    assert.equal(read(f.file('design')), text);
    assert.ok(!fs.existsSync(path.join(f.featureDir, 'decisions')), 'no archive is created');
  });
}

test('closed-points: indented lines, blank lines inside the item, sub-bullets and an indented fence move with their opener', () => {
  const f = closedFeature({ design: doc(
    '# D', '', CP_HEADING, '',
    '- **Decided:** use the cache.',
    '  - sub bullet one',
    '    - nested sub bullet',
    '',
    '  continuation after a blank line',
    '  ```text',
    '  ## 9. not a heading',
    '',
    '  still in the fence',
    '  ```',
    '\ttab indented line',
    '- open question stays',
    '',
  ) });
  const result = closedRun(f);
  assert.equal(result.moved[0].items, 1);
  const archive = read(designArchive(f));
  for (const line of [
    '- **Decided:** use the cache.', '  - sub bullet one', '    - nested sub bullet', '  continuation after a blank line',
    '  ```text', '  ## 9. not a heading', '  still in the fence', '\ttab indented line',
  ]) assert.ok(archive.includes(`${line}\n`), `archive holds "${line}"`);
  const after = read(f.file('design'));
  assert.ok(after.includes('- open question stays'));
  for (const gone of ['sub bullet', 'continuation after', 'still in the fence', 'tab indented']) assert.ok(!after.includes(gone), `${gone} left the artifact`);
});

test('closed-points: a non-indented line ends the item, and trailing blank lines are not part of it', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '', 'A paragraph that is not indented.', '') });
  const result = closedRun(f);
  assert.equal(result.moved[0].lines, 1);
  assert.equal(result.moved[0].items, 1);
  assert.ok(read(designArchive(f)).endsWith('\n\n- **Decided:** a.\n'));
  assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', 'A paragraph that is not indented.', '', DESIGN_POINTER));
});

test('closed-points: a non-blank line directly after the item that opens no list item, heading or fence is a lazy continuation and moves with it', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** use X', 'because Y', '- open Z', '', '## 8. Next') });
  const result = closedRun(f);
  assert.equal(result.moved[0].lines, 2);
  assert.equal(result.moved[0].items, 1);
  assert.ok(read(designArchive(f)).endsWith('\n\n- **Decided:** use X\nbecause Y\n'));
  assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', '- open Z', '', DESIGN_POINTER, '', '## 8. Next'));
});

test('closed-points: the exact pointer line directly after the item is not swallowed as a lazy continuation', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', DESIGN_POINTER, '- keep', '') });
  const result = closedRun(f);
  assert.equal(result.moved[0].lines, 1);
  assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', '- keep', '', DESIGN_POINTER));
});

test('closed-points: a heading, an ordered or other list item, or a fence directly after the item ends it', () => {
  for (const next of ['### Sub', '1. numbered', '* star', '+ plus', '```\ncode\n```', '2) paren']) {
    const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', next, '- keep', '') });
    const result = closedRun(f);
    assert.equal(result.moved[0].lines, 1, `"${next}" ends the item`);
  }
});

test('closed-points: a heading-like line inside an indented fence of the item does not end the section', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '  ```', '  ## 8. fake', '  ```', '', '## 8. History', '', 'None.') });
  closedRun(f);
  assert.ok(read(designArchive(f)).includes('  ## 8. fake\n'));
  assert.ok(read(f.file('design')).endsWith(doc('', '## 8. History', '', 'None.')));
});

test('closed-points: the pointer sits at the end of the file when the section ends it, and the heading may be unnumbered', () => {
  const f = closedFeature({ design: doc('# D', '', '## Open Points for Review', '', '- **Decided:** a.') });
  const result = closedRun(f);
  assert.equal(result.status, 'compacted');
  assert.equal(read(f.file('design')), doc('# D', '', '## Open Points for Review', '', DESIGN_POINTER));
  assert.ok(read(designArchive(f)).includes(`## Compacted ${CP_DATE} from design/design.md §Open Points for Review\n\n- **Decided:** a.\n`));
});

test('closed-points: leading and trailing blank lines of the kept body are dropped and inner runs collapse to one', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '', '- keep one', '', '', '', '- **Decided:** a.', '', '', '- keep two', '', '', '## 8. Next') });
  closedRun(f);
  assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', '- keep one', '', '- keep two', '', DESIGN_POINTER, '', '## 8. Next'));
});

test('closed-points: a second run finds nothing and changes no byte; the pointer stays once', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '- keep', '', '## 8. History', '') });
  closedRun(f);
  const snap = [read(f.file('design')), read(designArchive(f))];
  const second = closedRun(f, { date: '2026-11-27' });
  assert.deepEqual(second, { status: 'unchanged', moved: [], failed: [] });
  assert.deepEqual([read(f.file('design')), read(designArchive(f))], snap);
  assert.equal(read(f.file('design')).match(/^Closed points:/gm).length, 1);
});

test('closed-points: a point settled after a compaction moves as a second chunk behind the same single pointer', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '- keep', '') });
  closedRun(f);
  fs.appendFileSync(f.file('design'), '- **Round 2:** b.\n');
  const second = closedRun(f, { date: '2026-11-27' });
  assert.equal(second.status, 'compacted');
  assert.equal(second.moved[0].items, 1);
  const after = read(f.file('design'));
  assert.equal(after.match(/^Closed points:/gm).length, 1);
  assert.ok(after.includes('- keep'));
  assert.ok(!after.includes('Round 2'));
  const archive = read(designArchive(f));
  assert.equal(archive.match(/^## Compacted /gm).length, 2);
  assert.ok(archive.endsWith('## Compacted 2026-11-27 from design/design.md §7\n\n- **Round 2:** b.\n'));
});

test('closed-points: any line other than the exact canonical pointer is content, kept when not a labelled point', () => {
  const stray = 'Closed points: [decisions/history/design-closed.md](somewhere/else.md).';
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', stray, '', '- **Decided:** a.', '') });
  closedRun(f);
  assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', stray, '', DESIGN_POINTER));
});

test('closed-points: a line equal to the pointer but with leading or trailing spaces is content, not the pointer (IC-009)', () => {
  for (const variant of [`  ${DESIGN_POINTER}`, `${DESIGN_POINTER}  `, `\t${DESIGN_POINTER}`]) {
    const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', variant, '', '- **Decided:** a.', '') });
    closedRun(f);
    assert.equal(read(f.file('design')), doc('# D', '', CP_HEADING, '', variant, '', DESIGN_POINTER), JSON.stringify(variant));
  }
});

test('closed-points: specs and data-model move to their own archives with their own relative links', () => {
  const f = closedFeature({
    specs: doc('# S', '', '## 3. Open Points for Review', '', '- **Rejected (option B):** no.', '- keep', ''),
    data_model: doc('# M', '', '## Open Points for Review', '', '- **Round 2:** yes.'),
  });
  const result = closedRun(f);
  assert.deepEqual(result.moved.map((m: any) => [m.artifact, m.path, m.archive, m.items]), [
    ['specs.md', 'design/specs.md', 'decisions/history/specs-closed.md', 1],
    ['data-model.md', 'design/data-model.md', 'decisions/history/data-model-closed.md', 1],
  ]);
  assert.ok(read(f.file('specs')).includes('Closed points: [decisions/history/specs-closed.md](../decisions/history/specs-closed.md).'));
  assert.ok(read(f.file('data_model')).includes('Closed points: [decisions/history/data-model-closed.md](../decisions/history/data-model-closed.md).'));
  assert.ok(read(path.join(f.featureDir, 'decisions', 'history', 'specs-closed.md')).startsWith('# Closed points archive: design/specs.md\n'));
  assert.ok(read(path.join(f.featureDir, 'decisions', 'history', 'data-model-closed.md')).includes('from design/data-model.md §Open Points for Review'));
});

test('closed-points: a labelled bullet outside Open Points for Review, History and every other section are untouched', () => {
  const text = doc(
    '# D', '', '## 1. Overview', '', '- **Decided:** not in the open section.', '',
    '## 7. Open Points for Review', '', '- keep', '',
    '## 8. History', '', '- **Decided:** a history bullet.',
  );
  const f = closedFeature({ design: text, specs: doc('# S', '', '## 2. History', '', '| a |', '|---|', '| 1 |') });
  assert.deepEqual(closedRun(f), { status: 'unchanged', moved: [], failed: [] });
  assert.equal(read(f.file('design')), text);
});

test('closed-points: only the Open Points section changes; everything before and after is byte-identical', () => {
  const before = doc('# D', '', '## 1. Overview', '', '- **Decided:** stays here.', '');
  const after = doc('## 8. History', '', '| Date | ID |', '|---|---|', '| 2026-11-01 | x |');
  const f = closedFeature({ design: `${before}${doc(CP_HEADING, '', '- **Decided:** moves.', '')}\n${after}` });
  closedRun(f);
  const text = read(f.file('design'));
  assert.ok(text.startsWith(before));
  assert.ok(text.endsWith(after));
});

test('closed-points: the History section and its archive are untouched by the mode; the default mode then moves History and leaves the points', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '- keep', '', '## 8. History', '', '| Date | Change |', '|---|---|', '| 2026-10-01 | first |');
  const f = closedFeature({ design: text });
  const first = closedRun(f);
  assert.equal(first.status, 'compacted');
  assert.deepEqual(first.moved.map((m: any) => m.archive), ['decisions/history/design-closed.md']);
  assert.ok(read(f.file('design')).endsWith(doc('', '## 8. History', '', '| Date | Change |', '|---|---|', '| 2026-10-01 | first |')));
  assert.deepEqual(fs.readdirSync(path.join(f.featureDir, 'decisions', 'history')), ['design-closed.md']);

  const history = compactHistory({ repoRoot: f.repoRoot, featureDir: f.featureDir, paths: f.paths, date: CP_DATE });
  assert.deepEqual(history.moved.map((m: any) => m.archive), ['decisions/history/design.md']);
  assert.ok(read(f.file('design')).includes('Closed points: ['), 'history mode leaves the settled-points pointer');
  assert.ok(read(path.join(f.featureDir, 'decisions', 'history', 'design.md')).includes('| 2026-10-01 | first |'));
  assert.ok(!read(path.join(f.featureDir, 'decisions', 'history', 'design.md')).includes('Decided'));
});

test('closed-points: history mode (explicit or default) never moves settled points', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '## 8. Notes', '', 'Text.');
  const f = closedFeature({ design: text });
  for (const extra of [{}, { mode: 'history' }]) {
    assert.deepEqual(compactHistory({ repoRoot: f.repoRoot, featureDir: f.featureDir, paths: f.paths, date: CP_DATE, ...extra }), { status: 'unchanged', moved: [], failed: [] });
  }
  assert.equal(read(f.file('design')), text);
});

test('closed-points: CRLF stays CRLF in the artifact, and the moved block loses its trailing CR', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '  more', '- keep', '', '## 8. History', '').replace(/\n/g, '\r\n') });
  const result = closedRun(f);
  assert.equal(result.status, 'compacted');
  const after = read(f.file('design'));
  assert.equal((after.match(/\n/g) || []).length, (after.match(/\r\n/g) || []).length, 'every line break is CRLF');
  assert.ok(after.includes(`${DESIGN_POINTER}\r\n`));
  const archive = read(designArchive(f)).replace(/\r\n/g, '\n');
  assert.ok(archive.endsWith('\n\n- **Decided:** a.\n  more\n'));
  assert.ok(!archive.includes('\r'));
  assert.deepEqual(closedRun(f, { date: '2026-11-27' }), { status: 'unchanged', moved: [], failed: [] });
});

for (const [label, body, reason] of [
  ['code fence', ['- **Decided:** a.', '', '```text', 'never closed'], 'a code fence is never closed, so the end of the Open Points for Review section cannot be told'],
  ['HTML comment', ['- **Decided:** a.', '', '<!-- never closed', 'text'], 'an HTML comment is never closed, so the end of the Open Points for Review section cannot be told'],
] as any) {
  test(`closed-points: an unclosed ${label} in the section is refused and the artifact is left unchanged`, () => {
    const text = doc('# D', '', CP_HEADING, '', ...body);
    const f = closedFeature({ design: text });
    const result = closedRun(f);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.moved, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].artifact, 'design.md');
    assert.equal(result.failed[0].path, 'design/design.md');
    assert.equal(result.failed[0].message, `could not compact design/design.md: ${reason}; the artifact was left unchanged`);
    assert.equal(read(f.file('design')), text);
    assert.ok(!fs.existsSync(designArchive(f)));
  });
}

test('closed-points: a section heading after an unclosed fence is also refused', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '```', 'x', '', '## 8. Notes', '', 'Text.');
  const f = closedFeature({ design: text });
  const result = closedRun(f);
  assert.equal(result.status, 'partial');
  assert.match(result.failed[0].message, /a code fence is never closed/);
  assert.equal(read(f.file('design')), text);
});

test('closed-points: one refused artifact does not stop the others', () => {
  const f = closedFeature({
    design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '```', 'open'),
    specs: doc('# S', '', '## 3. Open Points for Review', '', '- **Decided:** b.'),
  });
  const result = closedRun(f);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failed.map((x: any) => x.artifact), ['design.md']);
  assert.deepEqual(result.moved.map((x: any) => x.artifact), ['specs.md']);
});

test('closed-points: a missing or null artifact path is skipped', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.') });
  const paths = { ...f.paths, specs: 'agent-docs/doflow/001-demo/design/specs.md', data_model: null };
  const result = closedRun({ ...f, paths });
  assert.equal(result.moved.length, 1);
  assert.deepEqual(result.failed, []);
});

test('closed-points: an artifact edited while it is compacted is not overwritten', () => {
  const f = closedFeature({ design: doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '- keep') });
  const edit = '\nconcurrent edit\n';
  let done = false;
  const editing: any = {
    ...fs,
    writeFileSync(p: any, data: any, enc: any) {
      if (!done && String(p).includes(`${path.sep}history${path.sep}`)) { done = true; fs.appendFileSync(f.file('design'), edit); }
      return fs.writeFileSync(p, data, enc);
    },
  };
  const result = closedRun(f, { fsImpl: editing });
  assert.equal(result.status, 'partial');
  assert.match(result.failed[0].message, /design\.md changed while it was being compacted/);
  assert.ok(read(f.file('design')).endsWith(edit));
  assert.ok(!read(f.file('design')).includes('Closed points:'));
});

// IC-013: the archive is appended and read back before the artifact is rewritten.

function renameFailing(target: any) {
  return { ...fs, renameSync(from: any, to: any) { if (to === target) throw new Error('disk full'); return fs.renameSync(from, to); } };
}

test('IC-013: a failed artifact rename leaves the artifact unchanged with the block in the archive; the next run appends nothing and rewrites the artifact', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '- keep', '', '## 8. History', '');
  const f = closedFeature({ design: text });
  const failed = closedRun(f, { fsImpl: renameFailing(f.file('design')) });
  assert.equal(failed.status, 'partial');
  assert.equal(failed.failed[0].artifact, 'design.md');
  assert.equal(read(f.file('design')), text);
  const archiveAfterFailure = read(designArchive(f));
  assert.ok(archiveAfterFailure.endsWith('\n\n- **Decided:** a.\n'));
  assert.equal(archiveAfterFailure.match(/^## Compacted /gm).length, 1);

  const next = closedRun(f, { date: '2026-11-27' });
  assert.equal(next.status, 'compacted');
  assert.equal(read(designArchive(f)), archiveAfterFailure, 'nothing is appended again');
  assert.ok(read(f.file('design')).includes(DESIGN_POINTER));
  assert.ok(!read(f.file('design')).includes('- **Decided:** a.'));
});

test('IC-013: a failed archive append leaves the artifact byte-identical', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.');
  const f = closedFeature({ design: text });
  const result = closedRun(f, { fsImpl: renameFailing(designArchive(f)) });
  assert.equal(result.status, 'partial');
  assert.equal(result.failed[0].artifact, 'design.md');
  assert.equal(read(f.file('design')), text);
  assert.ok(!fs.existsSync(designArchive(f)));
});

test('IC-013: an archive that does not hold the block after the write stops before the artifact is rewritten', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.');
  const f = closedFeature({ design: text });
  const lying: any = {
    ...fs,
    readFileSync(p: any, enc: any) {
      return String(p).includes(`${path.sep}history${path.sep}`) ? '# Closed points archive: design/design.md\n' : fs.readFileSync(p, enc);
    },
  };
  const result = closedRun(f, { fsImpl: lying });
  assert.equal(result.status, 'partial');
  assert.match(result.failed[0].message, /the moved block is not present in .*design-closed\.md after the write/);
  assert.equal(read(f.file('design')), text);
});

// IC-004 through runDecision: --mode default and unknown value.

const { runDecision } = require('../../src/runtime/decision-register.ts');
const { execFileSync } = require('node:child_process');

function registerRepo(designText: any) {
  const root = suiteTempDir('doflow-closed-points-run-');
  const git = (...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', `feat/${SLUG}`);
  assert.equal(runDecision({ action: 'init', projectRoot: root }).exitCode, 0);
  const design = path.join(root, 'agent-docs', 'doflow', SLUG, 'design', 'design.md');
  fs.mkdirSync(path.dirname(design), { recursive: true });
  fs.writeFileSync(design, designText);
  return { root, design };
}

test('IC-004: compact with no --mode is history mode and reports mode in the result; points stay put', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '## 8. Notes', '', 'Text.');
  const r = registerRepo(text);
  const run = runDecision({ action: 'compact', projectRoot: r.root });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.mode, 'history');
  assert.equal(run.result.status, 'unchanged');
  assert.equal(fs.readFileSync(r.design, 'utf8'), text);
});

test('IC-004: compact --mode closed-points moves the points and reports mode, moved[] and text shape', () => {
  const r = registerRepo(doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '  more', '- keep', ''));
  const run = runDecision({ action: 'compact', projectRoot: r.root, flags: { mode: 'closed-points' } });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.mode, 'closed-points');
  assert.equal(run.result.status, 'compacted');
  assert.deepEqual(run.result.moved[0], { artifact: 'design.md', path: 'design/design.md', archive: 'decisions/history/design-closed.md', lines: 2, items: 1 });
  assert.ok(fs.readFileSync(r.design, 'utf8').includes('Closed points: ['));
  assert.ok(!fs.existsSync(`${path.join(r.root, 'agent-docs', 'doflow', SLUG, 'decisions', 'register.json')}.lock`));
  const again = runDecision({ action: 'compact', projectRoot: r.root, flags: { mode: 'closed-points' } });
  assert.equal(again.result.status, 'unchanged');
  assert.equal(again.result.mode, 'closed-points');
});

test('IC-004: an unknown --mode is a usage error and nothing is written', () => {
  const text = doc('# D', '', CP_HEADING, '', '- **Decided:** a.');
  const r = registerRepo(text);
  const run = runDecision({ action: 'compact', projectRoot: r.root, flags: { mode: 'weekly' } });
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /--mode 'weekly': valid values are history, closed-points/);
  assert.equal(fs.readFileSync(r.design, 'utf8'), text);
});

test('IC-004: a closed-points failure is a finding that still carries mode', () => {
  const r = registerRepo(doc('# D', '', CP_HEADING, '', '- **Decided:** a.', '', '```', 'open'));
  const run = runDecision({ action: 'compact', projectRoot: r.root, flags: { mode: 'closed-points' } });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'compaction-failed');
  assert.equal(run.result.mode, 'closed-points');
  assert.equal(run.result.status, 'partial');
});
