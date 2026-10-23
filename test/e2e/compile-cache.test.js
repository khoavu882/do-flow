'use strict';

// 073 D5 — bin/doflow.js turns on Node's module compile cache before it loads anything from src/,
// so the type-stripping cost of the .ts modules is paid once rather than on every invocation.
// Static: the enableCompileCache call is best-effort and precedes the first ../src require. Functional:
// a real run reports an enabled cache (inside NODE_COMPILE_CACHE when set), NODE_DISABLE_COMPILE_CACHE
// still disables it, and the cache adds nothing to stdout or stderr.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-compile-cache-');
const PROBE = path.join(scratch.dir, 'probe.js');
const REPORT = path.join(scratch.dir, 'report.json');

// Runs before bin/doflow.js and, at exit, records what Node says about the compile cache. Nothing is
// printed, so stdout and stderr stay the CLI's own.
fs.writeFileSync(PROBE, `'use strict';
const m = require('node:module');
process.on('exit', () => {
  require('node:fs').writeFileSync(${JSON.stringify(REPORT)}, JSON.stringify({ dir: m.getCompileCacheDir() || null }));
});
`);

function run(extraEnv, args = ['--version']) {
  fs.rmSync(REPORT, { force: true });
  const env = scratch.env(extraEnv);
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, ['--require', PROBE, BIN, ...args], { env, encoding: 'utf8' });
  const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
  return { r, report };
}

test('compile cache: enableCompileCache is best-effort and called before the first ../src require', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const call = src.indexOf('enableCompileCache()');
  const firstSrc = src.search(/require\(['"]\.\.\/src\//);
  assert.ok(call !== -1, 'bin/doflow.js must call enableCompileCache()');
  assert.ok(firstSrc !== -1, 'bin/doflow.js must require from ../src/');
  assert.ok(call < firstSrc, 'enableCompileCache() must run before the first ../src require, or the first-load cost is not cached');
  assert.doesNotMatch(src, /typeof nodeModule\.enableCompileCache/, 'the floor Node always provides the API, so no feature check');
  assert.match(src, /try \{ nodeModule\.enableCompileCache\(\); \} catch/, 'the call must be best-effort');
});

test('compile cache: a real run enables the cache in NODE_COMPILE_CACHE and prints only the version', () => {
  const cacheDir = path.join(scratch.dir, 'cc');
  const { r, report } = run({ NODE_COMPILE_CACHE: cacheDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\n$/, 'stdout must be the bare version');
  assert.equal(r.stderr, '', 'the cache must not print anything to stderr');
  assert.ok(report && report.dir, 'the run must report an enabled compile cache');
  assert.ok(report.dir.startsWith(cacheDir + path.sep) || report.dir === cacheDir, `cache dir ${report.dir} must be under ${cacheDir}`);
});

test('compile cache: NODE_DISABLE_COMPILE_CACHE still disables it and the output is identical', () => {
  const on = run({ NODE_COMPILE_CACHE: path.join(scratch.dir, 'cc2') });
  const off = run({ NODE_DISABLE_COMPILE_CACHE: '1' });
  assert.equal(off.report && off.report.dir, null, 'an explicit disable must be respected');
  assert.equal(off.r.stdout, on.r.stdout);
  assert.equal(off.r.stderr, on.r.stderr);
  assert.equal(off.r.status, on.r.status);
});
