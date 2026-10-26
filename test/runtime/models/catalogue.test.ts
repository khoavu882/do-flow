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
          loginState: 'logged-in',
          reloginHint: null,
          detectedMode: 'subscription',
          derivedBilling: 'free',
          offeredModels: [{ id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' }],
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

test('Slice A: syncHarness and syncAllHarnesses with mock probe runners', async () => {
  const tmpProject = createTempDir('proj-sync');

  try {
    const mockExecFile = (bin: string, args: string[], opts: any, callback: any) => {
      if (args.includes('--version')) {
        callback(null, 'mock-tool 2.1.0\n', '');
      } else if (args.includes('status')) {
        callback(null, 'Logged in as mock user\n', '');
      } else if (args.includes('auth')) {
        callback(null, JSON.stringify([{ type: 'oauth', provider: 'mock' }]), '');
      } else {
        callback(null, '', '');
      }
    };

    const result = await syncHarness('claude', {
      projectRoot: tmpProject,
      execFileImpl: mockExecFile,
      env: { ANTHROPIC_API_KEY: 'test-key' },
    });

    assert.equal(result.harnessId, 'claude');
    assert.equal(result.installed, true);
    assert.equal(result.loginState, 'logged-in');
    assert.equal(result.detectedMode, 'api-key');
    assert.equal(result.derivedBilling, 'metered');

    const catalogue = await syncAllHarnesses({
      projectRoot: tmpProject,
      execFileImpl: mockExecFile,
      env: { ANTHROPIC_API_KEY: 'test-key' },
    });

    assert.equal(catalogue.version, 1);
    assert.ok(catalogue.harnesses.claude);
    assert.ok(catalogue.harnesses.codex);
    assert.ok(catalogue.harnesses.opencode);
    assert.ok(catalogue.harnesses.pi);
    assert.ok(catalogue.harnesses.copilot);
    assert.ok(catalogue.harnesses.kiro);
    assert.ok(catalogue.harnesses.antigravity);

    // Verify it was written to disk
    const onDisk = readCatalogue(tmpProject);
    assert.deepEqual(onDisk, catalogue);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});
