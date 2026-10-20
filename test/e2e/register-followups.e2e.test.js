'use strict';
// register-followups.e2e.test.js — feature 045 acceptance scenarios (requirement §6), NFR-001 legacy
// equivalence, RK5 slug acceptance and NFR-004, driven through the checkout's own dispatcher
// `core/shared/scripts/doflow/bin/doflow-run` (never ~/.doflow) against scratch git repos. Needs no
// model and no network.
//
// Three comparisons read the v1.12.0 tag (validator output twice, hook wiring). Each also carries a
// literal expectation that needs no tag. A missing tag fails under CI (CI fetches full history) and
// marks the test skipped, with the reason, on a local clone.
//
// This file: US1 (compaction, tokens, escaping), US3, US4, NFR-001, NFR-004. Siblings: register-followups-tasks
// (US2, US5) and register-followups-slugs (US6, RK5). Helpers: register-followups.shared.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO, SKIP, git, makeRepo, run, decision, writeFiles, read, featureDir, initRegister, addBatch, haveTagOrSkip, gitShow, squash, HISTORY, v1120Validate,
} = require('./register-followups.shared');
const { claudeDoorFindings, hookReachabilityFindings } = require('../helper/hook-reachability');
const { tempDir } = require('../helper/tmp');

// ── US1: compaction ─────────────────────────────────────────────────────────────────────────────────

describe('Scenario: An unclosed comment after History does not stall compaction (FR-001, FR-002)', { skip: SKIP }, () => {
  const slug = '046-compaction';
  const REQ_BAD = `# Req\n\n## 1. Overview\n\ntext\n\n${HISTORY}\n<!-- never closed\n`;
  const PLAN = `# Plan\n\n## 1. Approach\n\ntext\n\n${HISTORY}`;

  test('plan.md is compacted and requirement.md is reported, byte-identical (decision compact)', () => {
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    const dir = featureDir(repo, slug);
    writeFiles(dir, { 'intention/requirement.md': REQ_BAD, 'plan.md': PLAN });

    const res = decision(repo, ['--action', 'compact']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.strictEqual(res.json.status, 'partial');
    assert.strictEqual(res.json.finding, 'compaction-failed');
    assert.deepStrictEqual(res.json.moved.map((m) => [m.artifact, m.lines]), [['plan.md', 2]], 'moved is still reported');
    assert.strictEqual(res.json.failed.length, 1);
    assert.match(res.json.failed[0].artifact, /requirement\.md$/);
    assert.match(res.json.failed[0].message, /never closed|unchanged/);
    assert.strictEqual(read(path.join(dir, 'intention', 'requirement.md')), REQ_BAD, 'a refused artifact is never modified');
    assert.ok(read(path.join(dir, 'decisions', 'history', 'plan.md')).includes('- 2026-10-02 b'));
    assert.ok(!read(path.join(dir, 'plan.md')).includes('- 2026-10-02 b'));
  });

  test('the handoff compaction field reports partial with failed[] and moved', () => {
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    writeFiles(featureDir(repo, slug), { 'intention/requirement.md': REQ_BAD, 'plan.md': PLAN });
    const res = run(repo, ['orchestrate', '--action', 'handoff', '--task-id', slug, '--task-class', 'feature',
      '--calling-skill', 'do-brainstorm', '--note', 'discovery done', '--json']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.strictEqual(res.json.compaction.status, 'partial');
    assert.deepStrictEqual(res.json.compaction.moved.map((m) => m.artifact), ['plan.md']);
    assert.strictEqual(res.json.compaction.failed.length, 1);
  });

  test('an unclosed construct after the History section, or in an artifact with no History, refuses nothing (FR-001)', () => {
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    const dir = featureDir(repo, slug);
    const afterHistory = `# Req\n\n## 1. Overview\n\ntext\n\n${HISTORY}\n## 10. Appendix\n\n<!-- never closed\n`;
    const noHistory = '# Plan\n\n## 1. Approach\n\n```js\nnever closed\n';
    writeFiles(dir, { 'intention/requirement.md': afterHistory, 'plan.md': noHistory });
    const res = decision(repo, ['--action', 'compact']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.strictEqual(res.json.status, 'compacted');
    assert.deepStrictEqual(res.json.failed, []);
    assert.deepStrictEqual(res.json.moved.map((m) => m.artifact), ['requirement.md']);
    assert.strictEqual(read(path.join(dir, 'plan.md')), noHistory, 'no History section: untouched');
  });
});

// ── US1: validator tokens ───────────────────────────────────────────────────────────────────────────

describe('Scenario: Links are not unknown references (FR-003)', { skip: SKIP }, () => {
  const slug = '046-links';
  const repo = makeRepo({ branch: `feat/${slug}` });
  initRegister(repo, slug);
  writeFiles(featureDir(repo, slug), {
    'intention/requirement.md': '# Req\n\n## 1. Overview\n\ntext\n\n## 9. History\n\nNone — initial version.\n',
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'See https://example.test/docs/DEC-099 for the write-up.',
      'The note lives in notes/DEC-098.md beside the code.',
      '[linked](../decisions/DEC-097.md) is a link target.',
      '',
      '## 9. History', '', 'None — initial version.', '',
    ].join('\n'),
  });
  assert.strictEqual(addBatch(repo, 'links', [{ topic: 'store', statement: 'sqlite' }]).status, 0);

  test('a URL and a file path ending in an unregistered decision-shaped id raise no finding', () => {
    const res = run(repo, ['validate', '--json']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.deepStrictEqual(res.json.findings, []);
  });

  test('a DEC-001/DEC-099 pair in prose is still checked; only the URL/path word is exempt', () => {
    const file = path.join(featureDir(repo, slug), 'design', 'design.md');
    fs.writeFileSync(file, read(file).replace('\n## 9. History',
      'Pair DEC-001/DEC-099 in prose.\nBare DEC-096 in prose.\n\n## 9. History'));
    const res = run(repo, ['validate', '--json']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.deepStrictEqual(res.json.findings.map((f) => [f.rule, f.id]), [['unknown', 'DEC-099'], ['unknown', 'DEC-096']]);
  });
});

describe('Scenario: Older folders unchanged — a fenced History example (FR-014, NFR-001)', { skip: SKIP }, () => {
  const specs = [
    '# Specs', '', '## 1. Contracts', '',
    '```markdown', '## 9. History', '```', '',
    '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
    '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
  ].join('\n');

  const MIN = {
    'intention/requirement.md': '# Req\n\n## 1. Overview\n\ntext\n\n## 9. History\n\nNone — initial version.\n',
    'design/design.md': '# Design\n\n## 1. Choices\n\ntext\n\n## 9. History\n\nNone — initial version.\n',
  };

  test('with a register a fenced "## 9. History" does not hide the missing History entry', () => {
    const slug = '046-fence-register';
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    writeFiles(featureDir(repo, slug), { ...MIN, 'design/specs.md': specs });
    const res = run(repo, ['validate', '--json']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.deepStrictEqual(res.json.findings.map((f) => [f.rule, f.id]), [['history', 'IC-001']]);
  });

  test('without a register the same folder validates clean, byte-identical to the v1.12.0 validator', (t) => {
    const slug = '012-pre-register';
    const repo = makeRepo({ branch: `feat/${slug}` });
    writeFiles(featureDir(repo, slug), { ...MIN, 'design/specs.md': specs });
    const now = run(repo, ['validate', '--json']);
    assert.strictEqual(now.status, 0, now.stdout + now.stderr);
    assert.deepStrictEqual(now.json.findings, []);
    if (haveTagOrSkip(t, 'v1.12.0')) assert.strictEqual(now.stdout, v1120Validate(repo), 'identical to v1.12.0 output');
  });
});

// ── US1: live-view escaping ─────────────────────────────────────────────────────────────────────────

describe('Scenario: Backslash and pipe in a statement (FR-004)', { skip: SKIP }, () => {
  test('each statement occupies exactly one row whose cell, read back as markdown, equals the statement', () => {
    const slug = '046-cells';
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    const statements = ['a\\|b', 'only|pipe', 'only\\backslash', 'ends with a backslash\\', 'angle <b> | and \\\\ both'];
    const res = addBatch(repo, 'cells', statements.map((statement, i) => ({ topic: `t${i}`, statement })));
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);

    const rows = read(path.join(featureDir(repo, slug), 'decisions.md')).split('\n').filter((l) => l.startsWith('| DEC-'));
    assert.strictEqual(rows.length, statements.length, 'one row per decision');
    // The markdown reading of a row: split on pipes not escaped by a backslash, then undo the escapes.
    const cells = splitRow;
    statements.forEach((statement, i) => {
      const parsed = cells(rows[i]);
      assert.strictEqual(parsed[0], `DEC-00${i + 1}`);
      assert.strictEqual(parsed[2], statement, `row ${i + 1} renders the statement as written: ${rows[i]}`);
    });
    assert.ok(rows[0].includes('a\\\\\\|b'), `a\\|b is escaped backslash-first: ${rows[0]}`);
  });
});

/** Splits a markdown table row on unescaped pipes and unescapes `\\`, `\|` and `\<` in each cell. */
function splitRow(row) {
  const cells = [];
  let cur = '';
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length && /[\\|<]/.test(body[i + 1])) { cur += body[i + 1]; i += 1; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ── US3: change scope ───────────────────────────────────────────────────────────────────────────────

describe('Scenario: Change scope is answerable after planning (FR-008, FR-009)', { skip: SKIP }, () => {
  const slug = '046-scope';
  const PLAN = [
    '# Plan', '', '## 8. Tasks', '',
    '- [ ] A.1 [P] Do the thing — owner: core-implementer; files: src/in.js, test/in.test.js, test/fixtures/dir/',
    '- [ ] A.2 Second — owner: core-implementer; files: `docs/guide.md`; depends A.1', '',
  ].join('\n');

  const tier = (repo) => {
    const res = run(repo, ['verify', '--task-id', 'A.1', '--risk', 'LOW', '--json']);
    assert.ok(res.json, res.stdout + res.stderr);
    return res.json.tiers.find((t) => t.id === 'change-scope');
  };
  const commit = (repo, file) => {
    writeFiles(repo, { [file]: 'changed\n' });
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', `touch ${file}`);
  };

  const repo = makeRepo({ base: 'develop', branch: `feat/${slug}`, seed: { 'src/in.js': 'a\n', 'lib/legacy.js': 'b\n' } });
  initRegister(repo, slug);
  writeFiles(featureDir(repo, slug), { 'plan.md': PLAN, 'intention/requirement.md': '# Req\n' });

  test('in-bound committed changes pass, measured from the merge base with a clean working tree', () => {
    commit(repo, 'src/in.js');
    commit(repo, 'test/fixtures/dir/deep/x.json');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feature folder');
    assert.strictEqual(git(repo, 'status', '--porcelain').trim(), '');
    const t = tier(repo);
    assert.strictEqual(t.status, 'PASS', JSON.stringify(t));
    assert.deepStrictEqual(t.scope.actual.files.filter((f) => !f.startsWith(`agent-docs/doflow/${slug}/`)).sort(),
      ['src/in.js', 'test/fixtures/dir/deep/x.json']);
    assert.strictEqual(t.scope.baseline.kind, 'merge-base');
    assert.strictEqual(t.scope.bound.source, `agent-docs/doflow/${slug}/plan.md`);
  });

  test('out-of-bound files fail the tier and every one is listed, committed or not', () => {
    commit(repo, 'src/out.js');
    commit(repo, 'lib/other.js');
    writeFiles(repo, { 'stray/a.txt': 'x\n' });
    const t = tier(repo);
    assert.strictEqual(t.status, 'FAIL', JSON.stringify(t));
    for (const f of ['src/out.js', 'lib/other.js', 'stray/a.txt']) assert.match(t.reason, new RegExp(f.replace(/[./]/g, '\\$&')));
    assert.doesNotMatch(t.reason, /src\/in\.js/);
    assert.doesNotMatch(t.reason, /fixtures/);
  });
});

// ── US4: guidance (IC-010) and the decision path ───────────────────────────────────────────────────

describe('Scenario: Review fix records its decisions (FR-005, FR-010, FR-011, IC-010)', { skip: SKIP }, () => {
  test('a do-implement run on a register feature registers with refs, names the id in the handoff note and edits no other stage\'s artifact', () => {
    const slug = '046-implement';
    const repo = makeRepo({ branch: `feat/${slug}` });
    initRegister(repo, slug);
    const dir = featureDir(repo, slug);
    writeFiles(dir, {
      'intention/requirement.md': '# Req\n\n## 1. Overview\n\ntext\n\n## 9. History\n\nNone — initial version.\n',
      'design/design.md': '# Design\n\n## 1. Choices\n\nThe fix keeps the old retry policy.\n\n## 9. History\n\nNone — initial version.\n',
    });
    const owned = ['intention/requirement.md', 'design/design.md'];
    const before = owned.map((rel) => fs.readFileSync(path.join(dir, rel)));

    // The implementation stage owns no artifact: the decision cites what it applies to through `refs`.
    const added = addBatch(repo, 'implement', [{
      topic: 'retry', statement: 'keep the old retry policy', stage: 'implementation', channel: 'default', refs: ['FR-001', 'IC-004'],
    }]);
    assert.strictEqual(added.status, 0, added.stdout + added.stderr);
    const id = added.json.added[0].id;
    const live = decision(repo, ['--action', 'list']);
    assert.deepStrictEqual(live.json.decisions.find((d) => d.id === id).refs, ['FR-001', 'IC-004']);
    assert.match(read(path.join(dir, 'decisions.md')), new RegExp(`\\| ${id} \\| retry \\|`));

    // ... and the handoff note names the id. Any stage's handoff stores its note the same way; do-implement's own
    // needs a satisfied readiness contract, which is not what this scenario is about.
    const handoff = run(repo, ['orchestrate', '--action', 'handoff', '--task-id', slug, '--task-class', 'feature',
      '--calling-skill', 'do-plan', '--note', `kept the retry policy (${id})`, '--result', 'passed', '--json']);
    assert.strictEqual(handoff.status, 0, handoff.stdout + handoff.stderr);
    assert.match(read(path.join(repo, '.doflow', 'state', 'orchestration', `${slug}.json`)), new RegExp(`kept the retry policy \\(${id}\\)`));

    const validated = run(repo, ['validate', '--json']);
    assert.strictEqual(validated.status, 0, validated.stdout + validated.stderr);
    assert.deepStrictEqual(validated.json.findings, []);
    owned.forEach((rel, i) => assert.ok(fs.readFileSync(path.join(dir, rel)).equals(before[i]), `${rel} is byte-identical`));
  });

  test('IC-010: the three shipped files carry the decision-step lines', () => {
    const shipped = (rel) => squash(read(path.join(REPO, 'core', 'shared', rel)));
    const handoff = shipped('guidance/references/WORKFLOW_HANDOFF.md');
    assert.ok(handoff.includes('Drop an item that only rewords a live decision'), 'reworded duplicate is dropped');
    assert.ok(handoff.includes('it is neither registered nor used to supersede'));
    assert.ok(handoff.includes('an `unknown` one takes the right identifier from the live list'));
    assert.ok(handoff.includes('Hand off with the stage\'s decisions registered, or say which are not.'), 'positive wording');
    assert.ok(!handoff.includes('Never hand off'), 'the negative wording is gone');

    const pointer = 'follow steps 1-4 of the decision step in the guidance tree\'s `references/WORKFLOW_HANDOFF.md`';
    const implement = shipped('skills/do-implement/SKILL.md');
    // FR-010: the pointer is in step 5, which every run reaches, not in step 7 (skipped for a standalone run),
    // and it is read before the handoff call.
    const step5 = implement.slice(implement.indexOf('5. **Implement**'), implement.indexOf('6. **Verify'));
    assert.ok(step5.includes(pointer), 'do-implement step 5 carries the decision-step pointer');
    assert.ok(step5.includes('has_decisions: true'));
    const step7 = implement.slice(implement.indexOf('7. **Record the handoff'), implement.indexOf('8. **Report'));
    assert.ok(!step7.includes(pointer), 'step 7 does not carry it');
    assert.ok(implement.indexOf(pointer) < implement.indexOf('--action handoff --task-id "<task id>" --calling-skill do-implement'), 'the pointer is read before the handoff call');
    // FR-011: the gate-0 patch path itself, not anywhere in the file.
    const flow = shipped('skills/do-flow/SKILL.md');
    const gate0 = flow.slice(flow.indexOf('- **`gate-0`** (after discovery'), flow.indexOf('- **`gate-a`**'));
    assert.ok(gate0.length > 0 && gate0.includes('patch the answers into `requirement.md`'), 'the gate-0 bullet was located');
    assert.ok(gate0.includes(pointer), 'do-flow gate-0 patch path');
    assert.ok(gate0.includes('(stage `discovery`, channel `question`)'));
  });
});

// ── NFR-001: legacy equivalence ─────────────────────────────────────────────────────────────────────

describe('NFR-001: a pre-register folder behaves as under v1.12.0', { skip: SKIP }, () => {
  const slug = '012-pre-register';
  const PLAN = '# Plan\n\n## 8. Tasks\n\n- [ ] A.1 Do it — owner: core-implementer; files: src/in.js\n\n## 9. History\n\nNone — initial version.\n';
  const repo = makeRepo({ base: 'develop', branch: `feat/${slug}`, seed: { 'src/in.js': 'a\n', 'src/out.js': 'b\n', 'a.js': 'x\n' } });
  writeFiles(featureDir(repo, slug), {
    'intention/requirement.md': '# Req\n\n## 1. Overview\n\ntext\n\n## 9. History\n\nNone — initial version.\n',
    'design/design.md': '# Design\n\n## 1. Choices\n\nSee https://x.test/DEC-099 and DEC-001/DEC-099 and DEC-005.\n\n## 9. History\n\nNone — initial version.\n',
    'design/specs.md': [
      '# Specs', '', '## 1. Contracts', '', '```markdown', '## 9. History', '```', '',
      '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
      '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
    ].join('\n'),
    'plan.md': PLAN,
  });
  assert.ok(!fs.existsSync(path.join(featureDir(repo, slug), 'decisions', 'register.json')));
  const state = path.join(repo, '.doflow', 'state');

  // 115 D-2 changed this one behaviour of v1.12.0: a feature without a register now keeps its task
  // records under its slug, as every feature does; its flat records from before stay readable (D-3).
  test('task records go under the feature\'s slug, with and without --slug, and are read back', () => {
    const ev = (extra) => run(repo, ['evidence', '--task-id', 'A.1', ...extra, '--action', 'add', '--kind', 'exact-search',
      '--provenance', 'extracted', '--provider', 'semble', '--capability', 'code.exact-search', '--locator', 'a.js', '--json']);
    assert.strictEqual(ev([]).status, 0);
    assert.strictEqual(ev(['--slug', slug]).status, 0);
    assert.strictEqual(run(repo, ['claim', '--task-id', 'A.1', '--action', 'add', '--statement', 's', '--json']).status, 0);
    assert.strictEqual(run(repo, ['outcome', '--task-id', 'A.1', '--action', 'record', '--task-class', 'bug', '--stage', 'review',
      '--state', 'INCONCLUSIVE', '--json']).status, 0);
    assert.strictEqual(run(repo, ['retrieval-plan', '--task-id', 'A.1', '--action', 'declare', '--need', 'locate-known-symbol',
      '--stage', 'design', '--json']).status, 0);
    for (const rel of ['evidence/A.1.json', 'evidence/A.1_claims.json', 'outcome/A.1.json', 'retrieval/A.1.json']) {
      const [store, name] = rel.split('/');
      assert.ok(fs.existsSync(path.join(state, store, slug, name)), `${rel} is under the feature's slug`);
      assert.ok(!fs.existsSync(path.join(state, rel)), `${rel} is not written flat`);
    }
    assert.strictEqual(run(repo, ['evidence', '--task-id', 'A.1', '--action', 'list', '--json']).json.evidenceCount, 2);
    const pack = run(repo, ['context-pack', '--task-id', 'A.1', '--json']);
    assert.strictEqual(pack.json.evidenceCount, 2, 'the context pack reads the namespaced records');
  });

  test('verify leaves the change-scope tier UNRESOLVED although the plan has files: lists', () => {
    writeFiles(repo, { 'src/out.js': 'changed\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'out of the plan, committed');
    writeFiles(repo, { 'stray.txt': 'x\n' });
    const res = run(repo, ['verify', '--task-id', 'A.1', '--risk', 'LOW', '--json']);
    assert.ok(res.json, res.stdout + res.stderr);
    const t = res.json.tiers.find((x) => x.id === 'change-scope');
    assert.strictEqual(t.status, 'UNRESOLVED', JSON.stringify(t));
  });

  test('validate reports no stale or unknown finding, and the fenced "## 9. History" does not gate', (t) => {
    const res = run(repo, ['validate', '--json']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.deepStrictEqual(res.json.findings, []);
    assert.ok(!res.json.findings.some((f) => f.rule === 'stale' || f.rule === 'unknown' || f.rule === 'history'));
    if (haveTagOrSkip(t, 'v1.12.0')) assert.strictEqual(res.stdout, v1120Validate(repo), 'byte-identical to the v1.12.0 validator');
  });

  test('decision verbs still refuse the folder and write no register', () => {
    const init = decision(repo, ['--action', 'init']);
    assert.strictEqual(init.status, 1);
    assert.strictEqual(init.json.finding, 'predates-register');
    assert.ok(!fs.existsSync(path.join(featureDir(repo, slug), 'decisions')));
  });
});

// ── NFR-004: nothing new blocks a write ─────────────────────────────────────────────────────────────

describe('NFR-004: no write-time hook or refusal was added', { skip: SKIP }, () => {
  const settings = JSON.parse(read(path.join(REPO, 'core', 'harnesses', 'claude', 'settings', 'settings.json')));
  const wiring = (s, event) => (s.hooks[event] || []).map((entry) => [entry.matcher ?? null, entry.hooks.map((h) => path.basename(h.command))]);

  test('the only hook that runs before an Edit/Write/MultiEdit is the pre-existing pre-implement-gate', () => {
    assert.deepStrictEqual(wiring(settings, 'PreToolUse').filter(([m]) => m && /Edit|Write/.test(m)),
      [['Edit|Write|MultiEdit', ['pre-implement-gate.sh']]]);
    assert.deepStrictEqual(wiring(settings, 'PostToolUse'), [['Bash', ['post-shell-observe.sh PostToolUse']], ['Edit', ['post-edit-lint.sh']], ['Write', ['post-edit-lint.sh']]],
      'Bash has the observe-only shell hook; after a write only the existing lint hook runs');
  });

  test('every claude hook door is wired or sourced, and every wiring command resolves', () => {
    const files = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    assert.deepStrictEqual(claudeDoorFindings(REPO, files), []);
    assert.deepStrictEqual(hookReachabilityFindings(REPO, files), []);
  });

  test('current-truth controls reject a missing wiring target and an unwired claude door', (t) => {
    const root = tempDir(t, 'doflow-ic035-claude-');
    fs.mkdirSync(path.join(root, 'core/harnesses/claude/settings'), { recursive: true });
    fs.mkdirSync(path.join(root, 'core/harnesses/claude/hooks'), { recursive: true });
    fs.cpSync(path.join(REPO, 'core/harnesses/claude/hooks'), path.join(root, 'core/harnesses/claude/hooks'), { recursive: true });
    const settingsPath = path.join(root, 'core/harnesses/claude/settings/settings.json');
    fs.copyFileSync(path.join(REPO, 'core/harnesses/claude/settings/settings.json'), settingsPath);
    const files = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.SessionStart[0].hooks[0].command = 'bash "$DOFLOW_PROJECT_DIR/.claude/hooks/missing-door.sh"';
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    assert.ok(claudeDoorFindings(root, files).some((finding) => finding.includes('missing-door.sh')));

    const extra = 'core/harnesses/claude/hooks/orphan-check.sh';
    fs.writeFileSync(path.join(root, extra), '#!/usr/bin/env bash\ntrue\n');
    assert.ok(claudeDoorFindings(root, [...files, extra]).some((finding) => finding.includes(extra)));
  });
});
