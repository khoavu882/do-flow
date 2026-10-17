'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { buildInstallMirror } = require('../helper/hook-fixtures');

const REPO = path.resolve(__dirname, '../..');
const BENCH_FIXTURE = path.join(REPO, 'bench/perf/fixtures/hook-bridge-project');
const TELEMETRY = '.doflow/state/runs/telemetry';
const BASH = '/bin/bash';
const SURFACES = [
  { id: 'claude:pre-bash-guard', harness: 'claude', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.claude/hooks/pre-bash-guard.sh', fixture: 'claude/pre-bash-guard/perf.json' },
  { id: 'codex:pre-bash-guard', harness: 'codex', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.codex/hooks/pre-bash-guard.sh', fixture: 'codex/pre-bash-guard/perf.json' },
  { id: 'gemini:pre-bash-guard', harness: 'gemini', event: 'BeforeTool', policy: 'pre-bash-guard', door: '.gemini/hooks/pre-bash-guard.sh', fixture: 'gemini/pre-bash-guard/perf.json' },
  { id: 'kiro:pre-bash-guard', harness: 'kiro', event: 'PreToolUse', policy: 'pre-bash-guard', door: '.kiro/hooks/pre-bash-guard.sh', fixture: 'kiro/pre-bash-guard/perf.json' },
  { id: 'antigravity:pre-bash-guard', harness: 'antigravity', event: 'PreToolUse', policy: 'pre-bash-guard', runner: true, fixture: 'antigravity/pre-bash-guard/perf.json' },
  { id: 'pi:pre-bash-guard', harness: 'pi', event: 'tool_call', policy: 'pre-bash-guard', bridge: true, fixture: 'pi/tool_call/perf-bash.json' },
  { id: 'claude:user-prompt-submit', harness: 'claude', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.claude/hooks/user-prompt-submit.sh', fixture: 'claude/user-prompt-submit/perf.json' },
  { id: 'codex:user-prompt-submit', harness: 'codex', event: 'UserPromptSubmit', policy: 'user-prompt-submit', door: '.codex/hooks/user-prompt-submit.sh', fixture: 'codex/user-prompt-submit/perf.json' },
];

function replaceProject(value, root) {
  if (typeof value === 'string') return value.replaceAll('<project>', root);
  if (Array.isArray(value)) return value.map((item) => replaceProject(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceProject(item, root)]));
  }
  return value;
}

function fixtureNative(surface, root) {
  const fixturePath = path.join(REPO, 'test/fixtures/hooks', surface.fixture);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const native = replaceProject(fixture.native, root);
  if (Array.isArray(native.workspacePaths)) native.workspacePaths = [root];
  return native;
}

function environment(root, harness, mode, home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_') || key === 'EPOCHREALTIME') delete env[key];
  delete env.FORCE_COLOR;
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, 'xdg'), { recursive: true });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_TELEMETRY: mode,
    DOFLOW_AGENT: harness,
    DOFLOW_PROJECT_DIR: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

function run(mirror, root, surface, mode, home) {
  const fixture = fixtureNative(surface, root);
  const options = {
    cwd: root,
    input: `${JSON.stringify(fixture)}\n`,
    encoding: 'utf8',
    timeout: 30000,
    env: environment(root, surface.harness, mode, home),
  };
  let result;
  if (surface.runner) {
    result = spawnSync(process.execPath, [path.join(mirror, '.doflow/shared/hooks/stream-hook-runner.js'), surface.event], options);
  } else if (surface.bridge) {
    result = spawnSync(BASH, [path.join(mirror, '.doflow/shared/hooks/bridge/bridge.sh'), surface.harness, surface.event, surface.policy], options);
  } else {
    result = spawnSync(BASH, [path.join(mirror, surface.door)], options);
  }
  assert.equal(result.error, undefined, `${surface.id}/${mode}: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function telemetryLines(root) {
  const dir = path.join(root, TELEMETRY);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

function fixtureCopy(suite, name) {
  const root = path.join(suite, name);
  fs.mkdirSync(root);
  fs.cpSync(BENCH_FIXTURE, root, { recursive: true });
  return root;
}

test('perf hook fixture seeds the runs/telemetry directory', () => {
  const telemetry = path.join(BENCH_FIXTURE, TELEMETRY);
  assert.equal(fs.statSync(telemetry).isDirectory(), true);
  assert.equal(fs.statSync(path.join(telemetry, '.gitkeep')).isFile(), true);
});

test('perf hook fixture writes one ON line and zero OFF lines for the eight enumerated surfaces', (t) => {
  const suite = tempDir(t, 'doflow-perf-telemetry-fixture-');
  const mirror = path.join(suite, 'mirror');
  buildInstallMirror(mirror);
  for (const [index, surface] of SURFACES.entries()) {
    const onRoot = fixtureCopy(suite, `project-${index}-on`);
    const offRoot = fixtureCopy(suite, `project-${index}-off`);
    const on = run(mirror, onRoot, surface, 'on', path.join(suite, `home-${index}-on`));
    const off = run(mirror, offRoot, surface, 'off', path.join(suite, `home-${index}-off`));
    assert.equal(on.status, 0, `${surface.id}: ON exit`);
    assert.equal(off.status, 0, `${surface.id}: OFF exit`);
    assert.deepEqual(on, off, `${surface.id}: telemetry does not change hook output`);
    const onLines = telemetryLines(onRoot);
    const offLines = telemetryLines(offRoot);
    assert.equal(onLines.length, 1, `${surface.id}: ON writes one line`);
    assert.equal(onLines[0].kind, 'hook', `${surface.id}: telemetry kind`);
    assert.equal(offLines.length, 0, `${surface.id}: OFF writes no line`);
  }
});
