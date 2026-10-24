'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
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

function fixture(t: any) {
  const dir = tempDir(t, 'doflow-upkeep-switch-');
  const projectRoot = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const env: any = {
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

function setSwitch(env: any, value: any) {
  if (value === undefined) delete env.DOFLOW_UPKEEP;
  else env.DOFLOW_UPKEEP = value;
}

function writeEvent(folder: any, at: any, suffix: any, type: any, data: any) {
  fs.mkdirSync(folder, { recursive: true });
  const id = `${at.replace(/[-:.]/g, '')}-${suffix}`;
  fs.writeFileSync(path.join(folder, `${id}.json`), `${JSON.stringify({ v: 1, id, at, type, by: 'agent', data })}\n`);
  return `${id}.json`;
}

function treeSnapshot(root: any) {
  const entries: any = {};
  const visit = (dir: any) => {
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

function snapshotRoots(roots: any) {
  return Object.fromEntries(['project-state', 'user-state', 'config-home'].map(id => [id, treeSnapshot(roots[id])]));
}

function writeExpiredVerificationEntries(f: any) {
  const logsStore = registry.stores.find((store: any) => store.id === 'verification-logs');
  const reuseStore = registry.stores.find((store: any) => store.id === 'verification-reuse');
  const logsDir = path.join(f.roots[logsStore.root], logsStore.path);
  const reuseDir = path.join(f.roots[reuseStore.root], reuseStore.path);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(reuseDir, { recursive: true });
  for (let index = 0; index < logsStore.bound.keepNewest + 5; index += 1) {
    const at = NOW - (logsStore.bound.maxAgeDays + 60) * DAY - index * 1000;
    fs.writeFileSync(path.join(logsDir, `${at}-expired-${index}.log`), 'expired verification log\n');
  }
  for (let index = 0; index < 2; index += 1) {
    const file = path.join(reuseDir, `reuse-${String(index + 1).padStart(16, '0')}.json`);
    fs.writeFileSync(file, '{}\n');
    const expiredAt: any = new Date(NOW - (reuseStore.bound.maxAgeDays + 1) * DAY);
    fs.utimesSync(file, expiredAt, expiredAt);
  }
  return { logsDir, reuseDir };
}

function writeRecoveryEntries(roots: any, storeId: any) {
  const store = registry.stores.find((candidate: any) => candidate.id === storeId);
  const root = roots[store.root];
  const recoveryDir = path.join(root, store.path);
  fs.mkdirSync(recoveryDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger.json'), '{"lastRecoveryId":"recovery_d"}\n');
  for (const suffix of ['a', 'b', 'c', 'd']) {
    fs.writeFileSync(path.join(recoveryDir, `recovery_${suffix}.json`), `{"id":"recovery_${suffix}"}\n`);
  }
  return recoveryDir;
}

function assertNoUpkeepArtifacts(roots: any) {
  for (const id of ['project-state', 'user-state', 'config-home']) {
    assert.equal(fs.existsSync(path.join(roots[id], 'upkeep.lock')), false);
    assert.equal(fs.existsSync(path.join(roots[id], 'runs')), false);
  }
}

function fileCount(dir: any) {
  return fs.readdirSync(dir).filter((name: any) => fs.statSync(path.join(dir, name)).isFile()).length;
}

function runCli(cwd: any, args: any, env: any) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function legacyProject(t: any) {
  const f = fixture(t);
  const legacy = path.join(f.projectRoot, LEGACY_EVENTS_REL);
  const name = writeEvent(legacy, '2026-01-01T00:00:00.000Z', '000000', 'followup.added', {
    id: 'FU-aaaaaa', statement: 'legacy item', source: { kind: 'manual' },
  });
  return { ...f, legacy, name };
}

test('DOFLOW_UPKEEP=off leaves project, user and config state byte-identical when every root is due', t => {
  const f: any = fixture(t);
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
  const env: any = { ...f.env, DOFLOW_UPKEEP: 'off', DOFLOW_RETENTION_HOURS: '1' };
  const before = treeSnapshot(f.projectRoot);

  const result = prepareStore(f.projectRoot, { env, now: new Date(NOW) });

  assert.deepEqual(result, { ok: true, lines: [] });
  assert.deepEqual(treeSnapshot(f.projectRoot), before);
  assert.equal(fs.existsSync(path.join(f.projectRoot, MARKER_REL)), false);
});

test('DOFLOW_UPKEEP=off refuses pending legacy migration through the real followup CLI without writes', t => {
  const f: any = legacyProject(t);
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
  const onEnv: any = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const textOn = runCli(f.projectRoot, ['doctor'], onEnv);
  const jsonOn = runCli(f.projectRoot, ['doctor', '--json'], onEnv);
  assert.equal(jsonOn.status, textOn.status, jsonOn.stderr);
  assert.equal(textOn.stdout.split('\n').filter((line: any) => line === DOCTOR_NOTE).length, 1);
  assert.equal(JSON.parse(jsonOn.stdout).upkeepSwitch, 'off');

  const offEnv: any = { ...f.env };
  delete offEnv.DOFLOW_UPKEEP;
  const textOff = runCli(f.projectRoot, ['doctor'], offEnv);
  const jsonOff = runCli(f.projectRoot, ['doctor', '--json'], offEnv);
  assert.equal(jsonOff.status, textOff.status, jsonOff.stderr);
  assert.equal(textOff.stdout.includes(DOCTOR_NOTE), false);
  assert.equal(Object.hasOwn(JSON.parse(jsonOff.stdout), 'upkeepSwitch'), false);
});

test('DOFLOW_UPKEEP=off does not suppress followup add event writes', t => {
  const f: any = fixture(t);
  f.env.DOFLOW_UPKEEP = 'off';

  const result = runCli(f.projectRoot, ['followup', '--action', 'add', '--source', 'manual', '--statement', 'keep this event', '--json'], f.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const events = path.join(f.projectRoot, EVENTS_REL);
  const files = fs.readdirSync(events).filter((name: any) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const event = JSON.parse(fs.readFileSync(path.join(events, files[0]), 'utf8'));
  assert.equal(event.type, 'followup.added');
  assert.equal(event.data.statement, 'keep this event');
});

test('upkeepAfterVerify exact off leaves expired verification entries and roots unchanged', t => {
  const f: any = fixture(t);
  const { logsDir, reuseDir } = writeExpiredVerificationEntries(f);
  f.env.DOFLOW_UPKEEP = 'off';
  const before = treeSnapshot(f.dir);

  upkeep().upkeepAfterVerify({ projectRoot: f.projectRoot, env: f.env, now: f.now });

  assert.deepEqual(treeSnapshot(f.dir), before);
  assert.equal(fileCount(logsDir), registry.stores.find((store: any) => store.id === 'verification-logs').bound.keepNewest + 5);
  assert.equal(fileCount(reuseDir), 2);
  assertNoUpkeepArtifacts(f.roots);
});

test('upkeepAfterVerify with the switch unset prunes expired verification entries', t => {
  const f = fixture(t);
  const { logsDir, reuseDir } = writeExpiredVerificationEntries(f);
  setSwitch(f.env, undefined);

  upkeep().upkeepAfterVerify({ projectRoot: f.projectRoot, env: f.env, now: f.now });

  assert.equal(fileCount(logsDir), 0);
  assert.equal(fileCount(reuseDir), 0);
});

test('storageAfterInstall exact off leaves project and global scopes unchanged', async t => {
  for (const scope of ['project', 'global']) {
    await t.test(`${scope} scope`, (t: any) => {
      const f: any = fixture(t);
      const rootId = scope === 'global' ? 'user-state' : 'project-state';
      const storeId = scope === 'global' ? 'recovery-user' : 'recovery-project';
      writeRecoveryEntries(f.roots, storeId);
      f.env.DOFLOW_UPKEEP = 'off';
      const before = treeSnapshot(f.dir);

      upkeep().storageAfterInstall({ scope, scopeRoot: scope === 'global' ? f.env.HOME : f.projectRoot, env: f.env, now: f.now });

      assert.deepEqual(treeSnapshot(f.dir), before);
      assert.equal(fs.existsSync(path.join(f.roots[rootId], '.gitignore')), false);
      assert.equal(fs.existsSync(path.join(f.roots['user-state'], 'upkeep-roots')), false);
      assertNoUpkeepArtifacts(f.roots);
    });
  }
});

test('storageAfterInstall with the switch unset writes the ignore file and prunes recovery entries', t => {
  const f = fixture(t);
  const recoveryDir = writeRecoveryEntries(f.roots, 'recovery-project');
  setSwitch(f.env, undefined);

  upkeep().storageAfterInstall({ scope: 'project', scopeRoot: f.projectRoot, env: f.env, now: f.now });

  assert.equal(fs.readFileSync(path.join(f.roots['project-state'], '.gitignore'), 'utf8'), IGNORE);
  assert.equal(fileCount(recoveryDir), registry.stores.find((store: any) => store.id === 'recovery-project').bound.keepNewest);
});

const NON_OFF_MOMENT_VALUES: any = [
  ['uppercase OFF', 'OFF'],
  ['leading space', ' off'],
  ['zero', '0'],
  ['false', 'false'],
  ['empty string', ''],
];

for (const [label, value] of NON_OFF_MOMENT_VALUES) {
  test(`upkeepAfterVerify and storageAfterInstall run when DOFLOW_UPKEEP is ${label}`, t => {
    const verify = fixture(t);
    const { logsDir } = writeExpiredVerificationEntries(verify);
    setSwitch(verify.env, value);
    upkeep().upkeepAfterVerify({ projectRoot: verify.projectRoot, env: verify.env, now: verify.now });
    assert.equal(fileCount(logsDir), 0);

    const install = fixture(t);
    setSwitch(install.env, value);
    upkeep().storageAfterInstall({ scope: 'project', scopeRoot: install.projectRoot, env: install.env, now: install.now });
    assert.equal(fs.readFileSync(path.join(install.roots['project-state'], '.gitignore'), 'utf8'), IGNORE);
  });
}

const NON_OFF_VALUES: any = [
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
