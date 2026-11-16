'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Row 165 owner ruling C-7: a started session (worker run kind `main-session`, launched with DOFLOW_STARTED_RUN=<runId>)
// and the main session its harness's own SessionStart hook records are ONE tree node. The hook path is the real one
// (bridge.sh, which runs observe-model.sh and the shared session-context.sh policy) under a scratch HOME and config home;
// the run store is hand-written as `worker --action start-session` writes it. No harness CLI runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { buildTree } = require('../../src/runtime/fleet/tree.ts');

const REPO = path.resolve(__dirname, '../..');
const BRIDGE = path.join(REPO, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // GUARD: needs bash + jq
const RUN = 'w-5555555555ee';
const SESSION = 'c7-started-session-RAWID-1';
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const workerKey = (runId: string) => sha16(`worker:${runId}`);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function env(f: any, extra: any = {}): any {
  return {
    HOME: f.home, XDG_CONFIG_HOME: f.config, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off',
    CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '', DOFLOW_PROJECT_DIR: '', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '',
    ...extra,
  };
}

function world(t: any) {
  clearCheckoutCache();
  const root = tempDir(t, 'doflow-started-join-');
  const f: any = { home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  fs.mkdirSync(f.home);
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  fs.mkdirSync(path.join(f.main, '.doflow', 'state'), { recursive: true });
  git(f.main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.main, 'a.txt'), 'a\n');
  git(f.main, 'add', '-A');
  git(f.main, 'commit', '-q', '-m', 'first');
  f.top = fs.realpathSync(f.main);
  f.sessions = path.join(f.config, 'doflow', 'session-env', 'sessions');
  return f;
}

/** Runs in the started-sessions store as `worker --action start-session` writes them (165 IC-003), plus any extra runs. */
function startedRuns(f: any, list: Array<{ runId: string; harness: string; kind?: string }>) {
  const runs: any = {};
  for (const { runId, harness, kind = 'main-session' } of list) {
    runs[runId] = {
      runId, ...(kind ? { kind } : {}), task: kind || 'A.1', token: 1, seq: 1, request: 'r'.repeat(22), childOf: null, harness, phase: 'running',
      createdAt: '2026-11-15T01:00:00.000Z', startedAt: '2026-11-15T01:00:02.000Z', startedBy: 'device.d-0123456789ab',
      project: { projectKey: cwdHash(f.top), worktreeKey: cwdHash(f.top) }, binding: { model: `${harness}-start-9`, source: 'catalogue' }, supervisor: { pid: 5, start: 'x' },
    };
  }
  const dir = path.join(f.main, '.doflow', 'state', 'worker-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'started-sessions.json'), JSON.stringify({ slug: 'started-sessions', runs }));
}

/** The real SessionStart recording path for claude: bridge.sh runs observe-model.sh and session-context.sh. */
function sessionStart(f: any, sessionId: string, startedRun?: string) {
  const native = { hook_event_name: 'SessionStart', session_id: sessionId, model: 'claude-observed-1', cwd: f.top, source: 'startup' };
  const extra: any = { DOFLOW_AGENT: 'claude' };
  if (startedRun !== undefined) extra.DOFLOW_STARTED_RUN = startedRun;
  const r = spawnSync(bashPath(), [BRIDGE, 'claude', 'SessionStart', 'session-context'], { cwd: f.top, env: env(f, extra), input: JSON.stringify(native), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(f.sessions, sessionId, 'git-context.json');
  assert.ok(fs.existsSync(file), 'session-context wrote the session record');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const tree = (f: any) => {
  clearCheckoutCache();
  const built = buildTree({ env: env(f), cwd: f.main, alive: () => true });
  assert.equal(built.ok, true);
  return built.body;
};

HOOK_TEST('a session-start record with DOFLOW_STARTED_RUN joins its started run: the tree has one node', (t) => {
  const f = world(t);
  startedRuns(f, [{ runId: RUN, harness: 'claude' }]);
  const context = sessionStart(f, SESSION, RUN);
  assert.equal(context.started_run, RUN, 'the hook records the started run id');
  const body = tree(f);
  assert.equal(body.nodes.length, 1, `one node, got ${body.nodes.map((n: any) => `${n.kind}:${n.agentKey}`).join(', ')}`);
  const [n] = body.nodes;
  assert.deepEqual([n.agentKey, n.kind, n.harness, n.model, n.modelBasis, n.phase], [workerKey(RUN), 'started-session', 'claude', 'claude-start-9', 'start-record', 'running']);
  const rel = (stream: string) => `.doflow/state/worker-output/${RUN}.${stream}.log`;
  assert.deepEqual(n.fileKeys, { out: sha16(`${f.main}\0${rel('out')}`), err: sha16(`${f.main}\0${rel('err')}`) }, 'the run keeps its file keys');
  assert.equal(n.observed.state, 'observed');
  assert.deepEqual([n.observed.sessionKey, n.observed.model], [sha16(SESSION), 'claude-observed-1']);
  assert.match(n.observed.lastSeenAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(n.contextCapturedAt, /^\d{4}-\d\d-\d\dT/, 'the joined node carries the session context time like a main-session node');
  assert.equal(body.nodes.filter((x: any) => x.kind === 'main-session').length, 0, 'the observed session is not a node of its own');
  const json = JSON.stringify(body);
  assert.ok(!json.includes(SESSION) && !json.includes(f.top), 'no raw session id or path');
  assert.equal(json.split(RUN).length, 2, '165 F2: the run id appears once, as the started-session node\'s own runId');
});

HOOK_TEST('an invalid DOFLOW_STARTED_RUN value is not recorded, and the session still records', (t) => {
  const f = world(t);
  const bad = ['', 'w-5555555555EE', 'w-5555555555e', 'w-5555555555eee', ' w-5555555555ee', 'w-5555555555ee ', 'w-5555555555ee\nx', '../w-5555555555ee', 'x-5555555555ee', '"w-5555555555ee"'];
  bad.forEach((value, i) => {
    const context = sessionStart(f, `c7-bad-${i}`, value);
    assert.equal('started_run' in context, false, `not recorded: ${JSON.stringify(value)}`);
  });
  const none = sessionStart(f, 'c7-unset');
  assert.equal('started_run' in none, false, 'unset: not recorded');
});

test('a started run of a harness without a session hook is one node that says not observed, no-session-hook', (t) => {
  const f = world(t);
  startedRuns(f, [{ runId: RUN, harness: 'opencode' }, { runId: 'w-7777777777aa', harness: 'claude' }]);
  const body = tree(f);
  assert.equal(body.nodes.length, 2);
  assert.deepEqual(body.nodes.find((n: any) => n.agentKey === workerKey(RUN)).observed, { state: 'not-observed', reason: 'no-session-hook' });
  assert.deepEqual(body.nodes.find((n: any) => n.agentKey === workerKey('w-7777777777aa')).observed, { state: 'not-observed', reason: 'not-yet-observed' }, 'claude has the hook: not yet observed');
});

HOOK_TEST('a session record whose run id names no started run is a normal session node', (t) => {
  const f = world(t);
  startedRuns(f, [{ runId: RUN, harness: 'claude' }, { runId: 'w-8888888888bb', harness: 'claude', kind: '' }]);
  sessionStart(f, 'c7-no-such-run', 'w-999999999999');
  sessionStart(f, 'c7-ordinary-run', 'w-8888888888bb'); // an ordinary worker run, not a started session
  const body = tree(f);
  const mains = body.nodes.filter((n: any) => n.kind === 'main-session').map((n: any) => n.agentKey).sort();
  assert.deepEqual(mains, [sha16('claude:c7-no-such-run'), sha16('claude:c7-ordinary-run')].sort());
  assert.deepEqual(body.nodes.find((n: any) => n.agentKey === workerKey(RUN)).observed, { state: 'not-observed', reason: 'not-yet-observed' });
  assert.equal(body.nodes.find((n: any) => n.agentKey === workerKey('w-8888888888bb')).kind, 'worker-run');
  assert.equal('observed' in body.nodes.find((n: any) => n.agentKey === workerKey('w-8888888888bb')), false, 'an ordinary run has no observed field');
});

HOOK_TEST('two session records naming one started run: the earliest captured joins, the other stays its own node', (t) => {
  const f = world(t);
  startedRuns(f, [{ runId: RUN, harness: 'claude' }]);
  sessionStart(f, 'c7-first', RUN);
  sessionStart(f, 'c7-second', RUN);
  const ctx = (id: string) => path.join(f.sessions, id, 'git-context.json');
  const rewrite = (id: string, at: string) => fs.writeFileSync(ctx(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(ctx(id), 'utf8')), captured_at: at }));
  rewrite('c7-first', '2026-11-15T01:00:03Z');
  rewrite('c7-second', '2026-11-15T01:00:09Z');
  const body = tree(f);
  assert.equal(body.nodes.length, 2);
  assert.equal(body.nodes.find((n: any) => n.agentKey === workerKey(RUN)).observed.sessionKey, sha16('c7-first'));
  assert.match(body.nodes.find((n: any) => n.agentKey === workerKey(RUN)).contextCapturedAt, /^2026-11-15T01:00:03/, 'the earliest context time, not the later one');
  assert.ok(body.nodes.find((n: any) => n.agentKey === sha16('claude:c7-second') && n.kind === 'main-session'));
});
