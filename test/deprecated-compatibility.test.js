'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMappings } = require('../src/mappings');
const { LEGACY_MANIFEST_FILE_NAME, manifestPath, readManifest, writeManifest } = require('../src/manifest');

const REPO = path.resolve(__dirname, '..');
const MAP = path.join(REPO, 'bin', 'mappings.conf');
const DATE = new Date('2026-07-24T00:00:00Z');

test('Codex native lifecycle surfaces are no longer generic copier mappings', () => {
  const codex = readMappings(MAP, 'codex');
  assert.ok(!codex.some((entry) => ['core/harnesses/codex/config/config.toml', 'core/harnesses/codex/hooks/hooks.json', 'core/harnesses/codex/hooks/'].includes(entry.src)));
  for (const source of ['core/shared/guidance/rules/', 'core/shared/agent-specs/', 'core/shared/skills/', 'core/shared/scripts/', 'core/shared/templates/', 'core/shared/guidance/CLAUDE.md']) {
    assert.ok(codex.some((entry) => entry.src === source), `shared Codex compatibility asset retained: ${source}`);
  }
  assert.ok(readMappings(MAP, 'claude').some((entry) => entry.src === 'core/harnesses/claude/hooks/'), 'Claude hook mapping remains compatible');
  assert.ok(readMappings(MAP, 'gemini').some((entry) => entry.src === 'core/shared/skills/'), 'Gemini shared mapping remains compatible');
});

test('legacy manifest bridge remains idempotent across registry migration-era writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-legacy-bridge-'));
  const claudeDir = path.join(root, '.claude');
  assert.equal(path.basename(manifestPath(claudeDir)), LEGACY_MANIFEST_FILE_NAME);
  writeManifest({ claudeDir, scriptVersion: '2.4.4', operation: 'install', repoRoot: REPO, sourceCommit: 'test', tools: ['claude', 'codex'], date: DATE,
    managedResources: [{ target: 'codex', scope: 'project', kind: 'mcp-server', identity: 'context7' }] });
  writeManifest({ claudeDir, scriptVersion: '2.4.4', operation: 'update', repoRoot: REPO, sourceCommit: 'test', tools: ['gemini'], date: new Date('2026-07-25T00:00:00Z') });
  const read = readManifest(claudeDir);
  assert.deepEqual(Object.keys(read.tools).sort(), ['claude', 'codex', 'gemini']);
  assert.deepEqual(read.managedResources, [{ target: 'codex', scope: 'project', kind: 'mcp-server', identity: 'context7' }]);
});

test('malformed legacy manifest is reported as a conflict-safe error record, not adopted or rewritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-legacy-conflict-'));
  const claudeDir = path.join(root, '.claude'); fs.mkdirSync(claudeDir, { recursive: true });
  const file = manifestPath(claudeDir); const malformed = '{ this is not json'; fs.writeFileSync(file, malformed);
  const read = readManifest(claudeDir);
  assert.equal(read.operation, 'error');
  assert.equal(fs.readFileSync(file, 'utf8'), malformed, 'read bridge must not rewrite malformed legacy state');
});
