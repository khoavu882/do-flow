'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactHistory, POINTER } = require('../../src/runtime/history-compactor');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'decision-register');
const SLUG = '001-demo';

/** Builds a feature folder holding the named fixtures at the given feature-relative paths. */
function feature(layout) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-compact-'));
  const featureDir = path.join(repoRoot, 'agent-docs', 'doflow', SLUG);
  const paths = {};
  for (const [key, [rel, fixture]] of Object.entries(layout)) {
    const file = path.join(featureDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, fixture), file);
    paths[key] = path.relative(repoRoot, file);
  }
  return { repoRoot, featureDir, paths };
}

const read = (file) => fs.readFileSync(file, 'utf8');
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
  const before = {
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
  const snapshot = [
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
  const start = original.findIndex((l) => l.startsWith('## 9. History'));
  const originalLines = original.slice(start + 1).filter((l) => l.trim() !== '');
  compactHistory({ ...f, date: DATE });
  const after = read(path.join(f.featureDir, 'plan.md')).split('\n').slice(start + 1).filter((l) => l.trim() !== '');
  const archive = read(path.join(f.featureDir, 'decisions', 'history', 'plan.md')).split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('# History archive') && !l.startsWith('## Compacted'));
  assert.deepEqual([...after.filter((l) => l.startsWith('<!--')), ...archive], originalLines);
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
  const paths = { ...f.paths, design: 'agent-docs/doflow/001-demo/design/design.md', specs: null };
  const result = compactHistory({ ...f, paths, date: DATE });
  assert.equal(result.moved.length, 1);
});

/** fs whose renameSync into `target` fails: a simulated append failure. */
function failingRename(target) {
  return {
    ...fs,
    renameSync(from, to) {
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
  const lying = {
    ...fs,
    readFileSync(p, enc) {
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
  assert.deepEqual(result.failed.map((x) => x.artifact), ['plan.md']);
  assert.deepEqual(result.moved.map((x) => [x.artifact, x.path]), [['specs.md', 'design/specs.md']]);
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
  assert.equal(archive.split('\n').filter((l) => l.startsWith('## Compacted 2026-10-03')).length, 1);
  const snapshotAfter = [archive, read(file)];
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
  assert.equal(archive.split('\n').filter((l) => /^## Compacted 2026-10-0\d/.test(l)).length, 1);
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
  assert.deepEqual(result.moved.map((m) => m.artifact), ['plan.md']);
  assert.deepEqual(result.failed.map((x) => [x.artifact, x.path]), [['requirement.md', 'intention/requirement.md']]);
  assert.deepEqual(result.moved.map((m) => [m.artifact, m.path]), [['plan.md', 'plan.md']]);
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
