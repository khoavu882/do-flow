'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LEGACY_MANIFEST_FILE_NAME, manifestPath, readManifest, writeManifest } = require('../src/manifest');

const REPO = path.resolve(__dirname, '..');
const DATE = new Date('2026-07-24T00:00:00Z');

// Codex/Claude/Gemini native lifecycle surfaces are no longer generic copier mappings at all —
// bin/mappings.conf and the copier that read it (src/copy.js, src/mappings.js, src/diff.js) were
// deleted entirely in Phase I (012-legacy-surface-retirement) once every asset they used to copy
// became adapter-owned via the registry/lifecycle path. This file's remaining tests cover a
// different, still-live legacy bridge: reading the pre-registry .install-manifest.json format
// (src/manifest.js), which migrateLegacyManifest (src/state/) still imports from.

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
