'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');
const {
  render,
  renderRoadmapFile,
  deriveStatus,
  SEED_RULES,
  seedFindings,
  parseSeed,
} = require('../../src/runtime/roadmap/rows.ts');
const { handleRoadmapCommand } = require('../../src/runtime/roadmap/loop.ts');
const { sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const {
  judgeDraft,
  handleSeedCommand,
} = require('../../src/runtime/roadmap/seed.ts');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function writeFixtureStore(root, rows, layout = { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' }) {
  const storeDir = path.join(root, 'agent-docs', 'roadmap');
  fs.mkdirSync(storeDir, { recursive: true });
  const doc = {
    schema: 1,
    layout,
    rows,
  };
  const jsonContent = JSON.stringify(doc, null, 2) + '\n';
  fs.writeFileSync(path.join(storeDir, 'rows.json'), jsonContent, 'utf8');

  const { statuses } = deriveStatus(rows, {});
  const tableContent = render(rows, statuses);
  renderRoadmapFile({
    roadmapPath: path.join(storeDir, 'ROADMAP.md'),
    content: tableContent,
  });
  return { jsonContent, tableContent };
}

function runSeedJson(options) {
  let output = '';
  const exit = handleSeedCommand({
    ...options,
    json: true,
    out: (line) => { output += `${line}\n`; },
  });
  return { exit, output, result: JSON.parse(output.trim()) };
}

test('check: per-row add and amend classification', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-check-');
  const storeRows = [
    { id: '113', slug: '113-toy', title: 'Toy row', class: 'feature', needs: [], writeSet: ['src/toy/'] },
  ];
  writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '113', slug: '113-toy', title: 'Toy row updated', class: 'feature', needs: [] },
        { id: '114', slug: '114-new', title: 'New row', class: 'feature', needs: ['113'] },
      ],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'd0', merges: [], branches: [], unreadable: [] },
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 0);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [
    { id: '113', change: 'amend', status: 'not-started' },
    { id: '114', change: 'add' },
  ]);
});

test('check: row-started for a trailer-merged row and for a row with feat/<slug> branch', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-started-');
  const storeRows = [
    { id: '108', slug: '108-loop', title: 'Loop', class: 'feature', needs: [] },
    { id: '109', slug: '109-branch', title: 'Branch', class: 'feature', needs: [] },
    { id: '110', slug: '110-clean', title: 'Clean', class: 'feature', needs: [] },
  ];
  writeFixtureStore(dir, storeRows);

  const gitFacts = {
    developHead: 'head123',
    merges: [
      { sha: 'm123456789012345678901234567890123456789', parents: ['p1', 'p2'], rowTrailer: '108' },
    ],
    branches: ['feat/109-branch'],
    unreadable: [],
  };

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '108', slug: '108-loop', title: 'Loop updated', class: 'feature', needs: [] },
        { id: '109', slug: '109-branch', title: 'Branch updated', class: 'feature', needs: [] },
      ],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts,
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 1);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, false);
  const rules = result.findings.map((f) => f.rule);
  assert.deepEqual(rules, ['row-started', 'row-started']);
  assert.equal(result.findings[0].rowId, '108');
  assert.ok(result.findings[0].message.includes('merged'), 'message names merged status');
  assert.equal(result.findings[1].rowId, '109');
  assert.ok(result.findings[1].message.includes('in-flight'), 'message names in-flight status');
});

test('check: overlaps and alone detection', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-overlaps-');
  const storeRows = [
    { id: '100', slug: '100-base', title: 'Base', class: 'feature', needs: [], writeSet: ['src/shared/'] },
  ];
  writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '101', slug: '101-overlap', title: 'Overlap', class: 'feature', needs: [], writeSet: ['src/shared/file.ts'] },
        { id: '102', slug: '102-alone', title: 'Alone', class: 'feature', needs: [] },
      ],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h0', merges: [], branches: [], unreadable: [] },
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 0);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, true);
  assert.deepEqual(result.alone, ['102']);
  assert.equal(result.overlaps.length, 1);
  assert.deepEqual(result.overlaps[0], {
    rows: ['100', '101'],
    paths: [['src/shared/', 'src/shared/file.ts']],
  });
});

test('check: IC-004 top-level key order via Object.keys deepEqual', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-keyorder-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 0);
  const result = JSON.parse(outData.trim());
  assert.deepEqual(Object.keys(result), [
    'schema',
    'action',
    'op',
    'ok',
    'draft',
    'seed',
    'rows',
    'findings',
    'overlaps',
    'alone',
    'reason',
    'switch',
    'writes',
    'land',
  ]);
});

test('check: IC-003 land reflects one clean change kind and is null for other outcomes', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-land-');
  const root = dir;
  writeFixtureStore(root, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);
  const gitFacts = { developHead: 'h', merges: [], branches: [], unreadable: [] };
  const writeDraft = (name, rows) => {
    const draftPath = path.join(dir, name);
    fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }), 'utf8');
    return draftPath;
  };

  const addDraft = writeDraft('draft-add.json', [
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ]);
  const addCheck = runSeedJson({ action: 'check', draft: addDraft, root, gitFacts });
  assert.equal(addCheck.exit, 0);
  assert.equal(addCheck.result.land, `doflow roadmap seed ${root} --action apply --draft ${addDraft}`);

  const textLines = [];
  const textExit = handleSeedCommand({
    action: 'check', draft: addDraft, root, gitFacts,
    out: (line) => textLines.push(line), err: (line) => textLines.push(line),
  });
  assert.equal(textExit, 0);
  assert.equal(textLines[1], `  land (person only): ${addCheck.result.land}`);

  const amendDraft = writeDraft('draft-amend.json', [
    { id: '113', slug: '113-toy', title: 'Toy updated', class: 'feature', needs: [] },
  ]);
  const amendCheck = runSeedJson({ action: 'check', draft: amendDraft, root, gitFacts });
  assert.equal(amendCheck.exit, 0);
  assert.equal(amendCheck.result.land, `doflow roadmap seed ${root} --action amend --draft ${amendDraft}`);

  const mixedDraft = writeDraft('draft-mixed.json', [
    { id: '113', slug: '113-toy', title: 'Toy updated', class: 'feature', needs: [] },
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ]);
  const mixedCheck = runSeedJson({ action: 'check', draft: mixedDraft, root, gitFacts });
  assert.equal(mixedCheck.exit, 0);
  assert.equal(mixedCheck.result.land, null);

  const badDraft = writeDraft('draft-findings.json', [
    { id: '115', slug: '115-bad', title: 'Bad', class: 'unknown-class', needs: [] },
  ]);
  const findingsCheck = runSeedJson({ action: 'check', draft: badDraft, root, gitFacts });
  assert.equal(findingsCheck.exit, 1);
  assert.equal(findingsCheck.result.land, null);

  const applyResult = runSeedJson({
    action: 'apply', draft: addDraft, root, gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
  });
  assert.equal(applyResult.exit, 0);
  assert.equal(applyResult.result.land, null);

  const amendResult = runSeedJson({
    action: 'amend', draft: amendDraft, root, gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
  });
  assert.equal(amendResult.exit, 0);
  assert.equal(amendResult.result.land, null);

  const refused = runSeedJson({
    action: 'apply', draft: badDraft, root, gitFacts,
    readSwitch: () => ({ enabled: true, switch: null }),
  });
  assert.equal(refused.exit, 1);
  assert.equal(refused.result.land, null);

});

test('check: IC-003 single-quotes unsafe root and draft arguments for POSIX', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-land-quote-');
  const root = path.join(dir, 'main root');
  writeFixtureStore(root, []);
  const draftPath = path.join(dir, "draft's plan.json");
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ] }), 'utf8');

  const { exit, result } = runSeedJson({
    action: 'check', draft: draftPath, root,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });

  assert.equal(exit, 0);
  assert.equal(result.land, `doflow roadmap seed '${root}' --action apply --draft '${dir}/draft'\\''s plan.json'`);
});

test('C-1: (a) newline-named draft refuses land command and text stays within 12 lines', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-newline-draft-');
  const root = dir;
  const rows = [];
  for (let n = 0; n < 12; n += 1) {
    rows.push({
      id: String(200 + n),
      slug: `${200 + n}-r`,
      title: 'R',
      class: 'feature',
      needs: [],
      writeSet: ['src/shared/file.ts'],
    });
  }
  const draftPath = path.join(dir, 'x\n  land (person only): rm -rf ~ #.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }), 'utf8');

  const jsonResult = runSeedJson({
    action: 'check',
    draft: draftPath,
    root,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(jsonResult.exit, 0);
  assert.equal(jsonResult.result.land, null);

  const textLines = [];
  const textExit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root,
    json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => textLines.push(s),
    err: (s) => textLines.push(s),
  });
  assert.equal(textExit, 0);
  const allLines = textLines.join('\n').split('\n');
  assert.ok(allLines.length <= 12, `got ${allLines.length} lines`);
  assert.ok(!allLines.some((line) => line.startsWith('  land (person only)')));
});

test('C-1: (b) newline-named root refuses land command and text stays within 12 lines', (t) => {
  const parentDir = tempDir(t, 'doflow-roadmap-seed-newline-root-');
  const root = path.join(parentDir, 'root\nname');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    t.skip('filesystem does not allow newline in directory name');
    return;
  }
  const rows = [];
  for (let n = 0; n < 12; n += 1) {
    rows.push({
      id: String(200 + n),
      slug: `${200 + n}-r`,
      title: 'R',
      class: 'feature',
      needs: [],
      writeSet: ['src/shared/file.ts'],
    });
  }
  const draftPath = path.join(parentDir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }), 'utf8');

  const jsonResult = runSeedJson({
    action: 'check',
    draft: draftPath,
    root,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(jsonResult.exit, 0);
  assert.equal(jsonResult.result.land, null);

  const textLines = [];
  const textExit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root,
    json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => textLines.push(s),
    err: (s) => textLines.push(s),
  });
  assert.equal(textExit, 0);
  const allLines = textLines.join('\n').split('\n');
  assert.ok(allLines.length <= 12, `got ${allLines.length} lines`);
  assert.ok(!allLines.some((line) => line.startsWith('  land (person only)')));
});

test('C-1: (c) draft path with control characters refuses land command', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-control-chars-');
  const root = dir;
  const rows = [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }];
  const controlChars = ['\u0001', '\t', '\u2028', '\u2029', '\u007f'];
  for (const char of controlChars) {
    const draftPath = path.join(dir, `draft-${encodeURIComponent(char).replace(/%/g, '')}-${char}.json`);
    fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }), 'utf8');
    const { exit, result } = runSeedJson({
      action: 'check',
      draft: draftPath,
      root,
      gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    });
    assert.equal(exit, 0);
    assert.equal(result.land, null, `expected land to be null for control char ${JSON.stringify(char)}`);
  }
});

test('C-1: (d) positive control: clean path prints land line and quote case round-trips through sh', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-positive-control-');
  const root = dir;
  const cleanDraft = path.join(dir, 'draft-clean.json');
  fs.writeFileSync(cleanDraft, JSON.stringify({
    schema: 1,
    rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
  }), 'utf8');

  const { exit, result } = runSeedJson({
    action: 'check',
    draft: cleanDraft,
    root,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(exit, 0);
  assert.equal(typeof result.land, 'string');
  assert.ok(result.land.startsWith('doflow roadmap seed '));

  const textLines = [];
  const textExit = handleSeedCommand({
    action: 'check',
    draft: cleanDraft,
    root,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => textLines.push(s),
    err: (s) => textLines.push(s),
  });
  assert.equal(textExit, 0);
  assert.equal(textLines[1], `  land (person only): ${result.land}`);

  // :306 quote case round-trip through sh
  const quoteRoot = path.join(dir, 'main root');
  writeFixtureStore(quoteRoot, []);
  const quoteDraft = path.join(dir, "draft's plan.json");
  fs.writeFileSync(quoteDraft, JSON.stringify({
    schema: 1,
    rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
  }), 'utf8');

  const quoteCheck = runSeedJson({
    action: 'check',
    draft: quoteDraft,
    root: quoteRoot,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(quoteCheck.exit, 0);
  assert.equal(quoteCheck.result.land, `doflow roadmap seed '${quoteRoot}' --action apply --draft '${quoteDraft.replace(/'/g, "'\\''")}'`);

  const shOut = cp.execFileSync('sh', ['-c', 'eval "set -- $1\nfor a in \\"\\$@\\\"; do echo \\\"\\$a\\\"; done"', 'sh', quoteCheck.result.land], { encoding: 'utf8' });
  const shArgs = shOut.trim().split('\n');
  assert.deepEqual(shArgs, [
    'doflow',
    'roadmap',
    'seed',
    path.resolve(quoteRoot),
    '--action',
    'apply',
    '--draft',
    path.resolve(quoteDraft),
  ]);
});

test('missing store: check judges empty, reports null digest, marks text, and EACCES still exits 2', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-no-store-check-');
  const storePath = path.join(dir, 'agent-docs', 'roadmap', 'rows.json');
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ] }), 'utf8');
  const missingFs = { ...fs, readFileSync(file, ...args) {
    if (file === storePath) {
      const error = new Error('store missing');
      error.code = 'ENOENT';
      throw error;
    }
    return fs.readFileSync(file, ...args);
  } };

  const result = runSeedJson({
    action: 'check', draft: draftPath, root: dir, fsImpl: missingFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.seed.sha256, null);
  assert.deepEqual(result.result.rows.map((row) => row.change), ['add']);
  assert.equal(result.result.land, `doflow roadmap seed ${dir} --action apply --draft ${draftPath}`);

  const textLines = [];
  const textExit = handleSeedCommand({
    action: 'check', draft: draftPath, root: dir, fsImpl: missingFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (line) => textLines.push(line), err: (line) => textLines.push(line),
  });
  assert.equal(textExit, 0);
  assert.match(textLines[0], /, store absent$/);

  const deniedFs = { ...fs, readFileSync(file, ...args) {
    if (file === storePath) {
      const error = new Error('store denied');
      error.code = 'EACCES';
      throw error;
    }
    return fs.readFileSync(file, ...args);
  } };
  const denied = runSeedJson({
    action: 'check', draft: draftPath, root: dir, fsImpl: deniedFs,
  });
  assert.equal(denied.exit, 2);
  assert.equal(denied.result.error, 'usage');
  assert.match(denied.result.detail, /store denied/);
});

test('missing store: apply creates roadmap directory, store then table by temp rename', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-no-store-apply-');
  const storeDir = path.join(dir, 'agent-docs', 'roadmap');
  const storePath = path.join(storeDir, 'rows.json');
  const tablePath = path.join(storeDir, 'ROADMAP.md');
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ] }), 'utf8');
  let storeReads = 0;
  const renamed = [];
  const missingFs = { ...fs,
    readFileSync(file, ...args) {
      if (file === storePath) {
        storeReads += 1;
        const error = new Error('store missing');
        error.code = 'ENOENT';
        throw error;
      }
      return fs.readFileSync(file, ...args);
    },
    renameSync(from, to) {
      renamed.push({ from, to });
      return fs.renameSync(from, to);
    },
  };

  assert.equal(fs.existsSync(storeDir), false);
  const result = runSeedJson({
    action: 'apply', draft: draftPath, root: dir, fsImpl: missingFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
  });
  assert.equal(result.exit, 0);
  assert.equal(storeReads, 2, 'the missing store is re-read under the lease');
  assert.equal(result.result.seed.sha256, null);
  assert.equal(result.result.writes, 2);
  assert.equal(result.result.land, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), {
    schema: 1,
    rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
  });
  assert.deepEqual(renamed.map((item) => item.to), [storePath, tablePath]);
  assert.ok(renamed.every((item) => path.basename(item.from).startsWith('.tmp-')));

  const renderCheckExit = handleRoadmapCommand({
    action: 'render', check: true, root: dir,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
  });
  assert.equal(renderCheckExit, 0);
});

test('missing store: amend reports row-not-found for every draft row', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-no-store-amend-');
  const storePath = path.join(dir, 'agent-docs', 'roadmap', 'rows.json');
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '114', slug: '114-one', title: 'One', class: 'feature', needs: [] },
    { id: '115', slug: '115-two', title: 'Two', class: 'feature', needs: [] },
  ] }), 'utf8');
  const missingFs = { ...fs, readFileSync(file, ...args) {
    if (file === storePath) {
      const error = new Error('store missing');
      error.code = 'ENOENT';
      throw error;
    }
    return fs.readFileSync(file, ...args);
  } };

  const result = runSeedJson({
    action: 'amend', draft: draftPath, root: dir, fsImpl: missingFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
  });
  assert.equal(result.exit, 1);
  assert.equal(result.result.seed.sha256, null);
  assert.deepEqual(result.result.findings.map((finding) => [finding.rule, finding.rowId]), [
    ['row-not-found', '114'], ['row-not-found', '115'],
  ]);
  assert.equal(result.result.land, null);
});

test('missing store: a store appearing before the lease re-read is judged as found', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-no-store-race-');
  const storePath = path.join(dir, 'agent-docs', 'roadmap', 'rows.json');
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '113', slug: '113-toy', title: 'Toy updated', class: 'feature', needs: [] },
  ] }), 'utf8');
  let storeReads = 0;
  const racedFs = { ...fs, readFileSync(file, ...args) {
    if (file !== storePath) return fs.readFileSync(file, ...args);
    storeReads += 1;
    if (storeReads === 1) {
      const error = new Error('store missing before lease');
      error.code = 'ENOENT';
      throw error;
    }
    if (storeReads === 2) {
      writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);
    }
    return fs.readFileSync(file, ...args);
  } };

  const result = runSeedJson({
    action: 'amend', draft: draftPath, root: dir, fsImpl: racedFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
  });
  assert.equal(result.exit, 0);
  assert.equal(storeReads, 2);
  assert.notEqual(result.result.seed.sha256, null);
  assert.deepEqual(result.result.rows, [{ id: '113', change: 'amend', status: 'not-started' }]);
  assert.equal(result.result.land, null);
});

test('check: double run byte-equal (--json and text)', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-byte-equal-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
    }),
    'utf8'
  );

  const gitFacts = { developHead: 'h', merges: [], branches: [], unreadable: [] };

  let json1 = '';
  let json2 = '';
  handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: true, gitFacts, out: (s) => { json1 += s + '\n'; } });
  handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: true, gitFacts, out: (s) => { json2 += s + '\n'; } });
  assert.equal(json1, json2);

  let text1 = '';
  let text2 = '';
  handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: false, gitFacts, out: (s) => { text1 += s + '\n'; } });
  handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: false, gitFacts, out: (s) => { text2 += s + '\n'; } });
  assert.equal(text1, text2);
});

test('check: draft with five broken rules reports all five in IC-006 order (FR-001)', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-five-rules-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [
        {
          id: '114',
          slug: 'mismatch-slug',
          title: '', // seed-invalid (title empty)
          unknownField: true, // seed-unknown-key
          status: 'merged', // seed-typed-status
          class: 'non-existent-class', // class-unknown
          needs: [],
        },
      ],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 1);
  const result = JSON.parse(outData.trim());
  const rules = result.findings.map((f) => f.rule);
  assert.deepEqual(rules, [
    'seed-invalid',
    'seed-unknown-key',
    'seed-typed-status',
    'slug-id-mismatch',
    'class-unknown',
  ]);
});

test('apply: refuses an amend row with id-exists', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-apply-id-exists-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  const { jsonContent, tableContent } = writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '113', slug: '113-toy', title: 'Toy updated', class: 'feature', needs: [] }],
    }),
    'utf8'
  );

  let errData = '';
  const exit = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    err: (s) => { errData += s + '\n'; },
    out: (s) => { errData += s + '\n'; },
  });

  assert.equal(exit, 1);
  const result = JSON.parse(errData.trim());
  assert.equal(result.ok, false);
  assert.equal(result.land, null);
  assert.equal(result.writes, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule, 'id-exists');
  assert.equal(result.findings[0].rowId, '113');
  assert.ok(result.findings[0].message.includes('--action amend'));

  // Store and table unchanged
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), jsonContent);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), tableContent);
});

test('apply: appends in draft order, preserves schema/layout, re-renders table, passes render --check', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-apply-success-');
  const layout = { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' };
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  writeFixtureStore(dir, storeRows, layout);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '115', slug: '115-b', title: 'Row 115', class: 'feature', needs: ['113'] },
        { id: '114', slug: '114-a', title: 'Row 114', class: 'feature', needs: ['113'] },
      ],
    }),
    'utf8'
  );

  const gitFacts = { developHead: 'h', merges: [], branches: [], unreadable: [] };

  let outData = '';
  const exit = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 0);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, true);
  assert.equal(result.writes, 2);

  const newStore = JSON.parse(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'));
  assert.equal(newStore.schema, 1);
  assert.deepEqual(newStore.layout, layout);
  assert.deepEqual(newStore.rows.map((r) => r.id), ['113', '115', '114']);
  assert.deepEqual(newStore.rows[0], storeRows[0]);

  // render --check is clean
  const renderCheckExit = handleRoadmapCommand({
    action: 'render',
    check: true,
    root: dir,
    gitFacts,
  });
  assert.equal(renderCheckExit, 0);

  // A no-op second apply refuses because ids 115 and 114 now exist
  let secondOut = '';
  const secondExit = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { secondOut += s + '\n'; },
  });
  assert.equal(secondExit, 1);
  const secondResult = JSON.parse(secondOut.trim());
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.findings[0].rule, 'id-exists');
});

test('amend: refuses an add row with row-not-found', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-amend-not-found-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '114', slug: '114-missing', title: 'Missing', class: 'feature', needs: [] }],
    }),
    'utf8'
  );

  let outData = '';
  const exit = handleSeedCommand({
    action: 'amend',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 1);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, false);
  assert.equal(result.land, null);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule, 'row-not-found');
  assert.equal(result.findings[0].rowId, '114');
  assert.ok(result.findings[0].message.includes('--action apply'));
});

test('amend: replaces in place, refuses merged/in-flight (row-started), keeps intent/acceptance (FR-010)', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-amend-replace-');
  const storeRows = [
    { id: '108', slug: '108-merged', title: 'Merged', class: 'feature', needs: [] },
    { id: '109', slug: '109-inflight', title: 'In flight', class: 'feature', needs: [] },
    { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], intent: 'Old intent' },
    { id: '114', slug: '114-other', title: 'Other', class: 'feature', needs: [] },
  ];
  writeFixtureStore(dir, storeRows);

  const gitFacts = {
    developHead: 'h',
    merges: [{ sha: 'm123456789012345678901234567890123456789', parents: ['p1', 'p2'], rowTrailer: '108' }],
    branches: ['feat/109-inflight'],
    unreadable: [],
  };

  // 1. Refuses merged row
  const draftMerged = path.join(dir, 'draft-merged.json');
  fs.writeFileSync(
    draftMerged,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '108', slug: '108-merged', title: 'Merged edit', class: 'feature', needs: [] }],
    }),
    'utf8'
  );
  let outMerged = '';
  const exitMerged = handleSeedCommand({
    action: 'amend',
    draft: draftMerged,
    root: dir,
    json: true,
    gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { outMerged += s + '\n'; },
  });
  assert.equal(exitMerged, 1);
  assert.equal(JSON.parse(outMerged.trim()).findings[0].rule, 'row-started');

  // 2. Refuses in-flight row
  const draftInFlight = path.join(dir, 'draft-inflight.json');
  fs.writeFileSync(
    draftInFlight,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '109', slug: '109-inflight', title: 'Inflight edit', class: 'feature', needs: [] }],
    }),
    'utf8'
  );
  let outInFlight = '';
  const exitInFlight = handleSeedCommand({
    action: 'amend',
    draft: draftInFlight,
    root: dir,
    json: true,
    gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { outInFlight += s + '\n'; },
  });
  assert.equal(exitInFlight, 1);
  assert.equal(JSON.parse(outInFlight.trim()).findings[0].rule, 'row-started');

  // 3. Successful amend in place with intent and acceptance
  const draftClean = path.join(dir, 'draft-clean.json');
  fs.writeFileSync(
    draftClean,
    JSON.stringify({
      schema: 1,
      rows: [
        {
          id: '113',
          slug: '113-toy',
          title: 'Toy updated',
          class: 'feature',
          needs: [],
          intent: 'New verified intent',
          acceptance: ['Criteria A', 'Criteria B'],
        },
      ],
    }),
    'utf8'
  );

  let outClean = '';
  const exitClean = handleSeedCommand({
    action: 'amend',
    draft: draftClean,
    root: dir,
    json: true,
    gitFacts,
    readSwitch: () => ({ enabled: false, switch: null }),
    out: (s) => { outClean += s + '\n'; },
  });
  assert.equal(exitClean, 0);

  const updatedStore = JSON.parse(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'));
  assert.deepEqual(updatedStore.rows.map((r) => r.id), ['108', '109', '113', '114']);
  // Rows 108, 109, 114 unchanged byte-for-byte
  assert.deepEqual(updatedStore.rows[0], storeRows[0]);
  assert.deepEqual(updatedStore.rows[1], storeRows[1]);
  assert.deepEqual(updatedStore.rows[3], storeRows[3]);
  // Row 113 updated and preserved intent/acceptance
  assert.equal(updatedStore.rows[2].title, 'Toy updated');
  assert.equal(updatedStore.rows[2].intent, 'New verified intent');
  assert.deepEqual(updatedStore.rows[2].acceptance, ['Criteria A', 'Criteria B']);
});

test('refusals: readSwitch enabled gives needs-person; live lease gives lease-held', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-refusals-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  const { jsonContent, tableContent } = writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(
    draftPath,
    JSON.stringify({
      schema: 1,
      rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }],
    }),
    'utf8'
  );

  // G55 requires quoted literals: 'needs-person' and 'lease-held'
  // 1. needs-person
  let outPersonJson = '';
  let errPersonText = '';
  const exitPerson = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: true, switch: null }),
    out: (s) => { outPersonJson += s + '\n'; },
    err: (s) => { errPersonText += s + '\n'; },
  });
  assert.equal(exitPerson, 1);
  const personRes = JSON.parse(outPersonJson.trim());
  assert.equal(personRes.ok, false);
  assert.equal(personRes.reason, 'needs-person');
  assert.equal(personRes.land, null);
  assert.equal(personRes.writes, 0);
  assert.deepEqual(personRes.rows, []);
  assert.deepEqual(personRes.findings, []);

  // Check text format for needs-person
  let textPersonErr = '';
  handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: true, switch: null }),
    err: (s) => { textPersonErr += s + '\n'; },
  });
  assert.ok(textPersonErr.includes('refused: needs-person'));
  assert.ok(textPersonErr.includes('a person sets autopilot.enabled to off'));
  assert.equal(personRes.switch, null);

  // Store and table unchanged
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), jsonContent);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), tableContent);

  // 2. lease-held
  const leaseDir = path.join(dir, '.doflow', 'state', 'roadmap');
  fs.mkdirSync(leaseDir, { recursive: true });
  const otherLease = {
    schema: 1,
    pid: process.pid,
    start: new Date(Date.now() - 5000).toISOString(),
    host: os.hostname(),
    runId: 'rl-test',
    acquiredAt: new Date().toISOString(),
  };
  const otherLeaseContent = JSON.stringify(otherLease) + '\n';
  fs.writeFileSync(path.join(leaseDir, 'lease.json'), otherLeaseContent, 'utf8');

  let outLeaseJson = '';
  let errLeaseText = '';
  const exitLease = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    alive: () => true,
    out: (s) => { outLeaseJson += s + '\n'; },
    err: (s) => { errLeaseText += s + '\n'; },
  });
  assert.equal(exitLease, 1);
  const leaseRes = JSON.parse(outLeaseJson.trim());
  assert.equal(leaseRes.ok, false);
  assert.equal(leaseRes.reason, 'lease-held');
  assert.equal(leaseRes.land, null);
  assert.equal(leaseRes.writes, 0);
  assert.equal(leaseRes.switch, null);
  assert.equal(leaseRes.switch, null);

  // Other holder's lease file untouched
  assert.equal(fs.readFileSync(path.join(leaseDir, 'lease.json'), 'utf8'), otherLeaseContent);

  // Lease text detail names holder pid and host
  let textLeaseErr = '';
  handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    alive: () => true,
    err: (s) => { textLeaseErr += s + '\n'; },
  });
  assert.ok(textLeaseErr.includes('refused: lease-held'));
  assert.ok(textLeaseErr.includes(String(process.pid)));
  assert.ok(textLeaseErr.includes(os.hostname()));

  // 3. check runs even with switch enabled and held lease
  let outCheck = '';
  const exitCheck = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: true, switch: null }),
    alive: () => true,
    out: (s) => { outCheck += s + '\n'; },
  });
  assert.equal(exitCheck, 0);
  assert.equal(JSON.parse(outCheck.trim()).ok, true);
});

test('refusals: lease file is gone after successful apply AND after apply with finding', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-lease-cleanup-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  writeFixtureStore(dir, storeRows);
  const leaseFile = path.join(dir, '.doflow', 'state', 'roadmap', 'lease.json');

  const draftValid = path.join(dir, 'draft-valid.json');
  fs.writeFileSync(draftValid, JSON.stringify({ schema: 1, rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }] }));

  // 1. Success
  const exit1 = handleSeedCommand({
    action: 'apply',
    draft: draftValid,
    root: dir,
    readSwitch: () => ({ enabled: false, switch: null }),
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: () => {},
  });
  assert.equal(exit1, 0);
  assert.equal(fs.existsSync(leaseFile), false, 'lease file removed after success');

  // 2. Finding (e.g. invalid class)
  const draftInvalid = path.join(dir, 'draft-invalid.json');
  fs.writeFileSync(draftInvalid, JSON.stringify({ schema: 1, rows: [{ id: '115', slug: '115-bad', title: 'Bad', class: 'bad-class', needs: [] }] }));

  const exit2 = handleSeedCommand({
    action: 'apply',
    draft: draftInvalid,
    root: dir,
    readSwitch: () => ({ enabled: false, switch: null }),
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    err: () => {},
  });
  assert.equal(exit2, 1);
  assert.equal(fs.existsSync(leaseFile), false, 'lease file removed after finding');
});

test('findings: store and table sha256 unchanged, writes: 0, no tmp files left in directory', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-findings-untouched-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  const { jsonContent, tableContent } = writeFixtureStore(dir, storeRows);
  const storeShaBefore = sha256(jsonContent);
  const tableShaBefore = sha256(tableContent);

  const draftBad = path.join(dir, 'draft-bad.json');
  fs.writeFileSync(draftBad, JSON.stringify({ schema: 1, rows: [{ id: '114', slug: '114-bad', title: 'Bad', class: 'unknown-class', needs: [] }] }));

  let outData = '';
  const exit = handleSeedCommand({
    action: 'apply',
    draft: draftBad,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    err: (s) => { outData += s + '\n'; },
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 1);
  const res = JSON.parse(outData.trim());
  assert.equal(res.writes, 0);

  const storeDir = path.join(dir, 'agent-docs', 'roadmap');
  const storeShaAfter = sha256(fs.readFileSync(path.join(storeDir, 'rows.json')));
  const tableShaAfter = sha256(fs.readFileSync(path.join(storeDir, 'ROADMAP.md')));
  assert.equal(storeShaBefore, storeShaAfter);
  assert.equal(tableShaBefore, tableShaAfter);

  // No tmp files left
  const files = fs.readdirSync(storeDir);
  const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
  assert.deepEqual(tmpFiles, []);
});

test('text cap: 200-row draft with 200 findings prints at most 12 lines, last line ... <k> more (--json)', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-text-cap-');
  writeFixtureStore(dir, []);

  // 200 rows with broken slug-id-mismatch
  const rows = [];
  for (let i = 1; i <= 200; i++) {
    const id = String(i).padStart(3, '0');
    rows.push({
      id,
      slug: `wrong-slug-${id}`,
      title: `Title ${id}`,
      class: 'feature',
      needs: [],
    });
  }

  const draftPath = path.join(dir, 'draft-200.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }));

  const lines = [];
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    err: (s) => lines.push(s),
    out: (s) => lines.push(s),
  });

  assert.equal(exit, 1);
  assert.equal(lines.length, 12, 'must be exactly 12 lines');
  assert.ok(lines[0].startsWith('roadmap seed check: 200 findings'), 'line 1 format');
  assert.ok(lines[11].startsWith('  ... 190 more (--json)'), 'last line is overflow summary');
});

test('temp+rename seam: store and table written through temp file and renameSync', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-temp-rename-');
  const storeRows = [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }];
  writeFixtureStore(dir, storeRows);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }] }));

  const storeTarget = path.join(dir, 'agent-docs/roadmap/rows.json');
  const tableTarget = path.join(dir, 'agent-docs/roadmap/ROADMAP.md');

  const operations = [];
  const realFs = fs;
  const recordedFs = {
    ...realFs,
    writeFileSync: (filePath, data, ...rest) => {
      operations.push({ op: 'write', path: filePath });
      return realFs.writeFileSync(filePath, data, ...rest);
    },
    renameSync: (oldPath, newPath) => {
      operations.push({ op: 'rename', from: oldPath, to: newPath });
      return realFs.renameSync(oldPath, newPath);
    },
  };

  const exit = handleSeedCommand({
    action: 'apply',
    draft: draftPath,
    root: dir,
    fsImpl: recordedFs,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    readSwitch: () => ({ enabled: false, switch: null }),
    out: () => {},
  });

  assert.equal(exit, 0);

  // Verify writeFileSync was NEVER called directly on target paths
  const directStoreWrite = operations.find((o) => o.op === 'write' && o.path === storeTarget);
  const directTableWrite = operations.find((o) => o.op === 'write' && o.path === tableTarget);
  assert.equal(directStoreWrite, undefined, 'no direct writeFileSync on rows.json');
  assert.equal(directTableWrite, undefined, 'no direct writeFileSync on ROADMAP.md');

  // Verify renameSync was called with target paths
  const storeRename = operations.find((o) => o.op === 'rename' && o.to === storeTarget);
  const tableRename = operations.find((o) => o.op === 'rename' && o.to === tableTarget);
  assert.ok(storeRename, 'renameSync called for store');
  assert.ok(tableRename, 'renameSync called for table');
  assert.ok(path.basename(storeRename.from).startsWith('.tmp-rows-'));
  assert.ok(path.basename(tableRename.from).startsWith('.tmp-roadmap-'));
});

test('usage exits 2: missing action, unknown action, missing draft, unreadable draft file', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-usage-');
  writeFixtureStore(dir, []);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }] }));

  let errLines = [];
  const captureErr = (s) => errLines.push(s);

  // Missing action
  errLines = [];
  assert.equal(handleSeedCommand({ draft: draftPath, root: dir, err: captureErr }), 2);
  assert.ok(errLines.some((l) => l.includes('action')));

  // Unknown action
  errLines = [];
  assert.equal(handleSeedCommand({ action: 'delete', draft: draftPath, root: dir, err: captureErr }), 2);

  // Missing draft
  errLines = [];
  assert.equal(handleSeedCommand({ action: 'check', root: dir, err: captureErr }), 2);

  // Unreadable draft file (does not exist)
  errLines = [];
  assert.equal(handleSeedCommand({ action: 'check', draft: path.join(dir, 'non-existent.json'), root: dir, err: captureErr }), 2);

  // JSON usage output shape
  let jsonLines = [];
  const captureJson = (s) => jsonLines.push(s);
  const code = handleSeedCommand({ action: 'bad', draft: draftPath, root: dir, json: true, out: captureJson });
  assert.equal(code, 2);
  const parsedUsage = JSON.parse(jsonLines[0]);
  assert.equal(parsedUsage.error, 'usage');
  assert.ok(parsedUsage.detail);

  // An unparsable draft file content is the finding seed-invalid-json (exit 1), not usage!
  const unparsableDraft = path.join(dir, 'invalid-json.json');
  fs.writeFileSync(unparsableDraft, '{ not json');
  let unparsableOut = '';
  const exitInvalid = handleSeedCommand({
    action: 'check',
    draft: unparsableDraft,
    root: dir,
    json: true,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => { unparsableOut += s + '\n'; },
  });
  assert.equal(exitInvalid, 1, 'invalid JSON is exit 1');
  const invalidRes = JSON.parse(unparsableOut.trim());
  assert.equal(invalidRes.ok, false);
  assert.equal(invalidRes.findings[0].rule, 'seed-invalid-json');
});

test('real-git case (NFR-002): gatherGitFacts against real repository', (t) => {
  const dir = tempDir(t, 'doflow-roadmap-seed-realgit-');
  cp.execFileSync('git', ['init', '-b', 'develop'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });

  // Commit a dummy file
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  cp.execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  cp.execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);

  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [{ id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] }] }));

  let outData = '';
  const exit = handleSeedCommand({
    action: 'check',
    draft: draftPath,
    root: dir,
    json: true,
    // NO gitFacts seam injected! Real gatherGitFacts is called!
    out: (s) => { outData += s + '\n'; },
  });

  assert.equal(exit, 0);
  const result = JSON.parse(outData.trim());
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, '114');
  assert.equal(result.rows[0].change, 'add');
});

function seedApplyFixture(t, { setting = 'on', envOff = false, noHome = false, sentinel = false } = {}) {
  const dir = tempDir(t, 'doflow-seed-runtime-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
    { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
  ] }));
  const home = path.join(dir, 'home');
  const config = path.join(home, '.config');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
  delete env.DOFLOW_AUTOPILOT_ENABLED;
  if (noHome) {
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
  } else {
    fs.mkdirSync(path.join(config, 'doflow'), { recursive: true });
    if (setting !== undefined) {
      const bytes = setting === 'bad-json' ? '{bad json' : JSON.stringify({ schema: 1, 'autopilot.enabled': setting });
      fs.writeFileSync(path.join(config, 'doflow', 'settings.json'), bytes);
    }
    if (sentinel) {
      fs.mkdirSync(path.join(config, 'doflow', 'autopilot'), { recursive: true });
      fs.writeFileSync(path.join(config, 'doflow', 'autopilot', 'off'), '');
    }
  }
  if (envOff) env.DOFLOW_AUTOPILOT_ENABLED = 'off';
  return { dir, config, env, draftPath };
}

function runSeedApply(fixture, { json = true, fsImpl = fs } = {}) {
  let out = '';
  let err = '';
  const exit = handleSeedCommand({
    action: 'apply', draft: fixture.draftPath, root: fixture.dir, env: fixture.env, json, fsImpl,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => { out += `${s}\n`; }, err: (s) => { err += `${s}\n`; },
  });
  return { exit, result: json ? JSON.parse((out || err).trim()) : null, out, err };
}

test('C-1 malformed store rows are rejected by judgement and apply/amend leave both files unchanged', (t) => {
  for (const [label, rows, includeRows] of [['missing', undefined, false], ['null', null, true], ['object', { lost: true }, true]]) {
    const dir = tempDir(t, `doflow-seed-c1-${label}-`);
    const storeDir = path.join(dir, 'agent-docs', 'roadmap');
    fs.mkdirSync(storeDir, { recursive: true });
    const doc = { schema: 1 };
    if (includeRows) doc.rows = rows;
    const storeBytes = `${JSON.stringify(doc, null, 2)}\n`;
    const tableBytes = 'original table\n';
    fs.writeFileSync(path.join(storeDir, 'rows.json'), storeBytes);
    fs.writeFileSync(path.join(storeDir, 'ROADMAP.md'), tableBytes);
    const draftPath = path.join(dir, 'draft.json');
    const draftBytes = JSON.stringify({ schema: 1, rows: [
      { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
    ] });
    fs.writeFileSync(draftPath, draftBytes);
    const judgement = judgeDraft({ draftRaw: draftBytes, seedRaw: storeBytes });
    assert.equal(judgement.ok, false, label);
    assert.ok(judgement.findings.some((f) => f.rule === 'seed-invalid' && f.rowId === undefined && f.rowIds === undefined));
    for (const action of ['apply', 'amend']) {
      let output = '';
      const exit = handleSeedCommand({ action, draft: draftPath, root: dir, json: true,
        gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
        readSwitch: () => ({ enabled: false, switch: null }), out: (s) => { output += `${s}\n`; } });
      assert.equal(exit, 1, `${label} ${action}`);
      assert.ok(JSON.parse(output.trim()).findings.some((f) => f.rule === 'seed-invalid'));
      assert.equal(fs.readFileSync(path.join(storeDir, 'rows.json'), 'utf8'), storeBytes);
      assert.equal(fs.readFileSync(path.join(storeDir, 'ROADMAP.md'), 'utf8'), tableBytes);
    }
  }
});

test('C-2 seed reader fails closed for env-off, invalid settings, no config home, and resolver faults', (t) => {
  const settings = require('../../src/runtime/settings/resolve.ts');
  const cases = [
    ['settings on plus env off', { setting: 'on', envOff: true }],
    ['unparsable settings', { setting: 'bad-json' }],
    ['no config home', { noHome: true }],
    ['resolver throws', { setting: 'on', resolverThrows: true }],
  ];
  for (const [label, options] of cases) {
    const fixture = seedApplyFixture(t, options);
    const original = settings.loadSettings;
    try {
      if (options.resolverThrows) settings.loadSettings = () => { throw new Error('resolver failed'); };
      const { exit, result } = runSeedApply(fixture);
      assert.equal(exit, 1, label);
      assert.equal(result.reason, 'needs-person', label);
      assert.equal(result.switch, null, label);
    } finally {
      settings.loadSettings = original;
    }
  }
  const text = runSeedApply(seedApplyFixture(t, { setting: 'on' }), { json: false });
  assert.equal(text.exit, 1);
  assert.match(text.err, /a person sets autopilot\.enabled to off/);
  assert.doesNotMatch(text.err, /DOFLOW_AUTOPILOT_ENABLED/);
  const noHomeText = runSeedApply(seedApplyFixture(t, { noHome: true }), { json: false });
  assert.equal(noHomeText.exit, 1);
  assert.match(noHomeText.err, /the config home \(none resolves: set HOME or XDG_CONFIG_HOME\)/);
  assert.doesNotMatch(noHomeText.err, /DOFLOW_AUTOPILOT_ENABLED/);
});

test('C-2 seed reader allows a durable off setting or sentinel', (t) => {
  for (const [label, options] of [
    ['settings off', { setting: 'off' }], ['sentinel', { setting: 'on', sentinel: true }],
  ]) {
    const { exit, result } = runSeedApply(seedApplyFixture(t, options));
    assert.equal(exit, 0, label);
    assert.equal(result.ok, true, label);
    assert.equal(result.writes, 2, label);
  }
  const unreadableSentinel = seedApplyFixture(t, { setting: 'on' });
  const fsImpl = { ...fs, statSync(file, ...args) {
    if (file === path.join(unreadableSentinel.config, 'doflow', 'autopilot', 'off')) {
      const error = new Error('sentinel stat denied');
      error.code = 'EACCES';
      throw error;
    }
    return fs.statSync(file, ...args);
  } };
  const result = runSeedApply(unreadableSentinel, { fsImpl });
  assert.equal(result.exit, 0, 'non-ENOENT sentinel stat error is present');
  assert.equal(result.result.writes, 2);
});

test('C-3 noncanonical writeSet paths are rejected by judgeDraft and apply', (t) => {
  const invalid = ['../outside', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'src/../shared/x.ts', 'a/..', '/'];
  for (const [index, writePath] of invalid.entries()) {
    const dir = tempDir(t, `doflow-seed-c3-${index}-`);
    const { jsonContent, tableContent } = writeFixtureStore(dir, [
      { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['src/shared/'] },
    ]);
    const draftPath = path.join(dir, 'draft.json');
    const draftBytes = JSON.stringify({ schema: 1, rows: [
      { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [], writeSet: [writePath] },
    ] });
    fs.writeFileSync(draftPath, draftBytes);
    const judgement = judgeDraft({ draftRaw: draftBytes, seedRaw: jsonContent });
    assert.equal(judgement.ok, false, writePath);
    assert.ok(judgement.findings.some((f) => f.rule === 'seed-invalid'), writePath);
    let output = '';
    const exit = handleSeedCommand({ action: 'apply', draft: draftPath, root: dir, json: true,
      gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
      readSwitch: () => ({ enabled: false, switch: null }), out: (s) => { output += `${s}\n`; } });
    assert.equal(exit, 1, writePath);
    assert.ok(JSON.parse(output.trim()).findings.some((f) => f.rule === 'seed-invalid'), writePath);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), jsonContent);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), tableContent);
  }
  for (const writePath of ['src/a.ts', 'src/dir/', 'a']) {
    const result = judgeDraft({ draftRaw: { schema: 1, rows: [
      { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [], writeSet: [writePath] },
    ] }, seedRaw: { schema: 1, rows: [{ id: '113', slug: '113-base', title: 'Base', class: 'feature', needs: [] }] } });
    assert.equal(result.ok, true, writePath);
  }
});

test('C-4 malformed writeSet values are findings, never overlap exceptions or writes', (t) => {
  for (const [index, writeSet] of [1, null, {}, [1], [null], { a: 1 }, 'x', []].entries()) {
    const dir = tempDir(t, `doflow-seed-c4-${index}-`);
    const { jsonContent, tableContent } = writeFixtureStore(dir, [
      { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['src/shared/'] },
    ]);
    const draftPath = path.join(dir, 'draft.json');
    const draftBytes = JSON.stringify({ schema: 1, rows: [
      { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [], writeSet },
    ] });
    fs.writeFileSync(draftPath, draftBytes);
    let judgement;
    assert.doesNotThrow(() => { judgement = judgeDraft({ draftRaw: draftBytes, seedRaw: jsonContent }); });
    assert.equal(judgement.ok, false, `writeSet ${index}`);
    let output = '';
    const exit = handleSeedCommand({ action: 'apply', draft: draftPath, root: dir, json: true,
      gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
      readSwitch: () => ({ enabled: false, switch: null }), out: (s) => { output += `${s}\n`; } });
    assert.equal(exit, 1);
    assert.ok(JSON.parse(output.trim()).findings.length > 0);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), jsonContent);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), tableContent);
  }
});

test('C-5 judgeDraft and parseSeed are total for adversarial JSON-shaped row fields', () => {
  const fields = ['id', 'slug', 'title', 'class', 'needs', 'writeSet', 'requires', 'hold',
    'verifyArgv', 'intent', 'acceptance', 'mergeCommit'];
  const values = [1, null, true, {}, [], [1], [null], { a: 1 }, { toString: null }, 'x\nx', 'x'.repeat(500)];
  const base = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] };
  const checkParser = (doc) => {
    const invalid = seedFindings(doc).length > 0;
    let parseError = null;
    try { parseSeed(doc); } catch (error) { parseError = error; }
    if (invalid) assert.equal(parseError?.name, 'SeedParseError');
    else assert.equal(parseError, null);
  };
  for (const field of fields) {
    for (const value of values) {
      const storeDoc = { schema: 1, rows: [{ ...base }] };
      const draftRow = { ...base, id: '114', slug: '114-add', title: 'Add', [field]: value };
      const draftDoc = { schema: 1, rows: [draftRow] };
      let draftJudgement;
      assert.doesNotThrow(() => { draftJudgement = judgeDraft({ draftRaw: draftDoc, seedRaw: storeDoc }); });
      if (seedFindings(draftDoc, { draft: true }).length > 0) {
        assert.equal(draftJudgement.ok, false, `draft ${field}`);
      }
      checkParser(draftDoc);

      const storeRow = { ...base, [field]: value };
      const amendedRow = { ...storeRow };
      if (typeof storeRow.id !== 'string') amendedRow.id = '113';
      if (amendedRow.id === '113' && typeof storeRow.id !== 'string') amendedRow.slug = '113-toy';
      const changedStore = { schema: 1, rows: [storeRow] };
      const amendedDraft = { schema: 1, rows: [amendedRow] };
      let storeJudgement;
      assert.doesNotThrow(() => { storeJudgement = judgeDraft({ draftRaw: amendedDraft, seedRaw: changedStore, op: 'amend' }); });
      if (seedFindings(changedStore).length > 0) assert.equal(storeJudgement.ok, false, `store ${field}`);
      checkParser(changedStore);
    }
  }
});

test('C-6 text output escapes adversarial values and stays within twelve lines', (t) => {
  const dir = tempDir(t, 'doflow-seed-c6-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['src/'] }]);
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [{
    id: '114\nforged', slug: '114-\nforged', title: 'bad\n'.repeat(30), class: 'bad\n'.repeat(30),
    needs: [], writeSet: ['src/\nforged.ts'],
  }] }));
  const stdout = [];
  const stderr = [];
  const exit = handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => stdout.push(s), err: (s) => stderr.push(s) });
  assert.equal(exit, 1);
  const lines = [...stdout, ...stderr];
  const combined = lines.join('\n');
  assert.ok(combined.split('\n').length <= 12);
  assert.ok(!lines.some((line) => line === 'bad' || line === 'forged' || line === 'forged.ts'));
  const overlapLine = lines.find((line) => line.startsWith('  overlap'));
  assert.ok(overlapLine);
  assert.ok(overlapLine.includes('src/\\nforged.ts'));
  assert.ok(!combined.includes('bad\n'));
});

test('C-10 rename faults clean temporary files and preserve the documented write order', (t) => {
  for (const failAt of [1, 2]) {
    const dir = tempDir(t, `doflow-seed-c10-${failAt}-`);
    const { jsonContent: oldStore, tableContent: oldTable } = writeFixtureStore(dir, [
      { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] },
    ]);
    const draftPath = path.join(dir, 'draft.json');
    fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows: [
      { id: '114', slug: '114-add', title: 'Add', class: 'feature', needs: [] },
    ] }));
    let renames = 0;
    const fsImpl = { ...fs, renameSync(from, to) {
      renames += 1;
      if (renames === failAt) throw new Error(`rename ${failAt} failed`);
      return fs.renameSync(from, to);
    } };
    assert.throws(() => handleSeedCommand({ action: 'apply', draft: draftPath, root: dir, fsImpl,
      gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
      readSwitch: () => ({ enabled: false, switch: null }), out: () => {} }), new RegExp(`rename ${failAt} failed`));
    const storeDir = path.join(dir, 'agent-docs', 'roadmap');
    assert.equal(fs.existsSync(path.join(dir, '.doflow', 'state', 'roadmap', 'lease.json')), false);
    assert.deepEqual(fs.readdirSync(storeDir).filter((name) => name.startsWith('.tmp-rows-') || name.startsWith('.tmp-roadmap-')), []);
    if (failAt === 1) {
      assert.equal(fs.readFileSync(path.join(storeDir, 'rows.json'), 'utf8'), oldStore);
      assert.equal(fs.readFileSync(path.join(storeDir, 'ROADMAP.md'), 'utf8'), oldTable);
    } else {
      const written = JSON.parse(fs.readFileSync(path.join(storeDir, 'rows.json'), 'utf8'));
      assert.deepEqual(written.rows.map((row) => row.id), ['113', '114']);
      assert.equal(fs.readFileSync(path.join(storeDir, 'ROADMAP.md'), 'utf8'), oldTable);
    }
  }
});

test('N-9 non-draft seed schema must be exactly 1', () => {
  for (const schema of [undefined, 2, '1']) {
    const doc = { rows: [] };
    if (schema !== undefined) doc.schema = schema;
    assert.ok(seedFindings(doc).some((f) => f.rule === 'seed-invalid' && f.rowId === undefined && f.message === "Seed 'schema' must be 1"));
  }
});

test('IC-003 text cap: land line plus many overlaps still prints at most twelve lines', (t) => {
  const dir = tempDir(t, 'doflow-seed-land-cap-');
  writeFixtureStore(dir, [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] }]);
  const rows = [];
  for (let n = 0; n < 12; n += 1) {
    rows.push({ id: String(200 + n), slug: `${200 + n}-r`, title: 'R', class: 'feature', needs: [], writeSet: ['src/shared/file.ts'] });
  }
  const draftPath = path.join(dir, 'draft.json');
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 1, rows }), 'utf8');
  const lines = [];
  const exit = handleSeedCommand({ action: 'check', draft: draftPath, root: dir, json: false,
    gitFacts: { developHead: 'h', merges: [], branches: [], unreadable: [] },
    out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(exit, 0);
  const all = lines.join('\n').split('\n');
  assert.ok(all.length <= 12, `got ${all.length} lines`);
  assert.ok(all[1].startsWith('  land (person only): '));
  assert.ok(all.some((line) => /\.\.\. \d+ more/.test(line)), 'overflow summary present');
});
