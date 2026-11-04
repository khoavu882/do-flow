'use strict';
// update-targets.test.ts — `doflow update` and `doflow reconcile` without -t act on the harnesses the
// scope's install manifest lists as installed, not on the install default (claude). With no manifest
// the default stays. Every case runs the real bin/doflow.js in a scratch HOME and project.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { installedTargets } = require('../../src/install/targets.ts');

const SCRATCHES: any = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function project() {
  const scratch = createScratch('doflow-update-targets-');
  SCRATCHES.push(scratch);
  const root = path.join(scratch.dir, 'project');
  fs.mkdirSync(root);
  const git = spawnSync('git', ['init', '-q'], { cwd: root, env: scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' }) });
  assert.strictEqual(git.status, 0, String(git.stderr));
  return { scratch, root: fs.realpathSync(root) };
}

function run({ scratch, root }: any, args: string[]) {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  if (IS_WIN) env.USERPROFILE = scratch.home;
  const result = spawnSync(process.execPath, [DOFLOW, ...args, root], { cwd: scratch.dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return { ...result, out: `${result.stdout}\n${result.stderr}` };
}

const manifestTools = (root: string) => Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.doflow', '.install-manifest.json'), 'utf8')).tools).sort();

test('installedTargets lists the manifest\'s installed known harnesses, in registry order', () => {
  assert.deepStrictEqual(installedTargets(null), []);
  assert.deepStrictEqual(installedTargets({ tools: {} }), []);
  assert.deepStrictEqual(installedTargets({ tools: { pi: { installed: true }, codex: { installed: true }, gemini: { installed: true } } }), ['codex', 'pi']);
  assert.deepStrictEqual(installedTargets({ tools: { codex: { installed: false } } }), []);
});

test('update and reconcile without -t leave a codex-only project codex-only', () => {
  const p = project();
  const installed = run(p, ['install', '-t', 'codex', '-f', '--mcp', 'none']);
  assert.strictEqual(installed.status, 0, installed.out);
  assert.ok(!fs.existsSync(path.join(p.root, '.claude')));

  const update = run(p, ['update', '-f']);
  assert.strictEqual(update.status, 0, update.out);
  assert.doesNotMatch(update.out, /Found \d+ native change/, update.out);
  assert.match(update.out, /Already up to date/, update.out);
  assert.ok(!fs.existsSync(path.join(p.root, '.claude')), 'update must not install claude');
  assert.deepStrictEqual(manifestTools(p.root), ['codex']);

  const reconcile = run(p, ['reconcile', '-f']);
  assert.strictEqual(reconcile.status, 0, reconcile.out);
  assert.doesNotMatch(reconcile.out, /claude/, reconcile.out);
  assert.ok(!fs.existsSync(path.join(p.root, '.claude')), 'reconcile must not install claude');
  assert.deepStrictEqual(manifestTools(p.root), ['codex']);
});

test('update without -t refreshes every installed harness of a two-harness project', () => {
  const p = project();
  const installed = run(p, ['install', '-t', 'codex,pi', '-f', '--mcp', 'none']);
  assert.strictEqual(installed.status, 0, installed.out);
  const dry = run(p, ['update', '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /targets\s*: codex, pi/, dry.out);
  assert.doesNotMatch(dry.out, /claude/, dry.out);

  const update = run(p, ['update', '-f']);
  assert.strictEqual(update.status, 0, update.out);
  assert.ok(!fs.existsSync(path.join(p.root, '.claude')));
  assert.deepStrictEqual(manifestTools(p.root), ['codex', 'pi']);
});

test('update without -t and without a manifest keeps the install default', () => {
  const p = project();
  const dry = run(p, ['update', '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /targets\s*: claude\b/, dry.out);
});

test('an explicit -t still wins over the manifest', () => {
  const p = project();
  assert.strictEqual(run(p, ['install', '-t', 'codex', '-f', '--mcp', 'none']).status, 0);
  const dry = run(p, ['update', '-t', 'claude', '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /targets\s*: claude\b/, dry.out);
});
