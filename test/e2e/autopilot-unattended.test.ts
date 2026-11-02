'use strict';

// AU-P9: the unattended end-to-end proof, with no model call (autonomy plan section 10).
//
// A scripted driver plays the session of an unattended autopilot run on a fixture repository that has
// a main checkout, a local `develop` and NO remote. Every `roadmap --action next` is the real CLI
// (bin/doflow.js) against the SHIPPED core/registry/gates.json; every `after` argv an envelope names
// is run through the same CLI, from the row's worktree, as the primary session. The driver writes the
// artifacts a stage skill would write and never asks anything. Four rows are seeded:
//   601 bug, a stage that is never performed (K59: the session halts, records a follow-up, does not hand off)
//   602 feature, the whole chain: discovery, gate-0, design, planning, gate-a, implementation, verification, review, gate-b
//   603 bug, whose review accepts a NOTE by a default-channel decision (AU D4)
//   604 bug, whose review accepts a BLOCKER by a user-channel decision (policy never counts that as a person)
//
// Where the driver stands in for something that needs a model or a person:
//   - the implementation envelope of the feature row names `dispatch start` and `dispatch run`, which
//     would spawn model workers; the driver skips those two argv, commits the change itself on
//     the feature branch and runs only the envelope's handoff argv;
//   - the READY readiness record is written as a file (the shape the hook tests write), because the
//     `readiness` verb needs recorded evidence of an executed reproduction;
//   - the review findings are written as a reviewer would, with two seats.
// The scratch HOME and XDG are test/helper/scratch-env.ts `createScratch`, with `autopilot.enabled` on;
// the repository's own git config carries the identity the merge plumbing reads, and the spawn
// environment carries the author and committer for every commit. Nothing reads a real config home.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { runPolicy, parseRecords } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SWITCH = 'DOFLOW_AUTOPILOT_ENABLED';
const POLICY_DIR = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks');
const POSIX: any = { skip: process.platform === 'win32' && 'the hook policies need bash and jq' };
const MAX_CALLS = 120;

const ROWS = [
  { id: '601', slug: '601-k59', title: 'Stage never performed', class: 'bug', needs: [], writeSet: ['r601/'] },
  { id: '602', slug: '602-feature', title: 'Feature chain', class: 'feature', needs: [], writeSet: ['r602/'] },
  { id: '603', slug: '603-note', title: 'Bug with an accepted note', class: 'bug', needs: [], writeSet: ['r603/'] },
  { id: '604', slug: '604-blocker', title: 'Bug with an accepted blocker', class: 'bug', needs: [], writeSet: ['r604/'] },
];
const rowOf = (slug: string): any => ROWS.find((row) => row.slug === slug);

const scratch = createScratch('doflow-au-p9-');
after(() => scratch.remove());

const root = path.join(scratch.dir, 'main');
const develop = path.join(scratch.dir, 'develop');
const spawnEnv = (extra: any = {}): any => {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null', ...extra });
  delete env[SWITCH];
  return env;
};
const worktreeOf = (row: any) => path.join(scratch.dir, `main-${row.id}`);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { env: spawnEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The real CLI from `cwd`; `--json` unless the verb prints text. */
function cli(cwd: string, args: string[], { json = true }: any = {}): any {
  const result = spawnSync(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd, env: spawnEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let parsed: any = null;
  if (json) { try { parsed = JSON.parse(result.stdout); } catch { /* a verb that printed text */ } }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: parsed };
}

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const setSwitch = (value: string) => write(path.join(scratch.xdg, 'doflow', 'settings.json'), `${JSON.stringify({ schema: 1, 'autopilot.enabled': value })}\n`);
const next = (): any => {
  const result = cli(root, ['roadmap', '--action', 'next']);
  assert.ok(result.json, `roadmap next printed no JSON: ${result.stdout}\n${result.stderr}`);
  return { code: result.status, result: result.json };
};
const attendance = (row: any): string => {
  const result = cli(worktreeOf(row), ['attendance', '--task-id', row.slug], { json: false });
  assert.equal(result.status, 0, `attendance exits 0 whatever it answers: ${result.stderr}`);
  return result.stdout.trim();
};

// ── the hook policy, as the harness runs it before a source edit ────────────────────────────────────

/** The shipped registry beside a copy of the policy, the layout an install gives it. */
const LAYOUT = path.join(scratch.dir, 'layout');
function installLayout(): string {
  const policy = path.join(LAYOUT, 'shared', 'hooks', 'policies', 'pre-implementation-gate.sh');
  for (const file of ['pre-implementation-gate.sh', 'contract.sh']) write(path.join(path.dirname(policy), file), fs.readFileSync(path.join(POLICY_DIR, 'policies', file), 'utf8'));
  fs.cpSync(path.join(POLICY_DIR, 'bridge'), path.join(LAYOUT, 'shared', 'hooks', 'bridge'), { recursive: true });
  write(path.join(LAYOUT, 'runtime', 'core', 'registry', 'workflows.json'), fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));
  return policy;
}

/** What `pre-implementation-gate` says about an edit of r<id>/<name> made from the row's worktree. */
function editHook(row: any, name: string): { status: number; outcome: string; code: string; stderr: string } {
  const result = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { version: 1, operation: 'edit', paths: [`r${row.id}/${name}`] } }), {
    decisionFd: true, cwd: worktreeOf(row), policyPath: LAYOUT_POLICY,
    env: { DOFLOW_PROJECT_DIR: worktreeOf(row), HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg, GIT_CONFIG_GLOBAL: '/dev/null', DOFLOW_TASK_ID: row.slug },
  });
  const last = parseRecords(result.records).at(-1);
  return { status: result.status, outcome: last.outcome, code: last.code, stderr: result.stderr };
}
let LAYOUT_POLICY = '';

// ── the driver ──────────────────────────────────────────────────────────────────────────────────────

const planOf = (row: any) => '# Plan\n\n## 2. Constitution Check\n\n| Principle | Tier | Result | How |\n|---|---|---|---|\n'
  + ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id) => `| ${id} | MUST | PASS | toy |\n`).join('')
  + `\n## 8. Tasks\n\n- [ ] A.1 [US1] Write the toy file — owner: core-implementer; files: r${row.id}/early.txt, r${row.id}/implementation.txt\n`;

const observed: any = {
  hooks: [] as any[], // { row, moment, ...editHook }
  attendance: [] as any[], // { row, moment, answer }
  trace: [] as string[],
  denials: {} as any, // row id -> the number of denied results that named it
  firstDenied: {} as any,
  switchOff: null as any,
  idle: null as any,
  afterRuns: [] as any[], // { row, stage, argv0, status }
  followup: null as any,
};

/** Commits `toy/<name>` on the row's feature branch, as the edit the hook let through. */
function commitEdit(row: any, name: string, text: string) {
  write(path.join(worktreeOf(row), `r${row.id}`, name), text);
  git(worktreeOf(row), 'add', '.');
  git(worktreeOf(row), 'commit', '-qm', `${row.slug}: ${name}`);
}

const readinessRecord = (row: any) => write(path.join(root, '.doflow', 'state', 'readiness', `${row.slug}.json`), `${JSON.stringify({
  version: 1, taskId: row.slug, slug: null, taskClass: row.class, templateName: row.class, state: 'READY', stageEntry: 'ENTER', executionMode: 'workflow',
  inputs: {}, declaredScope: [`r${row.id}/implementation.txt`], unmet: [], evidenceCount: 1, evaluatedAt: '2026-01-01T00:00:00.000Z',
}, null, 2)}\n`);

const addDecision = (row: any, channel: string, topic: string) => {
  const result = cli(worktreeOf(row), ['decision', '--action', 'add', '--slug', row.slug, '--channel', channel, '--stage', 'review', '--topic', topic,
    '--statement', `Accept the ${topic} finding as it stands`, '--rationale', channel === 'default' ? 'unattended:envelope' : 'a person decided']);
  assert.equal(result.status, 0, `decision add: ${result.stdout}\n${result.stderr}`);
};

function reviewRecord(row: any, head: string) {
  const seat = (id: string, findings: any[] = []) => ({ id, findings });
  const base = { schema: 1, row: row.id, slug: row.slug, reviewedHead: head, rounds: 1 };
  if (row.slug === '603-note') {
    // A note a seat raised; the unattended session accepted it and recorded that as a default-channel decision (AU D4).
    return { ...base, seats: [seat('seat-1', [{ id: 'F1', severity: 'note', locator: `r${row.id}/implementation.txt:1`, summary: 'naming nit' }]), seat('seat-2')],
      converged: [{ id: 'C1', from: ['F1'], severity: 'note', locator: `r${row.id}/implementation.txt:1`, status: 'user-accepted', decision: 'DEC-001' }] };
  }
  if (row.slug === '604-blocker') {
    // A blocker marked user-accepted behind a user-channel entry: any session can write that entry, so policy never accepts it.
    return { ...base, seats: [seat('seat-1', [{ id: 'F1', severity: 'blocker', locator: `r${row.id}/implementation.txt:1`, summary: 'data loss' }]), seat('seat-2')],
      converged: [{ id: 'C1', from: ['F1'], severity: 'blocker', locator: `r${row.id}/implementation.txt:1`, status: 'user-accepted', decision: 'DEC-001' }] };
  }
  return { ...base, seats: [seat('seat-1'), seat('seat-2')], converged: [] };
}

/** Does what the stage skill does for the envelope, then runs the envelope's argv through the real CLI. */
function perform(row: any, p: any) {
  const wt = worktreeOf(row);
  const art = p.artifactRoot;
  const hook = (moment: string, name: string) => observed.hooks.push({ row: row.id, moment, ...editHook(row, name) });
  observed.attendance.push({ row: row.id, moment: p.purpose === 'post-merge' ? 'perform:post-merge' : `perform:${p.stage}`, answer: attendance(row), envelope: p.attendance || null });
  if (p.stage === 'discovery') {
    cli(wt, ['decision', '--action', 'init', '--slug', row.slug]); // do-brainstorm creates the register with the folder, before any artifact
    write(path.join(art, 'intention', 'requirement.md'), '# Requirement\n\nA toy.\n');
    // The session edits source now: the folder holds a requirement but no design or plan.
    hook('requirement-only', 'early.txt');
    commitEdit(row, 'early.txt', 'edited before design and plan existed\n');
  } else if (p.stage === 'design') {
    write(path.join(art, 'design', 'design.md'), '# Design\n\nA toy.\n');
  } else if (p.stage === 'planning') {
    write(path.join(art, 'plan.md'), planOf(row));
  } else if (p.stage === 'implementation') {
    hook('no-readiness-record', 'implementation.txt');
    readinessRecord(row);
    hook('ready', 'implementation.txt');
    commitEdit(row, 'implementation.txt', `${row.slug}\n`);
  } else if (p.stage === 'review') {
    if (row.slug === '603-note') { cli(wt, ['decision', '--action', 'init', '--slug', row.slug]); addDecision(row, 'default', 'naming-nit'); }
    if (row.slug === '604-blocker') { cli(wt, ['decision', '--action', 'init', '--slug', row.slug]); addDecision(row, 'question', 'data-loss'); }
    write(path.join(art, 'review', 'findings.json'), `${JSON.stringify(reviewRecord(row, git(wt, 'rev-parse', 'HEAD')))}\n`);
  }
  const argvs = Array.isArray(p.after[0]) ? p.after : [p.after];
  for (const argv of argvs) {
    if (argv[0] === 'dispatch') continue; // would spawn model workers; the driver committed the change itself
    const result = cli(p.purpose === 'post-merge' ? p.worktree : wt, argv.map((x: string) => (x === '<text>' ? 'stage work recorded' : x)));
    observed.afterRuns.push({ row: row.id, stage: p.stage, purpose: p.purpose || null, verb: argv[0], status: result.status });
    assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stdout}\n${result.stderr}`);
  }
}

/** K59: the session meets a stage it cannot perform, halts, records a follow-up and does not hand off. */
function haltK59(row: any, p: any) {
  const followup = cli(worktreeOf(row), ['followup', '--action', 'add', '--stage', 'implementation', '--slug', row.slug,
    '--statement', `K59 halt: ${p.stage} of ${row.slug} was not performed, unattended`]);
  observed.followup = { status: followup.status, out: followup.stdout.slice(0, 200), err: followup.stderr.slice(0, 200) };
}

let driven = false;
function drive() {
  if (driven) return;
  driven = true;
  const k59 = rowOf('601-k59');
  let switchTried = false;
  for (let call = 0; call < MAX_CALLS; call++) {
    const { code, result } = next();
    observed.trace.push(`${result.outcome}:${result.step ?? result.perform?.stage ?? result.reason ?? ''}:${result.row ?? ''}`);
    if (result.outcome === 'perform') {
      const row: any = ROWS.find((r) => r.id === result.row);
      if (row === k59) {
        if (!switchTried) {
          // While 601's perform is open: unattended. Switch off: next stops, attendance reads attended. Switch on again.
          switchTried = true;
          observed.attendance.push({ row: row.id, moment: 'perform-open', answer: attendance(row) });
          setSwitch('off');
          const stopped = next();
          observed.switchOff = { code: stopped.code, outcome: stopped.result.outcome, layer: stopped.result.annotations?.layer ?? stopped.result.annotations?.switch ?? null, attendance: attendance(row) };
          setSwitch('on');
        }
        haltK59(row, result.perform);
        continue;
      }
      perform(row, result.perform);
      continue;
    }
    if (result.outcome === 'denied') {
      const id = result.row ?? 'loop';
      observed.denials[id] = (observed.denials[id] || 0) + 1;
      observed.firstDenied[id] = observed.firstDenied[id] || { step: result.step, reason: result.reason, reasons: result.reasons, code };
      if (id === k59.id) observed.attendance.push({ row: id, moment: 'held', answer: attendance(k59) });
      continue;
    }
    if (result.outcome === 'idle') { observed.idle = result; break; }
    assert.equal(result.outcome, 'acted', `unexpected outcome ${JSON.stringify(result).slice(0, 400)}`);
  }
  assert.ok(observed.idle, `the loop never went idle: ${observed.trace.join(' > ')}`);
}

before(() => {
  LAYOUT_POLICY = installLayout();
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  // The merge plumbing reads user.name and user.email from the repository config; the scratch
  // repository has its own, so no global or real config is consulted.
  git(root, 'config', 'user.name', 'Develop Owner');
  git(root, 'config', 'user.email', 'develop@example.test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  write(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  write(path.join(root, 'core', 'registry', 'gates.json'), fs.readFileSync(path.join(REPO, 'core', 'registry', 'gates.json'), 'utf8'));
  write(path.join(root, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node -e 0' } })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  write(path.join(root, 'agent-docs', 'roadmap', 'rows.json'), JSON.stringify({ schema: 1, rows: ROWS }));
  setSwitch('on');
  drive();
});

// ── assertions ──────────────────────────────────────────────────────────────────────────────────────

test('the fixture is what the proof claims: scratch config home, autopilot on, local develop, no remote', () => {
  assert.equal(git(root, 'remote'), '', 'no remote');
  assert.ok(scratch.home.startsWith(scratch.dir) && scratch.xdg.startsWith(scratch.dir));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch.xdg, 'doflow', 'settings.json'), 'utf8')), { schema: 1, 'autopilot.enabled': 'on' });
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'develop'), 'develop');
});

test('(1) the edit hook, run on source edits made before the artifacts exist, gives advisory and never deny', POSIX, () => {
  const byRow = (id: string) => observed.hooks.filter((h: any) => h.row === id);
  const feature = byRow('602');
  assert.deepEqual(feature.map((h: any) => [h.moment, h.status, h.outcome, h.code]), [
    ['requirement-only', 0, 'advisory', 'missing-artifacts'],
    ['no-readiness-record', 0, 'advisory', 'readiness-missing'],
    ['ready', 0, 'allow', 'allow'],
  ], 'requirement.md alone, then all three artifacts and no READY record, then a READY record');
  assert.match(feature[0].stderr, /missing requirement\.md, design\.md, or plan\.md/);
  for (const row of ['603', '604']) {
    assert.deepEqual(byRow(row).map((h: any) => [h.moment, h.status]), [['no-readiness-record', 0], ['ready', 0]], `bug row ${row}`);
    assert.notEqual(byRow(row)[0].outcome, 'deny');
  }
  assert.equal(observed.hooks.some((h: any) => h.outcome === 'deny' || h.status !== 0), false, 'no hook call in the run denied');
  // The edits the hook let through are on the merged feature.
  assert.equal(git(root, 'show', 'develop:r602/early.txt'), 'edited before design and plan existed');
});

test('(2) the feature row and the bug row merge onto local develop, each with a DoFlow-Row trailer; nothing else lands', () => {
  const merges = git(root, 'log', 'develop', '--merges', '--format=%H %(trailers:key=DoFlow-Row,valueonly,separator=%x2C)').split('\n').filter(Boolean);
  const rows = merges.map((line) => line.split(' ')[1]).sort();
  assert.deepEqual(rows, ['602', '603']);
  for (const line of merges) {
    const parents = git(root, 'show', '-s', '--format=%P', line.split(' ')[0]).split(' ');
    assert.equal(parents.length, 2, 'a merge commit with the feature head as its second parent');
  }
  assert.equal(git(root, 'show', 'develop:r602/implementation.txt'), '602-feature');
  assert.equal(git(root, 'show', 'develop:r603/implementation.txt'), '603-note');
  assert.throws(() => git(root, 'cat-file', '-e', 'develop:r604/implementation.txt'), 'the blocker row is not on develop');
  // Finished rows are cleaned; the two held rows keep their worktrees and branches.
  assert.equal(fs.existsSync(worktreeOf(rowOf('602-feature'))), false);
  assert.equal(fs.existsSync(worktreeOf(rowOf('603-note'))), false);
  assert.equal(fs.existsSync(worktreeOf(rowOf('601-k59'))), true);
  assert.equal(fs.existsSync(worktreeOf(rowOf('604-blocker'))), true);
  // The seeded gate-b ran by policy for the merged rows (audit lines), never as a person.
  const audit = fs.readFileSync(path.join(root, '.doflow', 'state', 'roadmap', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
  const approved = audit.filter((e: any) => e.step === 'gate' && e.outcome === 'acted').map((e: any) => e.audit);
  assert.equal(approved.filter((a: string) => /^gate-b 60[23]-\w+ approved by policy gate-b@sha256:/.test(a)).length, 2);
  // And the feature's gate-0 and gate-a were approved by policy too.
  assert.ok(approved.some((a: string) => /^gate-0 602-feature approved by policy/.test(a)));
  assert.ok(approved.some((a: string) => /^gate-a 602-feature approved by policy/.test(a)));
});

test('(3) the K59 row is held stage-not-performed while the other rows advance; repeated calls spend no step', () => {
  assert.deepEqual([observed.firstDenied['601'].reason, observed.firstDenied['601'].step ?? null], ['stage-not-performed', null]);
  assert.equal(observed.denials['601'], 1, 'one denial for the row, however many calls the loop made');
  assert.equal(observed.idle.skips['601'], 'held:stage-not-performed');
  assert.equal(observed.followup.status, 0, `the halted session recorded a follow-up: ${JSON.stringify(observed.followup)}`);
  assert.equal(observed.afterRuns.filter((r: any) => r.row === '601').length, 0, 'the K59 session never ran a handoff');
  const runsDir = path.join(root, '.doflow', 'state', 'roadmap', 'runs');
  const runFile = path.join(runsDir, fs.readdirSync(runsDir).filter((f: string) => f.endsWith('.json')).sort().at(-1));
  const before = JSON.parse(fs.readFileSync(runFile, 'utf8')).steps;
  for (let i = 0; i < 3; i++) assert.equal(next().result.outcome, 'idle');
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).steps, before, 'idle calls spend no step');
  // The feature and the note row went all the way through while 601 stayed held.
  const trace = observed.trace;
  assert.ok(trace.indexOf('denied:stage-not-performed:601') < trace.indexOf('acted:cleanup:602'), '601 was held before the feature row finished');
  assert.ok(trace.includes('acted:cleanup:602') && trace.includes('acted:cleanup:603'));
});

test('(4) a user-accepted note passes gate-b; a user-accepted blocker is denied user-accepted-needs-person, held, and never merged', () => {
  assert.equal(observed.denials['603'] ?? 0, 0, 'the note row was never denied');
  const gates = fs.readFileSync(path.join(root, '.doflow', 'state', 'roadmap', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
  assert.ok(gates.some((e: any) => e.step === 'gate' && e.outcome === 'acted' && /^gate-b 603-note approved by policy/.test(e.audit || '')));
  // The cleanup copied the finished row's folder back to the main checkout.
  const decisions = JSON.parse(fs.readFileSync(path.join(root, 'agent-docs', 'doflow', '603-note', 'decisions', 'register.json'), 'utf8'));
  assert.equal(decisions.decisions[0].channel, 'default', 'the note rests on a default-channel (agent) decision');

  const blocker = observed.firstDenied['604'];
  assert.deepEqual([blocker.step, blocker.reason, blocker.reasons], ['gate', 'user-accepted-needs-person:C1', ['user-accepted-needs-person:C1']]);
  assert.equal(observed.denials['604'], 1, 'denied once, then held by its inputs digest');
  assert.match(observed.idle.skips['604'], /^held:/);
  assert.throws(() => git(root, 'merge-base', '--is-ancestor', 'feat/604-blocker', 'develop'), 'the blocker row is not on develop');
});

test('(5) attendance says unattended while a perform is open and attended once the row is held', () => {
  const at = (row: string, moment: string) => observed.attendance.find((a: any) => a.row === row && a.moment === moment)?.answer;
  assert.match(at('601', 'perform-open'), /^unattended /);
  assert.match(at('601', 'held'), /^attended /);
  for (const a of observed.attendance.filter((x: any) => /^perform:/.test(x.moment) && x.moment !== 'perform:post-merge')) assert.match(a.answer, /^unattended /, `${a.row} ${a.moment}`);
  assert.ok(observed.attendance.filter((x: any) => x.row === '602').length >= 6, 'every feature stage asked');
  // Held rows read attended now, from their own worktrees.
  assert.match(attendance(rowOf('601-k59')), /^attended /);
  assert.match(attendance(rowOf('604-blocker')), /^attended /);
});

// AU-P10: the loop leaves slot.postMerge when it issues the post-merge verification perform; attendance.ts reads it.
test('(5b) attendance also says unattended while the post-merge verification perform is open', () => {
  const post = observed.attendance.filter((x: any) => x.moment === 'perform:post-merge');
  assert.equal(post.length, 2, 'the feature row and the note row each had a post-merge perform');
  for (const a of post) {
    assert.deepEqual(a.envelope, { mode: 'unattended', run: a.envelope?.run }, 'the envelope itself says unattended');
    assert.match(a.answer, /^unattended /, `${a.row}: the verb disagrees with its own envelope (${a.answer})`);
  }
});

test('(6) switching autopilot off gives stopped and reads attended; switching it on resumes the run', () => {
  assert.ok(observed.switchOff, 'the switch was thrown while 601 was in flight');
  assert.equal(observed.switchOff.outcome, 'stopped');
  assert.notEqual(observed.switchOff.code, 0);
  assert.match(observed.switchOff.attendance, /^attended /, 'a stopped run is not unattended');
  setSwitch('off');
  try {
    const stopped = next();
    assert.equal(stopped.result.outcome, 'stopped');
    assert.match(attendance(rowOf('601-k59')), /^attended /);
  } finally { setSwitch('on'); }
  assert.equal(next().result.outcome, 'idle', 'switched on again, the same state answers idle');
});

test('(7) nothing pushed and nothing tagged: no remote, no tag, no remote-tracking ref', () => {
  assert.equal(git(root, 'remote'), '');
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(git(root, 'for-each-ref', 'refs/remotes', 'refs/tags'), '');
  const verbs = new Set(observed.afterRuns.map((r: any) => r.verb));
  assert.ok(!verbs.has('git') && !verbs.has('push'), `the driver ran only DoFlow verbs: ${[...verbs].join(', ')}`);
  // The only branches are main, develop and the claimed feature branches.
  assert.deepEqual(git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(), ['develop', 'feat/601-k59', 'feat/604-blocker', 'main']);
});
