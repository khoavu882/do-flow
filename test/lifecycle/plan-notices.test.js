'use strict';

// Plan notices: an adapter may attach one-line, non-blocking notes to its plan. planLifecycle keeps
// the well-formed ones, the printers show them, and none of it changes `safe` or an exit code.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAdapterRegistry } = require('../../src/adapters');
const { planLifecycle } = require('../../src/lifecycle');
const { printRegistryLifecycle } = require('../../src/lifecycle/view');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const NOTICE = 'no skills at global scope (the user-scope skills location is unresolved), so DoFlow skills and runtime are not installed here; install per project with: npx @khoavu882/doflow install -t antigravity';

const scratch = createScratch('doflow-notices-');
after(() => scratch.remove());

const registry = {
  harnesses: [{
    id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {},
    capabilities: { instructions: { status: 'supported' } },
  }],
  assets: [
    { id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake'], ownership: 'managed-file',
      projection: { fake: { renderer: 'fake', capability: 'instructions' } } },
  ],
  mcp: [], lifecycle: [],
};

function fakeAdapter(notices) {
  return {
    discover() { return { existing: [] }; },
    render() { return 'native'; },
    plan() {
      const result = { changes: [], conflicts: [], prerequisites: [] };
      if (notices !== undefined) result.notices = notices;
      return result;
    },
    apply() {}, remove() {}, verify() { return { ok: true, resources: [] }; },
  };
}

const planWith = (notices) => planLifecycle({
  registry, adapters: createAdapterRegistry({ fake: fakeAdapter(notices) }), scope: 'project', scopeRoot: scratch.dir, targets: ['fake'],
});

test('a plan carries the adapter notices as { harness, notice } and stays safe', () => {
  const plan = planWith(['first', 'second']);
  assert.deepEqual(plan.notices, [{ harness: 'fake', notice: 'first' }, { harness: 'fake', notice: 'second' }]);
  assert.deepEqual(plan.targets[0].notices, ['first', 'second']);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.prerequisites, []);
});

test('a plan with no notices has an empty notices list', () => {
  assert.deepEqual(planWith(undefined).notices, []);
  assert.deepEqual(planWith([]).notices, []);
});

test('a malformed notice is dropped, the good one kept, and safe is unchanged', () => {
  const plan = planWith(['kept', 42, null, { text: 'object' }, 'two\nlines', 'bell\u0007', 'x'.repeat(201), 'x'.repeat(200)]);
  assert.deepEqual(plan.notices.map((item) => item.notice), ['kept', 'x'.repeat(200)]);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.conflicts, []);
});

test('a notices field that is not an array is ignored', () => {
  const plan = planWith('not an array');
  assert.deepEqual(plan.notices, []);
  assert.equal(plan.safe, true);
});

test('the dry-run printer shows each notice under its harness line', () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    printRegistryLifecycle({ stateRoot: scratch.dir, plan: planWith(['a note']) }, '[DRY]');
  } finally { console.log = original; }
  const at = lines.findIndex((line) => line === '[DRY]   fake: 0 change(s)');
  assert.ok(at >= 0, lines.join('\n'));
  assert.equal(lines[at + 1], '[DRY]   fake: a note');
});

// ---- the Antigravity global notice, through the real CLI ----

/** A scratch of this test's own, removed with the file's. */
function ownScratch() {
  const own = createScratch('doflow-notices-cli-');
  after(() => own.remove());
  return own;
}

function cli(own, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: own.dir, encoding: 'utf8', input: '\n', env: own.env() });
}

test('install -g -t antigravity prints the notice, exits 0, and prints it again on a no-op reinstall', () => {
  const own = ownScratch();
  const first = cli(own, ['install', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.split('\n').includes(`[INFO] antigravity: ${NOTICE}`), first.stdout);

  const again = cli(own, ['install', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.split('\n').includes(`[INFO] antigravity: ${NOTICE}`), 'a reinstall with nothing to change still says so');
  assert.equal(fs.existsSync(path.join(own.home, '.doflow', 'runtime')), false, 'global scope projects no runtime');
});

test('update -g -t antigravity prints the notice when there is nothing to update', () => {
  const own = ownScratch();
  assert.equal(cli(own, ['install', '-g', '-f', '--no-backup', '-t', 'antigravity']).status, 0);
  const update = cli(own, ['update', '-g', '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Already up to date/);
  assert.ok(update.stdout.split('\n').includes(`[INFO] antigravity: ${NOTICE}`), update.stdout);
});

test('install --dry-run -g -t antigravity prints the notice under the harness line', () => {
  const dry = cli(ownScratch(), ['install', '-g', '--dry-run', '-t', 'antigravity']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.split('\n').includes(`[DRY]   antigravity: ${NOTICE}`), dry.stdout);
});

test('a project install and a global removal of antigravity print no notice', () => {
  const own = ownScratch();
  const project = cli(own, ['install', own.dir, '-f', '--no-backup', '-t', 'antigravity']);
  assert.equal(project.status, 0, project.stderr);
  assert.ok(!project.stdout.includes('no skills at global scope'), project.stdout);

  assert.equal(cli(own, ['install', '-g', '-f', '--no-backup', '-t', 'antigravity']).status, 0);
  const removal = cli(own, ['remove', '-g', '-f', '-t', 'antigravity']);
  assert.equal(removal.status, 0, removal.stderr);
  assert.ok(!removal.stdout.includes('no skills at global scope'), removal.stdout);
});
