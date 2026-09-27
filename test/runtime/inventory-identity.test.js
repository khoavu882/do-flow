'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveAssetIdentity } = require('../../src/runtime/inventory/identity');

// Every ownership identity below is a real shape, copied from a resource recorded by the adapters
// (`doflow:<harness>:<role>[:<discriminator>]`, or a harness-prefixed variant). Inventing a shape
// here would test the projection against a vocabulary no adapter emits.

test('two scopes, different absolute targets, same harness+ownershipIdentity — one identity', () => {
  const project = {
    harness: 'claude', assetId: 'guidance.context-layer', scope: 'project',
    target: '/repo/.doflow/guidance/DOFLOW_CORE.md',
    ownershipIdentity: 'doflow:claude:copy-tree:guidance.context-layer:DOFLOW_CORE.md',
  };
  const global = {
    ...project, scope: 'global', target: '/home/user/.doflow/guidance/DOFLOW_CORE.md',
  };
  const identity = deriveAssetIdentity(project);
  assert.notEqual(identity, null);
  assert.equal(identity, deriveAssetIdentity(global));
  // The join is what the whole verb rests on: the absolute target must not leak into the key.
  assert.ok(!identity.includes('/repo') && !identity.includes('/home/user'));
});

test('the same ownershipIdentity under two harnesses derives two identities', () => {
  const claude = {
    harness: 'claude', scope: 'global', target: '/home/user/.claude/CLAUDE.md',
    ownershipIdentity: 'instructions:managed-section',
  };
  const codex = { ...claude, harness: 'codex', target: '/home/user/.codex/AGENTS.md' };
  assert.notEqual(deriveAssetIdentity(claude), deriveAssetIdentity(codex));
});

test('three managed entries inside one config.toml stay three identities', () => {
  const target = '/home/user/.codex/config.toml';
  const base = { harness: 'codex', assetId: 'guidance.codex-pointer', scope: 'global', target };
  const identities = [
    'doflow:codex:configuration-entry:features.hooks',
    'doflow:codex:mcp-server:context7',
    'doflow:codex:mcp-server:sequential-thinking',
  ].map((ownershipIdentity) => deriveAssetIdentity({ ...base, ownershipIdentity }));

  assert.ok(identities.every((identity) => identity !== null));
  assert.equal(new Set(identities).size, 3);
});

test('the three assets that declare no native directory all derive an identity', () => {
  // guidance.core — a managed region inside a user-owned instruction file.
  const guidanceCore = deriveAssetIdentity({
    harness: 'claude', assetId: 'guidance.core', scope: 'global',
    target: '/home/user/.claude/CLAUDE.md',
    ownershipIdentity: 'doflow:claude:instructions:managed-section',
  });
  assert.notEqual(guidanceCore, null);

  // guidance.codex-pointer — the same in another harness's instruction file.
  const codexPointer = deriveAssetIdentity({
    harness: 'codex', assetId: 'guidance.codex-pointer', scope: 'global',
    target: '/home/user/.codex/AGENTS.md',
    ownershipIdentity: 'doflow:codex:instructions:managed-section',
  });
  assert.notEqual(codexPointer, null);

  // claude.settings — two files written at the harness config root, which must not collapse.
  const settings = deriveAssetIdentity({
    harness: 'claude', assetId: 'claude.settings', scope: 'global',
    target: '/home/user/.claude/settings.json',
    ownershipIdentity: 'doflow:claude:settings:settings.json',
  });
  const keybindings = deriveAssetIdentity({
    harness: 'claude', assetId: 'claude.settings', scope: 'global',
    target: '/home/user/.claude/keybindings.json',
    ownershipIdentity: 'doflow:claude:settings:keybindings.json',
  });
  assert.notEqual(settings, null);
  assert.notEqual(keybindings, null);
  assert.notEqual(settings, keybindings);
});

test('two entries of one copy-tree asset derive two identities', () => {
  const base = {
    harness: 'claude', assetId: 'guidance.context-layer', scope: 'global',
  };
  const core = deriveAssetIdentity({
    ...base, target: '/home/user/.doflow/guidance/DOFLOW_CORE.md',
    ownershipIdentity: 'doflow:claude:copy-tree:guidance.context-layer:DOFLOW_CORE.md',
  });
  const flags = deriveAssetIdentity({
    ...base, target: '/home/user/.doflow/guidance/FLAGS.md',
    ownershipIdentity: 'doflow:claude:copy-tree:guidance.context-layer:FLAGS.md',
  });
  assert.notEqual(core, null);
  assert.notEqual(flags, core);
});

test('the registry asset id is not part of the key', () => {
  const base = {
    harness: 'claude', scope: 'global', target: '/home/user/.claude/CLAUDE.md',
    ownershipIdentity: 'doflow:claude:instructions:managed-section',
  };
  assert.equal(
    deriveAssetIdentity({ ...base, assetId: 'guidance.core' }),
    deriveAssetIdentity({ ...base, assetId: 'something.else' }),
  );
  assert.notEqual(deriveAssetIdentity({ ...base, assetId: undefined }), null);
});

test('a missing or empty harness or ownershipIdentity returns null rather than a partial key', () => {
  const complete = {
    harness: 'claude', scope: 'global', target: '/home/user/.claude/CLAUDE.md',
    ownershipIdentity: 'doflow:claude:instructions:managed-section',
  };
  assert.notEqual(deriveAssetIdentity(complete), null);

  assert.equal(deriveAssetIdentity(null), null);
  assert.equal(deriveAssetIdentity({}), null);
  // Reachable despite the lifecycle boundary enforcing ownershipIdentity: a ledger is hand-editable.
  assert.equal(deriveAssetIdentity({ ...complete, ownershipIdentity: undefined }), null);
  assert.equal(deriveAssetIdentity({ ...complete, ownershipIdentity: '' }), null);
  assert.equal(deriveAssetIdentity({ ...complete, harness: undefined }), null);
  assert.equal(deriveAssetIdentity({ ...complete, harness: '' }), null);
});
