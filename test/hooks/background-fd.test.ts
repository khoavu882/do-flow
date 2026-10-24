'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratchGitRepo } = require('../helper/hook-fixtures.ts');
const { createScratch } = require('../helper/scratch-env.ts');

const scratch = createScratch('doflow-background-fd-');
const fixtures = require('../helper/hook-fixtures.ts').createScratch('doflow-background-fd-projects-');
const mirror = path.join(scratch.dir, 'mirror');
buildInstallMirror(mirror);
after(() => { scratch.remove(); fixtures.remove(); });

function write(file: any, contents: any, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode });
}

function runDoor(name: any, payload: any, project: any, extraEnv = {}) {
  const result = spawnSync('bash', [path.join(mirror, '.claude/hooks', `${name}.sh`)], {
    cwd: project,
    input: `${JSON.stringify(payload)}\n`,
    env: scratch.env({ DOFLOW_PROJECT_DIR: project, ...extraEnv }),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function assertPromptReturn(result: any, startedAt: any, label: any) {
  assert.equal(result.status, 0, `${label}: bridge/front door exits successfully (${result.stderr})`);
  assert.ok(performance.now() - startedAt < 1500, `${label}: returned before background worker finished`);
}

test('Claude Stop returns while its background eslint fixer is still running', () => {
  const project = createScratchGitRepo(fixtures, 'stop-project').root;
  const sessionId = 'background-stop';
  const sessionDir = path.join(scratch.xdg, 'doflow/session-env/sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'edited-files.txt'), 'src/a.js\n');
  const bin = path.join(scratch.dir, 'stop-bin');
  write(path.join(bin, 'eslint'), '#!/usr/bin/env bash\nsleep 3\n', 0o755);
  const startedAt = performance.now();
  const result = runDoor('stop-check', { session_id: sessionId, cwd: project }, project, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assertPromptReturn(result, startedAt, 'Claude Stop with queued JavaScript');
});

test('Claude SessionStart returns while storage upkeep is still running', () => {
  const project = createScratchGitRepo(fixtures, 'session-project').root;
  const runner = path.join(project, '.doflow/scripts/doflow/bin/doflow-run');
  write(runner, '#!/usr/bin/env bash\nsleep 3\n', 0o755);
  const startedAt = performance.now();
  const result = runDoor('session-start', { session_id: 'background-session', cwd: project }, project);
  assertPromptReturn(result, startedAt, 'Claude SessionStart storage upkeep');
});
