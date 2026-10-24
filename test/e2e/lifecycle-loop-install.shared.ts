'use strict';
// lifecycle-loop-install.shared.js — scratch homes, the real `doflow install` runner and the projected-locator
// runner the lifecycle-loop-install e2e files share. Not a test file. Every spawn runs under a scratch HOME and
// XDG_CONFIG_HOME and with no global git config (DEC-041); each test file removes its own scratch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { resolverOf, filesUnder } = require('../helper/skill-resolver.ts');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures.ts');
const { IS_WIN } = require('../helper-platform.ts');


const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SKIP = IS_WIN ? 'the projected locator and the skill resolver are POSIX shell' : false;

const scratch = createScratch('doflow-loop-install-');

let counter = 0;

/** A scratch home of its own, so one harness's install never leaks into the next one's resolution. */
function homeFor(name: any) {
  const dir = path.join(scratch.dir, `${name}-${(counter += 1)}`);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return { dir, home, xdg };
}

const envFor = (h: any, extra = {}) => scratch.env({
  HOME: h.home, USERPROFILE: h.home, XDG_CONFIG_HOME: h.xdg,
  DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '',
  ...extra,
});

/** `doflow install -g` for one target into the scratch home. */
function install(h: any, target: any) {
  const r = spawnSync(process.execPath, [CLI, 'install', '-g', '-f', '--no-backup', '-t', target], {
    cwd: h.dir, encoding: 'utf8', input: '\n', env: envFor(h),
  });
  assert.equal(r.status, 0, `install -t ${target}: ${r.stderr}`);
}

function run(h: any, cwd: any, locator: any, args: any, { input = '' } = {}) {
  const r = spawnSync('bash', [locator, ...args], { cwd, input, encoding: 'utf8', env: envFor(h) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** The skill file a harness installed, found by walking its home. */
function installedSkill(h: any, name: any) {
  const hit = filesUnder(h.home).find((f: any) => f.split(path.sep).slice(-3).join('/') === `skills/${name}/SKILL.md`);
  assert.ok(hit, `no installed ${name} skill under ${h.home}`);
  return path.join(h.home, hit);
}

module.exports = {
  REPO, CLI, SKIP, IS_WIN, scratch, homeFor, envFor, install, run, installedSkill, resolverOf, filesUnder, makeRepo, featureBranch,
};
