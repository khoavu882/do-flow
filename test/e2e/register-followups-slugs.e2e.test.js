'use strict';
// register-followups-slugs.e2e.test.js — feature 045 US6 (unsafe feature name refused) and RK5 (slugs that work today
// are still accepted), driven through the checkout's own dispatcher against scratch git repos.
// Helpers: register-followups.shared.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO, SCRATCH, SKIP, git, makeRepo, run, decision, initRegister, baseEnv,
} = require('./register-followups.shared');

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

  test('committed feature layout fixtures resolve and unnumbered folders are excluded from candidates', () => {
    const repo = makeRepo({ branch: 'feat/046-shapes' });
    const fixtureRoot = path.join(__dirname, '..', 'fixtures', 'feature-layouts');
    const shapes = [
      ['041-structured', 'structured', false],
      ['042-structured-register', 'structured', true],
      ['043-legacy', 'legacy', false],
      ['044-legacy-register', 'legacy', true],
    ];
    for (const [slug, layout, hasDecisions] of shapes) {
      fs.cpSync(path.join(fixtureRoot, slug), path.join(repo, 'agent-docs', 'doflow', slug), { recursive: true });
      const res = run(repo, ['paths', `--slug=${slug}`, '--json']);
      assert.strictEqual(res.status, 0, `${slug}: ${res.stdout}${res.stderr}`);
      assert.strictEqual(res.json.feature_slug, slug);
      assert.strictEqual(res.json.layout, layout, slug);
      assert.strictEqual(res.json.has_requirement, true, slug);
      assert.strictEqual(res.json.has_decisions, hasDecisions, slug);
    }

    // Exercise the directory-scan filter: only numeric-prefixed feature names become candidates.
    const scanRoot = path.join(SCRATCH, 'feature-layout-scan');
    const scanFeatures = path.join(scanRoot, 'agent-docs', 'doflow');
    fs.cpSync(fixtureRoot, scanFeatures, { recursive: true });
    const helper = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-paths.sh');
    const scanned = spawnSync('bash', [helper, '--json'], {
      cwd: scanRoot,
      env: { ...baseEnv(), DOFLOW_CONFIG_DIR: path.join(scanRoot, '.doflow') },
      encoding: 'utf8',
    });
    assert.strictEqual(scanned.status, 0, scanned.stdout + scanned.stderr);
    const scanJson = JSON.parse(scanned.stdout);
    assert.deepStrictEqual(scanJson.candidate_slugs, shapes.map(([slug]) => slug));
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
