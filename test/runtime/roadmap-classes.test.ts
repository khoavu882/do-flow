'use strict';

// AU-P1: the roadmap loop runs bug, refactor, trivial-edit, documentation and dependency-change
// rows through a gate-b-only policy (core/registry/gates.json). One row per class goes through to
// merge on a scratch repository with the real orchestrator, gate policy and merge plumbing; research,
// review and operations stay `class-unsupported`; an attended run of the same class keeps its
// gate-free program. Scratch HOME and XDG under the temp folder, git identity set per spawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { repoFromTemplate } = require('../helper/repo-template.ts');
const { next } = require('../../src/runtime/roadmap/loop.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '../..');
const SWITCH = 'DOFLOW_AUTOPILOT_ENABLED';
const CLASSES = ['bug', 'refactor', 'documentation', 'dependency-change', 'trivial-edit'];
const digest = (bytes: any) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const write = (file: any, bytes: any) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const rowOf = (cls: string): any => ({ id: '201', slug: `201-${cls}`, title: `A ${cls} row`, class: cls, needs: [], writeSet: ['toy/'] });

/** The shipped policy with each class's gate-b predicates narrowed to the ones a toy row can satisfy. */
function policyBytes(narrow = true) {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  policy.classes.feature['gate-0'].predicates = ['markers-zero:requirement'];
  policy.classes.feature['gate-a'].predicates = ['markers-zero:plan'];
  policy.classes.feature['gate-b'].predicates = ['markers-zero:plan'];
  if (narrow) for (const cls of CLASSES) policy.classes[cls]['gate-b'].predicates = ['plan-verification-absent', 'verify-pass-on-head', 'protected-paths'];
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function fixture(t: any, rows: any[], { narrow = true }: any = {}) {
  const dir = tempDir(t, 'doflow-roadmap-classes-');
  const root = path.join(dir, 'main');
  const develop = path.join(dir, 'develop');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '',
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test', GIT_AUTHOR_DATE: '1792400000 +0000', GIT_COMMITTER_DATE: '1792400000 +0000' };
  delete env[SWITCH];
  const git = (cwd: any, ...args: any[]) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const gates = policyBytes(narrow);
  repoFromTemplate(`classes-base:${digest(gates)}`, root, (base: any) => {
    git(base, 'init', '-q', '-b', 'main');
    git(base, 'config', 'user.name', 'Develop Owner');
    git(base, 'config', 'user.email', 'develop@example.test');
    git(base, 'config', 'core.hooksPath', '/dev/null');
    write(path.join(base, '.gitignore'), '.doflow/\nagent-docs/\n');
    write(path.join(base, 'core/registry/gates.json'), gates);
    write(path.join(base, 'shared.txt'), 'base\n');
    write(path.join(base, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node -e 0' } })}\n`);
    git(base, 'add', '.');
    git(base, 'commit', '-qm', 'base');
  });
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows }));
  write(path.join(home, '.config/doflow/settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }));
  let clock = Date.parse('2026-10-31T00:00:00.000Z');
  const tick = () => new Date(clock += 1000);
  const worktree = (row: any) => path.join(dir, `main-${row.id}`);
  const orch = (row: any) => new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: worktree(row),
    stateDir: path.join(worktree(row), '.doflow/state/orchestration'), featureSlug: row.slug, env, readinessEvaluate: () => 'READY' });
  return { dir, root, develop, home, env, git, tick, worktree, orch,
    next: (options: any = {}) => next({ root, env, now: tick, ...options }),
    featureDir: (row: any) => path.join(worktree(row), 'agent-docs/doflow', row.slug) };
}

function verifyLine(f: any, row: any, head: string, verdict = 'PASS') {
  const file = path.join(f.root, '.doflow/state/verification/runs', `${row.slug}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ schema: 1, taskId: row.slug, head, clean: true, verdict, at: '2026-10-31T00:00:00Z', reportSha256: `sha256:${'e'.repeat(64)}` })}\n`);
}

/** Does what the stage's skill does for a perform envelope, then records its handoff as the envelope's `after` says. */
function performStage(f: any, row: any, perform: any, seen: string[]) {
  const wt = f.worktree(row);
  seen.push(`${perform.stage}:${perform.skill}`);
  const kind = f.orch(row).readRun(row.slug).program.find((n: any) => n.id === perform.stage).kind;
  if (kind === 'implementation' || kind === 'synthesis') {
    write(path.join(wt, 'toy', `${perform.stage}.txt`), `${perform.stage}\n`);
    f.git(wt, 'add', '.');
    f.git(wt, 'commit', '-qm', perform.stage);
  } else if (kind === 'verification') {
    verifyLine(f, row, f.git(wt, 'rev-parse', 'HEAD'));
  } else if (kind === 'review') {
    write(path.join(f.featureDir(row), 'review/findings.json'), `${JSON.stringify({ stage: perform.stage })}\n`);
  }
  f.orch(row).handoff({ taskId: row.slug, callingSkill: perform.skill, note: 'stage work recorded', now: f.tick() });
}

/** Drives next() to the end of the row, as a session would, and returns what happened. */
async function drive(f: any, row: any) {
  const seen: string[] = [];
  const steps: string[] = [];
  const performs: any[] = [];
  for (let i = 0; i < 60; i++) {
    const out = await f.next();
    const r = out.result;
    steps.push(`${r.outcome}:${r.step ?? r.perform?.purpose ?? r.reason ?? ''}`);
    if (r.outcome === 'perform') performs.push(r.perform);
    if (r.outcome === 'perform' && r.perform.purpose === 'post-merge') {
      verifyLine(f, row, r.perform.head);
      continue;
    }
    if (r.outcome === 'perform') { performStage(f, row, r.perform, seen); continue; }
    if (r.outcome === 'acted' && r.step === 'cleanup') return { seen, steps, performs, last: r };
    if (r.outcome === 'denied' || r.outcome === 'blocked' || r.outcome === 'stopped' || r.outcome === 'idle') return { seen, steps, performs, last: r };
  }
  throw new Error(`the loop did not finish: ${steps.join(' > ')}`);
}

const PROGRAMS: Record<string, string[]> = {
  bug: ['reproduction:do-test', 'root-cause:do-diagnose', 'implementation:do-implement', 'regression-verification:do-test', 'review:do-code-review'],
  refactor: ['architecture-mapping:do-diagnose', 'baseline-verification:do-test', 'implementation:do-implement', 'verification:do-test', 'review:do-code-review'],
  documentation: ['authoring:do-document', 'verification:do-test', 'review:do-code-review'],
  'dependency-change': ['release-evidence:do-document', 'usage-impact:do-diagnose', 'implementation:do-implement', 'verification:do-test', 'review:do-code-review'],
  'trivial-edit': ['implementation:do-implement', 'verification:do-test', 'review:do-code-review'],
};

for (const cls of CLASSES) {
  test(`a ${cls} row goes from pick through its gate-b to a merge on develop and a cleaned worktree`, async (t) => {
    const row = rowOf(cls);
    const f = fixture(t, [row]);
    const out = await drive(f, row);
    assert.deepEqual(out.seen, PROGRAMS[cls], 'every stage is performed once, in the class order, by the stage skill (optional ones included)');
    assert.deepEqual([out.last.outcome, out.last.step, out.last.annotations?.cleanup], ['acted', 'cleanup', 'cleaned'], out.steps.join(' > '));
    // What the session is told: commit its edits on the feature branch (no dispatch); verify with the row's scope only where nothing else declares one.
    for (const perform of out.performs.filter((p: any) => p.purpose !== 'post-merge')) {
      const kind = ['implementation', 'authoring'].includes(perform.stage) ? 'edit' : /verification/.test(perform.stage) ? 'verify' : 'other';
      assert.deepEqual(perform.commit, kind === 'edit' ? { branch: `feat/${row.slug}` } : undefined, `${cls} ${perform.stage}`);
      if (kind === 'edit') assert.deepEqual(perform.after.slice(0, 2), ['orchestrate', '--action'], 'no dispatch for these classes');
      if (kind === 'verify') {
        assert.equal(perform.after[0].includes('--scope'), cls === 'documentation', `${cls} ${perform.stage}`);
        if (cls === 'documentation') assert.equal(perform.after[0][perform.after[0].indexOf('--scope') + 1], 'toy/');
        assert.match(perform.afterNote, /run the handoff next/);
      }
    }
    const postMerge = out.performs.find((p: any) => p.purpose === 'post-merge');
    assert.equal(postMerge.after.includes('--scope'), cls === 'documentation');
    const run = JSON.parse(fs.readFileSync(path.join(f.root, '.doflow/state/roadmap/runs', fs.readdirSync(path.join(f.root, '.doflow/state/roadmap/runs'))[0]), 'utf8'));
    assert.ok(run.rows[row.id].done);
    // develop holds the merge, with the row trailer; the feature worktree is gone.
    const trailers = f.git(f.develop, 'log', '-1', '--format=%(trailers:key=DoFlow-Row,valueonly)');
    assert.match(trailers, new RegExp(row.id));
    assert.equal(fs.existsSync(f.worktree(row)), false);
    // the gate-b approval was made by policy (audit), and no gate other than gate-b was ever decided.
    const audit = fs.readFileSync(path.join(f.root, '.doflow/state/roadmap/audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    const gates = audit.filter((e: any) => e.step === 'gate');
    assert.equal(gates.length, 1);
    assert.match(gates[0].audit, new RegExp(`^gate-b ${row.slug} approved by policy gate-b@sha256:`));
  });
}

test('the shipped gate-b predicates bite: a bug row with no review findings is denied and held, never merged', async (t) => {
  const row = rowOf('bug');
  const f = fixture(t, [row], { narrow: false });
  const out = await drive(f, row);
  assert.deepEqual([out.last.outcome, out.last.step], ['denied', 'gate'], out.steps.join(' > '));
  assert.deepEqual(out.last.reasons, ['findings-invalid'], 'the stage wrote a findings file that is not a valid review');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.git(f.root, 'rev-parse', 'main'), 'develop did not move');
  const again = await f.next();
  assert.equal(again.result.outcome, 'idle', 'the denied gate is held by its inputs digest');
  assert.equal(again.result.skips[row.id].startsWith('held:'), true);
});

test('the loop program: every stage required, a review stage and a gate-b added; the run journal records it', async (t) => {
  for (const cls of CLASSES) {
    const row = rowOf(cls);
    const f = fixture(t, [row]);
    await f.next();
    const run = f.orch(row).readRun(row.slug);
    const nodes = run.program.map((n: any) => (n.type === 'gate' ? n.id : `${n.id}:${n.skill}`));
    assert.deepEqual(nodes, [...PROGRAMS[cls], 'gate-b'], cls);
    assert.equal(run.program.some((n: any) => n.optional), false, `${cls}: no optional stage`);
    assert.equal(run.programKind, 'roadmap-loop');
    assert.match(run.history[0].detail, new RegExp(`task-class=${cls} program=roadmap-loop`));
  }
});

test('an attended run of the same classes keeps its gate-free program: no gate-b, optional stages stay optional', (t) => {
  const f = fixture(t, [rowOf('trivial-edit')]);
  const programs: Record<string, string[]> = {};
  for (const cls of CLASSES) {
    const row = rowOf(cls);
    const orch = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: f.root, stateDir: path.join(f.dir, `attended-${cls}`), featureSlug: row.slug, env: f.env, readinessEvaluate: () => 'READY' });
    const run = orch.start({ taskId: row.slug, taskClass: cls, now: f.tick() });
    const stored = orch.readRun(row.slug);
    programs[cls] = stored.program.map((n: any) => n.id);
    assert.equal(stored.program.some((n: any) => n.type === 'gate'), false, `${cls}: no gate node`);
    assert.equal(stored.programKind, undefined);
    assert.equal(run.state, 'RUNNING');
  }
  assert.deepEqual(programs['trivial-edit'], ['implementation', 'verification'], 'the attended trivial-edit has no review stage');
  assert.deepEqual(programs.bug, ['reproduction', 'root-cause', 'implementation', 'regression-verification', 'review']);
  const attended = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: f.root, stateDir: path.join(f.dir, 'attended-optional'), featureSlug: 'x', env: f.env });
  attended.start({ taskId: 'x', taskClass: 'bug', now: f.tick() });
  assert.equal(attended.readRun('x').program.find((n: any) => n.id === 'review').optional, true);
});

test('research, review and operations rows stay class-unsupported, before and after the claim', async (t) => {
  for (const cls of ['research', 'review', 'operations']) {
    const row = rowOf(cls);
    const f = fixture(t, [row]);
    const idle = await f.next();
    assert.deepEqual([idle.result.outcome, idle.result.skips[row.id]], ['idle', 'class-unsupported'], cls);
    assert.equal(f.git(f.root, 'branch', '--list', `feat/${row.slug}`), '', `${cls}: no branch is claimed`);
    // A branch a person started by hand for such a row is in flight, and the loop still leaves it alone.
    f.git(f.root, 'worktree', 'add', '-qb', `feat/${row.slug}`, f.worktree(row), 'develop');
    const inFlight = await f.next();
    assert.deepEqual([inFlight.result.outcome, inFlight.result.skips[row.id]], ['idle', 'class-unsupported'], `${cls} in flight`);
  }
});

test('a folder that holds artifacts but no decision register is denied once and held, never retried every call', async (t) => {
  const row = rowOf('bug');
  const f = fixture(t, [row]);
  await f.next(); // pick
  write(path.join(f.featureDir(row), 'requirement.md'), 'old\n');
  const denied = await f.next();
  assert.deepEqual([denied.result.outcome, denied.result.reason, denied.result.annotations.unreadable], ['denied', 'facts-unreadable', ['decision-register']]);
  const held = await f.next();
  assert.deepEqual([held.result.outcome, held.result.skips[row.id]], ['idle', 'held:facts-unreadable']);
});

/** Performs stages until `next` hands out the perform for `stage`, which is returned unperformed. */
async function driveTo(f: any, row: any, stage: string) {
  for (let i = 0; i < 30; i++) {
    const { result: r } = await f.next();
    if (r.outcome === 'acted') continue;
    if (r.outcome !== 'perform') throw new Error(`expected a perform for ${stage}, got ${r.outcome}:${r.step ?? r.reason ?? ''}`);
    if (r.perform.stage === stage) return r.perform;
    performStage(f, row, r.perform, []);
  }
  throw new Error(`never reached ${stage}`);
}

test('A: a stray handoff of another skill that backfills the pending stage does not count as performing it', async (t) => {
  const row = rowOf('bug');
  const f = fixture(t, [row]);
  const pending = await driveTo(f, row, 'root-cause');
  assert.equal(pending.skill, 'do-diagnose');
  // A second do-test handoff: reproduction is done, so catch-up walks root-cause as BACKFILLED and stops at implementation.
  const stray = f.orch(row).handoff({ taskId: row.slug, callingSkill: 'do-test', note: 'second run', now: f.tick() });
  assert.equal(stray.disposition, 'deferred');
  const entry = f.orch(row).readRun(row.slug).history.find((h: any) => h.node === 'root-cause' && h.action === 'complete-stage');
  assert.equal(entry.backfilled, true);
  const first = (await f.next()).result;
  assert.equal(first.outcome, 'denied');
  assert.equal(first.reason, 'stage-not-performed');
  assert.equal(first.perform.stage, 'root-cause');
  // Held by digest: a second call spends no step; the row is never advanced to implementation by the stray handoff.
  const second = (await f.next()).result;
  assert.notEqual(second.step, 'pick');
  assert.ok(!second.perform || second.perform.stage !== 'implementation');
  // A real do-diagnose handoff afterwards (an annotation on the already backfilled stage) is a handoff of THIS stage: accepted.
  f.orch(row).handoff({ taskId: row.slug, callingSkill: 'do-diagnose', note: 'root cause found', now: f.tick() });
  const accepted = (await f.next()).result;
  assert.equal(accepted.outcome, 'perform');
  assert.equal(accepted.perform.stage, 'implementation');
});

test('A: a stage backfilled by another skill is held with the annotate command that releases it, and that command releases it', async (t) => {
  const row = rowOf('bug');
  const f = fixture(t, [row]);
  const pending = await driveTo(f, row, 'reproduction');
  assert.equal(pending.skill, 'do-test');
  // The session ran do-diagnose first: catch-up backfills the pending reproduction and completes root-cause.
  f.orch(row).handoff({ taskId: row.slug, callingSkill: 'do-diagnose', note: 'root cause found', now: f.tick() });
  const denied = (await f.next()).result;
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.reason, 'stage-not-performed');
  assert.equal(denied.annotations.backfilled, true);
  assert.deepEqual(denied.annotations.release.slice(0, 7), ['orchestrate', '--action', 'annotate', '--task-id', row.slug, '--node', 'reproduction']);
  // Held for good otherwise: the next call spends no step and says nothing new.
  const again = (await f.next()).result;
  assert.notEqual(again.outcome, 'perform');
  // The named command, run as written, releases the hold: the loop moves on to implementation.
  f.orch(row).annotate({ taskId: row.slug, node: 'reproduction', note: 'reproduced before root-cause', now: f.tick() });
  const released = (await f.next()).result;
  assert.equal(released.outcome, 'perform');
  assert.equal(released.perform.stage, 'implementation');
});
