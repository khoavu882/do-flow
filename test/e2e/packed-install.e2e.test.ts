'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPackage } = require('../../src/release/build-package.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '../..');

function npm(args: any, options = {}) {
  const { npmCache, ...spawnOptions }: any = options;
  return spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
    { encoding: 'utf8', ...spawnOptions,
      env: { ...process.env, ...(npmCache ? { npm_config_cache: npmCache } : {}), ...spawnOptions.env } });
}

function pack(directory: any, destination: any, npmCache: any) {
  const result = npm(['pack', directory, '--pack-destination', destination], { cwd: destination, npmCache });
  assert.equal(result.status, 0, `npm pack failed\n${result.stdout}\n${result.stderr}`);
  const filename = result.stdout.trim().split(/\r?\n/).at(-1);
  return path.join(destination, filename);
}

function installTarball(tarball: any, prefix: any, env: any, npmCache: any) {
  const result = npm(['install', '--offline', '--prefix', prefix, tarball], { cwd: prefix, env, npmCache });
  assert.equal(result.status, 0, `offline npm install failed\n${result.stdout}\n${result.stderr}`);
}

test('packed package installs and runs its CLI and installed runtime offline', (t) => {
  const root = tempDir(t, 'doflow-packed-install-');
  const staged = path.join(root, 'package');
  const tarballs = path.join(root, 'tarballs');
  const prefix = path.join(root, 'prefix');
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'xdg');
  const npmCache = path.join(root, 'npm-cache');
  const repo = path.join(root, 'project');
  for (const directory of [tarballs, prefix, home, xdg, npmCache, repo]) fs.mkdirSync(directory, { recursive: true });

  buildPackage(staged);
  const tarball = pack(staged, tarballs, npmCache);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    npm_config_cache: npmCache,
    DOFLOW_CONFIG_DIR: '',
    DOFLOW_CLI: '',
    DOFLOW_AGENT: '',
    DOFLOW_FAILURE_CAPTURE: '',
  };
  installTarball(tarball, prefix, env, npmCache);

  const packageRoot = path.join(prefix, 'node_modules', '@khoavu882', 'doflow');
  const cli = path.join(packageRoot, 'bin', 'doflow.js');
  const version = spawnSync(process.execPath, [cli, '--version'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(version.status, 0, `${version.stdout}\n${version.stderr}`);
  assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version);

  const install = spawnSync(process.execPath, [cli, 'install', '-g', '-f', '--no-backup', '-t', 'claude'], {
    cwd: repo, encoding: 'utf8', input: '\n', env,
  });
  assert.equal(install.status, 0, `doflow install failed\n${install.stdout}\n${install.stderr}`);

  const dispatcher = path.join(home, '.claude', 'bin', 'doflow-run');
  const paths = spawnSync(bashPath(), [dispatcher, 'paths', '--json'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(paths.status, 0, `${paths.stdout}\n${paths.stderr}`);
  assert.ok(JSON.parse(paths.stdout), 'installed paths verb returned invalid JSON');

  // Control: packing the original TypeScript tree leaves .ts imports in node_modules, which
  // Node deliberately refuses to strip. This demonstrates that the staged strip step is needed.
  const controlTarballs = path.join(root, 'control-tarballs');
  const controlPrefix = path.join(root, 'control-prefix');
  fs.mkdirSync(controlTarballs);
  fs.mkdirSync(controlPrefix);
  const unstripped = pack(REPO_ROOT, controlTarballs, npmCache);
  installTarball(unstripped, controlPrefix, env, npmCache);
  const controlCli = path.join(controlPrefix, 'node_modules', '@khoavu882', 'doflow', 'bin', 'doflow.js');
  const control = spawnSync(process.execPath, [controlCli, '--version'], { cwd: repo, encoding: 'utf8', env });
  assert.notEqual(control.status, 0, 'unstripped package unexpectedly ran from node_modules');
  assert.match(control.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});
