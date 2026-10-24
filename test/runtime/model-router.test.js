'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { resolveModelRole, resolveRetrievalSlot, handleModelRoleCommand, availableProviderIds, BACKEND_CLI } = require('../../src/runtime/model-router.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { parseArgs } = require('../../src/cli/index.ts');
const { tempDir } = require('../helper/tmp.ts');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const registry = loadRegistry({ repoRoot: REPO });

function invokeModelRole(options) {
  const originalLog = console.log;
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  const stdout = [];
  const stderr = [];
  let code;
  try {
    console.log = (...args) => stdout.push(args.join(' '));
    console.error = (...args) => stderr.push(args.join(' '));
    code = handleModelRoleCommand(options);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('every shipped role resolves against real providers, tiers bound in models.json', () => {
  for (const roleId of registry.modelRoles.map((r) => r.id)) {
    const resolution = resolveModelRole({ registry, roleId });
    assert.ok(resolution.candidates.length >= 3, `${roleId} sees all declared providers`);
    if (resolution.policy.prefer) {
      assert.ok(resolution.candidates.some((c) => c.servesPreferredTier),
        `${roleId}'s preferred tier '${resolution.policy.prefer}' must be served by at least one provider`);
    }
  }
});

test('ordering: available backends first, then preferred-tier match, registry order breaking ties', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'reasoning',
    isAvailable: (id) => id === 'ollama', // only local backend installed
  });
  // ollama is the only available one → first despite not serving capable-long.
  assert.equal(resolution.candidates[0].id, 'ollama');
  const claude = resolution.candidates.find((c) => c.id === 'claude');
  assert.equal(claude.available, false);
  assert.equal(claude.servesPreferredTier, true, 'claude serves capable-long');
  // Among unavailable candidates, tier match outranks registry order:
  // claude (serves capable-long) sits directly behind the only installed backend.
  const order = resolution.candidates.map((c) => c.id);
  assert.equal(order.indexOf('claude'), 1);
  assert.ok(order.indexOf('codex') > order.indexOf('claude'));
  assert.ok(order.indexOf('copilot') > order.indexOf('claude'));
});

test('triage prefers cheap-fast: tier-matched unavailable beats unmatched available? No — availability dominates', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'triage',
    isAvailable: (id) => id === 'claude',
  });
  assert.equal(resolution.candidates[0].id, 'claude', 'an installed backend is usable; a matching-but-absent one is not');
  assert.ok(resolution.candidates.slice(1).some((c) => c.servesPreferredTier));
});

test('review with exclude drops the implementer and reports it, per different-family policy', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'review',
    isAvailable: () => true,
    exclude: ['claude'],
  });
  assert.ok(!resolution.candidates.some((c) => c.id === 'claude'));
  assert.deepEqual(resolution.excluded, ['claude']);
  assert.equal(resolution.policy.require, 'different-family');
});

test('review family exclusion drops same-family providers and labels cross-family, overlap, and unknown controls', () => {
  // Negative control: a cleanly cross-family provider remains eligible while same-family providers are dropped.
  const fixture = {
    modelRoles: [{ id: 'review', require: 'different-family' }],
    modelProviders: [
      { id: 'author', families: ['claude'] },
      { id: 'same-family', families: ['claude'] },
      { id: 'cross-family', families: ['openai'] },
      { id: 'mixed-catalogue', families: ['claude', 'openai'] },
      { id: 'mixed-unknown', families: ['claude', 'unknown'] },
      { id: 'unknown-family', families: ['unknown'] },
    ],
  };
  const resolution = resolveModelRole({ registry: fixture, roleId: 'review', excludeFamilies: ['claude'] });
  assert.deepEqual(resolution.excludedFamilies, ['claude']);
  assert.deepEqual(resolution.familyExcluded, ['author', 'same-family']);
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.id), ['cross-family', 'mixed-catalogue', 'mixed-unknown', 'unknown-family']);
  assert.equal(resolution.candidates.find((candidate) => candidate.id === 'cross-family').familyVerified, true);
  assert.equal(resolution.candidates.find((candidate) => candidate.id === 'cross-family').familyRelation, 'cross-family');
  assert.deepEqual(resolution.candidates.find((candidate) => candidate.id === 'mixed-catalogue').families, ['claude', 'openai']);
  assert.equal(resolution.candidates.find((candidate) => candidate.id === 'mixed-catalogue').familyVerified, false);
  assert.equal(resolution.candidates.find((candidate) => candidate.id === 'mixed-catalogue').familyRelation, 'overlaps-author');
  const mixedUnknown = resolution.candidates.find((candidate) => candidate.id === 'mixed-unknown');
  assert.equal(mixedUnknown.familyVerified, false);
  assert.equal(mixedUnknown.familyRelation, 'overlaps-author');
  const unknown = resolution.candidates.find((candidate) => candidate.id === 'unknown-family');
  assert.deepEqual(unknown.families, ['unknown']);
  assert.equal(unknown.familyVerified, false, 'unknown is retained without being claimed as cross-family');
  assert.equal(unknown.familyRelation, 'unverified');
});

test('model-role callers without family filters retain the legacy JSON shape byte-for-byte', () => {
  // Regression pin: this shape passes before the family-relation fix by design.
  const fixture = {
    modelRoles: [{ id: 'triage', prefer: 'cheap-fast', fallback: 'any-healthy' }],
    modelProviders: [{ id: 'custom', kind: 'hosted', displayName: 'Custom', tiers: ['cheap-fast'] }],
  };
  const actual = JSON.stringify(resolveModelRole({ registry: fixture, roleId: 'triage', isAvailable: () => false }));
  const expected = JSON.stringify({
    roleId: 'triage',
    policy: { prefer: 'cheap-fast', fallback: 'any-healthy', require: null },
    candidates: [{ id: 'custom', kind: 'hosted', displayName: 'Custom', backendCli: null, available: false,
      servesPreferredTier: true, servesFallbackTier: false }],
    excluded: [],
  });
  assert.equal(actual, expected);
});

test('model-role accepts repeatable family flags and human output labels all family outcomes', (t) => {
  const root = tempDir(t, 'doflow-model-role-family-');
  for (const dir of ['core', 'src', 'bin']) fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
  const modelsPath = path.join(root, 'core', 'registry', 'models.json');
  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  const families = { claude: ['author-family'], codex: ['author-family', 'other-family'], copilot: ['other-family'], ollama: ['unknown'] };
  for (const provider of models.providers) provider.families = families[provider.id];
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  const originalLog = console.log;

  const installed = new Set(availableProviderIds());
  const legacyResolution = resolveModelRole({
    registry: loadRegistry({ repoRoot: root }),
    roleId: 'review',
    isAvailable: (id) => installed.has(id),
  });
  const legacyHuman = [];
  try {
    console.log = (...args) => legacyHuman.push(args.join(' '));
    assert.equal(handleModelRoleCommand({ role: 'review', repoRoot: root }), 0);
  } finally {
    console.log = originalLog;
  }
  const expectedHuman = [`Role 'review' — prefer:— fallback:— require:different-family`];
  for (const candidate of legacyResolution.candidates) {
    const availability = candidate.available === null ? '?' : candidate.available ? 'yes' : 'no';
    expectedHuman.push(`  ${candidate.available ? '*' : ' '} ${candidate.id} (${candidate.kind}, via ${candidate.backendCli ?? 'hosted'}) available=${availability}`);
  }
  assert.deepEqual(legacyHuman, expectedHuman, 'no-filter human output matches the established format');
  const legacyJson = [];
  try {
    console.log = (...args) => legacyJson.push(args.join(' '));
    assert.equal(handleModelRoleCommand({ role: 'review', json: true, repoRoot: root }), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(legacyJson.join('\n'), JSON.stringify(legacyResolution, null, 2), 'no-filter JSON is byte-identical');

  const parsed = parseArgs(['model-role', '--role', 'review', '--exclude', 'claude,codex', '--exclude-family', 'author-family', '--exclude-family=other-family']);
  assert.deepEqual(parsed.exclude, ['claude', 'codex']);
  assert.deepEqual(parsed.excludeFamily, ['author-family', 'other-family']);
  const commaParsed = parseArgs(['model-role', '--role', 'review', '--exclude-family=author-family,other-family']);
  assert.deepEqual(commaParsed.excludeFamily, ['author-family', 'other-family']);

  const lines = [];
  try {
    console.log = (...args) => lines.push(args.join(' '));
    assert.equal(handleModelRoleCommand({ role: 'review', excludeFamilies: ['author-family'], repoRoot: root }), 0);
  } finally {
    console.log = originalLog;
  }
  const output = lines.join('\n');
  assert.match(output, /claude .*same-family/);
  assert.match(output, /codex .*overlaps-author/);
  assert.match(output, /copilot .*cross-family/);
  assert.match(output, /ollama .*unverified/);

  const jsonLines = [];
  try {
    console.log = (...args) => jsonLines.push(args.join(' '));
    assert.equal(handleModelRoleCommand({ role: 'review', excludeFamilies: ['author-family'], json: true, repoRoot: root }), 0);
  } finally {
    console.log = originalLog;
  }
  const json = JSON.parse(jsonLines.join('\n'));
  assert.deepEqual(json.excludedFamilies, ['author-family']);
  assert.deepEqual(json.familyExcluded, ['claude']);
  assert.ok(json.candidates.every((candidate) => Array.isArray(candidate.families)
    && ['cross-family', 'overlaps-author', 'unverified'].includes(candidate.familyRelation)
    && typeof candidate.familyVerified === 'boolean'));
});

test('model-role normalizes requested families and rejects unknown or empty family lists as usage errors', () => {
  const typo = invokeModelRole({ role: 'review', excludeFamilies: ['claud'], repoRoot: REPO });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /claud/);
  assert.match(typo.stderr, /known families:/);
  assert.doesNotMatch(typo.stderr.match(/known families: ([^\n]*)/)?.[1] ?? '', /\bunknown\b/);

  const noMatch = invokeModelRole({ role: 'review', excludeFamilies: ['openai'], repoRoot: REPO });
  assert.equal(noMatch.code, 2);
  assert.match(noMatch.stderr, /openai/);
  assert.match(noMatch.stderr, /known families:/);
  assert.doesNotMatch(noMatch.stderr.match(/known families: ([^\n]*)/)?.[1] ?? '', /\bunknown\b/);

  const blankArgs = parseArgs(['model-role', '--role', 'review', '--exclude-family=,']);
  assert.deepEqual(blankArgs.excludeFamily, []);
  const blank = invokeModelRole({ role: 'review', excludeFamilies: blankArgs.excludeFamily, repoRoot: REPO });
  assert.equal(blank.code, 2);
  assert.match(blank.stderr, /at least one family/);

  const normalized = invokeModelRole({ role: 'review', excludeFamilies: [' Claude '], repoRoot: REPO });
  assert.equal(normalized.code, 0);
  assert.match(normalized.stdout, /claude same-family \(excluded\)/);
});

test('--exclude-family unknown is rejected as missing knowledge and omitted from known families', () => {
  const unknown = invokeModelRole({ role: 'review', excludeFamilies: ['unknown'], repoRoot: REPO });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown cannot be excluded because it names missing knowledge/i);
  assert.doesNotMatch(unknown.stderr.match(/known families: ([^\n]*)/)?.[1] ?? '', /\bunknown\b/);
});

test('direct model-role resolution rejects an empty excluded-family list as usage input', () => {
  assert.throws(
    () => resolveModelRole({ registry, roleId: 'review', excludeFamilies: [] }),
    /--exclude-family requires at least one family name/,
  );
});

test('provider and family exclusions compose and JSON identifies ids dropped by each path', (t) => {
  const root = tempDir(t, 'doflow-model-role-family-combined-');
  for (const dir of ['core', 'src', 'bin']) fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
  const modelsPath = path.join(root, 'core', 'registry', 'models.json');
  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  const families = { claude: ['author-family'], codex: ['author-family', 'other-family'], copilot: ['other-family'], ollama: ['unknown'] };
  for (const provider of models.providers) provider.families = families[provider.id];
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2));

  const result = invokeModelRole({
    role: 'review',
    exclude: ['copilot'],
    excludeFamilies: ['author-family'],
    json: true,
    repoRoot: root,
  });
  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.excluded, ['copilot']);
  assert.deepEqual(json.familyExcluded, ['claude']);
  assert.ok(!json.candidates.some((candidate) => ['claude', 'copilot'].includes(candidate.id)));
  assert.equal(json.candidates.find((candidate) => candidate.id === 'codex').familyRelation, 'overlaps-author');
});

test('unknown roles are rejected with the valid set; ids are never guessed', () => {
  try {
    resolveModelRole({ registry, roleId: 'vibes' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /Unknown model role 'vibes'/);
    for (const valid of registry.modelRoles.map((r) => r.id)) assert.match(error.message, new RegExp(valid));
  }
});

test('availability probe scans PATH via fs only (no spawn), injectable everywhere', () => {
  const fakeFs = {
    accessSync(p) {
      if (String(p).endsWith(path.sep + 'ollama')) return;
      throw new Error('ENOENT');
    },
    constants: { X_OK: 1 },
  };
  const ids = availableProviderIds({
    fsImpl: fakeFs,
    pathEnv: '/usr/bin:/usr/local/bin',
  });
  assert.deepEqual(ids, ['ollama']);
  assert.equal(BACKEND_CLI.claude, 'claude');
});

test('absent slots resolve inactive and leave role routing byte-identical', () => {
  // Shipped registry declares no slots: both lookups stay lexical, no throw.
  for (const slotId of ['dense', 'rerank']) {
    const resolution = resolveRetrievalSlot({ registry, slotId });
    assert.deepEqual(resolution, { slotId, active: false, reason: 'undeclared' });
  }
  // Adding disabled slots to a fixture must not perturb role routing at all — the outputs are
  // deep-equal with and without them.
  const base = {
    modelProviders: structuredClone(registry.modelProviders),
    modelRoles: structuredClone(registry.modelRoles),
  };
  const without = resolveModelRole({ registry: base, roleId: 'triage' });
  const withDisabled = resolveModelRole({
    registry: { ...base, retrievalSlots: [
      { id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: false },
      { id: 'rerank', provider: 'ollama', model: 'bge-reranker-base', enabled: false },
    ] },
    roleId: 'triage',
  });
  assert.deepEqual(without, withDisabled);
});

test('an enabled dense slot routes through its bound provider with probed availability', () => {
  const slotted = {
    ...registry,
    retrievalSlots: [{ id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: true }],
  };
  const installed = resolveRetrievalSlot({ registry: slotted, slotId: 'dense', isAvailable: (id) => id === 'ollama' });
  assert.equal(installed.active, true);
  assert.equal(installed.provider, 'ollama');
  assert.equal(installed.model, 'nomic-embed-text');
  assert.equal(installed.kind, 'local');
  assert.equal(installed.backendCli, 'ollama');
  assert.equal(installed.available, true);
  // Same slot, backend absent: still reported, availability false — the caller stays lexical
  // rather than guessing; the binding itself is never hidden.
  const missing = resolveRetrievalSlot({ registry: slotted, slotId: 'dense', isAvailable: () => false });
  assert.equal(missing.active, true);
  assert.equal(missing.available, false);
  // No probe supplied: unknown stays null, never guessed into either boolean.
  const unprobed = resolveRetrievalSlot({ registry: slotted, slotId: 'dense' });
  assert.equal(unprobed.available, null);
});

test('a declared-but-disabled slot resolves inactive with its reason reported', () => {
  const slotted = {
    ...registry,
    retrievalSlots: [{ id: 'rerank', provider: 'ollama', model: 'bge-reranker-base', enabled: false }],
  };
  assert.deepEqual(resolveRetrievalSlot({ registry: slotted, slotId: 'rerank' }), {
    slotId: 'rerank', active: false, reason: 'disabled',
  });
});
