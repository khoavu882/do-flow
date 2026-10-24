'use strict';
// lifecycle-loop-install-store.e2e.test.js: an old agent-docs/lifecycle store is copied through every harness's
// projected dispatcher. Helpers: lifecycle-loop-install.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO, CLI, SKIP, scratch, homeFor, envFor, install, run, filesUnder, makeRepo,
} = require('./lifecycle-loop-install.shared.ts');

after(() => scratch.remove());

// The copy of an old store runs inside the dispatcher's own handlers, so every harness's projected
// locator reaches it the same way. The harness list is read from the registry, so a harness added
// there is covered without an edit here.
const HARNESS_IDS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses.map((x: any) => x.id);
// All 8 harnesses project their locator and runtime at global scope.
const NO_RUNTIME = new Set();
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';

/** The event files of a folder with their bytes. */
const eventFiles = (dir: any) => Object.fromEntries(fs.readdirSync(dir).sort().map((name: any) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));

/** A followup.added envelope, named by its own id as the store names them. */
function seedEvent(dir: any, n: any, followupId: any) {
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, n)).toISOString();
  const id = `${at.replace(/[-:.]/g, '')}-aaaaaa`;
  const event = { v: 1, id, type: 'followup.added', at, by: 'agent', data: { id: followupId, statement: `Seeded ${followupId}`, source: { kind: 'manual' } } };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(event, null, 2)}\n`);
}

describe('An old agent-docs/lifecycle store is copied through every harness\'s projected dispatcher', { skip: SKIP }, () => {
  for (const id of HARNESS_IDS) {
    test(`${id}: followup list copies the two old events once, notes it on stderr and leaves the old folder as it was`, () => {
      const h = homeFor(`migrate-${id}`);
      install(h, id);
      const locator = filesUnder(h.home).find((f: any) => path.basename(f) === 'doflow-run' && !f.split(path.sep).includes('.doflow'));
      assert.ok(locator, `${id} projects a doflow-run locator`);
      const project = makeRepo(scratch, `migrate-${id}`);
      const oldDir = path.join(project.dir, 'agent-docs', 'lifecycle', 'events');
      fs.mkdirSync(oldDir, { recursive: true });
      seedEvent(oldDir, 1, 'FU-aaaaaa');
      seedEvent(oldDir, 2, 'FU-bbbbbb');
      const before = eventFiles(oldDir);
      assert.equal(Object.keys(before).length, 2);

      const list = run(h, project.dir, path.join(h.home, locator), ['followup', '--action', 'list', '--json']);
      if (NO_RUNTIME.has(id)) {
        assert.equal(list.status, 2, list.stdout + list.stderr);
        assert.match(list.stderr, /no DoFlow runtime found/);
        assert.equal(fs.existsSync(path.join(project.dir, '.doflow')), false, 'no runtime ran, so nothing was copied');
      } else {
        assert.equal(list.status, 0, list.stderr);
        assert.deepEqual(list.json.items.map((i: any) => i.id).sort(), ['FU-aaaaaa', 'FU-bbbbbb']);
        assert.deepEqual(eventFiles(path.join(project.dir, '.doflow', 'state', 'lifecycle', 'events')), before, 'the new store holds the same names and bytes');
        assert.equal(list.stderr.split(NOTICE).length - 1, 1, `the notice is printed once: ${list.stderr}`);
      }
      assert.deepEqual(eventFiles(oldDir), before, 'the old folder is unchanged');
    });
  }
});

test('antigravity, project scope: followup list through the project\'s own locator copies the old events once', { skip: SKIP }, () => {
  const h = homeFor('migrate-antigravity-project');
  const project = makeRepo(scratch, 'migrate-antigravity-project');
  const installed = spawnSync(process.execPath, [CLI, 'install', project.dir, '-f', '--no-backup', '-t', 'antigravity'], { cwd: h.dir, encoding: 'utf8', input: '\n', env: envFor(h) });
  assert.equal(installed.status, 0, installed.stderr);
  const locator = path.join(project.dir, '.agents', 'bin', 'doflow-run');
  assert.ok(fs.existsSync(locator), 'a project install projects the locator under .agents/bin');
  const oldDir = path.join(project.dir, 'agent-docs', 'lifecycle', 'events');
  fs.mkdirSync(oldDir, { recursive: true });
  seedEvent(oldDir, 1, 'FU-aaaaaa');
  seedEvent(oldDir, 2, 'FU-bbbbbb');
  const before = eventFiles(oldDir);
  const list = run(h, project.dir, locator, ['followup', '--action', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.json.items.map((i: any) => i.id).sort(), ['FU-aaaaaa', 'FU-bbbbbb']);
  assert.deepEqual(eventFiles(path.join(project.dir, '.doflow', 'state', 'lifecycle', 'events')), before);
  assert.equal(list.stderr.split(NOTICE).length - 1, 1, list.stderr);
  assert.deepEqual(eventFiles(oldDir), before, 'the old folder is unchanged');
});

test('DOFLOW_RETENTION_HOURS=soon in the shell is not in the environment these spawns get', () => {
  const saved = process.env.DOFLOW_RETENTION_HOURS;
  process.env.DOFLOW_RETENTION_HOURS = 'soon';
  try {
    assert.equal('DOFLOW_RETENTION_HOURS' in envFor(homeFor('retention-shell')), false);
  } finally {
    if (saved === undefined) delete process.env.DOFLOW_RETENTION_HOURS; else process.env.DOFLOW_RETENTION_HOURS = saved;
  }
});
