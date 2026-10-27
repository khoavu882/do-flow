'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const { test, after }: any = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { encodeEnvelope } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const LIB = path.join(REPO, 'core/harnesses/shared/hooks/policies/lib.sh');
const PROJECT_DISPATCHER = '.doflow/scripts/doflow/bin/doflow-run';
const CONFIG_DISPATCHER = 'scripts/doflow/bin/doflow-run';
const GLOBAL_DISPATCHER = '.doflow/scripts/doflow/bin/doflow-run';
const scratch = createScratch('doflow-storage-hook-');
const MIRROR = path.join(scratch.dir, 'mirror');
const POLICY = path.join(MIRROR, '.doflow/shared/hooks/policies/session-context.sh');
const SESSION_END = [
  path.join(MIRROR, '.claude/hooks/session-end.sh'),
  path.join(MIRROR, '.codex/hooks/session-end.impl.sh'),
];
test.before(() => {
  const built = spawnSync(bashPath(), [path.join(REPO, 'test/hooks/build-install-mirror.sh'), MIRROR], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
});
after(() => scratch.remove());

test('session hooks launch asynchronous storage upkeep through the first available dispatcher', { skip: process.platform === 'win32' }, async (t: any) => {
  const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project, { recursive: true });
  const git = (...args: any[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  for (const args of [['init', '-q'], ['config', 'user.name', 'DoFlow test'], ['config', 'user.email', 'doflow-test@example.invalid'], ['commit', '--allow-empty', '-qm', 'baseline']]) {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
  }
  const projectDispatcher = path.join(project, PROJECT_DISPATCHER);
  const configDispatcher = path.join(scratch.home, '.claude', CONFIG_DISPATCHER);
  const globalDispatcher = path.join(scratch.home, GLOBAL_DISPATCHER);
  fs.mkdirSync(path.dirname(projectDispatcher), { recursive: true });
  fs.mkdirSync(path.dirname(configDispatcher), { recursive: true });
  fs.mkdirSync(path.dirname(globalDispatcher), { recursive: true });

  const record = path.join(scratch.dir, 'dispatcher-record');
  const makeDispatcher = (file: any, label: any) => {
    // Written to a temp file and renamed into place: `> "$STORAGE_TEST_RECORD"` creates the file
    // before printf fills it, so awaitRecord could read it empty or half-written.
    fs.writeFileSync(file, `#!/bin/bash\nsleep 2\nprintf '%s\\n%s\\n%s\\n' ${JSON.stringify(label)} "$*" "$PWD" > "$STORAGE_TEST_RECORD.tmp.$$"\nmv -f "$STORAGE_TEST_RECORD.tmp.$$" "$STORAGE_TEST_RECORD"\n`);
    fs.chmodSync(file, 0o755);
  };
  makeDispatcher(projectDispatcher, 'project');
  makeDispatcher(configDispatcher, 'claude-config');
  makeDispatcher(globalDispatcher, 'global-home');

  const payload = (sessionId: any) => encodeEnvelope('claude', 'SessionStart', 'session-context', JSON.stringify({ session_id: sessionId, cwd: project, source: 'startup' }));
  function runHook(script: any, sessionId: any, env = scratch.env({ STORAGE_TEST_RECORD: record })) {
    const started = Date.now();
    const result = spawnSync(bashPath(), [script], { input: payload(sessionId), cwd: project, env, encoding: 'utf8' });
    return { ...result, elapsedMs: Date.now() - started };
  }
  async function awaitRecord() {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (fs.existsSync(record)) return fs.readFileSync(record, 'utf8').trim().split('\n');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('the background dispatcher did not record its invocation');
  }
  function clearRecord() { try { fs.unlinkSync(record); } catch {} }
  function assertHangBound(result: any) {
    // DEC-022: this is a hang bound, not a latency judgement.
    assert.ok(result.elapsedMs < 10000, `hook exceeded the hang bound after ${result.elapsedMs}ms`);
  }
  function assertSilent(result: any, baseline: any) {
    assert.equal(result.status, baseline.status);
    assert.equal(result.stdout, baseline.stdout);
    assert.equal(result.stderr, baseline.stderr);
    assertHangBound(result);
  }
  function baselineEnv() {
    const home = path.join(scratch.dir, 'baseline-home');
    const xdg = path.join(scratch.dir, 'baseline-xdg');
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(xdg, { recursive: true });
    return scratch.env({ HOME: home, XDG_CONFIG_HOME: xdg, STORAGE_TEST_RECORD: record });
  }

  await t.test('project dispatcher wins over both home candidates; each hook launches once and silently', async () => {
    const scripts = [POLICY, ...SESSION_END];
    for (const [index, script] of scripts.entries()) {
      const disabledProjectDispatcher = `${projectDispatcher}.baseline-disabled`;
      fs.renameSync(projectDispatcher, disabledProjectDispatcher);
      let base;
      try {
        base = spawnSync(bashPath(), [script], { input: payload(`baseline-${index}`), cwd: project, env: baselineEnv(), encoding: 'utf8' });
      } finally { fs.renameSync(disabledProjectDispatcher, projectDispatcher); }
      try {
        const result = runHook(script, `active-${index}`);
        assertSilent(result, base);
        const [label, argv, cwd] = await awaitRecord();
        assert.equal(label, 'project');
        assert.equal(argv, 'storage --action upkeep');
        assert.equal(cwd, project);
      } finally { clearRecord(); }
    }
  });

  await t.test('fallback order is CLAUDE_CONFIG_DIR then HOME when earlier candidates are absent', async () => {
    fs.rmSync(projectDispatcher);
    const configured = path.join(scratch.dir, 'claude-config');
    fs.mkdirSync(configured, { recursive: true });
    const configCandidate = path.join(configured, CONFIG_DISPATCHER);
    fs.mkdirSync(path.dirname(configCandidate), { recursive: true }); makeDispatcher(configCandidate, 'explicit-claude-config');
    try {
      const configuredResult = runHook(POLICY, 'config-order', scratch.env({ CLAUDE_CONFIG_DIR: configured, STORAGE_TEST_RECORD: record }));
      assertHangBound(configuredResult);
      const configRecord = await awaitRecord(); assert.equal(configRecord[0], 'explicit-claude-config');
    } finally { clearRecord(); }

    fs.rmSync(configCandidate);
    fs.rmSync(configDispatcher);
    try {
      const homeResult = runHook(POLICY, 'home-order');
      assertHangBound(homeResult);
      const homeRecord = await awaitRecord(); assert.equal(homeRecord[0], 'global-home');
      assert.equal(homeRecord[1], 'storage --action upkeep');
    } finally { clearRecord(); }
  });

  await t.test('no candidate launches nothing, sourcing lib is silent, and Codex SessionStart stdout stays unchanged', async () => {
    fs.rmSync(globalDispatcher);
    const noCandidate = path.join(scratch.dir, 'no-candidate'); fs.mkdirSync(noCandidate);
    const env = scratch.env({ HOME: noCandidate, XDG_CONFIG_HOME: path.join(scratch.dir, 'empty-xdg'), STORAGE_TEST_RECORD: record });
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    const native = payload('no-candidate');
    const result = spawnSync(bashPath(), [POLICY], { input: encodeEnvelope('claude', 'SessionStart', 'session-context', native), cwd: project, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(record), false);

    const source = spawnSync(bashPath(), ['-c', 'source "$1"', 'bash', LIB], { env, encoding: 'utf8' });
    assert.equal(source.status, 0, source.stderr); assert.equal(source.stdout, ''); assert.equal(source.stderr, '');

    const codexStart = path.join(MIRROR, '.codex/hooks/session-start.sh');
    const codexHome = path.join(scratch.dir, 'codex-home'); fs.mkdirSync(codexHome, { recursive: true });
    const codexXdg = path.join(scratch.dir, 'codex-xdg'); fs.mkdirSync(codexXdg, { recursive: true });
    const codexEnv = scratch.env({ HOME: codexHome, XDG_CONFIG_HOME: codexXdg, STORAGE_TEST_RECORD: record });
    const codexBaseline = runHook(codexStart, 'codex-start-baseline', codexEnv);
    assert.equal(codexBaseline.status, 0, codexBaseline.stderr);
    assert.equal(codexBaseline.stdout, '');
    assert.equal(codexBaseline.stderr, '');

    const codexHomeDispatcher = path.join(codexHome, GLOBAL_DISPATCHER);
    fs.mkdirSync(path.dirname(codexHomeDispatcher), { recursive: true });
    makeDispatcher(codexHomeDispatcher, 'codex-session-start');
    try {
      const codex = runHook(codexStart, 'codex-start', codexEnv);
      assertSilent(codex, codexBaseline);
      const [label, argv, cwd] = await awaitRecord(); assert.equal(label, 'codex-session-start'); assert.equal(argv, 'storage --action upkeep'); assert.equal(cwd, project);
    } finally { clearRecord(); }
  });
});

test('a session started in a subdirectory runs upkeep from the project root (G.3 B3)', { skip: process.platform === 'win32' }, async () => {
  const project = path.join(scratch.dir, 'subdir-project'), sub = path.join(project, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const init = spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const record = path.join(scratch.dir, 'subdir-record');
  const dispatcher = path.join(project, PROJECT_DISPATCHER);
  fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
  fs.writeFileSync(dispatcher, `#!/bin/bash\nprintf '%s\\n' "$PWD" > "$STORAGE_TEST_RECORD.tmp.$$"\nmv -f "$STORAGE_TEST_RECORD.tmp.$$" "$STORAGE_TEST_RECORD"\n`);   // atomic, as above
  fs.chmodSync(dispatcher, 0o755);
  const result = spawnSync(bashPath(), [POLICY], {
    input: encodeEnvelope('claude', 'SessionStart', 'session-context', JSON.stringify({ session_id: 'subdir', cwd: sub, source: 'startup' })), cwd: sub,
    env: scratch.env({ STORAGE_TEST_RECORD: record }), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const until = Date.now() + 5000;
  while (!fs.existsSync(record) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.readFileSync(record, 'utf8').trim(), project);
});

// FU-0rgk31: the detached upkeep leaves the hook's session when setsid exists, so a harness that
// kills the hook's process group on exit does not take the upkeep with it. macOS has no setsid.
function sourceUpkeep(extraPath: any, projectDir: any, record: any) {
  return spawnSync(bashPath(), ['-c', 'source "$1" && storage_upkeep_async "$2"', 'bash', LIB, projectDir], {
    env: scratch.env({ PATH: `${extraPath}${extraPath ? path.delimiter : ''}${process.env.PATH}`, STORAGE_TEST_RECORD: record }), encoding: 'utf8',
  });
}
async function waitFor(file: any) {
  const until = Date.now() + 5000;
  while (!fs.existsSync(file) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  return fs.existsSync(file);
}
function upkeepFixture(name: any) {
  const project = path.join(scratch.dir, name); fs.mkdirSync(project, { recursive: true });
  const dispatcher = path.join(project, PROJECT_DISPATCHER);
  fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
  fs.writeFileSync(dispatcher, `#!/bin/bash\nprintf '%s\\n' "$*" > "$STORAGE_TEST_RECORD.tmp.$$"\nmv -f "$STORAGE_TEST_RECORD.tmp.$$" "$STORAGE_TEST_RECORD"\n`);
  fs.chmodSync(dispatcher, 0o755);
  return { project, record: path.join(scratch.dir, `${name}-record`) };
}

test('detached upkeep runs under setsid when setsid is on PATH', { skip: process.platform === 'win32' }, async () => {
  const { project, record } = upkeepFixture('setsid-present');
  const bin = path.join(scratch.dir, 'setsid-bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'setsid'), `#!/bin/bash\nprintf '%s\\n' "$*" > "$STORAGE_TEST_RECORD.setsid"\nexec "$@"\n`);
  fs.chmodSync(path.join(bin, 'setsid'), 0o755);
  const result = sourceUpkeep(bin, project, record);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(await waitFor(`${record}.setsid`), 'upkeep was not launched through setsid');
  assert.match(fs.readFileSync(`${record}.setsid`, 'utf8'), /doflow-run storage --action upkeep/);
  assert.ok(await waitFor(record), 'the dispatcher did not run behind setsid');
  assert.equal(fs.readFileSync(record, 'utf8').trim(), 'storage --action upkeep');
});

test('detached upkeep still runs when setsid is absent', { skip: process.platform === 'win32' || spawnSync(bashPath(), ['-c', 'command -v setsid']).status === 0 }, async () => {
  const { project, record } = upkeepFixture('setsid-absent');
  const result = sourceUpkeep('', project, record);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(await waitFor(record), 'the dispatcher did not run without setsid');
  assert.equal(fs.readFileSync(record, 'utf8').trim(), 'storage --action upkeep');
});
