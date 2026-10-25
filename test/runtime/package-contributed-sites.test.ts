'use strict';

// Feature 122 FU-1eh5z2: with an active third-party review preset on the machine (reachable since B.5), the places that
// read the preset lists behave as with none, except where IC-014 says a contributed preset is selectable by name:
//   1. the prepared-run check admits an active contributed id by dominance (never an indexOf of a non-core id);
//   2. the settings registry verifies its refs against the core registry only, so it loads on any machine;
//   3. the generated docs blocks are byte-identical whether or not a package is active.
// The package is staged through the real B.4 plan + apply into a scratch HOME and the lock bit is flipped by the test
// (review-preset is an inert point: no grant line is needed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { resetPackageView } = require('../../src/runtime/packages/view.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { BLOCKS, renderBlock, checkAll } = require('../../src/release/docs-blocks.ts');

const CORE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
const AT = Date.parse('2026-10-24T09:12:03Z');
const BARE_PATH = { PATH: path.dirname(process.execPath) };

/** A review preset the package ships: review-deep without its depth label, with the given round count. */
const presetWith = (rounds: number): any => {
  const preset = JSON.parse(JSON.stringify(CORE.presets['review-deep']));
  delete preset.depth;
  preset.rounds = { default: rounds, min: rounds };
  return preset;
};

/** Stage package `acme` (contributing review preset `acme.strict`, `rounds` rounds) into `home` and enable it. */
function stageActive(t: any, home: string, env: any, rounds: number): void {
  const dir = path.join(tempDir(t, 'doflow-sites-src-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.2.0', summary: 'A review preset', doflow: '>=2.0.0-beta.1 <3.0.0',
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  }));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(presetWith(rounds)));
  const planned = planPackage({ action: 'add', source: dir, homeDir: home, repoRoot: REPO_ROOT, now: AT });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: home, repoRoot: REPO_ROOT, env });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  const options = { scope: 'global', homeDir: home };
  const lock = readLock(options);
  writeLock(options, { ...lock, packages: lockPackages(lock).map((row: any) => (row.id === 'acme' ? { ...row, enabled: true } : row)) });
}

/** Put the scratch HOME into this process for the in-process cases; the package view is rebuilt from it. */
function useHome(t: any, f: any): void {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = f.home;
  process.env.XDG_CONFIG_HOME = f.xdg;
  resetPackageView();
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPackageView();
  });
}

// ── site 1: the prepared-run check ─────────────────────────────────────────────────────────────────────────

function preparedRun(t: any, rounds: number, doc: any): any {
  const f = createSettingsEnv(t);
  stageActive(t, f.home, f.env(), rounds);
  const file = path.join(f.dir, 'prepared.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, taskClass: 'feature', ...doc }));
  const result = f.run(['config', 'validate', '--prepared-run', file, '--json'], { env: BARE_PATH });
  return result;
}

const errorsOf = (result: any): any[] => {
  assert.ok(result.json, `${result.stdout}${result.stderr}`);
  return result.json.errors;
};

test('prepared run: an active contributed review preset named in presets.review is admitted when it dominates the pick', (t: any) => {
  const result = preparedRun(t, 2, { presets: { review: 'acme.strict' } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.json, { ok: true, errors: [] });
});

test('prepared run: a contributed id that does not dominate the effective pick is not-narrower and names the pick', (t: any) => {
  const result = preparedRun(t, 1, { settings: { 'review.preset': 'review-deep' }, presets: { review: 'acme.strict' } });
  const [only, ...rest] = errorsOf(result);
  assert.equal(rest.length, 0, JSON.stringify(rest));
  assert.equal(only.key, 'presets.review');
  assert.equal(only.code, 'not-narrower');
  assert.match(only.message, /review-deep/);
  assert.match(only.message, /project layer/);
});

test('prepared run: a core id against a contributed pick is admitted only when it dominates that pick', (t: any) => {
  const pick = { 'review.preset': 'acme.strict' };
  // acme.strict has review-deep's rounds and seats: review-deep dominates it; review-single (1 seat) does not.
  const dominating = preparedRun(t, 2, { settings: pick, presets: { review: 'review-deep' } });
  assert.equal(dominating.status, 0, `${dominating.stdout}${dominating.stderr}`);
  const looser = preparedRun(t, 2, { settings: pick, presets: { review: 'review-single' } });
  const [only, ...rest] = errorsOf(looser);
  assert.equal(rest.length, 0, JSON.stringify(rest));
  assert.equal(only.key, 'presets.review');
  assert.equal(only.code, 'not-narrower');
  assert.match(only.message, /acme\.strict/);
});

test('prepared run: an id that is neither core nor an active contributed id is the enum fault listing core then contributed ids', (t: any) => {
  const result = preparedRun(t, 2, { presets: { review: 'acme.nope', debate: 'acme.strict' } });
  const byKey = Object.fromEntries(errorsOf(result).map((e: any) => [e.key, e]));
  assert.deepEqual(Object.keys(byKey).sort(), ['presets.debate', 'presets.review']);
  assert.equal(byKey['presets.review'].code, 'enum');
  assert.deepEqual(byKey['presets.review'].allowed, ['review-deep', 'review-single', 'acme.strict']);
  assert.equal(byKey['presets.debate'].code, 'enum', 'a review preset is not a debate preset');
  assert.deepEqual(byKey['presets.debate'].allowed, ['debate-3', 'debate-2']);
});

// ── site 2: the settings registry's ref verification ───────────────────────────────────────────────────────

test('settings registry: verifyRefs depends on the core registry only; enumValues at run time keeps the contributed ids', (t: any) => {
  const f = createSettingsEnv(t);
  stageActive(t, f.home, f.env(), 2);
  useHome(t, f);
  const loaded = loadSettingsRegistry({ repoRoot: REPO_ROOT, fsImpl: fs, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const values = loaded.registry.enumValues('review.preset');
  assert.deepEqual(values, ['auto', 'review-deep', 'review-single', 'acme.strict']);
  assert.ok(!loaded.registry.keys.get('review.preset').order.includes('acme.strict'), 'a contributed id is a value, never a rank');
});

// ── site 3: the generated docs ─────────────────────────────────────────────────────────────────────────────

test('docs blocks: every generated block is byte-identical with and without an active package, and the docs stay in sync', (t: any) => {
  const f = createSettingsEnv(t);
  useHome(t, f);
  const without = Object.fromEntries(BLOCKS.map((block: any) => [block.id, renderBlock(block.id, REPO_ROOT)]));
  stageActive(t, f.home, f.env(), 2);
  resetPackageView();
  const withPackage = Object.fromEntries(BLOCKS.map((block: any) => [block.id, renderBlock(block.id, REPO_ROOT)]));
  assert.deepEqual(withPackage, without);
  assert.deepEqual(checkAll(REPO_ROOT), []);
});
