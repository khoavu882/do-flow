'use strict';
// 109 A.1 IC-001 (registry source mode) and IC-004 ({lastMessageFile} placement rule).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateWorker, registrySourceMode,
} = require('../../src/registry/index.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');

/** Helper creating a runtime-shaped directory holding only bin/, src/, core/registry/. */
function createRuntimeShapedTree() {
  const root = suiteTempDir('doflow-runtime-tree-');
  fs.cpSync(path.join(REPO, 'bin'), path.join(root, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  return root;
}

/** Supported helper for worker recipe mutations. */
function supported(recipe: any) {
  return {
    status: 'supported',
    evidence: ['test/registry/registry-sources.test.ts'],
    verification: 'Run it.',
    verifiedOn: '2026-10-18',
    ...recipe,
  };
}

test('registrySourceMode: detects package.json and returns require or skip', () => {
  assert.equal(registrySourceMode(REPO), 'require');

  const emptyDir = suiteTempDir('doflow-empty-');
  assert.equal(registrySourceMode(emptyDir), 'skip');

  const runtimeRoot = createRuntimeShapedTree();
  assert.equal(registrySourceMode(runtimeRoot), 'skip');

  const fakeFsRequire = { existsSync: () => true };
  assert.equal(registrySourceMode('/some/path', fakeFsRequire), 'require');

  const fakeFsSkip = { existsSync: () => false };
  assert.equal(registrySourceMode('/some/path', fakeFsSkip), 'skip');

  assert.equal(registrySourceMode(''), 'skip');
});

test('runtime-shaped copy: loads in default mode (skip) with validation.sources === "skip"', () => {
  const runtimeRoot = createRuntimeShapedTree();
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'package.json')), false);

  const registry = loadRegistry({ repoRoot: runtimeRoot });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.validation.sources, 'skip');
  assert.deepEqual(registry.validation.errors, []);

  const explicitSkip = validateRegistry(registry, { repoRoot: runtimeRoot, sources: 'skip' });
  assert.equal(explicitSkip.ok, true);
  assert.equal(explicitSkip.sources, 'skip');
  assert.deepEqual(explicitSkip.errors, []);
});

test('runtime-shaped copy: fails in require mode with exactly the 19 missing-source lines', () => {
  const runtimeRoot = createRuntimeShapedTree();
  const registry = loadRegistry({ repoRoot: runtimeRoot });

  const requireResult = validateRegistry(registry, { repoRoot: runtimeRoot, sources: 'require' });
  assert.equal(requireResult.ok, false);
  assert.equal(requireResult.sources, 'require');
  assert.equal(requireResult.errors.length, 24);

  for (const error of requireResult.errors) {
    assert.match(error, /source does not exist inside repository: /);
  }

  const assetErrors = requireResult.errors.filter((e: any) => e.startsWith("asset '"));
  assert.equal(assetErrors.length, 20);

  const projectionErrors = requireResult.errors.filter((e: any) => e.startsWith("harness 'codex' nativeProjection"));
  assert.equal(projectionErrors.length, 4);

  assert.throws(
    () => loadRegistry({ repoRoot: runtimeRoot, sources: 'require' }),
    (err: any) => {
      assert.match(err.message, /^Invalid DoFlow registry:\n- /);
      assert.equal(err.validation.ok, false);
      assert.equal(err.validation.sources, 'require');
      assert.equal(err.validation.errors.length, 24);
      return true;
    },
  );
});

test('unknown sources value: throws TypeError naming both require and skip modes', () => {
  const registry = loadRegistry({ repoRoot: REPO });

  for (const bad of ['invalid', 'REQUIRE', 'SKIP', 123, null, '', false]) {
    assert.throws(
      () => loadRegistry({ repoRoot: REPO, sources: bad }),
      {
        name: 'TypeError',
        message: /sources must be 'require' or 'skip'/,
      },
      `loadRegistry must throw TypeError for sources=${JSON.stringify(bad)}`,
    );

    assert.throws(
      () => validateRegistry(registry, { repoRoot: REPO, sources: bad }),
      {
        name: 'TypeError',
        message: /sources must be 'require' or 'skip'/,
      },
      `validateRegistry must throw TypeError for sources=${JSON.stringify(bad)}`,
    );
  }
});

test('skip mode: still checks missing, empty, or escaping source paths', () => {
  const registry = loadRegistry({ repoRoot: REPO });

  const escapingAsset = structuredClone(registry);
  escapingAsset.assets[0].source = '../outside.json';
  const resAssetEscape = validateRegistry(escapingAsset, { repoRoot: REPO, sources: 'skip' });
  assert.equal(resAssetEscape.ok, false);
  assert.match(resAssetEscape.errors.join('\n'), /source does not exist inside repository: \.\.\/outside\.json/);

  const emptyAsset = structuredClone(registry);
  emptyAsset.assets[0].source = '';
  const resAssetEmpty = validateRegistry(emptyAsset, { repoRoot: REPO, sources: 'skip' });
  assert.equal(resAssetEmpty.ok, false);
  assert.match(resAssetEmpty.errors.join('\n'), /requires source/);

  const escapingProjection = structuredClone(registry);
  const codex = escapingProjection.harnesses.find((h: any) => h.id === 'codex');
  codex.nativeProjection.config.source = '../outside.toml';
  const resProjEscape = validateRegistry(escapingProjection, { repoRoot: REPO, sources: 'skip' });
  assert.equal(resProjEscape.ok, false);
  assert.match(resProjEscape.errors.join('\n'), /source does not exist inside repository: \.\.\/outside\.toml/);

  const emptyProjection = structuredClone(registry);
  const codexEmpty = emptyProjection.harnesses.find((h: any) => h.id === 'codex');
  codexEmpty.nativeProjection.config.source = '';
  const resProjEmpty = validateRegistry(emptyProjection, { repoRoot: REPO, sources: 'skip' });
  assert.equal(resProjEmpty.ok, false);
  assert.match(resProjEmpty.errors.join('\n'), /requires a repository-relative source/);
});

test('placement rule: {lastMessageFile} once in structuredOutput.argv is accepted (positive)', () => {
  const errors: any = [];
  validateWorker({
    profile: 'user-headless',
    billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['-p', '{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1' }),
    readOnly: supported({ argv: ['--read-only'] }),
    spawnDenial: supported({ argv: ['--no-agents'] }),
    runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }),
    guidanceProbe: supported({ argv: ['--guidance'], marker: 'DOFLOW-MARKER' }),
    loginProbe: supported({ argv: ['--whoami'] }),
    persistentSession: supported({}),
    resume: { status: 'unsupported', evidence: ['docs'], verification: 'Read it.', verifiedOn: '2026-10-18' },
    steering: { status: 'unknown', evidence: [], verification: 'Read it.', verifiedOn: '2026-10-18', reason: 'unread' },
    modelChecks: [],
  }, "harness 'codex'", errors);
  assert.deepEqual(errors, []);

  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const codexHarness = registry.harnesses.find((h: any) => h.id === 'codex');
  codexHarness.worker.structuredOutput = supported({
    argv: ['--json', '-o', '{lastMessageFile}'],
    parser: 'doflow-jsonl-v1',
  });
  const res = validateRegistry(registry, { repoRoot: REPO });
  const workerErrors = res.errors.filter((e: any) => e.includes("harness 'codex' worker 'structuredOutput'"));
  assert.deepEqual(workerErrors, []);
});

test('placement rule: {lastMessageFile} rejected anywhere else or twice (negative)', () => {
  const base = () => ({
    profile: 'user-headless',
    billing: 'unknown',
    cli: supported({ binary: 'fake-cli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['-p', '{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: ['--json'], parser: 'doflow-jsonl-v1' }),
    readOnly: supported({ argv: ['--read-only'] }),
    spawnDenial: supported({ argv: ['--no-agents'] }),
    runnableProbe: supported({ argv: ['--probe'] }),
    hooksProbe: supported({ argv: ['--hooks'] }),
    guidanceProbe: supported({ argv: ['--guidance'], marker: 'DOFLOW-MARKER' }),
    loginProbe: supported({ argv: ['--whoami'] }),
    persistentSession: supported({}),
    resume: { status: 'unsupported', evidence: ['docs'], verification: 'Read it.', verifiedOn: '2026-10-18' },
    steering: { status: 'unknown', evidence: [], verification: 'Read it.', verifiedOn: '2026-10-18', reason: 'unread' },
    modelChecks: [],
  });

  const check = (mutate: any, expectedKey: any) => {
    const worker = base();
    mutate(worker);
    const errors: any = [];
    validateWorker(worker, "harness 'claude'", errors);
    assert.ok(errors.length > 0, `mutation for ${expectedKey} must fail validation`);
    const match = errors.filter((e: any) => e.includes(`harness 'claude' worker '${expectedKey}': argv must contain '{lastMessageFile}' only once and only in structuredOutput.argv`));
    assert.equal(match.length, 1, `expected error for ${expectedKey}, got: ${errors.join('\n')}`);
  };

  // Twice in structuredOutput.argv
  check((w: any) => {
    w.structuredOutput = supported({ argv: ['--json', '{lastMessageFile}', '{lastMessageFile}'], parser: 'doflow-jsonl-v1' });
  }, 'structuredOutput');

  // In readOnly.argv
  check((w: any) => {
    w.readOnly = supported({ argv: ['--read-only', '{lastMessageFile}'] });
  }, 'readOnly');

  // In oneShot.argv
  check((w: any) => {
    w.oneShot = supported({ argv: ['-p', '{prompt}', '{lastMessageFile}'], promptVia: 'argv' });
  }, 'oneShot');

  // In spawnDenial.argv
  check((w: any) => {
    w.spawnDenial = supported({ argv: ['--no-agents', '{lastMessageFile}'] });
  }, 'spawnDenial');

  // In runnableProbe.argv
  check((w: any) => {
    w.runnableProbe = supported({ argv: ['--probe', '{lastMessageFile}'] });
  }, 'runnableProbe');

  // In hooksProbe.argv
  check((w: any) => {
    w.hooksProbe = supported({ argv: ['--hooks', '{lastMessageFile}'] });
  }, 'hooksProbe');

  // In guidanceProbe.argv
  check((w: any) => {
    w.guidanceProbe = supported({ argv: ['--guidance', '{lastMessageFile}'], marker: 'M' });
  }, 'guidanceProbe');

  // In loginProbe.argv
  check((w: any) => {
    w.loginProbe = supported({ argv: ['--whoami', '{lastMessageFile}'] });
  }, 'loginProbe');

  // In cli.versionArgv
  check((w: any) => {
    w.cli = supported({ binary: 'fake', versionArgv: ['--version', '{lastMessageFile}'] });
  }, 'cli');

  // In modelChecks[0].argv
  check((w: any) => {
    w.modelChecks = [{ id: 'chk', argv: ['-p', 'x', '{lastMessageFile}'], establishes: ['login'], estimateTokens: 1, timeoutSeconds: 1 }];
  }, 'modelChecks[0]');
});
