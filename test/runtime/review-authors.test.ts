'use strict';

// Feature 120 D.1 (IC-015, IC-016): authoring identities read-only extractor.
// Evaluates the authoring identities set: record's author, dispatches that reached submit
// (subagent: requested, served; sequential: primary snapshot), and the resolved primary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { storeFileFor } = require('../../src/runtime/dispatch/store.ts');
const { authoringIdentities } = require('../../src/runtime/review/identity.ts');

test('authoringIdentities: empty when no record and no dispatch store exists', (t) => {
  const dir = tempDir(t, 'doflow-authors-empty-');
  const rows = authoringIdentities({ slug: '001-test', cwd: dir });
  assert.deepEqual(rows, []);
});

test('authoringIdentities: extracts record author and primary when matching', (t) => {
  const dir = tempDir(t, 'doflow-authors-record-');
  // Record author without harness produces no row
  const r1 = { author: { agent: 'codex', session: 's1', family: 'codex' } };
  assert.deepEqual(authoringIdentities({ slug: '001-test', cwd: dir, record: r1 }), []);

  // Record author with harness and model
  const r2 = { author: { agent: 'codex', session: 's1', family: 'codex', harness: 'codex', model: 'gpt-4o' } };
  // Mock primary that does not match author harness
  const rowsNoMatch = authoringIdentities({
    slug: '001-test',
    cwd: dir,
    record: r2,
    primary: { harness: 'claude', model: 'sonnet', state: 'confirmed' },
  });
  assert.deepEqual(rowsNoMatch, [
    { kind: 'record', harness: 'codex', model: 'gpt-4o', channel: 'claim' },
  ]);

  // When author.harness matches primary.harness and primary is confirmed
  const rowsMatch = authoringIdentities({
    slug: '001-test',
    cwd: dir,
    record: r2,
    primary: { harness: 'codex', model: 'gpt-4o-confirmed', state: 'confirmed' },
  });
  assert.deepEqual(rowsMatch, [
    { kind: 'record', harness: 'codex', model: 'gpt-4o', channel: 'claim' },
    { kind: 'primary', harness: 'codex', model: 'gpt-4o-confirmed', channel: 'observed' },
  ]);

  // When author.harness matches primary.harness but state is not confirmed
  const rowsUnverified = authoringIdentities({
    slug: '001-test',
    cwd: dir,
    record: r2,
    primary: { harness: 'codex', model: 'gpt-4o-unverified', state: 'unverified' },
  });
  assert.deepEqual(rowsUnverified, [
    { kind: 'record', harness: 'codex', model: 'gpt-4o', channel: 'claim' },
    { kind: 'primary', harness: 'codex', model: 'gpt-4o-unverified', channel: 'claim' },
  ]);
});

test('authoringIdentities: extracts subagent dispatches that reached submit', (t) => {
  const dir = tempDir(t, 'doflow-authors-subagent-');
  fs.mkdirSync(path.join(dir, '.git'));
  const storeFile = storeFileFor(dir, 'feat-subagent');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });

  const storeData = {
    version: 1,
    revision: 1,
    slug: 'feat-subagent',
    run: { runId: 'p-123456789012', state: 'running' },
    lease: null,
    drivers: [],
    spawnRequests: {},
    steps: [],
    dispatches: {
      // Reached submit: subagent on codex (supported descriptor: requested is observed)
      'd-1': {
        dispatchId: 'd-1',
        seq: 0,
        mode: 'subagent',
        harness: 'codex',
        phase: 'collected',
        collectedAt: '2026-10-24T12:00:00.000Z',
        outcome: 'offered',
        model: {
          requested: 'o3-mini',
          served: 'o3-mini-2025-01-31',
          source: 'binding',
          tier: 'standard',
        },
      },
      // Reached submit: subagent on claude (descriptor model status unknown: requested is claim)
      'd-2': {
        dispatchId: 'd-2',
        seq: 0,
        mode: 'subagent',
        harness: 'claude',
        phase: 'ended',
        collectedAt: '2026-10-24T13:00:00.000Z',
        endedAt: '2026-10-24T13:05:00.000Z',
        outcome: 'offered',
        commit: '1234567890123456789012345678901234567890',
        model: {
          requested: 'claude-3-5-sonnet',
          served: 'claude-3-5-sonnet-20241022',
          source: 'binding',
          tier: 'frontier',
        },
      },
      // NOT reached submit: launched but no collectedAt/commit
      'd-3': {
        dispatchId: 'd-3',
        seq: 0,
        mode: 'subagent',
        harness: 'codex',
        phase: 'launched',
        model: {
          requested: 'gpt-4o',
          served: null,
          source: 'binding',
        },
      },
      // NOT reached submit: ended with stale before submit
      'd-4': {
        dispatchId: 'd-4',
        seq: 0,
        mode: 'subagent',
        harness: 'antigravity',
        phase: 'ended',
        disposition: 'stale',
        staleReason: 'epoch',
        model: {
          requested: 'gemini-1.5-pro',
          served: null,
        },
      },
    },
  };

  fs.writeFileSync(storeFile, JSON.stringify(storeData, null, 2), 'utf8');

  const rows = authoringIdentities({ slug: 'feat-subagent', cwd: dir });
  assert.deepEqual(rows, [
    { kind: 'subagent', harness: 'codex', model: 'o3-mini-2025-01-31', channel: 'observed' },
    { kind: 'subagent', harness: 'codex', model: 'o3-mini', channel: 'observed' },
    { kind: 'subagent', harness: 'claude', model: 'claude-3-5-sonnet-20241022', channel: 'observed' },
    { kind: 'subagent', harness: 'claude', model: 'claude-3-5-sonnet', channel: 'claim' },
  ]);
});

test('authoringIdentities: extracts sequential dispatches that reached submit', (t) => {
  const dir = tempDir(t, 'doflow-authors-sequential-');
  fs.mkdirSync(path.join(dir, '.git'));
  const storeFile = storeFileFor(dir, 'feat-seq');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });

  const storeData = {
    version: 1,
    revision: 1,
    slug: 'feat-seq',
    run: { runId: 'p-123456789012', state: 'running' },
    lease: null,
    drivers: [],
    spawnRequests: {},
    steps: [],
    dispatches: {
      // Sequential with primary snapshot and requested model binding
      'd-1': {
        dispatchId: 'd-1',
        seq: 0,
        mode: 'sequential',
        phase: 'collected',
        collectedAt: '2026-10-24T12:00:00.000Z',
        outcome: 'offered',
        primary: {
          harness: 'codex',
          model: 'gpt-4o',
          state: 'confirmed',
        },
        model: {
          requested: 'gpt-4o-mini',
          source: 'binding',
        },
      },
      // Sequential without requested model -> model unknown
      'd-2': {
        dispatchId: 'd-2',
        seq: 0,
        mode: 'sequential',
        phase: 'ended',
        collectedAt: '2026-10-24T13:00:00.000Z',
        outcome: 'offered',
        primary: {
          harness: 'claude',
          model: 'sonnet',
          state: 'confirmed',
        },
        model: null,
      },
    },
  };

  fs.writeFileSync(storeFile, JSON.stringify(storeData, null, 2), 'utf8');

  const rows = authoringIdentities({ slug: 'feat-seq', cwd: dir });
  assert.deepEqual(rows, [
    { kind: 'sequential', harness: 'codex', model: 'gpt-4o-mini', channel: 'claim' },
    { kind: 'sequential', harness: 'claude', model: 'unknown', channel: 'claim' },
  ]);
});
