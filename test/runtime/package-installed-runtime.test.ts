'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// `package --action list` and `package --action check --path` through every harness's `doflow-run` shim after a real
// `doflow install -g` of every harness into a scratch HOME (FU-sf76tw). The installed runtime (`~/.doflow/runtime`)
// ships bin/, src/ and core/registry/ and no package.json, so the host version of a third-party package comes from the
// lock the install wrote beside it (`~/.doflow/doflow.lock` `sourceVersion`); without it every third-party package
// would fail closed as `host-incompatible`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { IS_WIN } = require('../helper-platform.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const SKIP = IS_WIN ? 'the doflow-run shim is POSIX shell' : false;
const HARNESSES = loadRegistry({ repoRoot: REPO_ROOT }).harnesses.map((harness: any) => harness.id);
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const NEXT_MAJOR = Number(VERSION.split('.')[0]) + 1;

/** Every `bin/doflow-run` shim under `dir`, relative to it, sorted. */
function shimsUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...shimsUnder(dir, next));
    else if (entry.name === 'doflow-run' && path.basename(rel) === 'bin') out.push(next);
  }
  return out.sort();
}

/** A minimal valid inert package: one review preset that dominates review-deep (a third seat, a third round). */
function writePackage(dir: string) {
  const core = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8')).presets['review-deep'];
  const { depth: _depth, ...deep } = core;
  const strict = { ...deep, seats: [...deep.seats, { ...deep.seats[1], id: 'seat-c' }], rounds: { default: 3, min: 2 } };
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), `${JSON.stringify(strict, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), `${JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'acme strict review preset',
    doflow: `>=${VERSION} <${NEXT_MAJOR}.0.0`,
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  }, null, 2)}\n`);
}

/** One scratch HOME with every harness installed, and a third-party package directory beside it. */
function setup() {
  const scratch = createScratch('doflow-installed-package-');
  const env = scratch.env({ DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' });
  const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', HARNESSES.join(',')],
    { cwd: scratch.dir, env, encoding: 'utf8', input: '\n' });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const runtime = path.join(scratch.home, '.doflow', 'runtime');
  assert.equal(fs.existsSync(path.join(runtime, 'package.json')), false, 'an installed runtime carries no package.json');
  assert.equal(fs.existsSync(path.join(runtime, 'core', 'shared')), false, 'an installed runtime carries no core/shared');
  const pkg = path.join(scratch.dir, 'acme-package');
  writePackage(pkg);
  const cwd = path.join(scratch.dir, 'work');
  fs.mkdirSync(cwd);
  const run = (shim: string, args: string[]) => spawnSync(bashPath(), [path.join(scratch.home, shim), ...args], { cwd, env, encoding: 'utf8' });
  return { scratch, shims: shimsUnder(scratch.home), pkg, run };
}

test('installed runtime: package list and check work through every harness shim', { skip: SKIP }, () => {
  const { scratch, shims, pkg, run } = setup();
  try {
    assert.equal(shims.length, 8, shims.join(', '));
    for (const shim of shims) {
      const listed = run(shim, ['package', '--action', 'list', '--json']);
      assert.equal(listed.status, 0, `${shim} package list: ${listed.stdout}${listed.stderr}`);
      const view = JSON.parse(listed.stdout);
      const bundled = view.packages.find((entry: any) => entry.id === 'doflow');
      assert.ok(bundled, `${shim}: ${listed.stdout}`);
      assert.equal(bundled.state, 'active', `${shim}: ${JSON.stringify(bundled)}`);

      const checked = run(shim, ['package', '--action', 'check', '--path', pkg, '--json']);
      assert.equal(checked.status, 0, `${shim} package check: ${checked.stdout}${checked.stderr}`);
      assert.doesNotMatch(checked.stdout + checked.stderr, /host-incompatible/, shim);
      const result = JSON.parse(checked.stdout);
      assert.equal(result.ok, true, `${shim}: ${checked.stdout}`);
      assert.deepEqual(result.findings, [], shim);
    }
  } finally { scratch.remove(); }
});
