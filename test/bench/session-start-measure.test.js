'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureSessionStart, runHookProcess } = require('../../bench/perf/lib/session-start.js');
const { computeStartupContext } = require('../../bench/perf/lib/context.js');
const { tempDir } = require('../helper/tmp');

const FIXTURE_TREE = path.resolve(__dirname, '../fixtures/session-start-tree');

test('session-start-measure: drives counting code against test/fixtures/session-start-tree with no install', () => {
  const claude = measureSessionStart('claude', { homeDir: FIXTURE_TREE });
  assert.equal(claude.stdoutBytes, 32);
  assert.equal(claude.stderrBytes, 12);

  const codex = measureSessionStart('codex', { homeDir: FIXTURE_TREE });
  assert.equal(codex.stdoutBytes, 32);
  assert.equal(codex.stderrBytes, 0);

  const gemini = measureSessionStart('gemini', { homeDir: FIXTURE_TREE });
  assert.equal(gemini.stdoutBytes, 32);
  assert.equal(gemini.stderrBytes, 0);
});

test('session-start-measure: counts stdout and stderr bytes separately', () => {
  const claude = measureSessionStart('claude', { homeDir: FIXTURE_TREE });
  assert.equal(claude.stdoutBytes, 32);
  assert.equal(claude.stderrBytes, 12);
  assert.notEqual(claude.stdoutBytes, claude.stdoutBytes + claude.stderrBytes);
});

test('session-start-measure control: adding stderr bytes into stdout fails', () => {
  const claude = measureSessionStart('claude', { homeDir: FIXTURE_TREE });
  const corruptedStdout = claude.stdoutBytes + claude.stderrBytes;
  assert.throws(
    () => {
      assert.equal(corruptedStdout, 32, 'corrupted stdout adding stderr must not equal true stdout');
    },
    /AssertionError/
  );
});

test('session-start-measure control: a stub hook exiting 1 gives hook failed with exit code 1', () => {
  const kiro = measureSessionStart('kiro', { homeDir: FIXTURE_TREE });
  assert.deepEqual(kiro.stdoutBytes, { unmeasured: 'hook failed with exit code 1' });
  assert.deepEqual(kiro.stderrBytes, { unmeasured: 'hook failed with exit code 1' });
});

test('session-start-measure: successful hook that ignores stdin is still measured after EPIPE', (t) => {
  const homeDir = tempDir(t, 'doflow-session-start-epipe-');
  const hookPath = path.join(homeDir, 'ignore-stdin.sh');
  fs.writeFileSync(hookPath, '#!/bin/sh\nprintf out\nprintf err >&2\n', 'utf8');
  fs.chmodSync(hookPath, 0o755);

  const measured = runHookProcess(hookPath, {
    cwd: homeDir,
    homeDir,
    fixtureStdin: 'x'.repeat(1024 * 1024),
  });
  assert.equal(measured.stdoutBytes, 3);
  assert.equal(measured.stderrBytes, 3);
});

test('session-start-measure: unmeasured reason - no session-start hook for opencode, pi, copilot, antigravity', () => {
  for (const h of ['opencode', 'pi', 'copilot', 'antigravity']) {
    const res = measureSessionStart(h, { homeDir: FIXTURE_TREE });
    assert.deepEqual(res.stdoutBytes, { unmeasured: 'no session-start hook' });
    assert.deepEqual(res.stderrBytes, { unmeasured: 'no session-start hook' });
  }
});

test('session-start-measure: unmeasured reason - jq not on PATH', () => {
  const res = measureSessionStart('claude', { homeDir: FIXTURE_TREE, isJqAvailableFn: () => false });
  assert.deepEqual(res.stdoutBytes, { unmeasured: 'jq not on PATH' });
  assert.deepEqual(res.stderrBytes, { unmeasured: 'jq not on PATH' });
});

test('session-start-measure: unmeasured reason - install failed: <exit>', () => {
  const res = measureSessionStart('claude', { installFn: () => ({ status: 2 }) });
  assert.deepEqual(res.stdoutBytes, { unmeasured: 'install failed: 2' });
  assert.deepEqual(res.stderrBytes, { unmeasured: 'install failed: 2' });
});

test('session-start-measure: computeStartupContext drives measurement on session-start-tree with IC-019 schema', () => {
  const result = computeStartupContext({ homeDir: FIXTURE_TREE, harnesses: ['claude', 'kiro', 'opencode'] });
  assert.equal(result.length, 3);

  const cl = result.find((r) => r.harness === 'claude');
  assert.equal(cl.sessionStartStdoutBytes, 32);
  assert.equal(cl.sessionStartStderrBytes, 12);
  assert.equal(cl.sessionStartBasis, 'measured:temp-home-install');
  assert.deepEqual(cl.perPromptStdoutBytes, { unmeasured: 'owner 077' });

  const ki = result.find((r) => r.harness === 'kiro');
  assert.deepEqual(ki.sessionStartStdoutBytes, { unmeasured: 'hook failed with exit code 1' });
  assert.deepEqual(ki.sessionStartStderrBytes, { unmeasured: 'hook failed with exit code 1' });
  assert.equal(ki.sessionStartBasis, 'measured:temp-home-install');
  assert.deepEqual(ki.perPromptStdoutBytes, { unmeasured: 'owner 077' });

  const op = result.find((r) => r.harness === 'opencode');
  assert.deepEqual(op.sessionStartStdoutBytes, { unmeasured: 'no session-start hook' });
  assert.deepEqual(op.sessionStartStderrBytes, { unmeasured: 'no session-start hook' });
  assert.equal(op.sessionStartBasis, 'measured:temp-home-install');
  assert.deepEqual(op.perPromptStdoutBytes, { unmeasured: 'owner 077' });
});
