'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { tempDir } = require('../helper/tmp');
const {
  render,
  renderRoadmapFile,
  deriveStatus,
  SEED_RULES,
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
  ]);
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
  assert.ok(textPersonErr.includes('turn autopilot off first'));

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
  assert.equal(leaseRes.writes, 0);

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
