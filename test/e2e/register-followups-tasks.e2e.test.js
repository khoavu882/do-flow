'use strict';
// register-followups-tasks.e2e.test.js — feature 045 US2 (per-feature task records) and US5 (release version), driven
// through the checkout's own dispatcher against scratch git repos. Helpers: register-followups.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SKIP, git, makeRepo, run, writeFiles, featureDir, initRegister,
} = require('./register-followups.shared');

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
