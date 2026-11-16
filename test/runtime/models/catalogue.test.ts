'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');

const {
  readCatalogue,
  writeCatalogue,
  syncHarness,
  syncAllHarnesses,
  getProjectCataloguePath,
  getUserCataloguePath,
} = require('../../../src/runtime/models/catalogue.ts');
import type { ObservedCatalogue } from '../../../src/runtime/models/catalogue.ts';

function createTempDir(prefix: string): string {
  return suiteTempDir(`doflow-test-${prefix}-`);
}

test('Slice A: catalogue path resolution', () => {
  const tmpProject = createTempDir('proj');
  const tmpHome = createTempDir('home');

  try {
    const projExpected = path.join(tmpProject, '.doflow', 'state', 'models', 'catalogue.json');
    assert.equal(getProjectCataloguePath(tmpProject), projExpected);

    const userExpected = path.join(tmpHome, '.config', 'doflow', 'state', 'models-observed.json');
    assert.equal(getUserCataloguePath(tmpHome), userExpected);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Slice A: writeCatalogue writes atomically and readCatalogue reads from project root', () => {
  const tmpProject = createTempDir('proj');

  try {
    const catalogue: ObservedCatalogue = {
      version: 1,
      syncedAt: '2026-10-25T12:00:00.000Z',
      harnesses: {
        claude: {
          harnessId: 'claude',
          binary: 'claude',
          installed: true,
          version: '1.0.0',
          detectedMode: 'subscription',
          derivedBilling: 'free',
          offeredModels: [{ id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' }],
          modelList: { status: 'listed' },
          lastSyncedAt: '2026-10-25T12:00:00.000Z',
        },
      },
    };

    writeCatalogue(catalogue, tmpProject);

    const targetFile = getProjectCataloguePath(tmpProject);
    assert.ok(fs.existsSync(targetFile), 'target file should exist');

    const read = readCatalogue(tmpProject);
    assert.deepEqual(read, catalogue);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('Slice A: readCatalogue falls back to user cache when project file is absent', () => {
  const tmpProject = createTempDir('proj-empty');
  const tmpHome = createTempDir('home');

  try {
    const catalogue: ObservedCatalogue = {
      version: 1,
      syncedAt: '2026-10-25T12:00:00.000Z',
      harnesses: {},
    };

    const userPath = getUserCataloguePath(tmpHome);
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(catalogue, null, 2), 'utf8');

    // Read with projectRoot where project catalogue does not exist
    const read = readCatalogue(tmpProject, { homeDir: tmpHome });
    assert.deepEqual(read, catalogue);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Slice A: readCatalogue handles corrupt file fail-safe by moving it aside and returning null', () => {
  const tmpProject = createTempDir('proj-corrupt');

  try {
    const targetFile = getProjectCataloguePath(tmpProject);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, 'NOT_VALID_JSON{', 'utf8');

    const read = readCatalogue(tmpProject);
    assert.equal(read, null);

    // Target file should have been moved aside
    assert.equal(fs.existsSync(targetFile), false, 'corrupt file should be moved aside');

    const dirFiles = fs.readdirSync(path.dirname(targetFile));
    const corruptBackup = dirFiles.find((f: string) => f.startsWith('catalogue.json.corrupt-'));
    assert.ok(corruptBackup, 'corrupt backup file should exist');
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('Slice A: readCatalogue drops the login fields an entry written before row 172 carries', () => {
  const tmpProject = createTempDir('proj-old');
  try {
    const file = getProjectCataloguePath(tmpProject);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { harnessId: 'claude', binary: 'claude', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: [], modelList: { status: 'none-recorded', reason: 'x' }, lastSyncedAt: '2026-10-25T12:00:00.000Z' };
    fs.writeFileSync(file, JSON.stringify({ version: 1, syncedAt: '2026-10-25T12:00:00.000Z', harnesses: { claude: { ...entry, loginState: 'logged-in', reloginHint: 'claude login', loginCheck: 'probe' } } }));
    assert.deepEqual(readCatalogue(tmpProject).harnesses.claude, entry);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('Slice A: syncHarness and syncAllHarnesses against a fake claude on a scratch PATH', { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink on POSIX' }, async () => {
  const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
  const { linkBin, writeScenario, readLog } = require('../../helper/fake-harness-cli.ts');
  const { loadRegistry } = require('../../../src/registry/index.ts');
  const scratch = createScratch('doflow-catalogue-sync-');
  const log = path.join(scratch.dir, 'log.jsonl');
  const scenario = { byArgv: [
    { argv: ['--version'], steps: [{ print: 'mock-tool 2.1.0' }, { exit: 0 }] },
    { argv: ['auth', 'status', '--json'], steps: [{ print: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) }, { exit: 0 }] },
  ] };
  const env = childEnv(scratch, { PATH: linkBin(path.join(scratch.dir, 'bin'), ['fake-claude']), FAKE_HARNESS_SCENARIO: writeScenario(scratch.dir, scenario), FAKE_HARNESS_LOG: log });
  const registry = structuredClone(loadRegistry({ repoRoot: path.resolve(__dirname, '..', '..', '..') }));
  const claude = registry.harnesses.find((h: any) => h.id === 'claude');
  claude.worker.cli = { ...claude.worker.cli, binary: 'fake-claude' };
  const tmpProject = createTempDir('proj-sync');
  const NO_PACKAGES = { packages: [], stateRead: { state: {} }, grants: { grants: [] } };

  try {
    const result = await syncHarness('claude', { projectRoot: tmpProject, env, registry, view: NO_PACKAGES });
    assert.deepEqual([result.harnessId, result.binary, result.installed, result.version], ['claude', 'fake-claude', true, '2.1.0']);
    assert.deepEqual([result.detectedMode, result.derivedBilling], ['api-key', 'metered']);
    assert.equal('loginState' in result, false);

    const catalogue = await syncAllHarnesses({ projectRoot: tmpProject, env, registry, view: NO_PACKAGES });
    assert.equal(catalogue.version, 1);
    assert.deepEqual(Object.keys(catalogue.harnesses).sort(), registry.harnesses.map((h: any) => h.id).sort());
    for (const [id, h] of Object.entries<any>(catalogue.harnesses)) {
      if (id !== 'claude') assert.deepEqual([h.installed, h.version, h.detectedMode], [false, null, 'unverified'], id);
    }
    assert.deepEqual(readLog(log).map((entry: any) => entry.argv), [['--version'], ['auth', 'status', '--json'], ['--version'], ['auth', 'status', '--json']]);

    // Verify it was written to disk
    const onDisk = readCatalogue(tmpProject);
    assert.deepEqual(onDisk, catalogue);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});
