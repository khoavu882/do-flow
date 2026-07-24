'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeManifest } = require('../src/manifest');
const {
  STATE_VERSION, stateRoot, ledgerPath, defaultLedger, readLedger, writeLedger,
  writeRecoveryRecord, readRecoveryRecord, migrateLegacyManifest,
} = require('../src/state');

const REPO = path.resolve(__dirname, '..');
const DATE = new Date('2026-07-24T12:34:56Z');
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-state-')); }

test('state roots are neutral and scope-specific', () => {
  const root = scratch();
  assert.equal(stateRoot({ scope: 'project', projectRoot: root }), path.join(root, '.doflow', 'state'));
  assert.equal(stateRoot({ scope: 'global', homeDir: root }), path.join(root, '.doflow', 'state'));
  assert.throws(() => stateRoot({ scope: 'other', projectRoot: root }), /Invalid state scope/);
});

test('ledger writes atomically and round-trips without a harness directory', () => {
  const root = path.join(scratch(), 'project', '.doflow', 'state');
  const ledger = defaultLedger({ scope: 'project', scopeRoot: path.dirname(path.dirname(root)) });
  ledger.resources.push({ harness: 'gemini', scope: 'project', assetId: 'guidance.core', target: 'GEMINI.md', ownershipIdentity: 'managed-section' });
  writeLedger(root, ledger);
  assert.deepEqual(readLedger(root), ledger);
  assert.equal(fs.readdirSync(root).filter((file) => file.endsWith('.tmp')).length, 0);
  assert.ok(fs.existsSync(ledgerPath(root)));
});

test('recovery records are append-only, atomically readable journals', () => {
  const root = path.join(scratch(), '.doflow', 'state');
  const first = writeRecoveryRecord(root, { changes: [{ operation: 'update', target: '.codex/config.toml' }] }, { now: DATE });
  const second = writeRecoveryRecord(root, { status: 'verified' }, { now: DATE });
  assert.notEqual(first.id, second.id);
  assert.equal(readRecoveryRecord(root, first.id).status, 'pending');
  assert.equal(readRecoveryRecord(root, first.id).changes[0].target, '.codex/config.toml');
  assert.throws(() => readRecoveryRecord(root, '../escape'), /Invalid recovery id/);
});

test('legacy manifest migration imports explicit ownership once and leaves the legacy file untouched', () => {
  const project = scratch();
  const claude = path.join(project, '.claude');
  writeManifest({
    claudeDir: claude, scriptVersion: '2.4.4', operation: 'install', repoRoot: REPO,
    backupId: 'install_2026-07-24_12-34-56', tools: ['claude', 'codex'], date: DATE,
    mcpServers: ['context7'], managedResources: [{ target: 'codex', scope: 'project', kind: 'mcp-server', identity: 'context7', sourceVersion: '2.4.4', fingerprint: 'abc', selection: true }],
  });
  const legacyBefore = fs.readFileSync(path.join(claude, '.install-manifest.json'), 'utf8');
  const root = stateRoot({ scope: 'project', projectRoot: project });
  const first = migrateLegacyManifest({ root, scope: 'project', scopeRoot: project, claudeDir: claude, now: DATE });
  assert.equal(first.migrated, true);
  assert.deepEqual(first.ledger.mcpSelections, { claude: ['context7'] });
  assert.equal(first.ledger.resources.length, 1);
  assert.deepEqual(first.ledger.resources[0], {
    harness: 'codex', scope: 'project', assetId: 'legacy.mcp-server', target: 'codex', ownershipIdentity: 'context7',
    sourceVersion: '2.4.4', fingerprint: 'abc', projection: { legacyKind: 'mcp-server' }, recoveryRef: null, selection: true,
  });
  assert.equal(fs.readFileSync(path.join(claude, '.install-manifest.json'), 'utf8'), legacyBefore);
  const second = migrateLegacyManifest({ root, scope: 'project', scopeRoot: project, claudeDir: claude, now: new Date('2026-07-25T00:00:00Z') });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already-imported');
  assert.equal(second.ledger.resources.length, 1);
  assert.equal(second.ledger.version, STATE_VERSION);
});

test('legacy migration does not create ownership from tool-only or malformed legacy state', () => {
  const project = scratch();
  const claude = path.join(project, '.claude');
  writeManifest({ claudeDir: claude, scriptVersion: '2.4.4', operation: 'install', repoRoot: REPO, tools: ['gemini'], date: DATE });
  const root = stateRoot({ scope: 'project', projectRoot: project });
  const migrated = migrateLegacyManifest({ root, scope: 'project', scopeRoot: project, claudeDir: claude, now: DATE });
  assert.equal(migrated.ledger.resources.length, 0);
  assert.ok(migrated.ledger.targets.gemini.imported);

  const invalidProject = scratch();
  const invalidClaude = path.join(invalidProject, '.claude');
  fs.mkdirSync(invalidClaude, { recursive: true });
  fs.writeFileSync(path.join(invalidClaude, '.install-manifest.json'), '{ invalid');
  const invalid = migrateLegacyManifest({ root: stateRoot({ scope: 'project', projectRoot: invalidProject }), scope: 'project', scopeRoot: invalidProject, claudeDir: invalidClaude, now: DATE });
  assert.equal(invalid.migrated, false);
  assert.equal(invalid.reason, 'legacy-invalid');
  assert.equal(readLedger(stateRoot({ scope: 'project', projectRoot: invalidProject })), null);
});
