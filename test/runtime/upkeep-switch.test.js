'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const registry = require('../../core/registry/storage.json');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { prepareStore, LEGACY_EVENTS_REL, MARKER_REL } = require('../../src/runtime/lifecycle/store-upkeep.ts');
const { EVENTS_REL } = require('../../src/runtime/lifecycle/event-store.ts');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const IGNORE = `${registry.settings.ignoreFile.lines.join('\n')}\n`;
const MIGRATION_MESSAGE = 'the lifecycle store has not been copied yet; run any followup, lifecycle or goal command once without DOFLOW_UPKEEP=off. Nothing was written.';
const DOCTOR_NOTE = 'note: DOFLOW_UPKEEP=off in this environment: upkeep and lifecycle retention are skipped';
const upkeep = () => require('../../src/runtime/storage/upkeep.ts');

function fixture(t) {
  const dir = tempDir(t, 'doflow-upkeep-switch-');
  const projectRoot = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    DOFLOW_TELEMETRY: 'off',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  delete env.DOFLOW_UPKEEP;
  delete env.DOFLOW_RETENTION_HOURS;
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const roots = resolveRoots({ registry, projectRoot, env });
  for (const id of ['project-state', 'user-state', 'config-home']) fs.mkdirSync(roots[id], { recursive: true });
  return { dir, projectRoot, env, roots, now: NOW };
}

function setSwitch(env, value) {
  if (value === undefined) delete env.DOFLOW_UPKEEP;
  else env.DOFLOW_UPKEEP = value;
}

function writeEvent(folder, at, suffix, type, data) {
  fs.mkdirSync(folder, { recursive: true });
  const id = `${at.replace(/[-:.]/g, '')}-${suffix}`;
  fs.writeFileSync(path.join(folder, `${id}.json`), `${JSON.stringify({ v: 1, id, at, type, by: 'agent', data })}\n`);
  return `${id}.json`;
}

function treeSnapshot(root) {
  const entries = {};
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const info = fs.lstatSync(file);
      if (info.isDirectory()) {
        entries[relative] = { type: 'directory' };
        visit(file);
      } else if (info.isFile()) {
        entries[relative] = {
          type: 'file',
          sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        };
      } else if (info.isSymbolicLink()) {
        entries[relative] = { type: 'symlink', target: fs.readlinkSync(file) };
      } else {
        entries[relative] = { type: 'other', mode: info.mode };
      }
    }
  };
  visit(root);
  return entries;
}

function snapshotRoots(roots) {
  return Object.fromEntries(['project-state', 'user-state', 'config-home'].map(id => [id, treeSnapshot(roots[id])]));
}

function runCli(cwd, args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function legacyProject(t) {
  const f = fixture(t);
  const legacy = path.join(f.projectRoot, LEGACY_EVENTS_REL);
  const name = writeEvent(legacy, '2026-01-01T00:00:00.000Z', '000000', 'followup.added', {
    id: 'FU-aaaaaa', statement: 'legacy item', source: { kind: 'manual' },
  });
  return { ...f, legacy, name };
}

test('DOFLOW_UPKEEP=off leaves project, user and config state byte-identical when every root is due', t => {
  const f = fixture(t);
  for (const id of ['project-state', 'user-state', 'config-home']) {
    const root = f.roots[id];
    fs.writeFileSync(path.join(root, 'upkeep-due'), `${Math.floor((NOW - DAY) / 1000)}\n`);
    fs.writeFileSync(path.join(root, `preserve-${id}.txt`), `${id} state\n`);
  }
  fs.writeFileSync(path.join(f.projectRoot, '.doflow', 'prune'), 'on\n');
  fs.writeFileSync(path.join(f.roots['config-home'], 'prune'), 'on\n');
  const oldLog = path.join(f.roots['project-state'], 'verification', 'logs', `${NOW - 31 * DAY}-expired.log`);
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, 'expired log\n');
  f.env.DOFLOW_UPKEEP = 'off';

  const before = snapshotRoots(f.roots);
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.existsSync(path.join(f.roots['project-state'], '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(f.roots['user-state'], '.gitignore')), false);
  assert.deepEqual(snapshotRoots(f.roots), before);
  assert.equal(fs.existsSync(path.join(f.roots['user-state'], 'upkeep-roots')), false);
  for (const id of ['project-state', 'user-state', 'config-home']) {
    assert.equal(fs.existsSync(path.join(f.roots[id], 'upkeep.lock')), false);
    assert.equal(fs.existsSync(path.join(f.roots[id], 'runs', 'telemetry')), false);
  }
  assert.equal(fs.existsSync(path.join(f.roots['project-state'], 'runs')), false);
  assert.equal(fs.existsSync(path.join(f.roots['user-state'], 'runs')), false);
});

test('DOFLOW_UPKEEP=off leaves an expired settled event and missing marker untouched', t => {
  const f = fixture(t);
  const events = path.join(f.projectRoot, EVENTS_REL);
  writeEvent(events, '2026-01-01T00:00:00.000Z', '000000', 'followup.added', {
    id: 'FU-bbbbbb', statement: 'old settled item', source: { kind: 'manual' },
  });
  writeEvent(events, '2026-01-01T00:01:00.000Z', '000001', 'followup.settled', {
    id: 'FU-bbbbbb', as: 'dismissed', reason: 'closed',
  });
  const env = { ...f.env, DOFLOW_UPKEEP: 'off', DOFLOW_RETENTION_HOURS: '1' };
  const before = treeSnapshot(f.projectRoot);

  const result = prepareStore(f.projectRoot, { env, now: new Date(NOW) });

  assert.deepEqual(result, { ok: true, lines: [] });
  assert.deepEqual(treeSnapshot(f.projectRoot), before);
  assert.equal(fs.existsSync(path.join(f.projectRoot, MARKER_REL)), false);
});

test('DOFLOW_UPKEEP=off refuses pending legacy migration through the real followup CLI without writes', t => {
  const f = legacyProject(t);
  const emptyNewStore = path.join(f.projectRoot, EVENTS_REL);
  fs.mkdirSync(emptyNewStore, { recursive: true });
  f.env.DOFLOW_UPKEEP = 'off';
  const before = treeSnapshot(f.dir);

  const result = runCli(f.projectRoot, ['followup', '--action', 'list', '--json'], f.env);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.action, 'list');
  assert.equal(report.finding, 'store-migration-pending');
  assert.equal(report.message, MIGRATION_MESSAGE);
  assert.deepEqual(treeSnapshot(f.dir), before);
  assert.deepEqual(fs.readdirSync(emptyNewStore), []);
  assert.equal(fs.existsSync(path.join(f.projectRoot, MARKER_REL)), false);
});

test('doctor reports the exact upkeep switch in text and JSON only when it is set to off', t => {
  const f = fixture(t);
  const onEnv = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const textOn = runCli(f.projectRoot, ['doctor'], onEnv);
  const jsonOn = runCli(f.projectRoot, ['doctor', '--json'], onEnv);
  assert.equal(jsonOn.status, textOn.status, jsonOn.stderr);
  assert.equal(textOn.stdout.split('\n').filter(line => line === DOCTOR_NOTE).length, 1);
  assert.equal(JSON.parse(jsonOn.stdout).upkeepSwitch, 'off');

  const offEnv = { ...f.env };
  delete offEnv.DOFLOW_UPKEEP;
  const textOff = runCli(f.projectRoot, ['doctor'], offEnv);
  const jsonOff = runCli(f.projectRoot, ['doctor', '--json'], offEnv);
  assert.equal(jsonOff.status, textOff.status, jsonOff.stderr);
  assert.equal(textOff.stdout.includes(DOCTOR_NOTE), false);
  assert.equal(Object.hasOwn(JSON.parse(jsonOff.stdout), 'upkeepSwitch'), false);
});

test('DOFLOW_UPKEEP=off does not suppress followup add event writes', t => {
  const f = fixture(t);
  f.env.DOFLOW_UPKEEP = 'off';

  const result = runCli(f.projectRoot, ['followup', '--action', 'add', '--source', 'manual', '--statement', 'keep this event', '--json'], f.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const events = path.join(f.projectRoot, EVENTS_REL);
  const files = fs.readdirSync(events).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const event = JSON.parse(fs.readFileSync(path.join(events, files[0]), 'utf8'));
  assert.equal(event.type, 'followup.added');
  assert.equal(event.data.statement, 'keep this event');
});

const NON_OFF_VALUES = [
  ['unset', undefined],
  ['uppercase OFF', 'OFF'],
  ['leading space', ' off'],
  ['trailing space', 'off '],
  ['zero', '0'],
  ['false', 'false'],
  ['no', 'no'],
  ['empty', ''],
];

for (const [label, value] of NON_OFF_VALUES) {
  test(`upkeep still runs when DOFLOW_UPKEEP is ${label}`, t => {
    const f = fixture(t);
    setSwitch(f.env, value);
    upkeep().upkeepAfterVerb(f);
    assert.equal(fs.readFileSync(path.join(f.roots['project-state'], '.gitignore'), 'utf8'), IGNORE);
  });

  test(`legacy migration still copies when DOFLOW_UPKEEP is ${label}`, t => {
    const f = legacyProject(t);
    setSwitch(f.env, value);
    fs.mkdirSync(path.join(f.projectRoot, EVENTS_REL), { recursive: true });

    const result = prepareStore(f.projectRoot, { env: f.env, now: new Date(NOW) });

    assert.equal(result.ok, true);
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, EVENTS_REL)), [f.name]);
    assert.equal(fs.existsSync(path.join(f.projectRoot, MARKER_REL)), true);
  });
}
