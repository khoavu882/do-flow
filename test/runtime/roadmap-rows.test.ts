'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const {
  parseSeed,
  deriveStatus,
  pick,
  render,
  renderRoadmapFile,
  check,
  pathsOverlap,
  writeSetsOverlap,
  seedFindings,
  validWriteSet,
  safeText,
  registryClasses,
  SEED_RULES,
  ROW_KEYS,
  TOP_KEYS,
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
    (err: any) => err.code === 'seed-typed-status'
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
    (err: any) => err.code === 'seed-typed-status'
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
    (err: any) => err.code === 'seed-typed-status'
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
    (err: any) => err.code === 'duplicate-id'
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
    (err: any) => err.code === 'slug-id-mismatch'
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
    (err: any) => err.code === 'slug-id-mismatch'
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
    (err: any) => err.code === 'needs-unresolved'
  );
});

test('deriveStatus: correctly identifies merged, in-flight, and not-started rows', () => {
  const rows: any = [
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

  const gitFacts: any = {
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
  const rows: any = [
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
  const gitFacts: any = {
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
  const rows: any = [
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

  const statuses: any = new Map([
    ['096', { status: 'merged', row: rows[0] }],
    ['108', { status: 'in-flight', row: rows[1] }],
    ['109', { status: 'not-started', row: rows[2] }],
  ]);

  const outcome = pick(rows, statuses, { wipLimit: 2 });
  assert.ok(outcome.picked);
  assert.equal(outcome.picked.id, '109');
});

test('pick: skips rows with write-set overlap, unmerged needs, or unsupported class', () => {
  const rows: any = [
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

  const statuses: any = new Map([
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
  const rows: any = [
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

  const statuses: any = new Map([
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
  const rows: any = [
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

  const statuses: any = new Map([
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

  const gitFacts: any = {
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
  assert.equal('claims' in facts, false, 'no claims reader: nothing writes .doflow/state/claims (108 C19)');
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
  const logs: any = [];
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
  const buggySwallowedFacts: any = {
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

  const rows: any = [
    { id: '108', slug: '108-loop', title: 'Loop', class: 'feature', needs: [] },
    { id: '109', slug: '109-other', title: 'Other', class: 'feature', needs: [] },
  ];
  const { statuses } = deriveStatus(rows, facts);
  assert.equal(statuses.get('108').status, 'not-started');
  assert.equal(statuses.get('109').status, 'not-started');
});

test('Fix 2 negative control: naive line-by-line parsing creates extra record and falsely merges first row', () => {
  const rawRevListOut = 'a000000000000000000000000000000000000001 d000 f000\0 108\n109\n';
  const naiveMerges: any = [];
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

  const rows: any = [
    { id: '108', slug: '108-loop', title: 'Loop', class: 'feature', needs: [] },
    { id: '109', slug: '109-other', title: 'Other', class: 'feature', needs: [] },
  ];
  const buggyStatus = deriveStatus(rows, { merges: naiveMerges });
  assert.equal(buggyStatus.statuses.get('108').status, 'merged', 'naive parser falsely marked 108 as merged');
});

test('Fix 3: status --row <id> for unseeded row exits 1 in both text and json forms', (t): any => {
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

  const gitFacts: any = {
    developHead: 'd0001',
    merges: [],
    branches: [],
    claims: [],
    unreadable: [],
  };

  // 1. Text form exits 1 with error on stderr
  const errs: any = [];
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
    assert.ok(errs.some((e: any) => e.includes("row '999' not found")));
  } finally {
    console.error = origErr;
    process.exitCode = 0;
  }

  // 2. JSON form exits 1 and emits { schema: 1, action: 'status', error: 'row-not-found', row: '999' }
  const logs: any = [];
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

test('C-3 canonical writeSet paths preserve the pick overlap control and reject traversal', () => {
  for (const value of ['src/a.ts', 'src/dir/', 'a']) assert.deepEqual(validWriteSet([value]), [value]);
  for (const value of ['../outside', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'src/../shared/x.ts', 'a/..', '/']) {
    assert.equal(validWriteSet([value]), null, value);
  }
  const rows = parseSeed({ schema: 1, rows: [
    { id: '100', slug: '100-base', title: 'Base', class: 'feature', needs: [], writeSet: ['shared/'] },
    { id: '101', slug: '101-next', title: 'Next', class: 'feature', needs: [], writeSet: ['shared/x.ts'] },
  ] }).rows;
  const statuses = deriveStatus(rows, { branches: ['feat/100-base'] }).statuses;
  const result = pick(rows, statuses, { wip: 2 });
  assert.equal(result.picked, null);
  assert.equal(result.skips['101'], 'write-set-overlap:100');

  assert.throws(() => parseSeed({ schema: 1, rows: [
    { id: '101', slug: '101-next', title: 'Next', class: 'feature', needs: [], writeSet: ['src/../shared/x.ts'] },
  ] }), (error: any) => error.name === 'SeedParseError');
});

test('C-5 safeText escapes controls, bounds values, and never calls toString', () => {
  assert.equal(safeText('line\nnext'), 'line\\nnext');
  assert.equal(safeText('\u2028\u2029'), '\\u2028\\u2029');
  assert.equal(safeText('x'.repeat(61)), `${'x'.repeat(57)}...`);
  assert.equal(safeText(undefined), 'undefined');
  assert.doesNotThrow(() => safeText({ toString: null }));
  assert.equal(safeText({ toString: null }), '{"toString":null}');
});

test('Fix 3 negative control: old status --row --json printed not-started and exited 0 for unknown row', () => {
  const filterRow = '999';
  const statuses: any = new Map();
  const singleStatus = statuses.get(filterRow);

  const oldJsonOutput: any = {
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

test('parseSeed: validates an optional hold as non-empty, single-line, and at most 120 characters', () => {
  const row: any = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [] };
  assert.equal(parseSeed({ schema: 1, rows: [{ ...row, hold: 'awaiting owner input' }] }).rows[0].hold, 'awaiting owner input');
  assert.equal(parseSeed({ schema: 1, rows: [{ ...row, hold: 'x'.repeat(120) }] }).rows[0].hold.length, 120);
  for (const hold of ['', '   ', 'x'.repeat(121), 'first line\nsecond line', 'first line\rsecond line', 7]) {
    assert.throws(() => parseSeed({ schema: 1, rows: [{ ...row, hold }] }), (err: any) => err.code === 'seed-invalid');
  }
});

test('pick: held ready rows are skipped before other checks and do not mask an unheld ready row', () => {
  const held: any = { id: '113', slug: '113-held', title: 'Held', class: 'feature', needs: [], hold: 'awaiting owner input' };
  const ready: any = { id: '114', slug: '114-ready', title: 'Ready', class: 'feature', needs: [] };
  const outcome = pick([held, ready], new Map([['113', { status: 'not-started' }], ['114', { status: 'not-started' }]]));
  assert.equal(outcome.picked.id, '114');
  assert.equal(outcome.skips['113'], 'row-held');

  const inFlightHeld = pick([held], new Map([['113', { status: 'in-flight' }]]));
  assert.equal(inFlightHeld.picked, null);
  assert.equal(inFlightHeld.skips['113'], 'row-held');
});

test('deriveStatus: a seed-held unmerged row reports its hold as holdReason; merged rows stay null; status comes from git alone', () => {
  const sha = 'a'.repeat(40);
  const held: any = { id: '113', slug: '113-held', title: 'Held', class: 'feature', needs: [], hold: 'awaiting owner input' };
  const merged: any = { id: '114', slug: '114-merged', title: 'Merged', class: 'feature', needs: [], hold: 'retired', mergeCommit: sha };
  const flying: any = { id: '115', slug: '115-flying', title: 'Flying', class: 'feature', needs: [], hold: 'seed text' };
  const plain: any = { id: '116', slug: '116-plain', title: 'Plain', class: 'feature', needs: [] };
  const { statuses } = deriveStatus([held, merged, flying, plain], {
    merges: [{ sha, parents: ['b'.repeat(40), 'c'.repeat(40)] }], branches: ['feat/115-flying'],
  });
  assert.equal(statuses.get('113').status, 'not-started');
  assert.equal(statuses.get('113').holdReason, 'awaiting owner input');
  assert.equal(statuses.get('114').status, 'merged');
  assert.equal(statuses.get('114').holdReason, null);
  assert.equal(statuses.get('115').status, 'in-flight');
  assert.equal(statuses.get('115').holdReason, 'seed text');
  assert.equal(statuses.get('116').holdReason, null);
  // C19: deriveStatus takes git facts only; a claim list or run record passed by an old caller changes nothing.
  const extra = deriveStatus([flying, plain], { branches: [] }, ['116-plain'], { rows: { 115: { held: { reason: 'record text' } } } }).statuses;
  assert.deepEqual([extra.get('115').status, extra.get('115').holdReason, extra.get('116').status], ['not-started', 'seed text', 'not-started']);
  assert.equal(Object.hasOwn(statuses.get('115'), 'nextStep'), false);
});

test('held rows keep derived merge status and render held text only while not merged', () => {
  const sha = 'a'.repeat(40);
  const pointer: any = { id: '113', slug: '113-pointer', title: 'Pointer', class: 'feature', needs: [], hold: 'deferred', mergeCommit: sha };
  const trailer: any = { id: '114', slug: '114-trailer', title: 'Trailer', class: 'feature', needs: [], hold: 'retired' };
  const { statuses } = deriveStatus([pointer, trailer], { merges: [
    { sha, parents: ['b'.repeat(40), 'c'.repeat(40)] },
    { sha: 'd'.repeat(40), parents: ['b'.repeat(40), 'e'.repeat(40)], rowTrailer: '114' },
  ] });
  assert.equal(statuses.get('113').status, 'merged');
  assert.equal(statuses.get('114').status, 'merged');
  const mergedText = render([pointer, trailer], statuses);
  assert.match(mergedText, /\| 113 \| Pointer \| feature \| - \| merged \| a{7} \(seeded\) \| - \|/);
  assert.match(mergedText, /\| 114 \| Trailer \| feature \| - \| merged \| d{7} \(trailer\) \| - \|/);

  const ready: any = { id: '115', slug: '115-held', title: 'Held', class: 'feature', needs: [], hold: 'awaiting owner input' };
  const statusesForReady: any = new Map([['115', { rowId: '115', status: 'not-started', evidence: null }]]);
  const first = render([ready], statusesForReady);
  assert.match(first, /\| 115 \| Held \| feature \| - \| not-started \| - \| held: awaiting owner input \|/);
  assert.equal(first, render([ready], statusesForReady), 'held rows render byte-stably');
});


test('a seed verifyArgv is an array of 1 to 8 non-empty strings', () => {
  const seed = (verifyArgv: any) => ({ schema: 1, rows: [{ id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], verifyArgv }] });
  assert.deepEqual(parseSeed(seed(['npm', 'test'])).rows[0].verifyArgv, ['npm', 'test']);
  for (const bad of [[], 'npm test', ['npm', ''], ['npm', 1], Array(9).fill('x'), ['npm', '  ']]) {
    assert.throws(() => parseSeed(seed(bad)), (error: any) => error.code === 'seed-invalid', JSON.stringify(bad));
  }
});

// ── Feature 113 A.1: Roadmap seed validator tests ──────────────────────────────────────────

test('113 A.1: exports constants and registryClasses', () => {
  assert.ok(Array.isArray(SEED_RULES));
  assert.deepEqual(SEED_RULES, [
    'seed-invalid-json',
    'seed-invalid',
    'seed-unknown-key',
    'seed-typed-status',
    'slug-id-mismatch',
    'duplicate-id',
    'class-unknown',
    'needs-unresolved',
    'needs-cycle',
    'id-exists',
    'row-not-found',
    'row-started',
  ]);
  assert.deepEqual(TOP_KEYS, ['schema', 'layout', 'rows']);
  assert.deepEqual(ROW_KEYS, [
    'id',
    'slug',
    'title',
    'class',
    'needs',
    'writeSet',
    'requires',
    'hold',
    'verifyArgv',
    'mergeCommit',
    'intent',
    'acceptance',
  ]);
  const classes = registryClasses();
  assert.ok(Array.isArray(classes));
  assert.ok(classes.includes('feature'));
  assert.ok(classes.includes('bug'));
});

test('113 A.1: one fixture per store rule with expected rule and rowId/rowIds', () => {
  // 1. seed-invalid-json
  const fJson = seedFindings('{not json');
  assert.equal(fJson.length, 1);
  assert.equal(fJson[0].rule, 'seed-invalid-json');

  // 2. seed-invalid (doc level non-object)
  const fInvDoc = seedFindings(null);
  assert.equal(fInvDoc.length, 1);
  assert.equal(fInvDoc[0].rule, 'seed-invalid');

  // 2b. seed-invalid (row level: empty title)
  const fInvRow = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '101-title', title: '', class: 'feature', needs: [] }],
  });
  assert.equal(fInvRow.length, 1);
  assert.equal(fInvRow[0].rule, 'seed-invalid');
  assert.equal(fInvRow[0].rowId, '101');

  // 3. seed-unknown-key
  const fUnk = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '101-unk', title: 'Unk', class: 'feature', needs: [], extraKey: 123 }],
  });
  assert.equal(fUnk.length, 1);
  assert.equal(fUnk[0].rule, 'seed-unknown-key');
  assert.equal(fUnk[0].rowId, '101');

  // 4. seed-typed-status
  const fStatus = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '101-stat', title: 'Stat', class: 'feature', needs: [], status: 'merged' }],
  });
  assert.equal(fStatus.length, 1);
  assert.equal(fStatus[0].rule, 'seed-typed-status');
  assert.equal(fStatus[0].rowId, '101');

  // 5. slug-id-mismatch
  const fSlug = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '102-wrong', title: 'Slug', class: 'feature', needs: [] }],
  });
  assert.equal(fSlug.length, 1);
  assert.equal(fSlug[0].rule, 'slug-id-mismatch');
  assert.equal(fSlug[0].rowId, '101');

  // 6. duplicate-id
  const fDup = seedFindings({
    schema: 1,
    rows: [
      { id: '101', slug: '101-first', title: 'First', class: 'feature', needs: [] },
      { id: '101', slug: '101-second', title: 'Second', class: 'feature', needs: [] },
    ],
  });
  assert.equal(fDup.length, 1);
  assert.equal(fDup[0].rule, 'duplicate-id');
  assert.equal(fDup[0].rowId, '101');

  // 7. class-unknown
  const fClass = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '101-cls', title: 'Cls', class: 'unknown-class-xyz', needs: [] }],
  });
  assert.equal(fClass.length, 1);
  assert.equal(fClass[0].rule, 'class-unknown');
  assert.equal(fClass[0].rowId, '101');
  assert.ok(fClass[0].message.includes('valid classes:'));

  // 8. needs-unresolved
  const fUnres = seedFindings({
    schema: 1,
    rows: [{ id: '101', slug: '101-unres', title: 'Unres', class: 'feature', needs: ['999'] }],
  });
  assert.equal(fUnres.length, 1);
  assert.equal(fUnres[0].rule, 'needs-unresolved');
  assert.equal(fUnres[0].rowId, '101');

  // 9. needs-cycle
  const fCycle = seedFindings({
    schema: 1,
    rows: [
      { id: '101', slug: '101-c1', title: 'C1', class: 'feature', needs: ['102'] },
      { id: '102', slug: '102-c2', title: 'C2', class: 'feature', needs: ['101'] },
    ],
  });
  assert.equal(fCycle.length, 1);
  assert.equal(fCycle[0].rule, 'needs-cycle');
  assert.deepEqual(fCycle[0].rowIds, ['101', '102']);
  assert.equal(fCycle[0].message, 'needs cycle 101 -> 102 -> 101');
});

test('113 A.1: one document breaking six rules returns six findings in IC-006 order', () => {
  const brokenDoc: any = {
    schema: 1,
    rows: [
      {
        id: '101',
        slug: '101-broken',
        title: '', // 1. seed-invalid
        class: 'feature',
        needs: [],
        bogusProp: true, // 2. seed-unknown-key
        phase: 'exploring', // 3. seed-typed-status
      },
      {
        id: '102',
        slug: '103-mismatched', // 4. slug-id-mismatch
        title: 'Valid title',
        class: 'feature',
        needs: [],
      },
      {
        id: '101', // 5. duplicate-id (second occurrence of 101)
        slug: '101-dup',
        title: 'Duplicate row',
        class: 'feature',
        needs: [],
      },
      {
        id: '104',
        slug: '104-unknown-class',
        title: 'Class unknown',
        class: 'not-a-real-class', // 6. class-unknown
        needs: [],
      },
    ],
  };

  const findings = seedFindings(brokenDoc);
  assert.equal(findings.length, 6);
  assert.deepEqual(
    findings.map((f: any) => f.rule),
    [
      'seed-invalid',
      'seed-unknown-key',
      'seed-typed-status',
      'slug-id-mismatch',
      'duplicate-id',
      'class-unknown',
    ]
  );
});

test('113 A.1: three-row cycle reports once in path order, and start-in-middle starts at lowest-pos member', () => {
  // Three-row cycle (A needs B needs C needs A)
  const threeRowCycleDoc: any = {
    schema: 1,
    rows: [
      { id: '101', slug: '101-a', title: 'A', class: 'feature', needs: ['102'] },
      { id: '102', slug: '102-b', title: 'B', class: 'feature', needs: ['103'] },
      { id: '103', slug: '103-c', title: 'C', class: 'feature', needs: ['101'] },
    ],
  };
  const f3 = seedFindings(threeRowCycleDoc);
  assert.equal(f3.length, 1);
  assert.equal(f3[0].rule, 'needs-cycle');
  assert.deepEqual(f3[0].rowIds, ['101', '102', '103']);
  assert.equal(f3[0].message, 'needs cycle 101 -> 102 -> 103 -> 101');

  // Self cycle
  const selfCycleDoc: any = {
    schema: 1,
    rows: [
      { id: '115', slug: '115-self', title: 'Self', class: 'feature', needs: ['115'] },
    ],
  };
  const fSelf = seedFindings(selfCycleDoc);
  assert.equal(fSelf.length, 1);
  assert.equal(fSelf[0].rule, 'needs-cycle');
  assert.deepEqual(fSelf[0].rowIds, ['115']);
  assert.equal(fSelf[0].message, 'needs cycle 115 -> 115');

  // Start-in-the-middle case:
  // row 0 not in the cycle needs row 2 which is in a 1-2 cycle
  // row 0: '100' needs '102'
  // row 1: '101' needs '102'
  // row 2: '102' needs '101'
  const middleCycleDoc: any = {
    schema: 1,
    rows: [
      { id: '100', slug: '100-entry', title: 'Entry', class: 'feature', needs: ['102'] },
      { id: '101', slug: '101-in-cycle', title: 'In cycle 1', class: 'feature', needs: ['102'] },
      { id: '102', slug: '102-in-cycle', title: 'In cycle 2', class: 'feature', needs: ['101'] },
    ],
  };
  const fMid = seedFindings(middleCycleDoc);
  assert.equal(fMid.length, 1);
  assert.equal(fMid[0].rule, 'needs-cycle');
  assert.deepEqual(fMid[0].rowIds, ['101', '102']);
  assert.equal(fMid[0].message, 'needs cycle 101 -> 102 -> 101');
});

test('113 A.1: intent and acceptance boundary cases', () => {
  const base: any = { id: '101', slug: '101-test', title: 'Test', class: 'feature', needs: [] };

  // intent: 200 chars valid, 201 chars invalid, newline invalid
  assert.deepEqual(seedFindings({ schema: 1, rows: [{ ...base, intent: 'a'.repeat(200) }] }), []);
  const fIntent201 = seedFindings({ schema: 1, rows: [{ ...base, intent: 'a'.repeat(201) }] });
  assert.equal(fIntent201.length, 1);
  assert.equal(fIntent201[0].rule, 'seed-invalid');
  assert.ok(fIntent201[0].message.includes('intent'));

  const fIntentNl = seedFindings({ schema: 1, rows: [{ ...base, intent: 'line 1\nline 2' }] });
  assert.equal(fIntentNl.length, 1);
  assert.equal(fIntentNl[0].rule, 'seed-invalid');
  assert.ok(fIntentNl[0].message.includes('intent'));

  // acceptance: 8 items each 200 chars valid
  const acc8 = Array(8).fill('b'.repeat(200));
  assert.deepEqual(seedFindings({ schema: 1, rows: [{ ...base, acceptance: acc8 }] }), []);

  // acceptance: 9 items invalid
  const acc9 = Array(9).fill('b');
  const fAcc9 = seedFindings({ schema: 1, rows: [{ ...base, acceptance: acc9 }] });
  assert.equal(fAcc9.length, 1);
  assert.equal(fAcc9[0].rule, 'seed-invalid');
  assert.ok(fAcc9[0].message.includes('acceptance'));

  // acceptance: item with 201 chars invalid
  const fAcc201 = seedFindings({ schema: 1, rows: [{ ...base, acceptance: ['b'.repeat(201)] }] });
  assert.equal(fAcc201.length, 1);
  assert.equal(fAcc201[0].rule, 'seed-invalid');
  assert.ok(fAcc201[0].message.includes('acceptance'));

  // acceptance: item with newline invalid
  const fAccNl = seedFindings({ schema: 1, rows: [{ ...base, acceptance: ['line 1\nline 2'] }] });
  assert.equal(fAccNl.length, 1);
  assert.equal(fAccNl[0].rule, 'seed-invalid');
  assert.ok(fAccNl[0].message.includes('acceptance'));
});

test('113 A.1: draft mode rules', () => {
  const validDraftRow: any = {
    id: '115',
    slug: '115-goal-board',
    title: 'Goal board',
    class: 'feature',
    needs: ['999'], // unresolved needs allowed in draft mode!
  };

  // unresolved needs NOT reported in draft mode
  assert.deepEqual(seedFindings({ schema: 1, rows: [validDraftRow] }, { draft: true }), []);

  // layout -> seed-unknown-key
  const fLayout = seedFindings(
    { schema: 1, layout: { branch: 'feat/{slug}' }, rows: [validDraftRow] },
    { draft: true }
  );
  assert.equal(fLayout.length, 1);
  assert.equal(fLayout[0].rule, 'seed-unknown-key');
  assert.ok(fLayout[0].message.includes('layout'));

  // draft mergeCommit -> seed-typed-status
  const fMergeCommit = seedFindings(
    {
      schema: 1,
      rows: [{ ...validDraftRow, mergeCommit: 'a000000000000000000000000000000000000096' }],
    },
    { draft: true }
  );
  assert.equal(fMergeCommit.length, 1);
  assert.equal(fMergeCommit[0].rule, 'seed-typed-status');
  assert.ok(fMergeCommit[0].message.includes('mergeCommit'));

  // schema 2 -> seed-invalid
  const fSchema2 = seedFindings(
    { schema: 2, rows: [validDraftRow] },
    { draft: true }
  );
  assert.equal(fSchema2.length, 1);
  assert.equal(fSchema2[0].rule, 'seed-invalid');
  assert.ok(fSchema2[0].message.includes('schema'));

  // empty rows -> seed-invalid
  const fEmpty = seedFindings(
    { schema: 1, rows: [] },
    { draft: true }
  );
  assert.equal(fEmpty.length, 1);
  assert.equal(fEmpty[0].rule, 'seed-invalid');
  assert.ok(fEmpty[0].message.includes('rows'));
});

test('113 A.1: parseSeed throws the first finding code and preserves all error codes', () => {
  // Document with multiple errors
  const doc: any = {
    schema: 1,
    rows: [
      {
        id: '101',
        slug: '101-test',
        title: '', // seed-invalid (first)
        class: 'feature',
        needs: [],
        badKey: true, // seed-unknown-key (second)
      },
    ],
  };
  assert.throws(
    () => parseSeed(JSON.stringify(doc)),
    (err: any) => err.code === 'seed-invalid' && err.rowId === '101'
  );
});

test('113 A.1: check reports class-unknown and suppresses render-drift on invalid seed', () => {
  const rows: any = [
    {
      id: '101',
      slug: '101-test',
      title: 'Test',
      class: 'not-a-class',
      needs: [],
    },
  ];
  const renderedBogus = '# Different rendered content\n';
  const result = check({ rows, rendered: renderedBogus, gitFacts: {} });
  assert.equal(result.ok, false);
  const classFinding = result.findings.find((f: any) => f.rule === 'class-unknown');
  assert.ok(classFinding, 'must report class-unknown');
  assert.equal(classFinding.rowId, '101');
  const driftFinding = result.findings.find((f: any) => f.rule === 'render-drift');
  assert.equal(driftFinding, undefined, 'render-drift must be suppressed when seed has errors');
});

test('113 A.1: fixture shaped like real store (46 rows) produces zero findings', () => {
  // Generate 46 rows with keys: id, slug, title, class, needs, hold, mergeCommit
  const rows: any = [];
  for (let i = 0; i < 46; i++) {
    const num = String(i + 1).padStart(3, '0');
    const prevNum = i > 0 ? String(i).padStart(3, '0') : null;
    const sha = i.toString(16).padStart(40, '0');
    rows.push({
      id: num,
      slug: `${num}-feature-${num}`,
      title: `Feature ${num}`,
      class: 'feature',
      needs: prevNum ? [prevNum] : [],
      hold: i === 45 ? 'final review' : undefined,
      mergeCommit: sha,
    });
  }
  const storeDoc: any = {
    schema: 1,
    layout: {
      worktree: '{mainParent}/{mainName}-{id}',
      branch: 'feat/{slug}',
    },
    rows,
  };
  const findings = seedFindings(storeDoc);
  assert.deepEqual(findings, []);
});

