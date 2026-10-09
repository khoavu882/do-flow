'use strict';
// register-followups.e2e.test.js — feature 045 acceptance scenarios (requirement §6), NFR-001 legacy
// equivalence, RK5 slug acceptance and NFR-004, driven through the checkout's own dispatcher
// `core/shared/scripts/doflow/bin/doflow-run` (never ~/.doflow) against scratch git repos. Needs no
// model and no network: HOME is redirected to a scratch directory, DOFLOW_CONFIG_DIR points into the
// scratch repo, and every feature folder lives in a throwaway repo under os.tmpdir().
//
// Three comparisons read the v1.12.0 tag (validator output twice, hook wiring). Each also carries a
// literal expectation that needs no tag. A missing tag fails under CI (CI fetches full history) and
// marks the test skipped, with the reason, on a local clone.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW_RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const { IS_WIN } = require('../helper-platform');

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-followups-e2e-')));
const HOME = path.join(SCRATCH, 'home');
fs.mkdirSync(HOME, { recursive: true });
after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

const SKIP = IS_WIN ? 'doflow-run is a bash script' : false;
let repoCounter = 0;

/** A minimal, explicit environment: no inherited DOFLOW_CLI, GIT_* or provider keys. */
function baseEnv() {
  return {
    PATH: process.env.PATH, HOME, USERPROFILE: HOME, TMPDIR: SCRATCH,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A scratch repo on `base` with `.doflow/` ignored (the runtime journals there) and one commit,
 * then branch `branch` checked out. Files in `seed` are committed on the base. */
function makeRepo({ base = 'main', branch = null, seed = {} } = {}) {
  const repo = path.join(SCRATCH, `repo-${repoCounter++}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', base);
  writeFiles(repo, { '.gitignore': '.doflow/\n', ...seed });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  if (branch) git(repo, 'checkout', '-q', '-b', branch);
  return repo;
}

/** Runs doflow-run with cwd = the scratch repo. Parses stdout as JSON when it is. */
function run(repo, args, { input } = {}) {
  const r = spawnSync('bash', [DOFLOW_RUN, ...args], {
    cwd: repo, env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') },
    input: input ?? '', encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const decision = (repo, args, opts) => run(repo, ['decision', ...args, '--json'], opts);

function writeFiles(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

const read = (file) => fs.readFileSync(file, 'utf8');
const featureDir = (repo, slug) => path.join(repo, 'agent-docs', 'doflow', slug);

function initRegister(repo, slug) {
  const res = run(repo, ['decision', '--action', 'init', '--slug', slug, '--json']);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  return res;
}

/** Adds decisions through one batch file; returns the CLI result. */
function addBatch(repo, name, items) {
  const file = path.join(SCRATCH, `${name}-${repoCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify(items.map((i) => ({
    channel: 'question', stage: 'design', rationale: `because ${i.topic}`, supersedes: [], refs: [],
    source: `intention/q.md#${i.topic}`, ...i,
  }))));
  return decision(repo, ['--action', 'add', '--batch', file]);
}

/** Whether this clone has the v1.12.0 tag to compare against. */
function hasTag(tag) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: REPO }).status === 0;
}

/**
 * Gate for a comparison against a tagged release. With the tag it returns true. Without it, CI fails
 * (the workflow fetches full history, so a missing tag there means the comparison silently stopped
 * running), and a local run marks the test skipped with the reason instead of passing quietly.
 */
function haveTagOrSkip(t, tag) {
  if (hasTag(tag)) return true;
  const reason = `the ${tag} tag is absent from this clone, so the comparison against it did not run (git fetch --tags)`;
  if (process.env.CI) assert.fail(reason);
  t.skip(reason);
  return false;
}

function gitShow(rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

const squash = (text) => text.replace(/\s+/g, ' ');

const HISTORY = '## 9. History\n\n- 2026-10-01 a\n- 2026-10-02 b\n';

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

/** Output of v1.12.0's validator on the repo's active feature: its script, beside the current resolver. */
function v1120Validate(repo) {
  const dir = path.join(SCRATCH, `v1120-${repoCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const bash = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');
  fs.writeFileSync(path.join(dir, 'validate-artifacts.sh'),
    gitShow('v1.12.0', 'core/shared/scripts/doflow/bash/validate-artifacts.sh'));
  fs.copyFileSync(path.join(bash, 'do-paths.sh'), path.join(dir, 'do-paths.sh'));
  const r = spawnSync('bash', [path.join(dir, 'validate-artifacts.sh'), '--json'], {
    cwd: repo, env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(repo, '.doflow') }, encoding: 'utf8',
  });
  return r.stdout;
}

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

// ── US2: per-feature task records ───────────────────────────────────────────────────────────────────

describe('Scenario: Same task id in two features (FR-006, FR-007)', { skip: SKIP }, () => {
  const LEGACY = '041-legacy';
  const NEW = '046-new';
  const OTHER = '047-other';
  const repo = makeRepo({ branch: `feat/${NEW}`, seed: { 'a.js': 'const x = 1;\n' } });
  writeFiles(featureDir(repo, LEGACY), { 'intention/requirement.md': '# Req\n' });
  initRegister(repo, NEW);
  initRegister(repo, OTHER);
  const state = path.join(repo, '.doflow', 'state');

  const evidence = (taskId, slug) => run(repo, ['evidence', '--task-id', taskId, ...(slug ? ['--slug', slug] : []),
    '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'semble',
    '--capability', 'code.exact-search', '--locator', 'a.js', '--establishes', 'affected_code', '--json']);
  const count = (taskId, slug) => run(repo, ['evidence', '--task-id', taskId, '--slug', slug, '--action', 'list', '--json']).json.evidenceCount;
  const affectedCode = (slug) => run(repo, ['readiness', '--task-id', 'A.1', '--task-class', 'bug', '--slug', slug, '--json'])
    .json.requirements.find((r) => r.id === 'affected_code');

  test('041 keeps its flat record; the register features write under their own slug', () => {
    assert.strictEqual(evidence('A.1', LEGACY).status, 0);           // pre-register feature: flat
    assert.strictEqual(evidence('A.1').status, 0);                    // branch-derived feature: namespaced
    assert.strictEqual(evidence('A.1', OTHER).status, 0);             // --slug routing, branch says NEW
    assert.ok(fs.existsSync(path.join(state, 'evidence', 'A.1.json')));
    assert.ok(fs.existsSync(path.join(state, 'evidence', NEW, 'A.1.json')));
    assert.ok(fs.existsSync(path.join(state, 'evidence', OTHER, 'A.1.json')));
    assert.ok(!fs.existsSync(path.join(state, 'evidence', LEGACY)), 'the legacy feature gets no namespace directory');
  });

  test('readiness for the new feature\'s A.1 never sees 041\'s record, and 041\'s own record is still returned', () => {
    const fresh = makeRepoLike();
    const ev = (slug) => run(fresh, ['evidence', '--task-id', 'A.1', '--slug', slug, '--action', 'add', '--kind', 'exact-search',
      '--provenance', 'extracted', '--provider', 'semble', '--capability', 'code.exact-search', '--locator', 'a.js',
      '--establishes', 'affected_code', '--json']);
    const readiness = (slug) => run(fresh, ['readiness', '--task-id', 'A.1', '--task-class', 'bug', '--slug', slug, '--json']);
    assert.strictEqual(ev(LEGACY).status, 0);

    const other = readiness(NEW);
    const own = readiness(LEGACY);
    const req = (res) => res.json.requirements.find((r) => r.id === 'affected_code');
    assert.strictEqual(req(own).satisfied, true, '041 reads its own flat record');
    assert.strictEqual(req(other).satisfied, false, 'the new feature must not borrow it');
    assert.deepStrictEqual(req(other).evidenceIds, []);
    assert.notStrictEqual(other.json.state, 'READY', 'the stale record does not move the new feature\'s verdict');
    assert.strictEqual(run(fresh, ['evidence', '--task-id', 'A.1', '--slug', LEGACY, '--action', 'list', '--json']).json.evidenceCount, 1);
    assert.strictEqual(run(fresh, ['evidence', '--task-id', 'A.1', '--slug', NEW, '--action', 'list', '--json']).json.evidenceCount, 0);
  });

  /** A repo with the same three features and a.js, empty state: isolates one assertion from the shared repo. */
  function makeRepoLike() {
    const r = makeRepo({ branch: `feat/${NEW}`, seed: { 'a.js': 'const x = 1;\n' } });
    writeFiles(featureDir(r, LEGACY), { 'intention/requirement.md': '# Req\n' });
    initRegister(r, NEW);
    return r;
  }

  test('--slug routes a write to the named feature, whatever the branch says; counts stay separate', () => {
    assert.strictEqual(count('A.1', LEGACY), 1);
    assert.strictEqual(count('A.1', NEW), 1);
    assert.strictEqual(count('A.1', OTHER), 1);
    assert.strictEqual(evidence('A.1', OTHER).status, 0);
    assert.strictEqual(count('A.1', OTHER), 2);
    assert.strictEqual(count('A.1', NEW), 1, 'the branch\'s feature did not receive the routed write');
    assert.strictEqual(count('A.1', LEGACY), 1, '041 is untouched by either');
    assert.strictEqual(affectedCode(LEGACY).satisfied, true);
  });

  test('claims and the context pack follow the same isolation', () => {
    const claim = (slug, text) => run(repo, ['claim', '--task-id', 'A.1', '--slug', slug, '--action', 'add', '--statement', text, '--json']);
    assert.strictEqual(claim(LEGACY, 'legacy claim').status, 0);
    assert.ok(fs.existsSync(path.join(state, 'evidence', 'A.1_claims.json')));
    assert.strictEqual(claim(NEW, 'new claim').status, 0);
    assert.ok(fs.existsSync(path.join(state, 'evidence', NEW, 'A.1_claims.json')));

    const listed = run(repo, ['claim', '--task-id', 'A.1', '--slug', NEW, '--action', 'list', '--json']);
    assert.ok(!JSON.stringify(listed.json).includes('legacy claim'), 'no claim from the other feature');
    assert.ok(JSON.stringify(listed.json).includes('new claim'));

    const pack = run(repo, ['context-pack', '--task-id', 'A.1', '--slug', NEW, '--json']);
    assert.ok(pack.json, pack.stdout + pack.stderr);
    assert.strictEqual(pack.json.evidenceCount, 1, 'only the new feature\'s evidence');
    assert.ok(!JSON.stringify(pack.json).includes('legacy claim'));
    const legacyPack = run(repo, ['context-pack', '--task-id', 'A.1', '--slug', LEGACY, '--json']);
    assert.strictEqual(legacyPack.json.evidenceCount, 1);
    assert.ok(JSON.stringify(legacyPack.json).includes('legacy claim'));
  });

  test('outcome and retrieval records are namespaced too', () => {
    const outcome = run(repo, ['outcome', '--task-id', 'A.1', '--slug', NEW, '--action', 'record', '--task-class', 'bug',
      '--stage', 'review', '--state', 'INCONCLUSIVE', '--json']);
    assert.strictEqual(outcome.status, 0, outcome.stdout + outcome.stderr);
    assert.ok(fs.existsSync(path.join(state, 'outcome', NEW, 'A.1.json')));
    assert.ok(!fs.existsSync(path.join(state, 'outcome', 'A.1.json')));
    assert.strictEqual(run(repo, ['outcome', '--task-id', 'A.1', '--slug', LEGACY, '--json']).status, 1, '041 recorded no outcome');

    const plan = run(repo, ['retrieval-plan', '--task-id', 'A.1', '--slug', NEW, '--action', 'declare',
      '--need', 'locate-known-symbol', '--stage', 'design', '--json']);
    assert.strictEqual(plan.status, 0, plan.stdout + plan.stderr);
    assert.ok(fs.existsSync(path.join(state, 'retrieval', NEW, 'A.1.json')));
    assert.ok(!fs.existsSync(path.join(state, 'retrieval', 'A.1.json')));
  });

  test('a feature-level task id (the slug itself) stays flat even with a register', () => {
    assert.strictEqual(evidence(NEW, NEW).status, 0);
    assert.ok(fs.existsSync(path.join(state, 'evidence', `${NEW}.json`)));
    assert.ok(!fs.existsSync(path.join(state, 'evidence', NEW, `${NEW}.json`)));
    assert.strictEqual(run(repo, ['orchestrate', '--action', 'handoff', '--task-id', NEW, '--task-class', 'feature',
      '--calling-skill', 'do-plan', '--note', 'done', '--json']).status, 0);
    assert.ok(fs.existsSync(path.join(state, 'orchestration', `${NEW}.json`)), 'the journal keeps its flat per-slug file');
  });
});

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

// ── US5: release version ────────────────────────────────────────────────────────────────────────────

describe('Scenario: Release proposes the right version (FR-012)', { skip: SKIP }, () => {
  /** main holds v1.12.0 on a merge commit that develop never got back; develop carries newer work. */
  function releaseRepo() {
    const repo = makeRepo({ base: 'main' });
    git(repo, 'tag', 'v1.11.0');
    git(repo, 'checkout', '-q', '-b', 'develop');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: release work');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', 'develop', '-m', 'Merge release 1.12 into production');
    git(repo, 'tag', 'v1.12.0');
    git(repo, 'checkout', '-q', 'develop');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: next work');
    assert.notStrictEqual(spawnSync('git', ['merge-base', '--is-ancestor', 'v1.12.0', 'HEAD'], { cwd: repo }).status, 0,
      'the fixture must leave v1.12.0 unreachable from the integration branch');
    return repo;
  }
  const next = (repo) => run(repo, ['git-state', '--next-version', '--json']);
  const parts = (v) => v.split('.').map(Number);
  const after = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

  test('from the integration branch the base tag is v1.12.0 and the proposal follows it', () => {
    const repo = releaseRepo();
    const res = next(repo);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.strictEqual(res.json.base_tag, 'v1.12.0');
    assert.strictEqual(res.json.current_version, '1.12.0');
    assert.ok(after(res.json.next_version, '1.12.0'), `next ${res.json.next_version} is after 1.12.0`);
    assert.ok(after(res.json.next_version, '1.11.0'));
    assert.strictEqual(res.json.warning, undefined, 'no manifest, no warning');
  });

  test('a manifest that disagrees with the base tag adds a warning; agreement adds none; other keys are unchanged', () => {
    const repo = releaseRepo();
    const keys = Object.keys(next(repo).json).sort();
    fs.writeFileSync(path.join(repo, 'package.json'), '{"version":"1.11.0"}\n');
    const warned = next(repo).json;
    assert.strictEqual(warned.warning, 'manifest version 1.11.0 differs from base tag v1.12.0');
    assert.deepStrictEqual(Object.keys(warned).filter((k) => k !== 'warning').sort(), keys);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"version":"1.12.0"}\n');
    assert.strictEqual(next(repo).json.warning, undefined);
  });
});

// ── US6: slug safety ────────────────────────────────────────────────────────────────────────────────

describe('Scenario: Unsafe feature name refused (FR-013, IC-009)', { skip: SKIP }, () => {
  const BAD = ['../../x', 'a/b', '..', 'a..b', '.hidden', 'a b'];
  const tree = (root) => {
    const out = [];
    const walk = (d) => {
      for (const name of fs.readdirSync(d).sort()) {
        if (name === '.git' || name === '.doflow') continue;   // .doflow: the dispatcher's own run ledger
        const p = path.join(d, name);
        out.push(path.relative(root, p));
        if (fs.statSync(p).isDirectory()) walk(p);
      }
    };
    walk(root);
    return out;
  };

  test('paths, git-state --branch-name and decision refuse with exit 2 and write nothing', () => {
    const repo = makeRepo({ branch: 'feat/046-safe' });
    const before = { repo: tree(repo), scratch: fs.readdirSync(SCRATCH).sort() };
    for (const slug of BAD) {
      const paths = run(repo, ['paths', `--slug=${slug}`, '--json']);
      assert.strictEqual(paths.status, 2, `paths ${slug}: ${paths.stdout}`);
      assert.strictEqual(paths.json.error, 'invalid-slug', slug);

      const branchName = run(repo, ['git-state', '--branch-name', '--class=feature', `--slug=${slug}`, '--json']);
      assert.strictEqual(branchName.status, 2, `branch-name ${slug}: ${branchName.stdout}`);
      assert.strictEqual(branchName.json.error, 'invalid-slug', slug);

      for (const action of ['init', 'list']) {
        const dec = run(repo, ['decision', '--action', action, '--slug', slug, '--json']);
        assert.strictEqual(dec.status, 2, `decision ${action} ${slug}: ${dec.stdout}`);
        assert.strictEqual(dec.json.error, 'invalid-slug', `decision ${action} ${slug}`);
        assert.deepStrictEqual(Object.keys(dec.json).sort(), ['error', 'hint', 'message']);
      }
    }
    assert.deepStrictEqual(tree(repo), before.repo, 'nothing written in the repo');
    assert.deepStrictEqual(fs.readdirSync(SCRATCH).sort(), before.scratch, 'nothing written beside the repo');
  });

  test('task-store verbs, verify and validate refuse an unsafe slug and write nothing outside the state directory', () => {
    const repo = makeRepo({ branch: 'feat/046-safe', seed: { 'a.js': 'x\n' } });
    initRegister(repo, '046-safe');
    const before = fs.readdirSync(SCRATCH).sort();
    const stateBefore = fs.existsSync(path.join(repo, '.doflow', 'state')) ? tree(path.join(repo, '.doflow', 'state')) : [];
    for (const slug of BAD) {
      const res = run(repo, ['evidence', '--task-id', 'A.1', '--slug', slug, '--action', 'add', '--kind', 'exact-search',
        '--provenance', 'extracted', '--provider', 'semble', '--capability', 'code.exact-search', '--locator', 'a.js', '--json']);
      assert.strictEqual(res.status, 2, `evidence ${slug}: ${res.stdout}${res.stderr}`);
      assert.deepStrictEqual(Object.keys(res.json).sort(), ['error', 'hint', 'message']);
      assert.strictEqual(res.json.error, 'invalid-slug');
      const verify = run(repo, ['verify', '--task-id', 'A.1', '--slug', slug, '--json']);
      assert.strictEqual(verify.status, 2, `verify ${slug}`);
      const validate = run(repo, ['validate', `--slug=${slug}`, '--json']);
      assert.strictEqual(validate.status, 2, `validate ${slug}: ${validate.stdout}${validate.stderr}`);
      assert.strictEqual(validate.json.error, 'invalid-slug');
    }
    const stateAfter = fs.existsSync(path.join(repo, '.doflow', 'state')) ? tree(path.join(repo, '.doflow', 'state')) : [];
    assert.deepStrictEqual(stateAfter, stateBefore, 'no record was written under any name');
    assert.deepStrictEqual(fs.readdirSync(SCRATCH).sort(), before);
    assert.ok(!fs.existsSync(path.join(SCRATCH, 'x')) && !fs.existsSync(path.join(repo, '..', '..', 'x')));
  });
});

describe('RK5: slugs that work today are still accepted', { skip: SKIP }, () => {
  const SHAPES = ['041-cross-scope-inventory', '045-register-followups', 'ABC-123-x', '001-a', 'x', 'v1.2.3-hotfix', 'a_b.c-d', '2026-10-03.notes'];

  test('every hardcoded representative shape passes `paths --slug` and echoes back', () => {
    const repo = makeRepo({ branch: 'feat/046-shapes' });
    for (const slug of SHAPES) {
      const res = run(repo, ['paths', `--slug=${slug}`, '--json']);
      assert.strictEqual(res.status, 0, `${slug}: ${res.stdout}${res.stderr}`);
      assert.strictEqual(res.json.feature_slug, slug);
    }
  });

  test('every feature folder under agent-docs/doflow/ of this checkout passes `paths --slug` (skipped when absent: gitignored)', (t) => {
    const root = path.join(REPO, 'agent-docs', 'doflow');
    // agent-docs/ is gitignored, so a clean CI checkout never has it: skipped with the reason rather
    // than passing silently, and not a CI failure (the hardcoded shapes above cover the same rule).
    if (!fs.existsSync(root)) { t.skip('agent-docs/doflow is absent (gitignored); the hardcoded shapes cover this'); return; }
    const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const repo = makeRepo({ branch: 'feat/046-shapes' });
    for (const slug of names) {
      const res = run(repo, ['paths', `--slug=${slug}`, '--json']);
      assert.strictEqual(res.status, 0, `existing feature folder "${slug}" refused: ${res.stdout}${res.stderr}`);
      assert.strictEqual(res.json.feature_slug, slug);
    }
  });

  test('branch shapes feat/045-x, feat/ABC-123-x and fix/x resolve to their slug', () => {
    const repo = makeRepo({ branch: 'feat/045-x' });
    const expected = [['feat/045-x', '045-x'], ['feat/ABC-123-x', 'ABC-123-x'], ['fix/x', 'x']];
    for (const [branch, slug] of expected) {
      if (branch !== 'feat/045-x') git(repo, 'checkout', '-q', '-b', branch);
      const res = run(repo, ['paths', '--json']);
      assert.strictEqual(res.status, 0, `${branch}: ${res.stdout}${res.stderr}`);
      assert.strictEqual(res.json.feature_slug, slug, branch);
    }
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

  test('task records keep the flat .doflow/state/<store>/<task>.json paths, with and without --slug', () => {
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
      assert.ok(fs.existsSync(path.join(state, rel)), `${rel} is where v1.12.0 put it`);
    }
    for (const store of ['evidence', 'outcome', 'retrieval']) {
      const dirs = fs.readdirSync(path.join(state, store), { withFileTypes: true }).filter((e) => e.isDirectory());
      assert.deepStrictEqual(dirs, [], `${store} holds no namespace directory`);
    }
    assert.strictEqual(run(repo, ['evidence', '--task-id', 'A.1', '--action', 'list', '--json']).json.evidenceCount, 2);
    const pack = run(repo, ['context-pack', '--task-id', 'A.1', '--json']);
    assert.strictEqual(pack.json.evidenceCount, 2, 'the context pack reads the flat records');
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
    assert.deepStrictEqual(wiring(settings, 'PostToolUse'), [['Edit', ['post-edit-lint.sh']], ['Write', ['post-edit-lint.sh']]],
      'after a write only the existing lint hook runs');
  });

  test('hook files and the claude hook wiring are the v1.12.0 set (compared when the tag is present)', (t) => {
    const hookFiles = () => spawnSync('git', ['ls-files', 'core'], { cwd: REPO, encoding: 'utf8' }).stdout
      .split('\n').filter((f) => /(^|\/)hooks\//.test(f) || /hooks\.json$/.test(f)).sort();
    assert.ok(hookFiles().length >= 15, 'the checkout ships its hook files');
    if (!haveTagOrSkip(t, 'v1.12.0')) return;
    const tagged = spawnSync('git', ['ls-tree', '-r', '--name-only', 'v1.12.0', 'core'], { cwd: REPO, encoding: 'utf8' }).stdout
      .split('\n').filter((f) => /(^|\/)hooks\//.test(f) || /hooks\.json$/.test(f)).sort();
    // Feature 046 adds exactly one file: the failure capture helper (IC-018, DEC-032). It is sourced
    // inside the two guard policies' existing fail-open branches and has no wiring entry, so the
    // no-write-time-hook intent holds; the wiring comparison below stays strict.
    const failureCaptureHelper = 'core/harnesses/shared/hooks/policies/capture-failure.sh';
    // Feature 059 adds the prompt nudge's decision program (IC-005): a jq file with no wiring entry
    // and no write-time effect, run by the existing UserPromptSubmit policy.
    const exempt = [failureCaptureHelper, 'core/harnesses/shared/hooks/policies/prompt-nudge.jq'];
    assert.deepStrictEqual(hookFiles().filter((f) => !exempt.includes(f)), tagged, 'no hook file was added or removed since v1.12.0');
    const old = JSON.parse(gitShow('v1.12.0', 'core/harnesses/claude/settings/settings.json'));
    assert.deepStrictEqual(settings.hooks, old.hooks, 'the claude hook wiring is unchanged since v1.12.0');
  });
});
