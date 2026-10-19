'use strict';
// 115 FR-004, FR-005, FR-006 (IC-004, IC-006, IC-007): a linked worktree keeps every per-task record
// in the main checkout, even when the worktree holds the feature folder itself; research-request
// reads the run and the claims from the root it writes; records survive `git worktree remove`; a
// DoFlow sandbox keeps its own store; a record left in the worktree's store is adopted, or refused
// with store-conflict when the main checkout holds a different one.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');
const SLUG = '940-wtrec';
const NOTE = `feature '${SLUG}' lives in the main checkout`;
const scratch = createScratch('doflow-worktree-records-');
after(() => scratch.remove());

/** A main checkout and a linked worktree on the feature branch, both holding the feature folder
 * (with a decision register, so the stores are namespaced), with agent-docs/ and .doflow/ ignored. */
function linkedWorld(t) {
  const base = tempDir(t, 'doflow-worktree-records-');
  const env = scratch.env();
  delete env.FORCE_COLOR;
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const main = path.join(base, 'm');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const recordsLiteral = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', `feat/${SLUG}`, wt);
  for (const root of [main, wt]) {
    for (const [rel, body] of [['intention/requirement.md', '# r\n'], ['design/design.md', '# d\n'], ['plan.md', '- [ ] A.1 x — owner: x; files: src/a.js\n'], ['decisions/register.json', '{"decisions":[]}\n']]) {
      const file = path.join(root, 'agent-docs', 'doflow', SLUG, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    }
  }
  const doflow = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--json'], { cwd, env, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, data: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  const state = (root, rel) => path.join(root, '.doflow', 'state', rel);
  return { base, main, wt, git, doflow, state };
}

/** Every file under a directory, relative to it; [] when it does not exist. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((rel) => fs.statSync(path.join(dir, rel)).isFile()).sort();
}

const ok = (res, what) => { assert.equal(res.status, 0, `${what}: ${res.stderr}${res.stdout}`); return res.data; };
const noteCount = (res) => res.stderr.split(NOTE).length - 1;

test('a worktree that holds the feature folder writes every task record under the main checkout, and they outlive the worktree', (t) => {
  const { main, wt, git, doflow, state } = linkedWorld(t);
  // The worktree's own copy of the source differs from main's: evidence is hashed where the verb runs.
  fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'const recordsLiteral = 2;\n');

  const started = doflow(wt, 'orchestrate', '--action', 'start', '--task-id', 'A.1', '--task-class', 'feature');
  ok(started, 'orchestrate start');
  assert.equal(noteCount(started), 1, 'the redirect note prints once');
  assert.equal(JSON.parse(fs.readFileSync(state(main, 'orchestration/A.1.json'), 'utf8')).featureSlug, SLUG, 'the run is created under main, for the worktree branch\'s feature');

  const request = ok(doflow(wt, 'research-request', '--action', 'open', '--task-id', 'A.1', '--stage-id', 'discovery',
    '--question', 'Which literal?', '--reason', 'detected-gap'), 'research-request open');
  assert.ok(fs.existsSync(state(main, `research/${SLUG}/A.1.json`)));

  const added = doflow(wt, 'evidence', '--task-id', 'A.1', '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted',
    '--provider', 'semble', '--capability', 'code.exact-search', '--locator', 'src/a.js:1', '--establishes', 'affected_code');
  const evidence = ok(added, 'evidence add').evidence[0];
  assert.equal(noteCount(added), 1);
  assert.ok(fs.existsSync(state(main, `evidence/${SLUG}/A.1.json`)));

  const claimId = ok(doflow(wt, 'claim', '--task-id', 'A.1', '--action', 'add', '--statement', 'The literal is 2.'), 'claim add').claim.id;
  ok(doflow(wt, 'claim', '--task-id', 'A.1', '--action', 'link', '--claim-id', claimId, '--evidence-id', evidence.id), 'claim link');
  assert.ok(fs.existsSync(state(main, `evidence/${SLUG}/A.1_claims.json`)));

  // FR-005: the request, the run and the claim recorded from the worktree are read from one root.
  const resolved = ok(doflow(wt, 'research-request', '--action', 'resolve', '--task-id', 'A.1', '--request-id', request.id,
    '--outcome', 'answered', '--claim-id', claimId, '--evidence-id', evidence.id), 'research-request resolve answered');
  assert.equal(resolved.status, 'ANSWERED');

  ok(doflow(wt, 'readiness', '--task-id', 'A.1', '--task-class', 'feature'), 'readiness');
  assert.ok(fs.existsSync(state(main, `readiness/${SLUG}/A.1.json`)));
  ok(doflow(wt, 'outcome', '--task-id', 'A.1', '--action', 'record', '--task-class', 'feature', '--state', 'COMPLETED'), 'outcome record');
  assert.ok(fs.existsSync(state(main, `outcome/${SLUG}/A.1.json`)));
  ok(doflow(wt, 'context-pack', '--task-id', 'A.1'), 'context-pack');
  assert.ok(fs.existsSync(state(main, `delivery/${SLUG}/A.1.json`)));

  assert.deepEqual(filesUnder(path.join(wt, '.doflow', 'state')), [], 'nothing is written under the worktree\'s .doflow/state');

  git(main, 'worktree', 'remove', '--force', wt);
  assert.ok(!fs.existsSync(wt));
  const run = ok(doflow(main, 'orchestrate', '--action', 'status', '--task-id', 'A.1', '--slug', SLUG), 'orchestrate status');
  assert.equal(run.current.id, 'discovery');
  assert.equal(ok(doflow(main, 'research-request', '--action', 'list', '--task-id', 'A.1', '--slug', SLUG), 'research list').requests[0].status, 'ANSWERED');
  assert.deepEqual(ok(doflow(main, 'evidence', '--task-id', 'A.1', '--action', 'list', '--slug', SLUG), 'evidence list').evidence.map((e) => e.id), [evidence.id]);
  assert.equal(ok(doflow(main, 'claim', '--task-id', 'A.1', '--action', 'list', '--slug', SLUG), 'claim list').claims[0].id, claimId);
  assert.equal(ok(doflow(main, 'outcome', '--task-id', 'A.1', '--action', 'show', '--slug', SLUG), 'outcome show').state, 'COMPLETED');
});

test('a DoFlow sandbox checkout keeps its own store', (t) => {
  const { base, main, git, doflow, state } = linkedWorld(t);
  const sandbox = path.join(base, 'sandbox');
  git(main, 'worktree', 'add', '-q', '-b', 'sandbox-branch', sandbox);
  fs.writeFileSync(path.join(sandbox, '.doflow-worktree-base'), 'base\n');
  const res = doflow(sandbox, 'orchestrate', '--action', 'start', '--task-id', 'S.1', '--task-class', 'bug');
  ok(res, 'orchestrate start in a sandbox');
  assert.equal(noteCount(res), 0);
  ok(doflow(sandbox, 'outcome', '--task-id', 'S.1', '--action', 'record', '--task-class', 'bug', '--state', 'INCONCLUSIVE'), 'outcome in a sandbox');
  assert.ok(fs.existsSync(state(sandbox, 'orchestration/S.1.json')) && fs.existsSync(state(sandbox, 'outcome/S.1.json')));
  assert.ok(!fs.existsSync(state(main, 'orchestration/S.1.json')) && !fs.existsSync(state(main, 'outcome/S.1.json')));
});

test('a record the worktree wrote in its own store is adopted; a different one in both refuses with store-conflict', (t) => {
  const { main, wt, doflow, state } = linkedWorld(t);
  // Written by a version before IC-004: the worktree held this task's outcome itself.
  ok(doflow(main, 'outcome', '--task-id', 'A.2', '--action', 'record', '--task-class', 'bug', '--state', 'BLOCKED', '--slug', SLUG), 'seed');
  const recorded = fs.readFileSync(state(main, `outcome/${SLUG}/A.2.json`));
  fs.mkdirSync(path.dirname(state(wt, `outcome/${SLUG}/A.2.json`)), { recursive: true });
  fs.renameSync(state(main, `outcome/${SLUG}/A.2.json`), state(wt, `outcome/${SLUG}/A.2.json`));

  assert.equal(ok(doflow(wt, 'outcome', '--task-id', 'A.2', '--action', 'show'), 'outcome show adopts').state, 'BLOCKED');
  assert.deepEqual(fs.readFileSync(state(main, `outcome/${SLUG}/A.2.json`)), recorded, 'moved byte for byte');
  assert.ok(!fs.existsSync(state(wt, `outcome/${SLUG}/A.2.json`)));

  fs.writeFileSync(state(wt, `outcome/${SLUG}/A.2.json`), '{"differs":true}\n');
  const refused = doflow(wt, 'outcome', '--task-id', 'A.2', '--action', 'show');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.deepEqual(refused.data, { ok: false, error: 'store-conflict', paths: [state(main, `outcome/${SLUG}/A.2.json`), state(wt, `outcome/${SLUG}/A.2.json`)] });
  assert.deepEqual(fs.readFileSync(state(main, `outcome/${SLUG}/A.2.json`)), recorded, 'nothing was written');
  assert.equal(fs.readFileSync(state(wt, `outcome/${SLUG}/A.2.json`), 'utf8'), '{"differs":true}\n');
});

/** O1's own case: a project that tracks agent-docs/, so each feature folder exists only on its branch,
 * in its worktree; the main checkout holds none. Two features, each with a register (namespaced). */
function trackedWorld(t, slugs) {
  const base = tempDir(t, 'doflow-worktree-records-tracked-');
  const env = scratch.env();
  delete env.FORCE_COLOR;
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const main = path.join(base, 'm');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const trackedLiteral = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), '.doflow/\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  const worktrees = {};
  for (const slug of slugs) {
    const wt = path.join(base, slug);
    git(main, 'worktree', 'add', '-q', '-b', `feat/${slug}`, wt);
    for (const [rel, body] of [['intention/requirement.md', `# Requirement\n\n## Summary\n\n${slug} objective text.\n`], ['design/design.md', '# d\n'], ['plan.md', `- [ ] A.1 ${slug} task — owner: x; files: src/a.js\n`], ['decisions/register.json', '{"decisions":[]}\n']]) {
      const file = path.join(wt, 'agent-docs', 'doflow', slug, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    }
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', `feature ${slug}`);
    worktrees[slug] = wt;
  }
  const doflow = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--json'], { cwd, env, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, data: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  const state = (root, rel) => path.join(root, '.doflow', 'state', rel);
  return { main, worktrees, doflow, state };
}

test('a feature folder only in its worktree: plan locators resolve, context-pack reads the plan, and two features\' A.1 records do not collide in main', (t) => {
  const slugs = ['941-alpha', '942-beta'];
  const { main, worktrees, doflow, state } = trackedWorld(t, slugs);
  assert.ok(!fs.existsSync(path.join(main, 'agent-docs')), 'the main checkout holds no feature folder');
  const ids = {};
  for (const slug of slugs) {
    const wt = worktrees[slug];
    const added = doflow(wt, 'evidence', '--task-id', 'A.1', '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
      '--provider', 'graph', '--capability', 'code.structural', '--locator', `agent-docs/doflow/${slug}/plan.md:1`,
      '--content', `plan of ${slug}`, '--establishes', 'affected_components');
    const evidence = ok(added, `evidence add ${slug}`).evidence[0];
    assert.equal(evidence.freshness.status, 'FRESH');
    const claimId = ok(doflow(wt, 'claim', '--task-id', 'A.1', '--action', 'add', '--statement', `${slug} plans A.1.`), `claim add ${slug}`).claim.id;
    const linked = ok(doflow(wt, 'claim', '--task-id', 'A.1', '--action', 'link', '--claim-id', claimId, '--evidence-id', evidence.id), `claim link ${slug}`);
    assert.equal(linked.claim.status, 'supported', 'the plan evidence is fresh where the claim is evaluated');
    const pack = ok(doflow(wt, 'context-pack', '--task-id', 'A.1'), `context-pack ${slug}`);
    assert.equal(pack.objective, `${slug} objective text.`, 'the pack reads the worktree\'s requirement');
    ids[slug] = { evidence: evidence.id, claimId };
  }
  for (const slug of slugs) {
    for (const rel of [`evidence/${slug}/A.1.json`, `evidence/${slug}/A.1_claims.json`, `delivery/${slug}/A.1.json`]) {
      assert.ok(fs.existsSync(state(main, rel)), `${rel} is in the main checkout, namespaced by its feature`);
    }
    assert.deepEqual(filesUnder(path.join(worktrees[slug], '.doflow', 'state')), [], `nothing under ${slug}'s worktree state`);
    const ledger = JSON.parse(fs.readFileSync(state(main, `evidence/${slug}/A.1.json`), 'utf8'));
    assert.deepEqual(ledger.evidence.map((e) => e.id), [ids[slug].evidence], `${slug}'s A.1 holds only its own evidence`);
  }
  assert.ok(!fs.existsSync(state(main, 'evidence/A.1.json')), 'no flat A.1 record shared by the two features');
});
