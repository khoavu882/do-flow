'use strict';

// Feature 080 E.1 (IC-017, DEC-004, DEC-015): the `task-attempt` verb's actions, flags, validation
// and exit codes, through `bin/doflow.js` on a temp project. Every child gets an explicit identity
// environment, so the developer's shell never decides a run key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { parseArgs } = require('../../src/cli/index.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { formatInspect } = require('../../src/runtime/task-run.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = 'feat-e';

const TASKS = [
  '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js',
  '', '### Phase B', '',
  '- [ ] B.1 later task; owner: quality-guardian; files: c.js', '',
];
const plan = ({ graph = true, tasks = TASKS } = {}) => ['# Plan', '', ...(graph ? ['**Task graph:** v1', ''] : []), '## Tasks', '', ...tasks].join('\n');

function project(t, text = plan()) {
  const dir = tempDir(t, 'doflow-task-attempt-cli-');
  const home = path.join(dir, '.home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: dir,
  };
  delete env.DOFLOW_RETENTION_HOURS;
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, text);
  const store = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  /** One CLI call; `json: false` omits `--json`. */
  const raw = (args, { json = true } = {}) => {
    const done = spawnSync(process.execPath, [CLI, 'task-attempt', ...args, ...(json ? ['--json'] : [])], { cwd: dir, env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* no JSON on stdout */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  const ta = (action, extra = [], opts) => raw(['--action', action, '--slug', SLUG, ...extra], opts);
  const evidence = (taskId) => {
    const ledger = new EvidenceLedger({ repoRoot: dir, slug: SLUG });
    const id = ledger.addEvidence({
      taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
      locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
    });
    ledger.save(taskId);
    return id;
  };
  return { dir, planFile, store, raw, ta, evidence };
}

const ok = (r, disposition) => {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  if (disposition) assert.equal(r.data.disposition, disposition);
  return r.data;
};
const exit1 = (r, disposition, reason) => {
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.ok(r.data, `exit 1 must carry JSON on stdout: ${r.stdout}`);
  assert.equal(r.data.disposition, disposition);
  if (reason) assert.equal(r.data.reason, reason);
  return r.data;
};
const usage = (r, code = 'usage') => {
  assert.equal(r.status, 2, r.stderr || r.stdout);
  if (r.data) { assert.equal(r.data.ok, false); assert.equal(r.data.error, code); }
  return r;
};

const startRun = (p, extra = []) => ok(p.ta('start', ['--by', 'lead', ...extra]), 'started');
const claimA1 = (p, extra = []) => ok(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '1', ...extra]), 'claimed');

test('IC-017 exit 0: every applied disposition and both reads print JSON', (t) => {
  const p = project(t);
  const started = startRun(p, ['--budget-attempts', '5', '--budget-tokens', '1000']);
  assert.equal(started.epoch, 1);
  assert.deepEqual(started.budget, { attempts: 5, tokens: 1000 });
  const claimed = claimA1(p, ['--reserve-tokens', '10', '--exec-worktree', '.']);
  assert.equal(claimed.execWorktree, p.dir);
  ok(p.ta('finish', ['--task', 'A.1', '--token', String(claimed.token), '--result', 'COMPLETED',
    '--evidence-id', p.evidence('A.1'), '--tokens', '7', '--tokens-basis', 'measured']), 'applied');
  const reopened = ok(p.ta('reopen', ['--task', 'A.1', '--token', String(claimed.token), '--by', 'lead', '--reason', 'redo']), 'reopened');
  assert.deepEqual(reopened.dependentsActive, []);
  const second = claimA1(p, ['--reserve-tokens', '10']);
  ok(p.ta('release', ['--task', 'A.1', '--token', String(second.token), '--reason', 'handing back', '--tokens', '0', '--tokens-basis', 'estimated']), 'released');
  const third = claimA1(p, ['--reserve-tokens', '10']);
  ok(p.ta('cancel', ['--task', 'A.1', '--token', String(third.token), '--by', 'lead', '--reason', 'stop one']), 'cancelled');
  ok(p.ta('pause', ['--by', 'lead', '--reason', 'break']), 'paused');
  const report = exit1(p.ta('resume'), 'ack-required');
  assert.match(report.digest, /^sha256:[0-9a-f]{64}$/);
  const resumed = ok(p.ta('resume', ['--ack', report.digest, '--by', 'lead', '--reason', 'back']), 'resumed');
  assert.equal(resumed.epoch, 2);
  ok(p.ta('cancel', ['--by', 'lead', '--reason', 'stop all']), 'cancelled');
  const status = ok(p.ta('status'));
  assert.ok(Array.isArray(status.tasks));
  const view = ok(p.ta('inspect'));
  assert.equal(view.slug, SLUG);
  assert.equal(view.run.control, 'cancelled');
});

test('IC-017 exit 1 with JSON: refused, stale and ack-required carry the disposition', (t) => {
  const p = project(t);
  startRun(p);
  exit1(p.ta('start', ['--by', 'lead']), 'refused', 'run-exists');
  const claimed = claimA1(p);
  exit1(p.ta('finish', ['--task', 'A.1', '--token', String(claimed.token + 1), '--result', 'BLOCKED']), 'stale', 'token-mismatch');
  exit1(p.ta('reopen', ['--task', 'A.2', '--token', '1', '--by', 'lead', '--reason', 'x']), 'refused', 'not-done');
  exit1(p.ta('claim', ['--task', 'A.2', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '2']), 'refused', 'resume-required');
  exit1(p.ta('resume'), 'ack-required');
  exit1(p.ta('resume', ['--ack', `sha256:${'0'.repeat(64)}`, '--by', 'lead']), 'refused', 'report-changed');
});

test('IC-017 exit 2 JSON: usage, store-unreadable, plan-unreadable and plan-malformed', (t) => {
  const p = project(t);
  usage(p.ta('start'));                                    // --by missing
  usage(p.ta('pause', ['--by', 'lead']));                  // --reason missing
  usage(p.ta('pause', ['--by', 'lead', '--reason', '']));  // empty reason on an action that needs one
  usage(p.ta('cancel', ['--by', 'lead', '--reason', 'x', '--task', 'A.1'])); // --task without --token
  usage(p.ta('resume', ['--ack', 'sha256:abc', '--by', 'lead']));
  usage(p.ta('resume', ['--ack', `sha256:${'0'.repeat(64)}`]));  // --ack needs --by
  usage(p.ta('start', ['--by', 'bad/name']));
  usage(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--owner-override', '  ']));
  usage(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--exec-worktree', 'missing-dir']));
  usage(p.ta('finish', ['--task', 'A.1', '--token', '1', '--result', 'BLOCKED', '--tokens', '3']));
  usage(p.ta('finish', ['--task', 'A.1', '--token', '1', '--result', 'BLOCKED', '--tokens', '3', '--tokens-basis', 'guessed']));
  usage(p.ta('finish', ['--task', 'A.1', '--token', '1', '--result', 'FAILED']));
  usage(p.ta('bogus'));
  fs.mkdirSync(path.dirname(p.store), { recursive: true });
  fs.writeFileSync(p.store, '{ torn');
  usage(p.ta('inspect'), 'store-unreadable');
  assert.equal(fs.readFileSync(p.store, 'utf8'), '{ torn');
  usage(p.raw(['--action', 'inspect', '--slug', 'no-such-feature']), 'plan-unreadable');
  fs.writeFileSync(p.planFile, plan({ tasks: ['### Phase A', '', '- [ ] A.1 one; depends-on: Q.9', ''] }));
  usage(p.ta('inspect'), 'plan-malformed');
});

test('DEC-018 report-usage: exit 0 with JSON usage-recorded; a missing --tokens-basis is exit 2 usage', (t) => {
  const p = project(t);
  startRun(p, ['--budget-tokens', '1000']);
  const claimed = claimA1(p, ['--reserve-tokens', '10']);
  ok(p.ta('finish', ['--task', 'A.1', '--token', String(claimed.token), '--result', 'BLOCKED']), 'applied');
  const before = fs.readFileSync(p.store);
  usage(p.ta('report-usage', ['--task', 'A.1', '--token', String(claimed.token), '--tokens', '40']));
  usage(p.ta('report-usage', ['--task', 'A.1', '--token', String(claimed.token), '--tokens', '40', '--tokens-basis', 'measured', '--reason', 'x']));
  assert.deepEqual(fs.readFileSync(p.store), before, 'a usage error writes nothing');
  const recorded = ok(p.ta('report-usage', ['--task', 'A.1', '--token', String(claimed.token), '--tokens', '40', '--tokens-basis', 'measured']), 'usage-recorded');
  assert.deepEqual([recorded.taskId, recorded.token], ['A.1', claimed.token]);
  exit1(p.ta('report-usage', ['--task', 'A.1', '--token', String(claimed.token), '--tokens', '1', '--tokens-basis', 'estimated']), 'refused', 'usage-present');
});

test('DEC-023 exec-worktree-directory: --exec-worktree naming an existing file is exit 2 usage and writes nothing', (t) => {
  const p = project(t);
  startRun(p);
  const before = fs.readFileSync(p.store);
  fs.writeFileSync(path.join(p.dir, 'not-a-dir.txt'), 'x\n');
  usage(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '1', '--exec-worktree', 'not-a-dir.txt']));
  assert.deepEqual(fs.readFileSync(p.store), before);
});

test('IC-017 / DEC-015 exit 1 without JSON: a parser usage error runs nothing', (t) => {
  const p = project(t);
  // `--reason` last, so nothing follows it to be read as its value.
  const noValue = p.raw(['--action', 'pause', '--slug', SLUG, '--by', 'lead', '--json', '--reason'], { json: false });
  assert.equal(noValue.status, 1);
  assert.equal(noValue.data, null, 'nothing on stdout parses as JSON');
  const unknown = p.ta('status', ['--no-such-flag']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.data, null);
  assert.equal(fs.existsSync(p.store), false, 'nothing was written');
});

test('IC-017: 0, 5abc and -1 are usage for every at-least-1 integer flag; 5abc and -1 for the rest', (t) => {
  const p = project(t);
  const cases = [
    ['--epoch', 1, (v) => ['claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', v]]],
    ['--reserve-tokens', 0, (v) => ['claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', v]]],
    ['--tokens', 0, (v) => ['finish', ['--task', 'A.1', '--token', '1', '--result', 'BLOCKED', '--tokens-basis', 'measured', v]]],
    ['--budget-attempts', 1, (v) => ['start', ['--by', 'lead', v]]],
    ['--budget-tokens', 1, (v) => ['start', ['--by', 'lead', v]]],
  ];
  for (const [flag, min, call] of cases) {
    const bad = ['5abc', '-1', '1.5', ...(min === 1 ? ['0'] : [])];
    for (const value of bad) {
      const [action, extra] = call(`${flag}=${value}`);
      const r = usage(p.ta(action, extra));
      assert.ok(r.data, `${flag}=${value}: usage JSON`);
    }
    // The space spelling of a negative value reads as a missing value: still exit 2.
    const [action, extra] = call(flag);
    usage(p.ta(action, [...extra, '-1']));
  }
  assert.equal(fs.existsSync(p.store), false, 'no rejected flag wrote anything');
  // The values IC-017 admits still parse.
  startRun(p, ['--budget-attempts', '1']);
  ok(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '1', '--reserve-tokens', '0']));
});

test('IC-017: a flag given to an action that does not take it is exit 2 usage', (t) => {
  const p = project(t);
  const misplaced = [
    ['start', ['--by', 'lead', '--epoch', '1']],
    ['status', ['--by', 'lead']],
    ['finish', ['--task', 'A.1', '--token', '1', '--result', 'BLOCKED', '--ack', `sha256:${'0'.repeat(64)}`]],
    ['claim', ['--task', 'A.1', '--owner', 'x', '--mode', 'subagent', '--budget-attempts', '2']],
    ['release', ['--task', 'A.1', '--token', '1', '--reason', 'x', '--adopt-unowned']],
    ['pause', ['--by', 'lead', '--reason', 'x', '--owner', 'x']],
    ['inspect', ['--task', 'A.1']],
    ['start', ['--by', 'lead', '--reason', 'x']],
    ['cancel', ['--task', 'A.1', '--token', '1', '--by', 'lead', '--reason', 'x', '--adopt-unowned']],
  ];
  for (const [action, extra] of misplaced) usage(p.ta(action, extra));
  assert.equal(fs.existsSync(p.store), false);
});

test('IC-017: --adopt-unowned is a switch that parses and takes runKey-less attempts on a run cancel', (t) => {
  const parsed = parseArgs(['task-attempt', '--action', 'cancel', '--adopt-unowned', '--by', 'lead', '--reason', 'x']);
  assert.equal(parsed.adoptUnowned, true);
  assert.equal(parsed.by, 'lead');
  assert.equal(parseArgs(['task-attempt', '--action', 'cancel']).adoptUnowned, undefined);
  const p = project(t, plan({ graph: false }));
  const claimed = ok(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent']), 'claimed');
  const store = JSON.parse(fs.readFileSync(p.store, 'utf8'));
  delete store.tasks['A.1'].attempts[0].runKey;  // as a pre-080 runtime would have written it
  fs.writeFileSync(p.store, JSON.stringify(store, null, 2));
  const cancelled = ok(p.ta('cancel', ['--by', 'lead', '--reason', 'stop', '--adopt-unowned']), 'cancelled');
  assert.deepEqual(cancelled.adopted, [{ taskId: 'A.1', token: claimed.token }]);
});

test('IC-017: every existing invocation keeps its exit code and JSON keys (legacy plan)', (t) => {
  const p = project(t, plan({ graph: false }));
  const claimed = ok(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent']), 'claimed');
  assert.deepEqual(Object.keys(claimed).sort(), ['disposition', 'revision', 'taskId', 'token']);
  const refused = exit1(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent']), 'refused', 'active-attempt');
  for (const key of ['disposition', 'taskId', 'reason', 'activeToken', 'owner', 'startedAt']) assert.ok(key in refused, key);
  const stale = exit1(p.ta('release', ['--task', 'A.1', '--token', '9', '--reason', 'x']), 'stale', 'token-mismatch');
  assert.deepEqual(Object.keys(stale).sort(), ['disposition', 'reason', 'taskId', 'token']);
  const applied = ok(p.ta('finish', ['--task', 'A.1', '--token', String(claimed.token), '--result', 'BLOCKED', '--reason', 'waiting']), 'applied');
  assert.deepEqual(Object.keys(applied).sort(), ['disposition', 'result', 'revision', 'taskId', 'token']);
  const again = ok(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent']), 'claimed');
  const released = ok(p.ta('release', ['--task', 'A.1', '--token', String(again.token), '--reason', 'x']), 'released');
  assert.deepEqual(Object.keys(released).sort(), ['disposition', 'revision', 'taskId', 'token']);
  const status = ok(p.ta('status'));
  for (const key of ['complete', 'revision', 'tasks', 'unclaimedChecked']) assert.ok(key in status, key);
  usage(p.ta('release', ['--task', 'A.1', '--token', '1', '--reason', '']));
  usage(p.ta('claim', ['--task', 'A.1', '--owner', 'core-implementer', '--mode', 'fast']));
});

test('IC-017 text output: inspect prints formatInspect lines; refusals and dispositions are one line', (t) => {
  const p = project(t);
  startRun(p);
  const text = p.ta('inspect', [], { json: false });
  assert.equal(text.status, 0, text.stderr);
  const view = ok(p.ta('inspect'));
  assert.deepEqual(text.stdout.trimEnd().split('\n'), formatInspect(view));
  const ack = p.ta('resume', [], { json: false });
  assert.equal(ack.status, 1);
  assert.match(ack.stderr, /^ack-required digest sha256:[0-9a-f]{64}/);
  const again = p.ta('start', ['--by', 'lead'], { json: false });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /refused \(run-exists\)/);
});
