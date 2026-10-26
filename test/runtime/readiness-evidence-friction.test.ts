'use strict';
// readiness-evidence-friction.test.ts — three frictions of the readiness gate, each with a control:
//   (b) a bare `readiness` re-check keeps the scope and plan an earlier evaluation stated; a call
//       that passes new ones replaces them,
//   (c) `evidence --action retire --stale` retires every stale item and leaves fresh ones,
//   (d) an evidence locator that is a directory is refused, loudly, in plain and --json mode.
//
// Every case runs the real bin/doflow.js in a scratch git repository under a scratch HOME.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createScratch } = require('../helper/scratch-env.ts');

const DOFLOW = path.resolve(__dirname, '../../bin/doflow.js');
const scratch = createScratch('doflow-friction-');
after(() => scratch.remove());

let n = 0;
/** A repository on main with committed src/a.js, src/b.js and src/dir/c.js, ignoring .doflow/. */
function makeRepo() {
  n += 1;
  const root = path.join(scratch.dir, `repo-${n}`);
  fs.mkdirSync(path.join(root, 'src', 'dir'), { recursive: true });
  for (const f of ['a.js', 'b.js', 'dir/c.js']) fs.writeFileSync(path.join(root, 'src', f), `${f}\n`);
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  const git = (...a: any[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, env: scratch.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}

function run(cwd: any, args: any[]) {
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env: scratch.env(), encoding: 'utf8' });
}

function addEvidence(cwd: any, taskId: any, locator: any, extra: any[] = []) {
  return run(cwd, ['evidence', '--task-id', taskId, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graph', '--capability', 'code.structural', '--locator', locator, '--content', `read ${locator}`,
    '--establishes', 'affected_components', '--json', ...extra]);
}

const readinessRecord = (root: any, taskId: any) => JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'readiness', `${taskId}.json`), 'utf8'));

test('a bare readiness call reuses the scope and plan of the last evaluation; new ones replace them', () => {
  const { root } = makeRepo();
  assert.equal(addEvidence(root, 'demo', 'src/a.js').status, 0);
  const first = run(root, ['readiness', '--task-class', 'feature', '--task-id', 'demo', '--scope', 'src/a.js', '--verification-plan', 'node -e 0']);
  assert.ok(first.stdout.includes('✓ READY'), first.stdout);

  const bare = run(root, ['readiness', '--task-class', 'feature', '--task-id', 'demo']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.ok(bare.stdout.includes('✓ READY'), `a bare call kept the verdict:\n${bare.stdout}`);
  assert.ok(bare.stdout.includes('Carried:'), bare.stdout);
  const kept = readinessRecord(root, 'demo');
  assert.equal(kept.state, 'READY');
  assert.deepEqual(kept.declaredScope, ['src/a.js']);
  assert.equal(kept.inputs.verificationPlan, 'node -e 0');

  // Control: an input passed now replaces the recorded one, and the other is still carried.
  const replaced = run(root, ['readiness', '--task-class', 'feature', '--task-id', 'demo', '--scope', 'src/b.js']);
  assert.ok(replaced.stdout.includes('✓ READY'), replaced.stdout);
  const after = readinessRecord(root, 'demo');
  assert.deepEqual(after.declaredScope, ['src/b.js']);
  assert.equal(after.inputs.verificationPlan, 'node -e 0');

  // Control: nothing is invented. A task never evaluated with them, or another template, carries nothing.
  assert.ok(run(root, ['readiness', '--task-class', 'feature', '--task-id', 'fresh']).stdout.includes('NEEDS EVIDENCE'));
  const other = run(root, ['readiness', '--task-class', 'bug', '--task-id', 'demo']);
  assert.ok(!other.stdout.includes('Carried:'), other.stdout);
});

test('evidence --action retire --stale retires stale items, records why, and leaves fresh ones', () => {
  const { root } = makeRepo();
  const staleAdd = JSON.parse(addEvidence(root, 'demo', 'src/a.js').stdout);
  const freshAdd = JSON.parse(addEvidence(root, 'demo', 'src/b.js').stdout);
  const staleId = staleAdd.evidence[0].id;
  const freshId = freshAdd.evidence[0].id;
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'changed\n');

  const retire = run(root, ['evidence', '--task-id', 'demo', '--action', 'retire', '--stale', '--json']);
  assert.equal(retire.status, 0, retire.stderr);
  const out = JSON.parse(retire.stdout);
  assert.equal(out.retired, 1);
  assert.deepEqual(out.ids, [staleId]);

  const ledger = JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'evidence', 'demo.json'), 'utf8')).evidence;
  const byId = Object.fromEntries(ledger.map((i: any) => [i.id, i]));
  assert.equal(byId[staleId].status, 'superseded');
  assert.match(byId[staleId].retiredReason, /^stale: /);
  assert.equal(byId[freshId].status, 'active', 'a fresh item is untouched');
  assert.equal(byId[freshId].retiredReason, undefined);

  // Idempotent, and the plain form names the count.
  const again = run(root, ['evidence', '--task-id', 'demo', '--action', 'retire', '--stale']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /no stale items to retire/);

  // The readiness gate no longer reports the retired item as stale.
  const ready = JSON.parse(run(root, ['readiness', '--task-class', 'feature', '--task-id', 'demo', '--scope', 'src/b.js', '--verification-plan', 'node -e 0', '--json']).stdout);
  assert.equal(ready.staleEvidence.length, 0);
  assert.equal(ready.state, 'READY');

  // `retire` without --stale is refused rather than guessed at.
  const bare = run(root, ['evidence', '--task-id', 'demo', '--action', 'retire']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--stale/);
});

test('without the retire, stale evidence blocks READY (control for the retire above)', () => {
  const { root } = makeRepo();
  assert.equal(addEvidence(root, 'demo', 'src/a.js').status, 0);
  assert.equal(addEvidence(root, 'demo', 'src/b.js').status, 0);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'changed\n');
  const ready = JSON.parse(run(root, ['readiness', '--task-class', 'feature', '--task-id', 'demo', '--scope', 'src/b.js', '--verification-plan', 'node -e 0', '--json']).stdout);
  assert.equal(ready.staleEvidence.length, 1);
  assert.notEqual(ready.state, 'READY');
});

test('a directory locator is refused with exit 2 and a message naming it, in plain and --json mode, for any provenance', () => {
  const { root } = makeRepo();
  const plain = run(root, ['evidence', '--task-id', 'demo', '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graph', '--capability', 'code.structural', '--locator', 'src/dir', '--content', 'x']);
  assert.equal(plain.status, 2);
  assert.ok(plain.stderr.includes("'src/dir'") && plain.stderr.includes('directory is not a valid locator'), plain.stderr);

  const json = addEvidence(root, 'demo', 'src/dir');
  assert.equal(json.status, 2);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.summary.includes("'src/dir'") && body.summary.includes('directory is not a valid locator'), body.summary);

  const asserted = run(root, ['evidence', '--task-id', 'demo', '--action', 'add', '--kind', 'documentation', '--provenance', 'asserted',
    '--provider', 'p', '--capability', 'c', '--locator', 'src/dir', '--content', 'x']);
  assert.equal(asserted.status, 2);
  assert.ok(asserted.stderr.includes('directory is not a valid locator'), asserted.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.doflow', 'state', 'evidence', 'demo.json')), 'nothing was recorded');

  // Control: a file locator, with a line, is still accepted.
  assert.equal(addEvidence(root, 'demo', 'src/dir/c.js:1').status, 0);
});
