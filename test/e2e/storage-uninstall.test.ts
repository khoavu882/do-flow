'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const TARGETS = 'claude,codex,gemini,antigravity,opencode,pi,copilot,kiro';
function run(scratch: any, args: any, cwd: any) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env: scratch.env(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function install(scratch: any, global: any, cwd: any) {
  const args = ['install', ...(global ? ['-g'] : [cwd]), '--force', '--mcp', 'none', '--target', TARGETS];
  const result = run(scratch, args, cwd);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
function removeAll(scratch: any, global: any, cwd: any) {
  for (const target of TARGETS.split(',')) {
    const result = run(scratch, ['remove', ...(global ? ['-g'] : [cwd]), '--force', '--target', target], cwd);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    if (target !== 'kiro') assert.doesNotMatch(result.stdout, /\[INFO\] Storage: removed/);
    else assert.match(result.stdout, /\[INFO\] Storage: removed \d+ DoFlow control file\(s\)/);
  }
}
function seedControls(project: any, home: any, xdg: any, ignoreContents: any) {
  const roots = [path.join(project, '.doflow/state'), path.join(home, '.doflow/state')];
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), ignoreContents);
    fs.writeFileSync(path.join(root, 'upkeep-due'), '1\n');
    fs.mkdirSync(path.join(root, 'upkeep.lock'));
  }
  const config = path.join(xdg, 'doflow');
  fs.writeFileSync(path.join(config, 'upkeep-due'), '1\n');
  fs.mkdirSync(path.join(config, 'upkeep.lock'));
  const index = path.join(home, '.doflow/state/upkeep-roots');
  fs.writeFileSync(index, `${fs.realpathSync(project)}\n`);
  return { projectState: roots[0], userState: roots[1], config, index };
}

test('removing the final harness clears owned storage controls and leaves user settings and another project alone', () => {
  const scratch = createScratch('doflow-storage-uninstall-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const other = path.join(scratch.dir, 'other'); fs.mkdirSync(path.join(other, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(other, '.doflow/doflow.lock'), 'other scope\n');
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
    const ignore = `${registry.settings.ignoreFile.lines.join('\n')}\n`;
    install(scratch, false, project);
    install(scratch, true, project);
    const controls = seedControls(project, scratch.home, scratch.xdg, ignore);
    fs.writeFileSync(path.join(controls.userState, '.gitignore'), `${ignore}# user rule\n`);
    fs.appendFileSync(controls.index, `${fs.realpathSync(other)}\n`);
    fs.mkdirSync(path.join(other, '.doflow/state'), { recursive: true });
    fs.writeFileSync(path.join(other, '.doflow/state/.gitignore'), ignore);
    fs.writeFileSync(path.join(other, '.doflow/state/upkeep-due'), '1\n');
    fs.writeFileSync(path.join(project, '.doflow/prune'), 'off\n');
    fs.writeFileSync(path.join(project, '.doflow/prompt-nudge'), 'user\n');
    fs.writeFileSync(path.join(scratch.home, '.doflow/prune'), 'off\n');
    fs.writeFileSync(path.join(scratch.home, '.doflow/prompt-nudge'), 'user\n');

    removeAll(scratch, false, project);
    for (const file of ['.gitignore', 'upkeep-due']) assert.equal(fs.existsSync(path.join(controls.projectState, file)), false);
    assert.equal(fs.existsSync(path.join(controls.projectState, 'upkeep.lock')), false);
    assert.equal(fs.existsSync(path.join(project, '.doflow/prune')), true);
    assert.equal(fs.existsSync(path.join(project, '.doflow/prompt-nudge')), true);
    assert.ok(fs.existsSync(path.join(other, '.doflow/state/.gitignore')));
    assert.ok(fs.existsSync(path.join(other, '.doflow/state/upkeep-due')));
    assert.ok(fs.readFileSync(controls.index, 'utf8').includes(fs.realpathSync(other)));

    removeAll(scratch, true, project);
    for (const root of [controls.userState, controls.config]) {
      for (const file of ['upkeep-due']) assert.equal(fs.existsSync(path.join(root, file)), false);
      assert.equal(fs.existsSync(path.join(root, 'upkeep.lock')), false);
    }
    assert.equal(fs.readFileSync(path.join(controls.userState, '.gitignore'), 'utf8'), `${ignore}# user rule\n`);
    assert.equal(fs.existsSync(controls.index), false);
    assert.equal(fs.existsSync(path.join(scratch.home, '.doflow/prune')), true);
    assert.equal(fs.existsSync(path.join(scratch.home, '.doflow/prompt-nudge')), true);
  } finally { scratch.remove(); }
});
