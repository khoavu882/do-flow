'use strict';

// Feature 161 T4 (IC-003, D5-D8, AC-5): the `layers:<pk>` channel of `doflow events --follow`.
// Scratch HOME and config home, scratch git projects; the in-process cases inject the clock and the
// watch, so passes, debounces and throttles run on a fake clock. Read-only, no lock (AC-7: the
// source scan of `src/runtime/events/*.ts` in events-control.test.ts covers the modules added here).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { sha16 } = require('../../src/runtime/scaffold/fingerprint.ts');
const { handleEventsCommand } = require('../../src/runtime/events/command.ts');
const { channelSpec } = require('../../src/runtime/events/sections.ts');
const { createProjectsIndex } = require('../../src/runtime/events/projects-index.ts');
const { scanArtifacts, findArtifact, ARTIFACT_LIMIT } = require('../../src/runtime/events/artifacts.ts');
const { AUDIT } = require('../../src/runtime/events/coverage.ts');
const { maskBody } = require('../../src/runtime/mask.ts');
const { gateName } = require('../../src/runtime/events/layers.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const WIN = process.platform === 'win32';
const SCRATCH = 'scratch.noindex'; // not in any fixture path, so the scratch projects are listed
const SECTIONS = ['artifacts', 'checkouts', 'coverage', 'gates', 'reviews', 'runs', 'sessions', 'traffic', 'tree'];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake clock that starts at the real time, so the files the test writes are "recent" on it. */
function fakeClock() {
  let now = Math.floor(Date.now() / 1000) * 1000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: null }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId; },
    clearInterval(id: number) { timers.delete(id); },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        let pick: [number, { at: number; fn: () => void; every: number | null }] | null = null;
        for (const entry of timers) if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        if (timer.every !== null) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = target;
      await settle();
    },
  };
}

/** A watch whose handles a test can fire. */
function fakeWatch() {
  const handles: any[] = [];
  const watch: any = (dir: string, _options: any, listener: (type: string, name: string | null) => void) => {
    const handle: any = {
      dir, closed: false,
      close() { handle.closed = true; },
      on() { return handle; },
      emit(type: string, name: string | null) { if (!handle.closed) listener(type, name); },
    };
    handles.push(handle);
    return handle;
  };
  watch.open = (dir: string) => handles.filter((h) => h.dir === dir && !h.closed);
  return watch;
}

function fakeStdin() {
  const stdin: any = new EventEmitter();
  stdin.pause = () => {};
  stdin.destroy = () => {};
  stdin.json = (op: string, ch: string) => stdin.emit('data', Buffer.from(`${JSON.stringify({ op, ch })}\n`, 'utf8'));
  return stdin;
}

function sink() {
  const s: any = { text: '', write(chunk: string) { s.text += chunk; return true; } };
  s.frames = () => s.text.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
  return s;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-events-layers-'));
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config') };
  f.store = path.join(f.config, 'doflow', 'session-env');
  f.sessions = path.join(f.store, 'sessions');
  fs.mkdirSync(path.join(f.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(f.sessions, { recursive: true });
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config, TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_TELEMETRY: 'off',
    DOFLOW_FAILURE_CAPTURE: 'off', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '',
  };
  return f;
}

/** A DoFlow project (a git repository with `.doflow/state`), registered in `upkeep-roots`. */
function project(f: any, name: string): string {
  const dir = path.join(f.root, name);
  fs.mkdirSync(path.join(dir, '.doflow', 'state', 'orchestration'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${dir}\n`);
  return dir;
}

function indexFor(f: any, cwd: string, now: () => number = Date.now) {
  return createProjectsIndex({ env: f.env, cwd, now, tempRoots: [], scratchName: SCRATCH });
}

/** A hook session as the hooks leave it: a model observation at the checkout and a session directory with its git context. */
function session(f: any, harness: string, rawId: string, cwd: string, nowMs: number): string {
  const dir = path.join(f.store, 'primary', cwdHash(cwd), harness);
  fs.mkdirSync(dir, { recursive: true });
  const observedAt = new Date(nowMs - 60000).toISOString();
  fs.writeFileSync(path.join(dir, `${sha16(rawId)}.json`), JSON.stringify({ schema: 1, harness, model: `${harness}-fixture-1`, event: 'SessionStart', observedAt, session: sha16(rawId) }));
  const sdir = path.join(f.sessions, rawId);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'git-context.json'), JSON.stringify({ cwd, captured_at: observedAt, branch: 'main' }));
  return sdir;
}

function auditLine(event: string, sessionId: string, agentId: string, agentType = 'Explore', at = new Date().toISOString()): string {
  return `${JSON.stringify({ timestamp: at.replace(/\.\d+Z$/, 'Z'), session_id: sessionId, event, agent_type: agentType, agent_id: agentId })}\n`;
}

function journal(root: string, slug: string | null, taskId: string, changes: any = {}): string {
  const file = path.join(root, '.doflow', 'state', 'orchestration', ...(slug ? [slug] : []), `${taskId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, taskId, taskClass: 'feature', workflowName: 'Feature Delivery', terminalStage: null, state: 'RUNNING', cursor: 0,
    program: [{ type: 'stage', id: 'build', status: 'pending' }], history: [], revision: 1, updatedAt: '2026-11-15T00:00:00.000Z', ...changes,
  }, null, 2));
  return file;
}

function write(file: string, text: string, mtimeMs?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

const layersOf = (frames: any[], pk: string) => frames.filter((frame) => frame.ch === `layers:${pk}`);
const fileKeyOf = (checkout: string, rel: string) => sha16(`${checkout}\0${rel}`);

test('161 T4: writing exec/task-3-brief.md in a scratch checkout patches artifacts with kind task-brief and a fileKey; appending a SubagentStart line patches sessions with the tree agentKey', async (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const pk = cwdHash(a);
  const clock = fakeClock();
  const raw = 'sess-claude-161';
  const sdir = session(f, 'claude', raw, a, clock.now());
  fs.mkdirSync(path.join(a, 'agent-docs', 'doflow', '161-x', 'exec'), { recursive: true });
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: a, env: f.env,
    stdin, stdout, stderr, clock, watch: fakeWatch(), signals: new EventEmitter(), epoch: '0a1b2c3d',
    projectsIndex: indexFor(f, a, () => clock.now()),
  });

  stdin.json('sub', `layers:${pk}`);
  await settle();
  const [snapshot] = layersOf(stdout.frames(), pk);
  assert.equal(snapshot && snapshot.type, 'snapshot', stdout.text + stderr.text);
  const s = snapshot.data.sections;
  assert.deepEqual(Object.keys(s).sort(), SECTIONS);
  for (const name of SECTIONS) assert.equal(s[name].exit, 0, `${name}: ${JSON.stringify(s[name].json)}`);
  assert.deepEqual(s.checkouts.json, [{ worktreeKey: pk, label: 'proj-a', branch: 'main', main: true }]);
  assert.deepEqual(s.artifacts.json, []);
  assert.ok(JSON.stringify(s.tree.json).includes(sha16(`claude:${raw}`)), 'the main session is a tree node');
  assert.deepEqual(s.sessions.json, [{
    sessionKey: sha16(raw), harness: 'claude',
    audit: { observed: true, open: 0, started: 0, stopped: 0, recent: [] }, denials: { observed: true, count: 0, recent: [] },
  }]);

  // The brief appears: the next pass patches `artifacts` with its kind and fileKey.
  const rel = 'agent-docs/doflow/161-x/exec/task-3-brief.md';
  write(path.join(a, ...rel.split('/')), '# Task 3\n');
  await clock.advance(1100);
  const briefPatch = layersOf(stdout.frames(), pk).find((frame) => frame.type === 'patch' && frame.data.sections.artifacts);
  assert.ok(briefPatch, `an artifacts patch: ${stdout.text}`);
  const [item] = briefPatch.data.sections.artifacts.json;
  assert.equal(item.kind, 'task-brief');
  assert.equal(item.fileKey, fileKeyOf(a, rel));
  assert.deepEqual([item.worktreeKey, item.feature, item.task, item.bytes], [pk, '161-x', '3', 9]);
  assert.ok(!('path' in item));

  // A SubagentStart line in the session's audit log patches `sessions` with the tree's agentKey.
  fs.appendFileSync(path.join(sdir, 'subagent-audit.log'), auditLine('SubagentStart', raw, 'agent-7'));
  await clock.advance(1100);
  const auditPatch = layersOf(stdout.frames(), pk).find((frame) => frame.type === 'patch' && frame.data.sections.sessions);
  assert.ok(auditPatch, `a sessions patch: ${stdout.text}`);
  const [row] = auditPatch.data.sections.sessions.json;
  assert.deepEqual([row.audit.observed, row.audit.open, row.audit.started, row.audit.stopped], [true, 1, 1, 0]);
  assert.deepEqual(row.audit.recent.map((r: any) => [r.event, r.agentType, r.agentKey]), [['SubagentStart', 'Explore', sha16(`claude:${raw}:agent-7`)]]);

  stdin.emit('end');
  assert.equal(await done, 0);
  assert.equal(stderr.text, '');
  assert.ok(!stdout.text.includes(f.root), 'no absolute path leaves the core');
});

test('161 IC-003: reviews give each feature absent, unreadable, invalid or ok with countFindings counts', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-r');
  const features = path.join(a, 'agent-docs', 'doflow');
  fs.mkdirSync(path.join(features, '161-absent'), { recursive: true });
  write(path.join(features, '161-unreadable', 'review', 'findings.json'), '{not json');
  fs.mkdirSync(path.join(features, '161-dir', 'review', 'findings.json'), { recursive: true }); // not a regular file
  write(path.join(features, '161-invalid', 'review', 'findings.json'), JSON.stringify({ schema: 2 }));
  write(path.join(features, '161-ok', 'review', 'findings.json'), JSON.stringify({
    schema: 1, row: '161', slug: '161-ok', reviewedHead: '0123456789abcdef0123456789abcdef01234567', seats: [], converged: [],
  }));
  fs.mkdirSync(path.join(features, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(features, '161-linked'), { recursive: true });
  fs.symlinkSync(path.join(features, '161-ok', 'review'), path.join(features, '161-linked', 'review')); // a linked review directory is not read
  const spec = channelSpec(`layers:${cwdHash(a)}`, { cwd: a, env: f.env, index: indexFor(f, a) });
  const { sections } = await spec.compute(['reviews']);
  assert.deepEqual(Object.keys(sections), ['reviews']);
  const byFeature = Object.fromEntries(sections.reviews.json.map((r: any) => [r.feature, r]));
  assert.deepEqual(Object.keys(byFeature).sort(), ['161-absent', '161-dir', '161-invalid', '161-linked', '161-ok', '161-unreadable']);
  assert.equal(byFeature['161-linked'].state, 'unreadable');
  assert.deepEqual(byFeature['161-absent'], { worktreeKey: cwdHash(a), feature: '161-absent', state: 'absent' });
  assert.equal(byFeature['161-unreadable'].state, 'unreadable');
  assert.equal(byFeature['161-dir'].state, 'unreadable');
  assert.equal(byFeature['161-invalid'].state, 'invalid');
  assert.equal(byFeature['161-ok'].state, 'ok');
  assert.equal(byFeature['161-ok'].counts.converged, 0);
  assert.equal(byFeature['161-ok'].counts.task, '161-ok', 'the countFindings body as it is');
});

test('161 IC-003, DEC-006: gates carry by autopilot, manual or null from the timeline, and an awaiting gate with by null', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-g');
  const gate = (id: string) => ({ type: 'gate', id, kind: 'approval', name: `Approve ${id}`, prompt: 'PRIVATE-PROMPT-161', status: 'done' });
  journal(a, 'feat-g', 't1', {
    runKey: `${cwdHash(a)}/t1/l1`, updatedAt: '2026-11-15T03:00:00.000Z',
    program: [gate('g-auto'), gate('g-manual'), gate('g-none')],
    history: [
      { at: '2026-11-15T01:00:00.000Z', action: 'decide-gate', node: 'g-auto', detail: 'approve', by: 'autopilot' },
      { at: '2026-11-15T02:00:00.000Z', action: 'decide-gate', node: 'g-manual', detail: 'reject', by: 'manual', note: 'PRIVATE-NOTE' },
      { at: '2026-11-15T03:00:00.000Z', action: 'decide-gate', node: 'g-none', detail: 'approve' },
    ],
  });
  journal(a, 'feat-g', 't2', {
    state: 'AWAITING_GATE', updatedAt: '2026-11-15T04:00:00.000Z',
    program: [{ ...gate('g-wait'), status: 'pending' }],
  });
  const spec = channelSpec(`layers:${cwdHash(a)}`, { cwd: a, env: f.env, index: indexFor(f, a) });
  const { sections } = await spec.compute(['gates']);
  assert.equal(sections.gates.exit, 0, JSON.stringify(sections.gates.json));
  assert.deepEqual(sections.gates.json.map((g: any) => [g.taskId, g.gateId, g.state, g.by, g.runKey]), [
    ['t2', 'g-wait', 'awaiting', null, null],
    ['t1', 'g-none', 'approved', null, `${cwdHash(a)}/t1/l1`],
    ['t1', 'g-manual', 'rejected', 'manual', `${cwdHash(a)}/t1/l1`],
    ['t1', 'g-auto', 'approved', 'autopilot', `${cwdHash(a)}/t1/l1`],
  ]);
  assert.deepEqual(sections.gates.json[1].name, 'Approve g-none');
  assert.ok(!JSON.stringify(sections).includes('PRIVATE'), 'no gate prompt or decision note');
});

test('161 IC-003, IC-004: artifacts list the ten kinds from regular files only; never .last.log, a symbolic link or a dotted id; the fileKey lookup stays inside the core', (t) => {
  const root = fs.realpathSync(tempDir(t, 'doflow-events-artifacts-'));
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const exec = path.join(main, 'agent-docs', 'doflow', '161-x', 'exec');
  const envelopes = path.join(main, '.doflow', 'state', 'dispatch-envelopes');
  const output = path.join(linked, '.doflow', 'state', 'worker-output');
  const base = Date.now() - 100000;
  let n = 0;
  const at = () => base + (n += 1) * 1000;
  write(path.join(exec, 'task-3-brief.md'), 'b', at());
  write(path.join(exec, 'task-3-brief.json'), '{}', at());
  write(path.join(exec, 'group-a-brief.md'), 'g', at());
  write(path.join(exec, 'group-a-brief.json'), '{}', at());
  write(path.join(exec, 'task-3-report.md'), 'r', at());
  write(path.join(envelopes, 'd-1.handoff.json'), '{}', at());
  write(path.join(envelopes, 'd-1.result.json'), '{}', at());
  write(path.join(envelopes, 'req-1.prompt.txt'), 'p', at());
  write(path.join(output, 'w-0123456789ab.out.log'), 'o', at());
  write(path.join(output, 'w-0123456789ab.err.log'), 'e', at());
  // Never listed:
  write(path.join(output, 'w-0123456789ab.last.log'), 'l', at());
  write(path.join(output, 'w-nothex.out.log'), 'x', at());
  write(path.join(exec, 'task-..-brief.md'), 'x', at());
  write(path.join(exec, 'notes.md'), 'x', at());
  const outside = write(path.join(root, 'outside', 'secret.md'), 'SECRET', at());
  fs.symlinkSync(outside, path.join(exec, 'task-9-brief.md'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(main, 'agent-docs', 'doflow', '161-linked'));
  fs.mkdirSync(path.join(root, 'outside', 'exec'));
  write(path.join(root, 'outside', 'exec', 'task-4-brief.md'), 'x', at());

  const scan = scanArtifacts([main, linked]);
  assert.deepEqual(scan.items.map((i: any) => i.kind), [
    'worker-err', 'worker-out', 'spawn-prompt', 'result', 'handoff', 'task-report', 'group-brief-record', 'group-brief', 'task-brief-record', 'task-brief',
  ]);
  assert.deepEqual(scan.items.map((i: any) => i.task ?? i.group ?? i.dispatchId ?? i.runId), [
    'w-0123456789ab', 'w-0123456789ab', 'req-1', 'd-1', 'd-1', '3', 'a', 'a', '3', '3',
  ]);
  const worker = scan.items[0];
  assert.deepEqual([worker.worktreeKey, worker.feature, worker.bytes], [cwdHash(linked), null, 1]);
  assert.equal(worker.fileKey, fileKeyOf(linked, '.doflow/state/worker-output/w-0123456789ab.err.log'));
  for (const item of scan.items) assert.ok(!JSON.stringify(item).includes(root), 'no path in an item');
  const brief = scan.items.at(-1);
  assert.deepEqual(findArtifact([main, linked], brief.fileKey), { path: path.join(exec, 'task-3-brief.md'), kind: 'task-brief', root: main });
  assert.equal(findArtifact([main, linked], fileKeyOf(main, 'agent-docs/doflow/161-x/exec/task-9-brief.md')), null, 'a link is never resolved');
  assert.equal(findArtifact([main, linked], fileKeyOf(linked, '.doflow/state/worker-output/w-0123456789ab.last.log')), null);
});

test('161 IC-003: artifacts keep the 64 newest', (t) => {
  const root = fs.realpathSync(tempDir(t, 'doflow-events-artifacts-'));
  const exec = path.join(root, 'agent-docs', 'doflow', '161-x', 'exec');
  const base = Date.now() - 1000000;
  for (let i = 0; i < ARTIFACT_LIMIT + 6; i += 1) write(path.join(exec, `task-${i}-brief.md`), 'b', base + i * 1000);
  const scan = scanArtifacts([root]);
  assert.equal(scan.items.length, ARTIFACT_LIMIT);
  assert.equal(scan.items[0].task, String(ARTIFACT_LIMIT + 5));
  assert.equal(scan.items.at(-1).task, '6');
  assert.equal(scan.files.size, ARTIFACT_LIMIT);
});

test('161 IC-003, D8, AC-5: a codex audit line has agentKey null, an antigravity session has subagents not observed, a claude denial is "permission refused" with its tool and reason', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-s');
  const now = Date.now();
  const codex = session(f, 'codex', 'sess-codex-1', a, now);
  fs.writeFileSync(path.join(codex, 'subagent-audit.log'), auditLine('SubagentStart', 'sess-codex-1', 'child-1', 'worker') + auditLine('SubagentStop', 'sess-codex-1', 'child-1', 'worker'));
  session(f, 'antigravity', 'sess-agy-1', a, now - 1000);
  const claude = session(f, 'claude', 'sess-claude-2', a, now - 2000);
  fs.writeFileSync(path.join(claude, 'permission-audit.log'), [
    JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', session_id: 'sess-claude-2', event: 'PermissionDenied', tool_name: 'Bash', reason: 'x'.repeat(300) }),
    'not json',
    JSON.stringify({ timestamp: '2026-11-15T02:00:00Z', session_id: 'sess-claude-2', event: 'PermissionDenied', tool_name: 'Write', reason: 'outside the write set' }),
  ].join('\n'));
  const spec = channelSpec(`layers:${cwdHash(a)}`, { cwd: a, env: f.env, index: indexFor(f, a) });
  const { sections } = await spec.compute(['sessions', 'coverage']);
  assert.equal(sections.sessions.exit, 0, JSON.stringify(sections.sessions.json));
  const by = Object.fromEntries(sections.sessions.json.map((s: any) => [s.harness, s]));
  assert.deepEqual(Object.keys(by).sort(), ['antigravity', 'claude', 'codex']);

  assert.deepEqual([by.codex.audit.started, by.codex.audit.stopped, by.codex.audit.open], [1, 1, 0]);
  assert.deepEqual(by.codex.audit.recent.map((r: any) => [r.event, r.agentKey]), [['SubagentStop', null], ['SubagentStart', null]], 'codex: audit-only, no tree join');
  assert.deepEqual(by.codex.denials, { observed: false, reason: 'no-harness-record' });

  assert.deepEqual(by.antigravity.audit, { observed: false, reason: 'no-audit-hook' });
  assert.deepEqual(by.antigravity.denials, { observed: false, reason: 'no-harness-record' });

  assert.equal(by.claude.denials.count, 2);
  assert.deepEqual(by.claude.denials.recent.map((r: any) => [r.tool, r.reason.length]), [['Write', 21], ['Bash', 200]]);

  const coverage = Object.fromEntries(sections.coverage.json.map((c: any) => [c.harness, c]));
  assert.deepEqual(coverage.antigravity.subagents, { observed: false, reason: 'no-audit-hook' });
  assert.deepEqual(coverage.claude.permissions, { observed: true });
  assert.deepEqual(coverage.codex.permissions, { observed: false, reason: 'no-harness-record' });
  for (const row of sections.coverage.json) {
    assert.deepEqual(Object.keys(row), ['harness', 'main', 'subagents', 'transcript', 'permissions', 'questions']);
    assert.deepEqual(row.questions, { observed: false, reason: 'no-harness-record' }, `${row.harness}: no harness records a question (D7)`);
  }
});

test('161 review 3: a denial reason and a gate name are masked whole before the 200-character cap, so a secret cut at the boundary is never sent', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-m');
  const secret = ' sk-Abcdef0123456789xyz';
  const claude = session(f, 'claude', 'sess-claude-m', a, Date.now());
  write(path.join(claude, 'permission-audit.log'), `${JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', tool_name: 'Bash', reason: 'x'.repeat(185) + secret })}\n`);
  const spec = channelSpec(`layers:${cwdHash(a)}`, { cwd: a, env: f.env, index: indexFor(f, a) });
  const { sections } = await spec.compute(['sessions']);
  const [reason] = sections.sessions.json[0].denials.recent.map((r: any) => r.reason);
  for (const text of [reason, gateName('x'.repeat(185) + secret, 'g-1'), gateName(`${'y'.repeat(190)} token=hunter2`, 'g-1')]) {
    assert.ok(!text.includes('sk-Abc') && !text.includes('hunter'), text);
    assert.ok(text.length <= 200, String(text.length));
    assert.equal(maskBody(text).text, text, 'the envelope\'s own masking leaves it as it is, so it stays under the cap');
  }
});

/** An fs whose next open (or read by name) of a key of `swaps` first swaps it for a link to its value, after every lstat the reader made. */
function swapAtOpen(swaps: Map<string, string>): any {
  const swap = (file: any) => {
    const outside = typeof file === 'string' ? swaps.get(file) : undefined;
    if (outside === undefined) return;
    swaps.delete(file);
    fs.renameSync(file, `${file}.moved`);
    fs.symlinkSync(outside, file);
  };
  return {
    ...fs,
    openSync(file: any, flags: any, mode?: any) { swap(file); return fs.openSync(file, flags, mode); },
    readFileSync(file: any, options?: any) { swap(file); return fs.readFileSync(file, options); },
  };
}

test('161 review 1: a denial log and a findings.json swapped for links between the lstat and the open read nothing from outside', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-l');
  const claude = session(f, 'claude', 'sess-claude-l', a, Date.now());
  const denials = write(path.join(claude, 'permission-audit.log'), `${JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', tool_name: 'Bash', reason: 'inside the project, a line longer than the outside one' })}\n`);
  const outsideLog = write(path.join(f.root, 'outside.log'), `${JSON.stringify({ timestamp: '2026-11-15T02:00:00Z', tool_name: 'Bash', reason: 'OUTSIDE-LINE' })}\n`);
  const findings = write(path.join(a, 'agent-docs', 'doflow', '161-l', 'review', 'findings.json'), JSON.stringify({ schema: 2 }));
  const outsideFindings = write(path.join(f.root, 'outside.json'), JSON.stringify({ schema: 1, row: '161', slug: '161-l', reviewedHead: '0123456789abcdef0123456789abcdef01234567', seats: [], converged: [] }));
  const fsImpl = swapAtOpen(new Map([[denials, outsideLog], [findings, outsideFindings]]));
  const spec = channelSpec(`layers:${cwdHash(a)}`, { cwd: a, env: f.env, index: indexFor(f, a), fsImpl });
  const { sections } = await spec.compute(['sessions', 'reviews']);
  assert.ok(!JSON.stringify(sections.sessions.json).includes('OUTSIDE-LINE'), JSON.stringify(sections.sessions.json));
  assert.notEqual(sections.reviews.json.find((r: any) => r.feature === '161-l').state, 'ok', 'the outside findings are not counted');
});

/** The harnesses whose front door, wired in their own hook config under `events`, is a script that runs `policy`. */
function wiredFrontDoors(events: RegExp, policy: RegExp): string[] {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), 'utf8'));
  const walk = (dir: string): string[] => {
    let out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walk(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  };
  const found: string[] = [];
  for (const { id } of registry.harnesses) {
    const dir = path.join(REPO_ROOT, 'core', 'harnesses', id);
    if (!fs.existsSync(dir)) continue;
    const files = walk(dir);
    const scripts = new Map(files.filter((p) => p.endsWith('.sh')).map((p) => [path.basename(p), p]));
    const named = new Set<string>();
    const visit = (node: any): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (events.test(key)) for (const m of JSON.stringify(value).matchAll(/([\w.-]+\.sh)/g)) named.add(m[1]);
        visit(value);
      }
    };
    for (const file of files.filter((p) => p.endsWith('.json'))) visit(JSON.parse(fs.readFileSync(file, 'utf8')));
    const runs = [...named].some((name) => {
      const script = scripts.get(name);
      if (!script) return false;
      const code = fs.readFileSync(script, 'utf8').split('\n').filter((line: string) => !/^\s*#/.test(line)).join('\n');
      return policy.test(code);
    });
    if (runs) found.push(id);
  }
  return found.sort();
}

test('161 IC-003 guard: the coverage AUDIT table equals the front-door hooks on disk', () => {
  assert.deepEqual(wiredFrontDoors(/^subagent(?:start|stop)$/i, /\bsubagent-audit\b/), [...AUDIT.subagents].sort(),
    'a harness whose hook config runs subagent-audit is in AUDIT.subagents, and only those');
  assert.deepEqual(wiredFrontDoors(/^permissiondenied$/i, /permission-audit\.log/), [...AUDIT.permissions].sort(),
    'a harness whose hook config records PermissionDenied is in AUDIT.permissions, and only those');
});

test('161 IC-003, IC-008: tree recomputes at most once per 1000 ms and traffic once per 5000 ms; sessions and gates are never throttled', async (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const f = fixture(t);
  const a = project(f, 'proj-t');
  const pk = cwdHash(a);
  const clock = fakeClock();
  session(f, 'claude', 'sess-claude-3', a, clock.now());
  const watch = fakeWatch();
  const calls: Array<{ at: number; only: string[] | null }> = [];
  const specFor = (channel: any, ctx: any) => {
    const spec = channelSpec(channel, ctx);
    const compute = spec.compute;
    spec.compute = (only?: string[]) => { calls.push({ at: clock.now(), only: only ? [...only] : null }); return compute(only); };
    return spec;
  };
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: a, env: f.env,
    stdin, stdout, stderr, clock, watch, signals: new EventEmitter(), epoch: '0a1b2c3d', specFor,
    projectsIndex: indexFor(f, a, () => clock.now()),
  });
  stdin.json('sub', `layers:${pk}`);
  await settle();
  assert.equal(layersOf(stdout.frames(), pk)[0]?.type, 'snapshot', stdout.text + stderr.text);
  const sessionsWatch = watch.open(f.sessions)[0];
  const storeWatch = watch.open(path.join(a, '.doflow', 'state', 'orchestration'))[0];
  assert.ok(sessionsWatch && storeWatch, 'the session directory and the orchestration store are watched');

  // A 3 s burst: a session-directory event (tree, sessions) and a store event (runs, gates) every 200 ms.
  const start = clock.now();
  for (let i = 0; i < 15; i += 1) {
    sessionsWatch.emit('change', 'sess-claude-3');
    storeWatch.emit('change', `t${i}.json`);
    await clock.advance(200);
  }
  // A session event 500 ms before the 5 s derived pass: that pass must not run tree again inside its window.
  const subscribed = calls[0].at;
  await clock.advance(subscribed + 4500 - clock.now());
  sessionsWatch.emit('change', 'sess-claude-3');
  await clock.advance(12000); // the trailing runs and two more derived passes
  stdin.emit('end');
  assert.equal(await done, 0);
  assert.equal(stderr.text, '');

  const timesOf = (name: string) => calls.filter((c) => c.only === null || c.only.includes(name)).map((c) => c.at);
  const gaps = (times: number[]) => times.slice(1).map((at, i) => at - times[i]);
  const tree = timesOf('tree');
  const traffic = timesOf('traffic');
  assert.ok(gaps(tree).every((gap) => gap >= 1000), `tree gaps ${gaps(tree)}`);
  assert.ok(tree.filter((at) => at >= start && at < start + 3000).length <= 4, `tree inside the burst: ${tree.map((at) => at - start)}`);
  assert.ok(gaps(traffic).every((gap) => gap >= 5000), `traffic gaps ${gaps(traffic)}`);
  assert.ok(traffic.length >= 3, 'the derived passes still recompute traffic');
  const inBurst = (name: string) => calls.filter((c) => c.only !== null && c.only.includes(name) && c.at >= start && c.at < start + 3000).length;
  assert.ok(inBurst('gates') >= 14, `gates every debounce: ${inBurst('gates')}`);
  assert.ok(inBurst('sessions') >= 14, `sessions every debounce: ${inBurst('sessions')}`);
});

test('161 IC-001: a layers channel for a project key the index does not know is gone after one refresh', async (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const f = fixture(t);
  const a = project(f, 'proj-u');
  const clock = fakeClock();
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: a, env: f.env,
    stdin, stdout, stderr, clock, watch: fakeWatch(), signals: new EventEmitter(), epoch: '0a1b2c3d',
    projectsIndex: indexFor(f, a, () => clock.now()),
  });
  const unknown = 'f'.repeat(16);
  stdin.json('sub', `layers:${unknown}`);
  await settle();
  assert.deepEqual(layersOf(stdout.frames(), unknown).map((frame) => frame.type), ['gone'], stdout.text + stderr.text);
  stdin.emit('end');
  assert.equal(await done, 0);
});
