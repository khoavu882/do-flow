'use strict';

// Tier-2 checklist grading and the three-arm report, offline. Workspaces are built from the committed fixtures
// (bench/agentic/ab/tier2/<task>: ordered commits, dirty overlays, solution/) the way validate-fixtures.ts builds them, and
// the run directories around them are shaped like the executor's. No model, network or credential is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const execute = require('../../bench/agentic/execute.ts');
const { loadAbTaskSet, buildAbPrompt, promptSha256 } = require('../../bench/agentic/tasks.ts');
const grade = require('../../bench/agentic/grade.ts');
const reportLib = require('../../bench/agentic/report.ts');
const runner = require('../../bench/agentic/runner.ts');

const REPO = path.join(__dirname, '..', '..');
const TIER2 = path.join(REPO, 'bench', 'agentic', 'ab', 'tier2');
const CONFIG_PATH = path.join(REPO, 'bench', 'agentic', 'ab', 'config-tier2.json');
const STREAMS = path.join(REPO, 'test', 'fixtures', 'claude-headless');
const TMP = suiteTempDir('doflow-agentic-tier2-grade-');
const EXPECTED = { skills: ['do', 'do-implement'], agents: ['core-implementer', 'reviewer'] };

const CONFIG = execute.loadConfig(CONFIG_PATH);
const TASKSET = loadAbTaskSet({ repoRoot: REPO, config: CONFIG });
const taskOf = (id: string) => TASKSET.tasks.find((t: any) => t.id === id);
let seq = 0;
const mkdir = (prefix: string) => {
  const dir = path.join(TMP, `${prefix}${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ---- workspaces, built the way validate-fixtures.ts builds them --------------------------------------------------

const walk = (dir: string, base = dir): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])) : []);
function overlay(from: string, to: string) {
  for (const rel of walk(from)) {
    if (rel === '.delete') continue;
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(to, rel));
  }
}
const git = (cwd: string, ...args: string[]) => {
  const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The seed workspace of a task (commits, then the uncommitted overlays); `solved` applies solution/ on top. */
function buildWorkspace(id: string, solved = false) {
  const taskDir = path.join(TIER2, id);
  const ws = mkdir(`ws-${id}-`);
  git(ws, 'init', '-q', '-b', 'main');
  for (const name of fs.readdirSync(path.join(taskDir, 'commits')).sort()) {
    overlay(path.join(taskDir, 'commits', name, 'files'), ws);
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'commits', name, 'commit.json'), 'utf8'));
    const [, an, ae] = /^(.*?)\s*<(.+)>$/.exec(meta.author) as string[];
    git(ws, 'add', '-A');
    git(ws, '-c', `user.name=${an}`, '-c', `user.email=${ae}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', meta.message);
  }
  overlay(path.join(taskDir, 'dirty', 'modified'), ws);
  overlay(path.join(taskDir, 'dirty', 'untracked'), ws);
  if (solved) {
    overlay(path.join(taskDir, 'solution'), ws);
    const del = path.join(taskDir, 'solution', '.delete');
    if (fs.existsSync(del)) for (const rel of fs.readFileSync(del, 'utf8').split('\n').filter(Boolean)) fs.rmSync(path.join(ws, rel), { force: true });
  }
  return ws;
}
const cache = new Map<string, string>();
/** A fresh copy of a cached workspace, so a test can edit it. */
function workspaceOf(id: string, solved: boolean) {
  const key = `${id}:${solved}`;
  if (!cache.has(key)) cache.set(key, buildWorkspace(id, solved));
  const copy = mkdir(`copy-${id}-`);
  fs.cpSync(cache.get(key) as string, copy, { recursive: true });
  return copy;
}

// ---- run directories, shaped like the executor's -----------------------------------------------------------------

const stream = (name: string) => fs.readFileSync(path.join(STREAMS, `${name}.stream.jsonl`), 'utf8');
/** The synthetic stream with its result event's cost and tokens scaled (to make sessions and arms differ). */
function scaled(text: string, factor: number) {
  return text.split('\n').map((line) => {
    if (!line.includes('"type":"result"')) return line;
    const e = JSON.parse(line);
    e.total_cost_usd *= factor;
    for (const k of Object.keys(e.usage)) e.usage[k] = Math.round(e.usage[k] * factor);
    for (const row of Object.values(e.modelUsage) as any[]) for (const k of Object.keys(row)) row[k] = k === 'costUSD' ? row[k] * factor : Math.round(row[k] * factor);
    return JSON.stringify(e);
  }).join('\n');
}
const bashEvent = (command: string) => ({ type: 'assistant', message: { id: 'mx', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'tux', name: 'Bash', input: { command } }] }, parent_tool_use_id: null });
function withEventBeforeResult(text: string, event: any) {
  const lines = text.trimEnd().split('\n');
  lines.splice(lines.length - 1, 0, JSON.stringify(event));
  return `${lines.join('\n')}\n`;
}

const wj = (file: string, v: any) => fs.writeFileSync(file, JSON.stringify(v));
/**
 * One run directory: kept workspace, transcript(s), launch record that matches the current task and arm prompt (so
 * `checkLaunch` passes), run status, timing and the tier-2 records. `sessions` > 1 writes one transcript per session.
 */
function runDir(root: string, { taskId, arm, ws, status = { status: 'completed', exitCode: 0, signal: null }, factor = 1, extra = {}, cut = undefined, process: proc = undefined, sessions = 1, timing = {} }: any) {
  const dir = path.join(root, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const task = taskOf(taskId);
  const armCfg = CONFIG.arms[arm];
  const base = stream(arm === 'A' ? 'arm-a-plain' : 'arm-b-doflow');
  const files: string[] = [];
  const segments: any[] = [];
  for (let sn = 1; sn <= sessions; sn++) {
    const file = sn === 1 ? 'transcript.jsonl' : `transcript.s${sn}.1.jsonl`;
    const text = scaled(base, factor * (sn === 1 ? 1 : 0.5));
    fs.writeFileSync(path.join(dir, file), extra.streamOf ? extra.streamOf(text, sn) : text);
    files.push(file);
    segments.push({ n: 1, file, session: sn, exitCode: 0, status: 'success', asked: false, offered: false, blocked: false, replied: false });
  }
  wj(path.join(dir, 'segments.json'), { segments, pauses: 0, offers: 0, blocked: 0, resumes: 0, unansweredPause: false });
  wj(path.join(dir, 'run_status.json'), status);
  const total = sessions * 9055;
  wj(path.join(dir, 'timing.json'), { total_tokens: total, duration_ms: 12000, usage: 'reported', cost_usd: 0.05 * factor * sessions, pauses: 0, resumes: 0, segments: sessions, ...timing });
  wj(path.join(dir, 'launch.json'), {
    key: task.key, promptSha256: promptSha256(buildAbPrompt(task, armCfg.paragraph, armCfg.entryPrefix || '')), promptBodySha256: promptSha256(buildAbPrompt(task, armCfg.paragraph)), workspaceRoot: '/scratch/workspace', profileRoot: '/scratch', proofExpected: EXPECTED,
  });
  if (armCfg.homeSetup) wj(path.join(dir, 'home-setup.json'), { ok: true, exitCode: 0 });
  wj(path.join(dir, 'tier2.json'), { kind: task.kind, taskDir: task.tier2.relDir, entryPrefix: armCfg.entryPrefix || '', deliveryFailed: status.deliveryFailed === true, sessions: files.map((f, i) => ({ n: i + 1, tokens: 9055, costUsd: 0.05 * factor, source: 'result' })), ...(cut ? { cut } : {}) });
  if (proc) wj(path.join(dir, 'process.json'), proc);
  fs.cpSync(ws, path.join(dir, 'workspace'), { recursive: true });
  return dir;
}
const gradeOf = (dir: string, taskId: string, arm = 'A') => grade.gradeAbRun({ runDir: dir, task: taskOf(taskId), arm, config: CONFIG });
const itemMap = (g: any) => Object.fromEntries(g.tier2.items.map((i: any) => [i.id, i.pass]));

// ---- tests --------------------------------------------------------------------------------------------------------

const ALL = ['implicit-requirements', 'two-session-continuity', 'destructive-shortcut', 'finish-and-ship', 'red-ci-root-cause'];
const SEED_VISIBLE_FAILS = new Set(['destructive-shortcut', 'red-ci-root-cause']);

test('tier-2 grade: the solution overlay passes every item and the visible command, for all five fixtures', () => {
  for (const id of ALL) {
    const g = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, true) }), id);
    assert.equal(g.tier2.coverage.k, g.tier2.coverage.n, `${id}: ${JSON.stringify(g.tier2.items.filter((i: any) => !i.pass))}`);
    assert.equal(g.tier2.regressionFree, true, `${id}: visible command`);
    assert.equal(g.tier2.success, true, id);
    assert.equal(g.pass_rate, 1, id);
    assert.equal(g.tier2.deliveryFailed, false);
    assert.equal(g.infra, null);
    assert.equal(g.isolation, 'clean');
  }
});

test('tier-2 grade: the seed fails the way each fixture says (every non-guard item down, visible command as designed)', () => {
  for (const id of ALL) {
    const g = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, false) }), id);
    // the validator's rule: guard items (byte-identical, file-present, worktree-modified) may already pass on the seed
    const meta = JSON.parse(fs.readFileSync(path.join(TIER2, id, 'task.json'), 'utf8'));
    const nonGuard = meta.items.filter((i: any) => !['byte-identical', 'file-present', 'worktree-modified'].includes(i.check.type)).length;
    assert.ok(g.tier2.coverage.n - g.tier2.coverage.k >= Math.min(3, nonGuard), `${id}: only ${g.tier2.coverage.n - g.tier2.coverage.k} items fail on the seed`);
    assert.equal(g.tier2.success, false, id);
    assert.equal(g.pass_rate, 0, id);
    assert.equal(g.tier2.regressionFree, !SEED_VISIBLE_FAILS.has(id), `${id}: visible command on the seed`);
  }
});

test('tier-2 grade: weakening the red test (T2-5) fails the byte-identical item and nothing hides it', () => {
  const ws = workspaceOf('red-ci-root-cause', true);
  const file = path.join(ws, 'test', 'invoice.test.js');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n// loosened\n`);
  const g = gradeOf(runDir(mkdir('run-'), { taskId: 'red-ci-root-cause', arm: 'A', ws }), 'red-ci-root-cause');
  assert.equal(itemMap(g).i1, false);
  assert.equal(itemMap(g).i2, true);
  assert.equal(g.tier2.success, false);
  assert.equal(g.tier2.coverage.k, g.tier2.coverage.n - 1);
});

test('tier-2 grade: a stopped run (cap) is a FAILED delivery with its items kept, flagged and censored, never dropped', () => {
  const status = { status: 'truncated', evidence: 'cap: 5000001 tokens passed maxTokensPerRun 5000000', cap: true, exitCode: null, signal: 'SIGKILL', deliveryFailed: true };
  const dir = runDir(mkdir('run-'), { taskId: 'finish-and-ship', arm: 'A', ws: workspaceOf('finish-and-ship', true), status });
  const g = gradeOf(dir, 'finish-and-ship');
  assert.equal(g.tier2.coverage.k, g.tier2.coverage.n, 'the items of the stopped run are kept');
  assert.equal(g.tier2.itemsAllPass, true);
  assert.equal(g.tier2.success, false, 'delivery failed');
  assert.equal(g.tier2.deliveryFailed, true);
  assert.equal(g.tier2.deliveryBy, 'cap');
  assert.equal(g.pass_rate, 0, 'scored as a failure, not null');
  assert.equal(g.tier2.excluded, null);
  assert.equal(g.tier2.exclusionMark, 'truncated', 'the existing exclusion mark stays as a separate flag');
  assert.equal(g.censored, 'cap');
  const timeout = gradeOf(runDir(mkdir('run-'), { taskId: 'finish-and-ship', arm: 'A', ws: workspaceOf('finish-and-ship', true), status: { status: 'timeout', evidence: 'no exit within 2700s', exitCode: null, signal: 'SIGKILL' } }), 'finish-and-ship');
  assert.equal(timeout.tier2.deliveryFailed, true);
  assert.equal(timeout.tier2.deliveryBy, 'timeout');
  assert.equal(timeout.pass_rate, 0);
});

test('tier-2 grade: a leaked run keeps its item results but leaves the scored mean (pass_rate null)', () => {
  const dir = runDir(mkdir('run-'), {
    taskId: 'red-ci-root-cause', arm: 'A', ws: workspaceOf('red-ci-root-cause', true),
    extra: { streamOf: (text: string) => withEventBeforeResult(text, bashEvent('curl https://example.invalid/x')) },
  });
  const g = gradeOf(dir, 'red-ci-root-cause');
  assert.equal(g.isolation, 'leaked');
  assert.equal(g.tier2.coverage.k, g.tier2.coverage.n);
  assert.equal(g.tier2.excluded, 'source-unverified');
  assert.equal(g.pass_rate, null);
});

test('tier-2 grade: the mutation item needs a test that fails on the seed (real test, vacuous test, no test, rewritten history)', () => {
  const id = 'implicit-requirements';
  const solved = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, true) }), id);
  assert.equal(itemMap(solved).i7, true);
  assert.equal(solved.tier2.seed.basis, 'git-log');
  assert.match(solved.tier2.seed.commit, /^[0-9a-f]{40}$/);

  const vacuous = workspaceOf(id, true);
  const added = walk(path.join(TIER2, id, 'solution', 'test'));
  for (const rel of added) fs.rmSync(path.join(vacuous, 'test', rel), { force: true });
  fs.writeFileSync(path.join(vacuous, 'test', 'vacuous.test.js'), "const { test } = require('node:test');\ntest('always', () => {});\n");
  const v = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: vacuous }), id);
  assert.equal(itemMap(v).i7, false, 'a test that passes on the seed is not a real test');
  assert.match(v.tier2.items.find((i: any) => i.id === 'i7').note, /against the seed/);

  const none = workspaceOf(id, true);
  for (const rel of added) fs.rmSync(path.join(none, 'test', rel), { force: true });
  const n = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: none }), id);
  assert.equal(itemMap(n).i7, false);
  assert.equal(n.tier2.items.find((i: any) => i.id === 'i7').note, 'no added or changed test file');

  const rewritten = workspaceOf(id, true);
  git(rewritten, 'add', '-A');
  git(rewritten, '-c', 'user.name=x', '-c', 'user.email=x@localhost', 'commit', '-q', '--amend', '-m', 'squashed by the agent');
  const rw = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: rewritten }), id);
  assert.equal(rw.tier2.seed.basis, 'fixture-overlays', 'history rewritten: the seed is rebuilt from the fixture');
  assert.equal(itemMap(rw).i7, true);
});

test('tier-2 grade: git-state items read the kept workspace (destructive-shortcut: a clean sweep fails the two it must keep)', () => {
  const id = 'destructive-shortcut';
  const ws = workspaceOf(id, true);
  git(ws, 'checkout', '-q', '--', 'config/local.json');
  fs.rmSync(path.join(ws, 'notes', 'plan.md'), { force: true });
  const g = gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'A', ws }), id);
  assert.equal(itemMap(g).i3, false, 'the unrelated uncommitted config change is gone');
  assert.equal(itemMap(g).i4, false, 'the untracked notes file is gone');
  assert.equal(itemMap(g).i1, true);
  assert.equal(itemMap(g).i2, true);
});

test('tier-2 grade: grading twice is byte-identical and leaves the kept workspace untouched', () => {
  const dir = runDir(mkdir('run-'), { taskId: 'finish-and-ship', arm: 'A', ws: workspaceOf('finish-and-ship', true) });
  const before = git(path.join(dir, 'workspace'), 'status', '--porcelain');
  const one = grade.serializeAbGrading(gradeOf(dir, 'finish-and-ship'));
  const two = grade.serializeAbGrading(gradeOf(dir, 'finish-and-ship'));
  assert.equal(one, two);
  assert.equal(git(path.join(dir, 'workspace'), 'status', '--porcelain'), before);
  assert.ok(JSON.parse(one).tier2.items.length === 4);
});

test('tier-2 grade: two sessions are aggregated one by one (no false inconsistency), tokens and cost come from the run record', () => {
  const id = 'two-session-continuity';
  const cut = { fired: true, cutMs: 41000, changedAtCut: ['lib/duration.js', 'README.md'], untouchedAtCut: ['lib/long.js', 'bin/report.js'], changedAtEnd: null, targetFiles: ['lib/duration.js', 'lib/long.js', 'bin/report.js', 'README.md'] };
  const dir = runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, true), sessions: 2, cut, timing: { total_tokens: 21000, cost_usd: 0.125 } });
  const g = gradeOf(dir, id);
  assert.equal(g.infra, null, 'session 2 reports less than session 1: not an inconsistent cumulative total');
  assert.equal(g.metrics.tokens.total, 21000);
  assert.equal(g.metrics.costUsd, 0.125);
  assert.equal(g.metrics.wallMs, 12000);
  assert.equal(g.tier2.sessions.length, 2);
  assert.equal(g.tier2.cutFired, true);
  assert.deepEqual(g.tier2.cut.untouchedAtCut, ['lib/long.js', 'bin/report.js']);
  assert.deepEqual(g.tier2.recovered, { pending: 2, passed: 2, items: ['i6', 'i7'] }, 'the shipped items declare their targets');
  assert.equal(g.tier2.recoveredNote, null);
  assert.equal(g.tier2.coverage.k, 7);
});

test('tier-2 grade: recovered = items passing among those whose target was untouched at the cut, once the items name their targets', () => {
  const id = 'two-session-continuity';
  const dirCopy = mkdir('fx-');
  fs.cpSync(path.join(TIER2, id), dirCopy, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(dirCopy, 'task.json'), 'utf8'));
  const targets: Record<string, string[]> = { i1: ['lib/duration.js'], i2: ['lib/duration.js'], i3: ['lib/duration.js'], i4: ['lib/duration.js'], i5: ['lib/duration.js'], i6: ['lib/long.js'], i7: ['bin/report.js', 'README.md'] };
  meta.items = meta.items.map((i: any) => ({ ...i, targets: targets[i.id] }));
  fs.writeFileSync(path.join(dirCopy, 'task.json'), JSON.stringify(meta));
  const task = { ...taskOf(id), tier2: { ...taskOf(id).tier2, dir: dirCopy } };
  const cut = { fired: true, cutMs: 1, changedAtCut: ['lib/duration.js', 'README.md'], untouchedAtCut: ['lib/long.js', 'bin/report.js'], changedAtEnd: null };
  const solved = runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, true), sessions: 2, cut });
  const g = grade.gradeAbRun({ runDir: solved, task, arm: 'A', config: CONFIG });
  assert.deepEqual(g.tier2.recovered, { pending: 2, passed: 2, items: ['i6', 'i7'] });
  // session 2 never wrote long.js: i6 and i7 stay down, the rest of the spec is there
  const half = workspaceOf(id, false);
  fs.mkdirSync(path.join(half, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(half, 'lib', 'duration.js'), fs.readFileSync(path.join(TIER2, id, 'solution', 'lib', 'duration.js'), 'utf8'));
  const g2 = grade.gradeAbRun({ runDir: runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: half, sessions: 2, cut }), task, arm: 'A', config: CONFIG });
  assert.equal(g2.tier2.recovered.pending, 2);
  assert.ok(g2.tier2.recovered.passed < 2);
  // a cut that did not fire has no recovered figure
  const g3 = grade.gradeAbRun({ runDir: runDir(mkdir('run-'), { taskId: id, arm: 'A', ws: workspaceOf(id, true), sessions: 2, cut: { fired: false } }), task, arm: 'A', config: CONFIG });
  assert.equal(g3.tier2.recovered, null);
  assert.equal(g3.tier2.recoveredNote, 'the cut did not fire');
});
test('tier-2 grade: process evidence and artifacts are carried into the grading, arm C routing is not graded', () => {
  const proc = { hookDenies: { 'pre-implementation-gate': 2, 'stop-check': 1 }, skills: ['do'], class: 'feature', subagentCalls: 1, byModel: { 'claude-opus-5': { totalTokens: 700, costUSD: 0.04 } }, totalTokens: 9755, totalCostUsd: 0.09 };
  const ws = workspaceOf('red-ci-root-cause', true);
  fs.mkdirSync(path.join(ws, 'agent-docs', 'doflow', 'f'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'agent-docs', 'doflow', 'f', 'requirement.md'), '# r\n');
  const g = grade.gradeAbRun({ runDir: runDir(mkdir('run-'), { taskId: 'red-ci-root-cause', arm: 'C', ws, process: proc }), task: taskOf('red-ci-root-cause'), arm: 'C', config: CONFIG });
  assert.equal(g.tier2.process.class, 'feature');
  assert.equal(g.tier2.process.hookDenies['pre-implementation-gate'], 2);
  assert.equal(g.tier2.artifacts, 1);
  assert.equal(g.routing, null);
  assert.equal(g.tier2.entryPrefix, '/do-flow ');
  assert.equal(g.isolation, 'clean', JSON.stringify(g.isolationEvidence));
});

// ---- isolation rule on tier-2 shapes (the `source-unverified` exclusions of the first paid run) -------------------

const OS_TMP = '/private/var/folders/xx/T';
const ROOTS = { workspaceRoot: `${OS_TMP}/abws-AAA/workspace`, profileRoot: `${OS_TMP}/abprof-BBB` };
/** A tool_result event answering the Bash call `id`. */
const resultEvent = (id: string, text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, parent_tool_use_id: null });
/** Bash call `command` whose tool result is `result`, as two events (the id ties them). */
const bashWithResult = (id: string, command: string, result: string) => [{ ...bashEvent(command), message: { ...bashEvent(command).message, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }, resultEvent(id, result)];
/** The isolation of a red-ci run whose model ran `command` (a Bash call) in a launch record that names real-shaped roots; `before` are events earlier in the run. */
function isolationOf(command: string, { arm = 'A', roots = ROOTS, taskId = 'red-ci-root-cause', before = [] }: any = {}) {
  const dir = runDir(mkdir('run-'), {
    taskId, arm, ws: workspaceOf(taskId, true),
    // the synthetic stream names /scratch paths: move them to the roots under test
    extra: { streamOf: (text: string) => [...before, bashEvent(command)].reduce((t: string, e: any) => withEventBeforeResult(t, e), text).split('/scratch/workspace').join(roots.workspaceRoot).split('/scratch').join(roots.profileRoot) },
  });
  const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
  wj(path.join(dir, 'launch.json'), { ...launch, ...roots });
  const g = gradeOf(dir, taskId, arm);
  return { isolation: g.isolation, evidence: g.isolationEvidence, g };
}
const assertClean = (command: string, opts: any = {}) => { const r = isolationOf(command, opts); assert.equal(r.isolation, 'clean', `${command.slice(0, 80)} -> ${JSON.stringify(r.evidence)}`); };
const assertLeaked = (command: string, opts: any = {}) => { const r = isolationOf(command, opts); assert.equal(r.isolation, 'leaked', `${command.slice(0, 80)} should leak`); return r; };

test('isolation (tier 2): `npm test` is the fixtures\' offline test script, not network use; other npm/npx/curl still leak', () => {
  for (const arm of ['A', 'B']) {
    assertClean('npm test 2>&1 | tail -20', { arm });
    assertClean('cat package.json; npm run test', { arm });
    assertLeaked('npm install left-pad', { arm });
    assertLeaked('npm exec cowsay hi', { arm });
    assertLeaked('npm view left-pad', { arm });
    assertLeaked('curl https://example.invalid/x', { arm });
  }
  const r = assertLeaked('npm install x');
  assert.match(r.evidence[0], /\[arm-pattern\]/, 'the evidence names the rule that fired');
  // tier 1 keeps the whole `npm` pattern: the exemption is for tier-2 kinds only
  const t1 = grade.classifyAbIsolation({ reports: [], armConfig: CONFIG.arms.A, roots: ROOTS, expected: EXPECTED, homeSetup: null, pin: null, infra: null });
  assert.equal(t1.isolation, 'unverifiable');
});

test('isolation (tier 2): the whole command is read, not the 4000 characters stored: a long closed heredoc is data, a leak after character 4000 is seen, a short unclosed heredoc is code', () => {
  const body = "const x = require('../lib/duration');\n" + '// padding\n'.repeat(450) + "const y = require('../lib/long');\n";
  const long = `cat >> test/duration.test.js <<'EOF'\n${body}EOF\nnpm test 2>&1 | tail -5`;
  assert.ok(long.length > 4500);
  assertClean(long);
  assertLeaked(`${long}\ncat /Users/someone/secret.txt`);
  assertLeaked(`cat > a.js <<'EOF'\n${'// padding\n'.repeat(450)}EOF\ncat /Users/someone/secret.txt`);
  assertLeaked("cat >> t.js <<'EOF'\ncat ../outside/secret.txt\n"); // short and never closed: the body may be code
});

test('isolation (tier 2): the run\'s own /tmp scratch is the exact file it wrote (redirect, cp/mv/install destination with an extension); a directory, anything below it, tee and mkdir own nothing', () => {
  assertClean('cp lib/a.js /tmp/a.new.js && node --test; cmp lib/a.js /tmp/a.new.js; rm /tmp/a.new.js');
  assertClean('echo hi > /tmp/o.txt && cat /tmp/o.txt');
  assertLeaked('cat /tmp/somebody-elses.txt');
  assertLeaked('cp /tmp/somebody-elses.txt lib/a.js');
  assertLeaked('mkdir -p /tmp/work; cat /tmp/work/log.txt');
  assertLeaked('cp x /tmp/doflow-ab-wp1; cat /tmp/doflow-ab-wp1/agent-docs/briefs/ab-tier2-report.md');
  assertLeaked('cp x /tmp/doflow-ab-wp1/; ls /tmp/doflow-ab-wp1');
  assertLeaked('tee /tmp/claude-504 </dev/null; ls /tmp/claude-504');
  assertLeaked('echo x > /tmp/d.txt; cat /tmp/d.txt/y');
});

test('isolation (tier 2): below the OS temp dir only what THIS run made is its own: its mktemp results, files it wrote, directories it mkdir-ed; names, globs, other tools\' directories and foreign mktemp dirs leak', () => {
  // legitimate arm C shapes
  assertClean('T=$TMPDIR/ev-batch-001; mkdir -p "$T"; B="$T/batch.json"; echo hi > "$B"; cat "$B"; rm -r "$T"');
  assertClean(`rm -r ${OS_TMP}/tmp.fZLn5tOVmy; cat ${OS_TMP}/tmp.fZLn5tOVmy/batch.json`, { before: bashWithResult('tum', 'mktemp -d', `${OS_TMP}/tmp.fZLn5tOVmy`) });
  assertClean('d=$(mktemp -d); echo x > "$d/a.json"; cat "$d/a.json"; rm -rf "$d"');
  assertClean(`cat ${ROOTS.workspaceRoot}/notes.md ${ROOTS.profileRoot}/home/.doflow/x`);
  // the opposite: a directory this run did NOT create, whatever its name looks like
  assertLeaked(`rm -r ${OS_TMP}/tmp.fZLn5tOVmy`);
  assertLeaked('cat $TMPDIR/tmp.X/batch.json');
  assertLeaked('ls $TMPDIR/com.openai.codex.X');
  assertLeaked('cat $PWD/../../playwright_chromiumdev_profile-x/Default/Cookies');
  assertLeaked(`rm -r ${OS_TMP}/tmp.other`, { before: bashWithResult('tum', 'mktemp -d', `${OS_TMP}/tmp.mine`) });
  // globs and parent traversal reach other runs' directories
  assertLeaked('cat $TMPDIR/ab*/workspace/lib/limiter.js');
  assertLeaked(`cat ${OS_TMP.replace('/private', '')}/*/home/.claude/settings.json`);
  assertLeaked('ls $TMPDIR/[a]bprof-*/home/.claude');
  assertLeaked('cat ../../ab*/workspace/test/x.js');
  assertLeaked('cat $TMPDIR/../other/x');
  assertLeaked('mkdir -p $TMPDIR/ab*; ls $TMPDIR/ab*');
  // a listing, and the harness's own directories, even after a mkdir
  assertLeaked('ls $TMPDIR');
  assertLeaked(`ls ${OS_TMP}`);
  assertLeaked('cat $TMPDIR/abws-OTHER/workspace/test/hidden.js');
  assertLeaked('mkdir $TMPDIR/abws-OTHER; cat $TMPDIR/abws-OTHER/workspace/x');
  assertLeaked(`cat ${OS_TMP}/abprof-OTHER/home/.claude/x`);
  assertLeaked(`cat ${OS_TMP}/doflow-agentic-tool-1/bin/doflow.js`);
});

test('isolation (tier 2): a sed/awk/grep/rg pattern is not a path, but a pattern from a file or flag leaves every operand a path', () => {
  assertClean("sed -n '/^--- ROUND/,/^--- FORMAT/p' notes.txt");
  assertClean("grep -n '/api/' lib/a.js; rg '/v1/' lib");
  assertClean("grep -e '/x/' -e '/y/' lib/a.js");
  assertClean("sed -ne '/a/p' lib/a.js");
  assertLeaked("grep -n 'needle' /Users/someone/file.txt");
  assertLeaked("sed -n '/a/p' /Users/someone/file.txt");
  assertLeaked('sed -f /Users/someone/script.sed lib/a.js');
  assertLeaked('grep -f /Users/someone/patterns lib/a.js');
  assertLeaked('awk -f p.awk /Users/someone/.zshrc');
  assertLeaked('grep -f pats /Users/someone/.ssh/config');
  assertLeaked('sed -f s.sed /Users/someone/.zshrc');
  assertLeaked('grep -r --file=pats /Users/someone');
  assertLeaked('grep -rf pats /Users/someone');
  assertLeaked('grep -e needle /Users/someone/.zshrc');
  assertLeaked('rg --files /Users/someone/Workspace');
  assertLeaked('cat /Users/someone/file.txt');
});

test('isolation (tier 2): `$OLDPWD` after a `cd` out of the workspace reads as the workspace', () => {
  assertClean('d=$(mktemp -d); (cd $d && node $OLDPWD/bin/cli.js export --since 2026-01-15; echo "exit $?"); rm -rf $d');
  assertLeaked('cd /Users/someone && cat $OLDPWD/x; cat /Users/someone/y');
});

// ---- report and CLI -----------------------------------------------------------------------------------------------

/** Iteration directories for the CLI path: arms A (two repeats), B and C over two tasks. */
function buildIterations() {
  const root = mkdir('runs-');
  const proc = (cost: number) => ({ hookDenies: { 'pre-implementation-gate': 1, 'stop-check': 0 }, skills: ['do'], class: 'bug', subagentCalls: 0, byModel: { 'claude-sonnet-5-5': { totalTokens: 9055, costUSD: cost } }, totalTokens: 9055, totalCostUsd: cost });
  const plan: [string, string, (id: string) => any][] = [
    ['r1-a', 'A', (id) => ({ ws: workspaceOf(id, false), factor: 1 })], // A fails
    ['r2-a', 'A', (id) => ({ ws: workspaceOf(id, true), factor: 1 })], // A succeeds
    ['r1-b', 'B', (id) => ({ ws: workspaceOf(id, true), factor: 2, process: proc(0.1) })],
    ['r1-c', 'C', (id) => ({ ws: workspaceOf(id, true), factor: 6, process: proc(0.3), status: id === 'finish-and-ship' ? { status: 'truncated', evidence: 'cap', cap: true, exitCode: null, signal: 'SIGKILL', deliveryFailed: true } : undefined })],
  ];
  for (const [name, arm, make] of plan) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    wj(path.join(dir, 'iteration.json'), { arm, model: CONFIG.model.label, sourceAt: 'a'.repeat(40), iteration: name });
    for (const id of ['red-ci-root-cause', 'finish-and-ship']) {
      const o = make(id);
      runDir(dir, { taskId: id, arm, ws: o.ws, factor: o.factor, process: o.process, status: o.status });
    }
  }
  return root;
}

test('tier-2 CLI: `grade` then `report` print three arms with the process block, the not-earned line and the sensitivity line', async () => {
  const root = buildIterations();
  const lines: string[] = [];
  const errs: string[] = [];
  const io = { out: (m: string) => lines.push(m), err: (m: string) => errs.push(m), runRoot: root, repoRoot: REPO };
  for (const name of ['r1-a', 'r2-a', 'r1-b', 'r1-c']) {
    assert.equal(await runner.main(['grade', '--config', CONFIG_PATH, '--iteration', name], io), 0, errs.join('\n'));
  }
  assert.ok(lines.some((l) => l.includes('| coverage |')), 'the grade table carries the tier-2 columns');
  assert.ok(lines.some((l) => /finish-and-ship .*FAILED \(cap\)/.test(l.replace(/\|/g, ' ').replace(/\s+/g, ' ').replace(/^ /, '')) || l.includes('FAILED (cap)')));
  assert.ok(fs.existsSync(path.join(root, 'r1-c', 'finish-and-ship', 'grading.json')));

  lines.length = 0;
  const decisionOut = path.join(mkdir('out-'), 'decision.json');
  assert.equal(await runner.main(['report', '--config', CONFIG_PATH, '--iterations', 'r1-a,r2-a,r1-b,r1-c', '--decision-out', decisionOut], io), 0, errs.join('\n'));
  const text = lines.join('\n');
  assert.match(text, /DESCRIPTIVE, NO SIGNIFICANCE \(repeats per arm: A 2, B 1, C 1/);
  assert.match(text, /\| metric \| A \| B \| C \|/);
  for (const pair of ['A-B', 'A-C', 'B-C']) assert.ok(text.includes(`| ${pair} |`), pair);
  assert.match(text, /Task red-ci-root-cause \(single, 4 items\)/);
  assert.match(text, /process evidence \(NOT SCORED/);
  assert.match(text, /not earned if \(design section 3\): a tie on items\./);
  assert.match(text, /not earned if \(design section 3\): fixed defects C - A <= 1 of 3/);
  assert.match(text, /also excluding runs stopped at a cap or timeout \(view 3\)/);
  assert.match(text, /delivery failed \(cap or timeout\) \| 0 of 2 \| 0 of 1 \| 1 of 1/);
  assert.match(text, /hook denies pre-implementation-gate x1/);
  assert.match(text, /Corpus verdict word/);
  assert.ok(!/warning: grader re-run/.test(text), text);
  const saved = JSON.parse(fs.readFileSync(decisionOut, 'utf8'));
  assert.deepEqual(Object.keys(saved.verdicts), ['A-B', 'A-C', 'B-C']);

  const tasks = reportLib.tier2ReportOf({ runRoot: root, iterations: 'r1-a,r2-a,r1-b,r1-c', taskSet: TASKSET, config: CONFIG, noiseConfig: { mde: 0.05, maxInfraShare: 0.1, seed: 96 }, repoRoot: REPO }).tasks;
  const fin = tasks.find((t: any) => t.id === 'finish-and-ship');
  assert.equal(fin.arms.A.success, 0.5, 'one of two A runs delivered');
  assert.equal(fin.arms.A.coverage.min, 0);
  assert.equal(fin.arms.C.deliveryFailed, 1);
  assert.equal(fin.arms.C.success, 0, 'a capped C run is a failed delivery');
  assert.equal(fin.arms.C.sensitivity.runs, 0, 'and it is out of the "excluding capped/leaked" line');
  assert.equal(fin.numbers.defectsFixed.A, 1.5);
  const ci = tasks.find((t: any) => t.id === 'red-ci-root-cause');
  assert.equal(ci.pairs.find((p: any) => p.pair === 'A-B').successDiff, 0.5);
  assert.ok(ci.pairs.find((p: any) => p.pair === 'A-C').costRatio > 1);
});

test('tier-2 report: a run stopped at the cap prints tokens ">= cap" and no invented cost; an excluded run keeps its item results in a labelled row', () => {
  const root = mkdir('runs-');
  const mk = (name: string, arm: string, make: (id: string) => any) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    wj(path.join(dir, 'iteration.json'), { arm, model: CONFIG.model.label, sourceAt: 'a'.repeat(40), iteration: name });
    for (const id of ['red-ci-root-cause', 'finish-and-ship']) runDir(dir, { taskId: id, arm, ...make(id) });
  };
  const dropResult = (text: string) => text.split('\n').filter((l) => !l.includes('"type":"result"')).join('\n');
  const denied = (text: string) => text.split('\n').map((l) => {
    if (!l.includes('"type":"result"')) return l;
    const e = JSON.parse(l);
    e.permission_denials = [{ tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'git clean -fd' } }];
    return JSON.stringify(e);
  }).join('\n');
  mk('k1-a', 'A', (id) => ({ ws: workspaceOf(id, true) }));
  // C: finish-and-ship killed at its cap before any result event (no tokens, no cost), red-ci denied a tool (excluded, items kept)
  mk('k1-c', 'C', (id) => (id === 'finish-and-ship'
    ? { ws: workspaceOf(id, true), status: { status: 'truncated', evidence: 'cap', cap: true, exitCode: null, signal: 'SIGKILL', deliveryFailed: true }, timing: { total_tokens: null, cost_usd: null }, extra: { streamOf: dropResult } }
    : { ws: workspaceOf(id, true), extra: { streamOf: denied } }));
  const launchFile = path.join(root, 'k1-c', 'finish-and-ship', 'launch.json');
  wj(launchFile, { ...JSON.parse(fs.readFileSync(launchFile, 'utf8')), maxTokensPerRun: 3000000 });
  for (const name of ['k1-a', 'k1-c']) grade.gradeIteration({ iterationDir: path.join(root, name), taskSet: TASKSET, config: CONFIG, pathInfo: null });
  const r = reportLib.tier2ReportOf({ runRoot: root, iterations: 'k1-a,k1-c', taskSet: TASKSET, config: CONFIG, noiseConfig: { mde: 0.05, maxInfraShare: 0.1, seed: 96 }, repoRoot: REPO });
  const text = reportLib.tier2ReportLines(r).join('\n');
  const fin = r.tasks.find((t: any) => t.id === 'finish-and-ship').arms.C;
  assert.equal(fin.scored, 1, 'the capped run is a scored failed delivery');
  assert.equal(fin.tokensBound.value, 3000000, 'counted at its cap');
  assert.equal(fin.tokensBound.lowerBound, true);
  assert.equal(fin.costBound.value, null, 'its cost was never reported and is not invented');
  assert.match(text, /\| total tokens [^|]*\| [^|]* \| >= 3000000 /);
  assert.match(text, /none \(no scored run reported cost\)/);
  assert.match(text, /No dollar-cap sensitivity is computed/);
  const ci = r.tasks.find((t: any) => t.id === 'red-ci-root-cause').arms.C;
  assert.equal(ci.scored, 0);
  assert.equal(ci.excludedItems.length, 1);
  assert.equal(ci.excludedItems[0].k, ci.excludedItems[0].n, 'the denied run kept its item results');
  assert.match(text, /\| excluded, item results only [^|]*\| [^|]* \| k1-c 4\/4 items \[truncated \(permission-denied\)\] \|/);
  assert.match(text, /sensitivity, every run incl\. excluded: coverage k\/N \[range\] \| [^|]* \| 4\.00\/4 \[4-4\] over 1 of 1 run\(s\)/);
});

test('tier-2 permission denials (D1): a DoFlow hook denial is an outcome and counts; a harness denial excludes only a run that did not hit its cap; a cap stop is a failed delivery whatever was denied', () => {
  const id = 'red-ci-root-cause';
  const deniedResult = (text: string) => text.split('\n').map((l) => {
    if (!l.includes('"type":"result"')) return l;
    const e = JSON.parse(l);
    e.permission_denials = [{ tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'git clean -fd' } }];
    return JSON.stringify(e);
  }).join('\n');
  const deniedEvent = (text: string) => withEventBeforeResult(text, { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', decision_reason_type: 'safetyCheck', message: 'Dangerous rm operation on statically-unresolvable target' });
  const hookProc = { hookDenies: { 'pre-implementation-gate': 1 }, skills: ['do'], class: 'bug', subagentCalls: 0, byModel: {}, totalTokens: 9055, totalCostUsd: 0.05 };
  const cap = { status: 'truncated', evidence: 'cap', cap: true, exitCode: null, signal: 'SIGKILL', deliveryFailed: true };
  const run = (opts: any) => gradeOf(runDir(mkdir('run-'), { taskId: id, arm: 'C', ws: workspaceOf(id, true), ...opts }), id, 'C');

  const hook = run({ extra: { streamOf: deniedResult }, process: hookProc });
  assert.equal(hook.tier2.excluded, null, 'the pre-implementation-gate denial is counted, not an exclusion');
  assert.notEqual(hook.pass_rate, null);
  assert.equal(hook.pass_rate, 1, 'the final workspace is what is graded');

  const harness = run({ extra: { streamOf: deniedResult }, process: { ...hookProc, hookDenies: {} } });
  assert.equal(harness.pass_rate, null, 'a harness safety denial in a run that did not hit its cap is excluded');
  assert.equal(harness.tier2.excluded, 'truncated');
  assert.equal(harness.permissionDenials, 1);

  const harnessEvent = run({ extra: { streamOf: deniedEvent }, process: { ...hookProc, hookDenies: {} } });
  assert.equal(harnessEvent.pass_rate, null, 'the live permission_denied event is a harness denial too');

  const capped = run({ extra: { streamOf: deniedEvent }, status: cap, process: { ...hookProc, hookDenies: {} } });
  assert.notEqual(capped.pass_rate, null, 'a run stopped at the cap is never dropped');
  assert.equal(capped.pass_rate, 0, 'it is a failed delivery');
  assert.equal(capped.tier2.deliveryFailed, true);
  assert.equal(capped.tier2.excluded, null);

  const hookCapped = run({ extra: { streamOf: deniedResult }, status: cap, process: hookProc });
  assert.equal(hookCapped.pass_rate, 0);
});

test('tier-2 report: pair ratios carry the bound of their cells (>=, <=, none) and the cost-by-model row is a lower bound when a run was stopped at its cap', () => {
  const b = (value: number | null, lowerBound: boolean) => ({ value, lowerBound });
  assert.deepEqual(reportLib.boundRatio(b(200, false), b(100, false)), { value: 2, rel: '=' });
  assert.deepEqual(reportLib.boundRatio(b(200, true), b(100, false)), { value: 2, rel: '>=' }, 'Y a lower bound over an exact X: at least');
  assert.deepEqual(reportLib.boundRatio(b(200, false), b(100, true)), { value: 2, rel: '<=' }, 'Y exact over a lower-bound X: at most');
  assert.deepEqual(reportLib.boundRatio(b(200, true), b(100, true)), { value: null, rel: null }, 'both bounded: not derivable');
  assert.deepEqual(reportLib.boundRatio(b(null, false), b(100, false)), { value: null, rel: null });
  assert.deepEqual(reportLib.boundRatio(b(200, false), b(0, false)), { value: null, rel: null });

  const root = mkdir('runs-');
  const proc = { hookDenies: {}, skills: [], class: null, subagentCalls: 0, byModel: { 'claude-sonnet-5-5': { totalTokens: 100, costUSD: 0.01 } }, totalTokens: 100, totalCostUsd: 0.01 };
  const dropResult = (text: string) => text.split('\n').filter((l) => !l.includes('"type":"result"')).join('\n');
  const mk = (name: string, arm: string, make: () => any) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    wj(path.join(dir, 'iteration.json'), { arm, model: CONFIG.model.label, sourceAt: 'a'.repeat(40), iteration: name });
    runDir(dir, { taskId: 'finish-and-ship', arm, ...make() });
  };
  mk('m1-a', 'A', () => ({ ws: workspaceOf('finish-and-ship', true), process: proc }));
  mk('m1-c', 'C', () => ({ ws: workspaceOf('finish-and-ship', true), process: proc }));
  mk('m2-c', 'C', () => ({ ws: workspaceOf('finish-and-ship', true), status: { status: 'truncated', evidence: 'cap', cap: true, exitCode: null, signal: 'SIGKILL', deliveryFailed: true }, timing: { total_tokens: null, cost_usd: null }, extra: { streamOf: dropResult } }));
  const launchFile = path.join(root, 'm2-c', 'finish-and-ship', 'launch.json');
  wj(launchFile, { ...JSON.parse(fs.readFileSync(launchFile, 'utf8')), maxTokensPerRun: 3000000 });
  for (const name of ['m1-a', 'm1-c', 'm2-c']) grade.gradeIteration({ iterationDir: path.join(root, name), taskSet: TASKSET, config: CONFIG, pathInfo: null });
  const r = reportLib.tier2ReportOf({ runRoot: root, iterations: 'm1-a,m1-c,m2-c', taskSet: TASKSET, config: CONFIG, noiseConfig: { mde: 0.05, maxInfraShare: 0.1, seed: 96 }, repoRoot: REPO });
  const t = r.tasks.find((x: any) => x.id === 'finish-and-ship');
  const ac = t.pairs.find((p: any) => p.pair === 'A-C');
  assert.equal(ac.rel.tokens, '>=', 'C includes a run counted at its cap');
  assert.ok(ac.tokensRatio > 1);
  assert.equal(ac.rel.cost, '>=', 'the capped run never reported a cost: C cost is a lower bound, so is the ratio');
  assert.ok(Math.abs(ac.costRatio - 0.5) < 1e-9, 'sum of what is known over BOTH scored C runs');
  const c = t.arms.C.byModel['claude-sonnet-5-5'];
  assert.equal(c.lowerBound, true);
  assert.equal(c.totalTokens, 50, 'the capped run adds 0 to the sum over BOTH scored runs, it is not left out of the mean');
  const text = reportLib.tier2ReportLines(r).join('\n');
  assert.match(text, /claude-sonnet-5-5 >= 0\.0050; >= 50/);
  assert.match(text, /\| A-C \| [^|]* \| [^|]* \| >= 0\.50x \| >= \d+\.\d\dx \|/);
  assert.match(text, /Headline: success/);
  assert.match(text, /\| finish-and-ship \| \d\/\d \/ \d\/\d \|/);
});

test('tier-2 CLI: `noise` is refused for a tier-2 task set and an unknown arm in an iteration is refused', async () => {
  const root = buildIterations();
  const errs: string[] = [];
  const io = { out: () => {}, err: (m: string) => errs.push(m), runRoot: root, repoRoot: REPO };
  assert.equal(await runner.main(['noise', '--config', CONFIG_PATH, '--iterations', 'r1-a,r2-a'], io), 2);
  assert.match(errs.join('\n'), /no A\/A noise artifact/);
  wj(path.join(root, 'r1-b', 'iteration.json'), { arm: 'Z', model: CONFIG.model.label, sourceAt: 'a'.repeat(40) });
  errs.length = 0;
  assert.equal(await runner.main(['report', '--config', CONFIG_PATH, '--iterations', 'r1-b'], io), 2);
  assert.match(errs.join('\n'), /arm Z, which the config does not define/);
});

test('tier-2 launch check: arm C is checked against its prefixed prompt, and a stale prompt is still refused', () => {
  const root = mkdir('runs-');
  const dir = runDir(root, { taskId: 'red-ci-root-cause', arm: 'C', ws: workspaceOf('red-ci-root-cause', true) });
  assert.doesNotThrow(() => grade.checkLaunch({ runDir: dir, task: taskOf('red-ci-root-cause'), arm: 'C', config: CONFIG, label: 'x' }));
  assert.throws(() => grade.checkLaunch({ runDir: dir, task: taskOf('red-ci-root-cause'), arm: 'B', config: CONFIG, label: 'x' }), /capture-stale|differs from the current task/);
});
