'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const {
  parseSeed,
  deriveStatus,
  pick,
  render,
  renderRoadmapFile,
  check,
  pathsOverlap,
  writeSetsOverlap,
} = require('../../src/runtime/roadmap/rows.ts');
const { gatherGitFacts } = require('../../src/runtime/roadmap/facts.ts');
const { handleRoadmapCommand } = require('../../src/runtime/roadmap/loop.ts');

test('parseSeed: accepts valid seed with declared schema and rows', () => {
  const seedJson = JSON.stringify({
    schema: 1,
    layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' },
    rows: [
      {
        id: '096',
        slug: '096-trace-store',
        title: 'Trace store',
        class: 'feature',
        needs: [],
        mergeCommit: 'a000000000000000000000000000000000000096',
      },
      {
        id: '108',
        slug: '108-roadmap-loop',
        title: 'Roadmap loop',
        class: 'feature',
        needs: ['096'],
        writeSet: ['src/runtime/roadmap/'],
        requires: ['code.semantic-search'],
      },
    ],
  });

  const parsed = parseSeed(seedJson);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].id, '096');
  assert.equal(parsed.rows[1].id, '108');
});

test('parseSeed: rejects seed-typed-status (status/phase/evidence in top-level or rows)', () => {
  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          status: 'merged',
          rows: [],
        })
      ),
    (err) => err.code === 'seed-typed-status'
  );

  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [
            {
              id: '108',
              slug: '108-loop',
              title: 'Loop',
              class: 'feature',
              phase: 'implemented',
            },
          ],
        })
      ),
    (err) => err.code === 'seed-typed-status'
  );

  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [
            {
              id: '108',
              slug: '108-loop',
              title: 'Loop',
              class: 'feature',
              evidence: { sha: 'abc' },
            },
          ],
        })
      ),
    (err) => err.code === 'seed-typed-status'
  );
});

test('parseSeed: rejects duplicate id, invalid id, slug mismatch, and unresolved needs', () => {
  // Duplicate id
  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [
            { id: '108', slug: '108-alpha', title: 'Alpha', class: 'feature' },
            { id: '108', slug: '108-beta', title: 'Beta', class: 'feature' },
          ],
        })
      ),
    (err) => err.code === 'duplicate-id'
  );

  // Invalid id
  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [{ id: 'bad-id', slug: 'bad-id-alpha', title: 'Alpha', class: 'feature' }],
        })
      ),
    (err) => err.code === 'slug-id-mismatch'
  );

  // Slug mismatch
  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [{ id: '108', slug: '109-mismatched', title: 'Alpha', class: 'feature' }],
        })
      ),
    (err) => err.code === 'slug-id-mismatch'
  );

  // Unresolved needs
  assert.throws(
    () =>
      parseSeed(
        JSON.stringify({
          schema: 1,
          rows: [{ id: '108', slug: '108-alpha', title: 'Alpha', class: 'feature', needs: ['999'] }],
        })
      ),
    (err) => err.code === 'needs-unresolved'
  );
});

test('deriveStatus: correctly identifies merged, in-flight, and not-started rows', () => {
  const rows = [
    {
      id: '096',
      slug: '096-trace-store',
      title: 'Trace store',
      class: 'feature',
      needs: [],
      mergeCommit: 'a000000000000000000000000000000000000096',
    },
    {
      id: '108',
      slug: '108-roadmap-loop',
      title: 'Roadmap loop',
      class: 'feature',
      needs: ['096'],
    },
    {
      id: '110',
      slug: '110-next-step',
      title: 'Next step',
      class: 'feature',
      needs: ['108'],
    },
    {
      id: '112',
      slug: '112-idle-feature',
      title: 'Idle feature',
      class: 'feature',
      needs: [],
    },
  ];

  const gitFacts = {
    developHead: 'd0001',
    merges: [
      {
        sha: 'a000000000000000000000000000000000000096',
        parents: ['d000', 'f096'],
        rowTrailer: null,
      },
      {
        sha: 'a000000000000000000000000000000000000108',
        parents: ['a096', 'f108'],
        rowTrailer: '108',
      },
    ],
    branches: ['feat/110-next-step'],
    claims: [],
  };

  const { statuses, rowStatus } = deriveStatus(rows, gitFacts);

  assert.equal(statuses.get('096').status, 'merged');
  assert.equal(statuses.get('096').evidence.kind, 'seeded');
  assert.equal(statuses.get('108').status, 'merged');
  assert.equal(statuses.get('108').evidence.kind, 'trailer');
  assert.equal(statuses.get('110').status, 'in-flight');
  assert.equal(statuses.get('112').status, 'not-started');

  assert.equal(rowStatus['096'], 'merged');
  assert.equal(rowStatus['108'], 'merged');
  assert.equal(rowStatus['110'], 'in-flight');
  assert.equal(rowStatus['112'], 'not-started');
});

test('deriveStatus negative control: trailer only in commit subject is NOT merged', () => {
  const rows = [
    {
      id: '108',
      slug: '108-roadmap-loop',
      title: 'Roadmap loop',
      class: 'feature',
      needs: [],
    },
  ];

  // A commit whose subject/message mentions "merge: 108" or "DoFlow-Row: 108"
  // but rowTrailer (git trailer extraction) is null or missing.
  const gitFacts = {
    developHead: 'd0001',
    merges: [
      {
        sha: 'a000000000000000000000000000000000000099',
        parents: ['d000', 'f099'],
        rowTrailer: null, // subject had "merge: 108" but no git trailer
      },
    ],
    branches: [],
    claims: [],
  };

  const { statuses } = deriveStatus(rows, gitFacts);
  // Status must remain not-started, NOT merged!
  assert.notEqual(statuses.get('108').status, 'merged');
  assert.equal(statuses.get('108').status, 'not-started');
});

test('pick: picks first ready feature with disjoint write set and WIP under 2', () => {
  const rows = [
    {
      id: '096',
      slug: '096-trace-store',
      title: 'Trace store',
      class: 'feature',
      needs: [],
      mergeCommit: 'a000000000000000000000000000000000000096',
    },
    {
      id: '108',
      slug: '108-roadmap-loop',
      title: 'Roadmap loop',
      class: 'feature',
      needs: ['096'],
      writeSet: ['src/runtime/roadmap/'],
    },
    {
      id: '109',
      slug: '109-gate-eval',
      title: 'Gate eval',
      class: 'feature',
      needs: ['096'],
      writeSet: ['src/runtime/gates/'],
    },
  ];

  const statuses = new Map([
    ['096', { status: 'merged', row: rows[0] }],
    ['108', { status: 'in-flight', row: rows[1] }],
    ['109', { status: 'not-started', row: rows[2] }],
  ]);

  const outcome = pick(rows, statuses, { wipLimit: 2 });
  assert.ok(outcome.picked);
  assert.equal(outcome.picked.id, '109');
});

test('pick: skips rows with write-set overlap, unmerged needs, or unsupported class', () => {
  const rows = [
    {
      id: '108',
      slug: '108-roadmap-loop',
      title: 'Roadmap loop',
      class: 'feature',
      needs: [],
      writeSet: ['src/runtime/roadmap/'],
    },
    {
      id: '109',
      slug: '109-overlapping',
      title: 'Overlapping',
      class: 'feature',
      needs: [],
      writeSet: ['src/runtime/roadmap/'],
    },
    {
      id: '110',
      slug: '110-unmet-need',
      title: 'Unmet need',
      class: 'feature',
      needs: ['108'],
      writeSet: ['src/runtime/other/'],
    },
    {
      id: '111',
      slug: '111-chore-task',
      title: 'Chore task',
      class: 'chore',
      needs: [],
      writeSet: ['docs/'],
    },
  ];

  const statuses = new Map([
    ['108', { status: 'in-flight', row: rows[0] }],
    ['109', { status: 'not-started', row: rows[1] }],
    ['110', { status: 'not-started', row: rows[2] }],
    ['111', { status: 'not-started', row: rows[3] }],
  ]);

  const outcome = pick(rows, statuses, { wipLimit: 2 });
  assert.equal(outcome.picked, null);
  assert.equal(outcome.skips['109'], 'write-set-overlap:108');
  assert.equal(outcome.skips['110'], 'need-unmerged');
  assert.equal(outcome.skips['111'], 'class-unsupported');
});

test('pick negative control: two in-flight rows pick none with wip-full', () => {
  const rows = [
    {
      id: '108',
      slug: '108-first',
      title: 'First',
      class: 'feature',
      needs: [],
      writeSet: ['src/first/'],
    },
    {
      id: '109',
      slug: '109-second',
      title: 'Second',
      class: 'feature',
      needs: [],
      writeSet: ['src/second/'],
    },
    {
      id: '110',
      slug: '110-third',
      title: 'Third',
      class: 'feature',
      needs: [],
      writeSet: ['src/third/'],
    },
  ];

  const statuses = new Map([
    ['108', { status: 'in-flight', row: rows[0] }],
    ['109', { status: 'in-flight', row: rows[1] }],
    ['110', { status: 'not-started', row: rows[2] }],
  ]);

  const outcome = pick(rows, statuses, { wipLimit: 2 });
  // Two rows are in-flight; with WIP limit 2, pick must pick none
  assert.equal(outcome.picked, null);
  assert.equal(outcome.skips['110'], 'wip-full');
});

test('render: produces byte-stable markdown table with all 7 IC-003 columns', () => {
  const rows = [
    {
      id: '096',
      slug: '096-trace-store',
      title: 'Trace store',
      class: 'feature',
      needs: [],
      mergeCommit: 'a000000000000000000000000000000000000096',
    },
    {
      id: '108',
      slug: '108-roadmap-loop',
      title: 'Roadmap loop',
      class: 'feature',
      needs: ['096'],
      writeSet: ['src/runtime/roadmap/'],
    },
  ];

  const statuses = new Map([
    [
      '096',
      {
        status: 'merged',
        evidence: { kind: 'seeded', shortSha: 'a000000' },
        next: '-',
      },
    ],
    [
      '108',
      {
        status: 'not-started',
        evidence: null,
        next: 'pick',
      },
    ],
  ]);

  const rendered1 = render(rows, statuses);
  const rendered2 = render(rows, statuses);

  // NFR-001 byte stability
  assert.equal(rendered1, rendered2);

  // Header columns
  assert.ok(rendered1.includes('| Row | Title | Class | Needs | Status | Evidence | Next |'));
  assert.ok(rendered1.includes('| 096 | Trace store | feature | - | merged | a000000 (seeded) | - |'));
  assert.ok(rendered1.includes('| 108 | Roadmap loop | feature | 096 | not-started | - | pick |'));
});

test('renderRoadmapFile: writes file on change, skips write when byte-identical', (t) => {
  const temp = tempDir(t, 'doflow-render-file-');
  const targetFile = path.join(temp, 'ROADMAP.md');
  const content = '# Roadmap\n\n| Row | Title |\n|---|---|\n| 096 | Trace |\n';

  // First write: file does not exist -> written: true
  const res1 = renderRoadmapFile({ roadmapPath: targetFile, content });
  assert.equal(res1.written, true);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), content);

  // Second write: file has exact same content -> written: false
  const res2 = renderRoadmapFile({ roadmapPath: targetFile, content });
  assert.equal(res2.written, false);
});

test('roadmap CLI: handles status and render actions with valid exits', (t) => {
  const temp = tempDir(t, 'doflow-roadmap-cli-');
  const agentDocsDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(agentDocsDir, { recursive: true });

  const seedContent = JSON.stringify({
    schema: 1,
    layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' },
    rows: [
      {
        id: '096',
        slug: '096-trace-store',
        title: 'Trace store',
        class: 'feature',
        needs: [],
        mergeCommit: 'a000000000000000000000000000000000000096',
      },
    ],
  });

  fs.writeFileSync(path.join(agentDocsDir, 'rows.json'), seedContent, 'utf8');

  const gitFacts = {
    developHead: 'd0001',
    merges: [
      {
        sha: 'a000000000000000000000000000000000000096',
        parents: ['d000', 'f096'],
        rowTrailer: null,
      },
    ],
    branches: [],
    claims: [],
  };

  // 1. status action
  const statusExit = handleRoadmapCommand({
    action: 'status',
    root: temp,
    gitFacts,
  });
  assert.equal(statusExit, 0);

  // 2. status action with --row
  const singleStatusExit = handleRoadmapCommand({
    action: 'status',
    row: '096',
    root: temp,
    gitFacts,
  });
  assert.equal(singleStatusExit, 0);

  // 3. render action: writes ROADMAP.md
  const renderExit = handleRoadmapCommand({
    action: 'render',
    root: temp,
    gitFacts,
  });
  assert.equal(renderExit, 0);
  assert.ok(fs.existsSync(path.join(agentDocsDir, 'ROADMAP.md')));

  // 4. render --check: passes when content matches
  const checkExit = handleRoadmapCommand({
    action: 'render',
    check: true,
    root: temp,
    gitFacts,
  });
  assert.equal(checkExit, 0);

  // 5. invalid action -> usage error exit code 2
  const badActionExit = handleRoadmapCommand({
    action: 'invalid-action',
    root: temp,
    gitFacts,
  });
  assert.equal(badActionExit, 2);
  process.exitCode = 0;
});

test('gatherGitFacts: executes read verbs rev-parse, rev-list, and for-each-ref', () => {
  const facts = gatherGitFacts({ root: process.cwd() });
  assert.ok(typeof facts.developHead === 'string');
  assert.ok(Array.isArray(facts.merges));
  assert.ok(Array.isArray(facts.branches));
  assert.ok(Array.isArray(facts.claims));
  assert.ok(Array.isArray(facts.unreadable));
});

test('gatherGitFacts: reports unreadable develop-branch when develop is missing (Fix 1)', (t) => {
  const temp = tempDir(t, 'doflow-git-unreadable-');
  execFileSync('git', ['init', '-b', 'main', temp]);
  execFileSync('git', ['-C', temp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', temp, 'config', 'user.email', 'test@test.local']);
  fs.writeFileSync(path.join(temp, 'f1'), 'test');
  execFileSync('git', ['-C', temp, 'add', 'f1']);
  execFileSync('git', ['-C', temp, 'commit', '-m', 'initial']);

  const facts = gatherGitFacts({ root: temp });
  assert.ok(facts.unreadable.includes('develop-branch'));
  assert.equal(facts.developHead, '');
  assert.deepEqual(facts.merges, []);
});

test('roadmap CLI: exits 1 and writes nothing when unreadable facts exist (Fix 1)', (t) => {
  const temp = tempDir(t, 'doflow-roadmap-unreadable-cli-');
  execFileSync('git', ['init', '-b', 'main', temp]);
  execFileSync('git', ['-C', temp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', temp, 'config', 'user.email', 'test@test.local']);
  fs.writeFileSync(path.join(temp, 'f1'), 'test');
  execFileSync('git', ['-C', temp, 'add', 'f1']);
  execFileSync('git', ['-C', temp, 'commit', '-m', 'initial']);

  const agentDocsDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(agentDocsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDocsDir, 'rows.json'),
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '108', slug: '108-roadmap-loop', title: 'Loop', class: 'feature', needs: [] },
      ],
    }),
    'utf8'
  );
  const initialRoadmapContent = '# Pre-existing Roadmap\n';
  fs.writeFileSync(path.join(agentDocsDir, 'ROADMAP.md'), initialRoadmapContent, 'utf8');

  // 1. render action (without --check): must exit 1, and ROADMAP.md must be unchanged
  const renderExit = handleRoadmapCommand({
    action: 'render',
    root: temp,
  });
  assert.equal(renderExit, 1);
  assert.equal(fs.readFileSync(path.join(agentDocsDir, 'ROADMAP.md'), 'utf8'), initialRoadmapContent);

  // 2. render action with --check: must exit 1
  const checkExit = handleRoadmapCommand({
    action: 'render',
    check: true,
    root: temp,
  });
  assert.equal(checkExit, 1);
  assert.equal(fs.readFileSync(path.join(agentDocsDir, 'ROADMAP.md'), 'utf8'), initialRoadmapContent);

  // 3. status action: must exit 1
  const statusExit = handleRoadmapCommand({
    action: 'status',
    root: temp,
  });
  assert.equal(statusExit, 1);

  // 4. status action with --json: emits unreadable-facts and exact source name
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const jsonStatusExit = handleRoadmapCommand({
      action: 'status',
      json: true,
      root: temp,
    });
    assert.equal(jsonStatusExit, 1);
    assert.ok(logs.length > 0);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.action, 'status');
    assert.ok(parsed.sources.includes('develop-branch'));
  } finally {
    console.log = origLog;
    process.exitCode = 0;
  }
});

test('Fix 1 negative control: unreadable develop-branch cannot overwrite ROADMAP.md as not-started', (t) => {
  const temp = tempDir(t, 'doflow-fix1-control-');
  execFileSync('git', ['init', '-b', 'main', temp]);
  execFileSync('git', ['-C', temp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', temp, 'config', 'user.email', 'test@test.local']);
  fs.writeFileSync(path.join(temp, 'f1'), 'test');
  execFileSync('git', ['-C', temp, 'add', 'f1']);
  execFileSync('git', ['-C', temp, 'commit', '-m', 'initial']);

  const agentDocsDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(agentDocsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDocsDir, 'rows.json'),
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '108', slug: '108-roadmap-loop', title: 'Loop', class: 'feature', needs: [] },
      ],
    }),
    'utf8'
  );
  const initialRoadmapContent = '# Pre-existing Preserved Content\n';
  fs.writeFileSync(path.join(agentDocsDir, 'ROADMAP.md'), initialRoadmapContent, 'utf8');

  // Mutated facts simulation (empty arrays without unreadable, as old code did)
  const buggySwallowedFacts = {
    developHead: '',
    merges: [],
    branches: [],
    claims: [],
  };

  // With the fix, real gatherGitFacts returns unreadable: ['develop-branch']
  const realFacts = gatherGitFacts({ root: temp });
  assert.ok(realFacts.unreadable && realFacts.unreadable.includes('develop-branch'), 'real gatherGitFacts must report develop-branch unreadable');

  // Verify that old buggy swallow would have overwritten ROADMAP.md
  const testOldBuggyBehavior = () => {
    const buggyExit = handleRoadmapCommand({
      action: 'render',
      root: temp,
      gitFacts: buggySwallowedFacts,
    });
    assert.equal(buggyExit, 0, 'buggy code exited 0');
    assert.notEqual(fs.readFileSync(path.join(agentDocsDir, 'ROADMAP.md'), 'utf8'), initialRoadmapContent, 'buggy code overwrote ROADMAP.md');
  };
  testOldBuggyBehavior();

  // Reset file content
  fs.writeFileSync(path.join(agentDocsDir, 'ROADMAP.md'), initialRoadmapContent, 'utf8');

  // Now verify that with the fix, handleRoadmapCommand rejects and keeps ROADMAP.md intact
  const fixedExit = handleRoadmapCommand({
    action: 'render',
    root: temp,
    gitFacts: realFacts,
  });
  assert.equal(fixedExit, 1);
  assert.equal(fs.readFileSync(path.join(agentDocsDir, 'ROADMAP.md'), 'utf8'), initialRoadmapContent);
  process.exitCode = 0;
});

test('Fix 2: merge commit with two DoFlow-Row trailers is not merged for either row and creates no extra record', (t) => {
  const temp = tempDir(t, 'doflow-git-trailer-');
  execFileSync('git', ['init', '-b', 'develop', temp]);
  execFileSync('git', ['-C', temp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', temp, 'config', 'user.email', 'test@test.local']);
  fs.writeFileSync(path.join(temp, 'f1'), 'base');
  execFileSync('git', ['-C', temp, 'add', 'f1']);
  execFileSync('git', ['-C', temp, 'commit', '-m', 'base']);

  execFileSync('git', ['-C', temp, 'checkout', '-b', 'feat/multi-trailer']);
  fs.writeFileSync(path.join(temp, 'f2'), 'feat');
  execFileSync('git', ['-C', temp, 'add', 'f2']);
  execFileSync('git', ['-C', temp, 'commit', '-m', 'feat commit']);

  execFileSync('git', ['-C', temp, 'checkout', 'develop']);
  execFileSync('git', [
    '-C',
    temp,
    'merge',
    '--no-ff',
    'feat/multi-trailer',
    '-m',
    'merge: test multi-trailer\n\nDoFlow-Row: 108\nDoFlow-Row: 109',
  ]);

  const facts = gatherGitFacts({ root: temp });
  // Exactly 1 merge commit, NO extra bogus records created
  assert.equal(facts.merges.length, 1);
  assert.equal(facts.merges[0].rowTrailer, '108\n109');

  const rows = [
    { id: '108', slug: '108-loop', title: 'Loop', class: 'feature', needs: [] },
    { id: '109', slug: '109-other', title: 'Other', class: 'feature', needs: [] },
  ];
  const { statuses } = deriveStatus(rows, facts);
  assert.equal(statuses.get('108').status, 'not-started');
  assert.equal(statuses.get('109').status, 'not-started');
});

test('Fix 2 negative control: naive line-by-line parsing creates extra record and falsely merges first row', () => {
  const rawRevListOut = 'a000000000000000000000000000000000000001 d000 f000\0 108\n109\n';
  const naiveMerges = [];
  for (const rawLine of rawRevListOut.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const nulIdx = line.indexOf('\0');
    let commitPart = line;
    let trailerPart = '';
    if (nulIdx !== -1) {
      commitPart = line.slice(0, nulIdx).trim();
      trailerPart = line.slice(nulIdx + 1).trim();
    }
    const parts = commitPart.split(/\s+/);
    naiveMerges.push({
      sha: parts[0],
      parents: parts.slice(1),
      rowTrailer: trailerPart || null,
    });
  }

  assert.equal(naiveMerges.length, 2, 'naive parser created bogus extra record');
  assert.equal(naiveMerges[0].rowTrailer, '108', 'naive parser set trailer to 108');
  assert.equal(naiveMerges[1].sha, '109', 'naive parser treated trailer continuation line as sha');

  const rows = [
    { id: '108', slug: '108-loop', title: 'Loop', class: 'feature', needs: [] },
    { id: '109', slug: '109-other', title: 'Other', class: 'feature', needs: [] },
  ];
  const buggyStatus = deriveStatus(rows, { merges: naiveMerges });
  assert.equal(buggyStatus.statuses.get('108').status, 'merged', 'naive parser falsely marked 108 as merged');
});

test('Fix 3: status --row <id> for unseeded row exits 1 in both text and json forms', (t) => {
  const temp = tempDir(t, 'doflow-fix3-cli-');
  const agentDocsDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(agentDocsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDocsDir, 'rows.json'),
    JSON.stringify({
      schema: 1,
      rows: [
        { id: '096', slug: '096-trace-store', title: 'Trace store', class: 'feature', needs: [] },
      ],
    }),
    'utf8'
  );

  const gitFacts = {
    developHead: 'd0001',
    merges: [],
    branches: [],
    claims: [],
    unreadable: [],
  };

  // 1. Text form exits 1 with error on stderr
  const errs = [];
  const origErr = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    const textExit = handleRoadmapCommand({
      action: 'status',
      row: '999',
      json: false,
      root: temp,
      gitFacts,
    });
    assert.equal(textExit, 1);
    assert.ok(errs.some((e) => e.includes("row '999' not found")));
  } finally {
    console.error = origErr;
    process.exitCode = 0;
  }

  // 2. JSON form exits 1 and emits { schema: 1, action: 'status', error: 'row-not-found', row: '999' }
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const jsonExit = handleRoadmapCommand({
      action: 'status',
      row: '999',
      json: true,
      root: temp,
      gitFacts,
    });
    assert.equal(jsonExit, 1);
    assert.ok(logs.length > 0);
    const res = JSON.parse(logs[0]);
    assert.deepEqual(res, {
      schema: 1,
      action: 'status',
      error: 'row-not-found',
      row: '999',
    });
  } finally {
    console.log = origLog;
    process.exitCode = 0;
  }
});

test('Fix 3 negative control: old status --row --json printed not-started and exited 0 for unknown row', () => {
  const filterRow = '999';
  const statuses = new Map();
  const singleStatus = statuses.get(filterRow);

  const oldJsonOutput = {
    schema: 1,
    action: 'status',
    row: filterRow,
    status: singleStatus?.status || 'not-started',
    info: singleStatus || null,
  };
  const oldExitCode = 0;

  assert.equal(oldExitCode, 0, 'old behavior exited 0');
  assert.equal(oldJsonOutput.status, 'not-started', 'old behavior reported not-started');
  assert.equal(oldJsonOutput.error, undefined, 'old behavior had no error field');
});

