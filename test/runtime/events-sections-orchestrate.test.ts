'use strict';

// 149 IC-004: the `now` section `list` and the `run:<slug>:<task>` sections `status` and `timeline`
// are the in-process results the orchestrate verb prints. Each exported function is run next to the
// CLI over one fixture with two runs and a missing one, and its `{exit, json}` must equal the exit
// code and the parsed stdout of `doflow orchestrate ... --json`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { listRunsResult, statusResult, timelineResult } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function project(t: any) {
  const root = tempDir(t, 'doflow-events-sections-orchestrate-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  return root;
}

function runCli(cwd: any, args: any) {
  const home = path.join(cwd, '.test-home');
  const config = path.join(cwd, '.test-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env: any = { ...process.env, DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', HOME: home, XDG_CONFIG_HOME: config };
  const result = spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The CLI's answer as a section result: the exit code and stdout parsed, null when it is not one JSON value. */
function cliResult(cwd: any, args: any) {
  const result = runCli(cwd, ['orchestrate', ...args, '--json']);
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { exit: result.status, json, stderr: result.stderr };
}

function ok(cwd: any, args: any) {
  const result = cliResult(cwd, args);
  assert.equal(result.exit, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.json;
}

function inProcess(fn: any, options: any) {
  clearCheckoutCache();
  return fn(options);
}

test('IC-004: list, status and timeline results equal the orchestrate CLI on one fixture', async (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'a1', '--task-class', 'feature', '--slug', 'feat-a']);
  ok(root, ['--action', 'complete-stage', '--task-id', 'a1', '--stage', 'discovery', '--result', 'passed', '--slug', 'feat-a']);
  ok(root, ['--action', 'start', '--task-id', 'b1', '--task-class', 'research', '--slug', 'feat-b']);
  ok(root, ['--action', 'skip-stage', '--task-id', 'b1', '--stage', 'scoping', '--reason', 'not needed', '--slug', 'feat-b']);
  const runs = [['a1', 'feat-a'], ['b1', 'feat-b']];
  const missing = ['zz9', 'feat-a'];

  await t.test('list', () => {
    const cli = cliResult(root, ['--action', 'list']);
    const own = inProcess(listRunsResult, { stateRoot: root });
    assert.equal(own.exit, cli.exit);
    assert.equal(own.exit, 0);
    assert.deepEqual(own.json, cli.json);
    assert.deepEqual(own.json.runs.map((r: any) => r.taskId).sort(), ['a1', 'b1']);
  });

  for (const [name, fn] of [['status', statusResult], ['timeline', timelineResult]] as const) {
    await t.test(`${name} of each run`, () => {
      for (const [taskId, slug] of runs) {
        const cli = cliResult(root, ['--action', name, '--task-id', taskId, '--slug', slug]);
        const own = inProcess(fn, { stateRoot: root, taskId, slug });
        assert.equal(own.exit, cli.exit, `${name} ${taskId}`);
        assert.equal(own.exit, 0, `${name} ${taskId}`);
        assert.notEqual(own.json, null, `${name} ${taskId}`);
        assert.deepEqual(own.json, cli.json, `${name} ${taskId}`);
        assert.equal(own.json.taskId, taskId);
      }
    });

    await t.test(`${name} of a missing run exits 1 with no JSON`, () => {
      const [taskId, slug] = missing;
      const cli = cliResult(root, ['--action', name, '--task-id', taskId, '--slug', slug]);
      const own = inProcess(fn, { stateRoot: root, taskId, slug });
      assert.equal(cli.exit, 1, cli.stderr);
      assert.equal(own.exit, cli.exit);
      assert.equal(cli.json, null);
      assert.equal(own.json, null);
    });
  }
});
