'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Row 120 IC-005 Writer: the shared bridge step `observe-model` records `identity.model` in an
// observation file under the config home, and never changes the bridge's output or exit code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { MODEL_PAYLOADS } = require('../helper/hook-fixtures.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '../..');
const BRIDGE = path.join(REPO, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const POLICY = 'mcp-tool-guard';

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-observe-model-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { dir, home, cwd, store: path.join(home, '.config', 'doflow', 'session-env') };
}

function bridge(s: any, harness: string, { native, event, env = {}, cwd = s.cwd }: any = {}) {
  const fixture = MODEL_PAYLOADS[harness];
  const childEnv: any = { ...process.env, HOME: s.home, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_DECISION_FD: '', DOFLOW_BRIDGE_TRACE: '' };
  for (const name of ['XDG_CONFIG_HOME', 'DOFLOW_SESSION_ROLE', 'DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_WORKTREE', 'DOFLOW_TASK_ID']) delete childEnv[name];
  const result = spawnSync(bashPath(), [BRIDGE, harness, event || fixture.event, POLICY], {
    cwd, env: { ...childEnv, ...env }, input: JSON.stringify(native || fixture.native), encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function files(root: any) {
  const found: any[] = [];
  const walk = (dir: any) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

const sessionKey = (id: any) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

test('a codex payload writes one observation with exactly the six fields, mode 0600', (t) => {
  const s = scratch(t);
  const result = bridge(s, 'codex');
  assert.equal(result.status, 0, result.stderr);
  const key = sessionKey(MODEL_PAYLOADS.codex.native.session_id);
  const relative = path.join('primary', cwdHash(s.cwd), 'codex', `${key}.json`);
  assert.deepEqual(files(s.store).filter((f) => f.startsWith('primary')), [relative]);
  const file = path.join(s.store, relative);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(value), ['schema', 'harness', 'model', 'event', 'observedAt', 'session']);
  assert.equal(value.schema, 1);
  assert.equal(value.harness, 'codex');
  assert.equal(value.model, MODEL_PAYLOADS.codex.native.model);
  assert.equal(value.event, 'PreToolUse');
  assert.match(value.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(value.observedAt) - Date.now()) < 120000);
  assert.equal(value.session, key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // modes are not expressible on Windows
});

test('a repeated event with the same model does not rewrite the file; a changed model does', (t) => {
  const s = scratch(t);
  bridge(s, 'codex');
  const file = path.join(s.store, 'primary', cwdHash(s.cwd), 'codex', `${sessionKey(MODEL_PAYLOADS.codex.native.session_id)}.json`);
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, past, past);
  const before = fs.readFileSync(file, 'utf8');
  bridge(s, 'codex');
  assert.equal(fs.statSync(file).mtimeMs, past.getTime());
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  bridge(s, 'codex', { native: { ...MODEL_PAYLOADS.codex.native, model: 'gpt-5.2' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'gpt-5.2');
  assert.deepEqual(files(path.dirname(file)), [path.basename(file)], 'no tmp file is left behind');
});

test('a read-only store leaves stdout, stderr and the exit code identical and writes nothing', (t) => {
  const writable = scratch(t);
  const open = bridge(writable, 'codex');
  assert.equal(files(writable.store).length, 1);
  const locked = scratch(t);
  fs.mkdirSync(locked.store, { recursive: true });
  // Windows has no directory permission bits: there the two directories the writer would create are
  // regular files instead, which equally leaves nothing writable beneath them.
  const blockers = ['primary', 'worker-model'];
  if (process.platform === 'win32') for (const name of blockers) fs.writeFileSync(path.join(locked.store, name), '');
  else fs.chmodSync(locked.store, 0o500); // tempDir's removal restores owner write permission
  const denied = bridge(locked, 'codex');
  assert.deepEqual(denied, open);
  assert.deepEqual(files(locked.store), process.platform === 'win32' ? blockers : []);
  const noHome = bridge(locked, 'codex', { env: { HOME: '' } });
  assert.deepEqual(noHome, open, 'with no config home nothing is written and nothing changes');
});

test('role worker writes worker-model/L.<run>.<lineage>.<attempt>.json; an unlaunched worker writes nothing', (t) => {
  const s = scratch(t);
  bridge(s, 'codex', { env: { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'lin', DOFLOW_ATTEMPT: '2' } });
  assert.deepEqual(files(s.store), [path.join('worker-model', 'L.r1.lin.2.json')]);
  const value = JSON.parse(fs.readFileSync(path.join(s.store, 'worker-model', 'L.r1.lin.2.json'), 'utf8'));
  assert.equal(value.model, MODEL_PAYLOADS.codex.native.model);
  const solo = scratch(t);
  bridge(solo, 'codex', { env: { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1' } });
  assert.deepEqual(files(solo.store), []);
});

test('the shell cwdHash equals identity.ts cwdHash for the same path, a symlinked one included', (t) => {
  const s = scratch(t);
  const link = path.join(s.dir, 'link');
  fs.symlinkSync(s.cwd, link);
  bridge(s, 'codex', { native: { ...MODEL_PAYLOADS.codex.native, cwd: link } });
  const dirs = fs.readdirSync(path.join(s.store, 'primary'));
  assert.deepEqual(dirs, [cwdHash(link)]);
  assert.equal(cwdHash(link), cwdHash(s.cwd));
});

test('negative control: a kiro payload carrying a model writes nothing', (t) => {
  const s = scratch(t);
  const result = bridge(s, 'kiro');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(s.store), []);
});

// FU-v8reh7: Claude Code 2.1.311 runs SessionStart (source `compact`) when an in-session subagent
// compacts, under the parent's session_id, with the subagent's model and no agent_id. Codex puts
// agent_id and agent_type on a subagent's PreToolUse. Neither may become the main session's model.
const MAIN = 'parent-session-0001';
const claudeStart = (model: string, source: string, extra: any = {}) => ({
  hook_event_name: 'SessionStart', session_id: MAIN, transcript_path: `/t/${MAIN}.jsonl`, cwd: '', permission_mode: 'auto', source, model, ...extra,
});
const observation = (s: any, harness: string) => {
  const file = path.join(s.store, 'primary', cwdHash(s.cwd), harness, `${sessionKey(MAIN)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

test('a subagent compaction (claude SessionStart source compact) does not replace the main session model', (t) => {
  const s = scratch(t);
  bridge(s, 'claude', { native: { ...claudeStart('claude-fable-5-2', 'startup'), cwd: s.cwd } });
  assert.equal(observation(s, 'claude').model, 'claude-fable-5-2');
  bridge(s, 'claude', { native: { ...claudeStart('claude-sonnet-5-5', 'compact'), cwd: s.cwd } });
  const value = observation(s, 'claude');
  assert.equal(value.model, 'claude-fable-5-2');
  assert.equal(value.event, 'SessionStart');
});

test('a compaction with no record yet is written as SessionStart:compact, which the reader does not confirm', (t) => {
  const s = scratch(t);
  bridge(s, 'claude', { native: { ...claudeStart('claude-opus-5-5', 'compact'), cwd: s.cwd } });
  const value = observation(s, 'claude');
  assert.equal(value.model, 'claude-opus-5-5');
  assert.equal(value.event, 'SessionStart:compact');
  // The next main-session start confirms it, even with the same model.
  bridge(s, 'claude', { native: { ...claudeStart('claude-opus-5-5', 'resume'), cwd: s.cwd } });
  assert.deepEqual([observation(s, 'claude').model, observation(s, 'claude').event], ['claude-opus-5-5', 'SessionStart']);
});

test('an event carrying agent_id (codex subagent PreToolUse) records nothing and changes nothing', (t) => {
  const s = scratch(t);
  const sub = { ...MODEL_PAYLOADS.codex.native, session_id: MAIN, cwd: s.cwd, model: 'gpt-6-luna', agent_id: 'agent-1', agent_type: 'worker' };
  bridge(s, 'codex', { native: sub });
  assert.equal(observation(s, 'codex'), null);
  bridge(s, 'codex', { native: { ...sub, agent_id: undefined, agent_type: undefined, model: 'gpt-6.1-sol' } });
  bridge(s, 'codex', { native: sub });
  assert.equal(observation(s, 'codex').model, 'gpt-6.1-sol');
  bridge(s, 'claude', { native: { ...claudeStart('claude-sonnet-5-5', 'startup'), cwd: s.cwd, agent_id: 'a1' } });
  assert.equal(observation(s, 'claude'), null);
});

test('a wrong record left on disk heals on the next main-session event, and a compaction does not re-break it', (t) => {
  const s = scratch(t);
  const dir = path.join(s.store, 'primary', cwdHash(s.cwd), 'claude');
  fs.mkdirSync(dir, { recursive: true });
  // The record a subagent compaction wrote before this fix: indistinguishable from a main one.
  fs.writeFileSync(path.join(dir, `${sessionKey(MAIN)}.json`), `${JSON.stringify({ schema: 1, harness: 'claude', model: 'claude-sonnet-5-5', event: 'SessionStart', observedAt: '2026-11-15T05:41:45Z', session: sessionKey(MAIN) })}\n`);
  bridge(s, 'claude', { native: { ...claudeStart('claude-opus-5-5', 'compact'), cwd: s.cwd } });
  assert.equal(observation(s, 'claude').model, 'claude-sonnet-5-5', 'a compaction never replaces a non-compaction record');
  bridge(s, 'claude', { native: { ...claudeStart('claude-fable-5-2', 'resume'), cwd: s.cwd } });
  assert.equal(observation(s, 'claude').model, 'claude-fable-5-2');
  bridge(s, 'claude', { native: { ...claudeStart('claude-sonnet-5-5', 'compact'), cwd: s.cwd } });
  assert.equal(observation(s, 'claude').model, 'claude-fable-5-2');
});
