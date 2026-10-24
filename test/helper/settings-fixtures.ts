'use strict';

// Isolated settings environment for feature 086 tests. Each fixture owns a temp HOME, a temp
// XDG_CONFIG_HOME and a project folder with `.doflow/`, optionally with a linked git worktree, and
// hands the environment to the code under test explicitly, so no test reads or writes the real home
// or ~/.config/doflow. Writers cover the 2.0 file formats (decision-model.json, `prune`, the
// `failures/off` sentinel) and the settings.json format that arrives later in the feature.
//
// Never let a test run with HOME unset against code that reads files: Node then names the real
// account home through os.homedir(). Cases that unset HOME assert a computed path only.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');

// Variables a developer's shell may carry that change what the code under test resolves.
const DROPPED = ['DOFLOW_RETENTION_HOURS', 'DOFLOW_FAILURE_CAPTURE', 'XDG_CONFIG_HOME', 'HOME', 'PI_CODING_AGENT_DIR'];

function write(file: any, text: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text)}\n`);
  return file;
}

/** A complete 2.0 user decision-model file; `overrides` replace fields, undefined removes one. */
function userDecision(overrides = {}) {
  const base: any = { schema: 1, enabled: true, provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'clef-flash' };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key]; else base[key] = value;
  }
  return base;
}

function git(cwd: any, args: any, env: any) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{prefix?: string, worktree?: boolean}} [options]
 */
function createSettingsEnv(t: any, { prefix = 'doflow-settings-', worktree = false } = {}) {
  const dir = tempDir(t, prefix);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const project = path.join(dir, 'project');
  for (const folder of [home, xdg, path.join(project, '.doflow')]) fs.mkdirSync(folder, { recursive: true });
  const configDir = path.join(xdg, 'doflow');
  const failuresDir = path.join(configDir, 'failures');

  /** A clean environment for a function or subprocess; `extra` entries set, `undefined` removes. */
  function env(extra: any = {}) {
    const next: any = { ...process.env };
    for (const key of DROPPED) delete next[key];
    Object.assign(next, {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    });
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete next[key]; else next[key] = value;
    }
    return next;
  }

  const fixture: any = {
    dir, home, xdg, project, configDir, failuresDir, env,
    userFile: (name: any) => path.join(configDir, name),
    projectFile: (name: any, root = project) => path.join(root, '.doflow', name),

    // 2.0 formats
    writeUserDecision: (value: any) => write(fixture.userFile('decision-model.json'), value),
    writeProjectDecision: (value: any, root = project) => write(fixture.projectFile('decision-model.json', root), value),
    writeUserPrune: (text: any) => write(fixture.userFile('prune'), text),
    writeProjectPrune: (text: any, root = project) => write(fixture.projectFile('prune', root), text),
    writeSentinel: (text = 'off\n') => write(path.join(failuresDir, 'off'), text),

    // the settings.json format of the feature (later tasks)
    writeUserSettings: (object: any) => write(fixture.userFile('settings.json'), object),
    writeProjectSettings: (object: any, root = project) => write(fixture.projectFile('settings.json', root), object),
    writeProjectLocal: (object: any, root = project) => write(fixture.projectFile('settings.local.json', root), object),

    remove: (file: any) => fs.rmSync(file, { force: true, recursive: true }),

    /** Runs bin/doflow.js with the fixture environment; `cwd` defaults to the project. */
    run(args: any, { cwd = project, env: extra = {} } = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(extra), encoding: 'utf8' });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* text output */ }
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },

    /** Runs a script in a fresh Node process: `cwd`, `env` (undefined removes) are explicit. */
    node(script: any, { cwd = project, env: extra = {} } = {}) {
      const r = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], { cwd, env: env(extra), encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`node subprocess failed (${r.status}): ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
  };

  if (worktree) {
    // A real linked worktree of a project that is its own git main checkout.
    const e = env();
    git(project, ['init', '-q', '-b', 'main'], e);
    write(path.join(project, 'README.md'), 'fixture\n');
    git(project, ['add', 'README.md'], e);
    git(project, ['commit', '-q', '-m', 'init'], e);
    const linked = path.join(dir, 'linked');
    git(project, ['worktree', 'add', '-q', '-b', 'linked-branch', linked], e);
    fixture.worktree = fs.realpathSync(linked);
    fs.mkdirSync(path.join(fixture.worktree, '.doflow'), { recursive: true });
  }
  return fixture;
}

/** One lifecycle event envelope, dated `atMs` (shape as test/runtime/lifecycle-retention.test.js). */
let serial = 0;
function lifecycleEvent(type: any, data: any, atMs: any) {
  serial += 1;
  const at = new Date(atMs).toISOString();
  return { v: 1, id: `${at.replace(/[-:.]/g, '')}-${String(serial).padStart(6, '0')}`, type, at, by: 'agent', data };
}

/** A follow-up added and dismissed `hoursAgo` hours before now; returns the event file names. */
function writeSettledFollowup(eventsDir: any, id: any, hoursAgo: any, now = Date.now()) {
  const HOUR = 3600000;
  const events = [
    lifecycleEvent('followup.added', { id, statement: `s ${id}`, source: { kind: 'manual' } }, now - hoursAgo * HOUR),
    lifecycleEvent('followup.settled', { id, as: 'dismissed', reason: 'why' }, now - hoursAgo * HOUR + 1),
  ];
  fs.mkdirSync(eventsDir, { recursive: true });
  for (const event of events) fs.writeFileSync(path.join(eventsDir, `${event.id}.json`), `${JSON.stringify(event, null, 2)}\n`);
  return events.map((event) => `${event.id}.json`);
}

module.exports = { createSettingsEnv, userDecision, writeSettledFollowup, write, CLI, REPO };
