'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// FU-b6xtmh (row 120 IC-005 Lifetime): the Claude and Codex SessionEnd hooks remove the ending main
// session's hashed model observation and nothing else. The observation path is the one
// observe-model.sh writes: primary/<cwd_hash>/<harness>/<first 16 hex of sha256(session id)>.json.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const POSIX = process.platform !== 'win32';
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const SKIP = { skip: !POSIX || !HAS_JQ };
const DOORS: any = [
  { harness: 'claude', door: '.claude/hooks/session-end.sh' },
  { harness: 'codex', door: '.codex/hooks/session-end.impl.sh' },
];
const key = (session: string) => crypto.createHash('sha256').update(session).digest('hex').slice(0, 16);

let MIRROR: any = null;
const mirror = () => (MIRROR ??= buildInstallMirror(path.join(suiteTempDir('doflow-session-end-obs-'), 'm')));

function world(t: any, harness: string) {
  const home = tempDir(t, 'doflow-session-end-home-');
  const cwd = fs.realpathSync(tempDir(t, 'doflow-session-end-cwd-'));
  const store = path.join(home, '.config', 'doflow', 'session-env');
  const observe = (session: string, atCwd = cwd, h = harness) => {
    const file = path.join(store, 'primary', cwdHash(atCwd), h, `${key(session)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 1, harness: h, model: 'm', event: 'PreToolUse', observedAt: '2026-11-04T00:00:00Z', session: key(session) })}\n`);
    return file;
  };
  const worker = path.join(store, 'worker-model', 'L.r1.main.1.json');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, '{"schema":1}\n');
  const run = (door: string, session: string | null, env: any = {}) => spawnSync(bashPath(), [path.join(mirror(), door)], {
    cwd, input: JSON.stringify({ hook_event_name: 'SessionEnd', ...(session === null ? {} : { session_id: session }), cwd }),
    env: { PATH: process.env.PATH, HOME: home, DOFLOW_TELEMETRY: 'off', ...env }, encoding: 'utf8',
  });
  return { home, cwd, store, observe, worker, run };
}

for (const { harness, door } of DOORS) {
  test(`${harness} SessionEnd removes only the ending main session's observation`, SKIP, (t) => {
    const w = world(t, harness);
    const ending = w.observe('ending-session');
    const other = w.observe('other-session');
    const otherCwd = w.observe('ending-session', fs.realpathSync(tempDir(t, 'doflow-session-end-other-cwd-')));
    const otherHarness = w.observe('ending-session', w.cwd, harness === 'claude' ? 'codex' : 'claude');
    const result = w.run(door, 'ending-session');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(ending), false, 'the ending session observation is gone');
    for (const kept of [other, otherCwd, otherHarness, w.worker]) assert.equal(fs.existsSync(kept), true, `${path.relative(w.store, kept)} is preserved`);
  });

  test(`${harness} SessionEnd tolerates a missing record, a missing session id and a link in place of the file`, SKIP, (t) => {
    const w = world(t, harness);
    assert.equal(w.run(door, 'never-observed').status, 0, 'no record');
    const kept = w.observe('someone');
    assert.equal(w.run(door, null).status, 0, 'no session id');
    assert.equal(fs.existsSync(kept), true);
    const link = w.observe('linked');
    const target = path.join(w.home, 'target.json');
    fs.writeFileSync(target, 'x');
    fs.rmSync(link); fs.symlinkSync(target, link);
    assert.equal(w.run(door, 'linked').status, 0);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a link is never followed or removed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  });

  test(`${harness} SessionEnd in a worker session leaves the main observation alone`, SKIP, (t) => {
    const w = world(t, harness);
    const mine = w.observe('ending-session');
    const result = w.run(door, 'ending-session', { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(mine), true);
    assert.equal(fs.existsSync(w.worker), true);
  });
}

test('coverage records the SessionEnd door for exactly the harnesses whose hook is wired', () => {
  const lifecycle = JSON.parse(fs.readFileSync(path.join(__dirname, '../../core/registry/lifecycle.json'), 'utf8'));
  const rows = lifecycle.coverage.rows.filter((r: any) => r.policy === 'session-end');
  assert.deepEqual(rows.filter((r: any) => r.wired).map((r: any) => `${r.harness}/${r.event}`).sort(), ['claude/SessionEnd', 'codex/SessionEnd']);
  assert.deepEqual(rows.filter((r: any) => !r.wired).map((r: any) => r.class), ['unsupported', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
  for (const [harness, file] of [['claude', 'core/harnesses/claude/settings/settings.json'], ['codex', 'core/harnesses/codex/hooks/hooks.json']]) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'));
    assert.ok(config.hooks.SessionEnd.some((g: any) => g.hooks.some((h: any) => h.command.includes('session-end'))), `${harness} wires SessionEnd to session-end`);
  }
});
