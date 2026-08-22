'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveTargets, VALID, toolDirs } = require('../../src/install/targets');
const { writeManifest, readManifest, manifestPath } = require('../../src/install/manifest');
const { resolveContext } = require('../../src/install/context');

const REPO = path.resolve(__dirname, "../..");

test('Codex plugin manifest packages the single-source core skills tree', () => {
  // .codex-plugin/ must keep its exact required name and location (core/) — Codex plugin
  // discovery requires .codex-plugin/plugin.json, with all other content (skills/, etc.) as
  // siblings at the plugin root, not nested under core/harnesses/codex/ with the rest of the
  // harness-native reorg.
  const manifestPath = path.join(REPO, 'core', '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.name, 'doflow');
  assert.strictEqual(manifest.version, require('../../package.json').version);
  assert.strictEqual(manifest.skills, './shared/skills/');
  assert.ok(fs.existsSync(path.join(REPO, 'core', 'shared', 'skills', 'do-execute-plan', 'SKILL.md')));
});

test('Claude marketplace exposes the single-source core plugin', () => {
  // Same constraint as Codex's plugin: .claude-plugin/ must stay at core/ (the documented
  // marketplace root), not moved under core/harnesses/claude/.
  const marketplacePath = path.join(REPO, 'core', '.claude-plugin', 'marketplace.json');
  const manifestPath = path.join(REPO, 'core', '.claude-plugin', 'plugin.json');
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.strictEqual(marketplace.name, 'doflow');
  assert.strictEqual(marketplace.plugins.length, 1);
  assert.deepStrictEqual(marketplace.plugins[0].source, '.');
  assert.strictEqual(marketplace.plugins[0].name, manifest.name);
  assert.strictEqual(manifest.version, require('../../package.json').version);
  assert.deepStrictEqual(manifest.skills, ['./shared/skills/']);
  assert.deepStrictEqual(manifest.agents, ['./shared/agent-specs/']);
  assert.ok(fs.existsSync(path.join(REPO, 'core', 'shared', 'skills', 'do-execute-plan', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(REPO, 'core', 'shared', 'agent-specs', 'system-architect.md')));
});

test('resolveTargets defaults to claude alone and validates', () => {
  // Deliberately not all of VALID: an install with no --target should configure the one harness the
  // user almost certainly has, rather than writing into every harness DoFlow knows about. That was
  // defensible at three entries and stops being so as VALID grows.
  assert.deepStrictEqual(resolveTargets([]), ['claude']);
  assert.deepStrictEqual(resolveTargets(undefined), ['claude']);
  assert.deepStrictEqual(resolveTargets(['claude']), ['claude']);
  assert.deepStrictEqual(resolveTargets(['antigravity']), ['antigravity']);
  assert.deepStrictEqual(resolveTargets(['agy']), ['antigravity']);
  assert.deepStrictEqual(resolveTargets([...VALID]), VALID, 'every valid target is still selectable');
  assert.throws(() => resolveTargets(['bogus']), /Unknown target/);
});

test('VALID lists all eight harnesses', () => {
  assert.deepStrictEqual(VALID, ['claude', 'codex', 'gemini', 'copilot', 'kiro', 'opencode', 'pi', 'antigravity']);
});

for (const target of ['copilot', 'kiro', 'opencode', 'pi']) {
  test(`resolveTargets accepts the new '${target}' target`, () => {
    assert.deepStrictEqual(resolveTargets([target]), [target]);
  });
}

test('resolveTargets rejects an unknown target and names all seven valid ones', () => {
  assert.throws(() => resolveTargets(['bogus']), (err) => {
    assert.match(err.message, /Unknown target/);
    for (const target of VALID) assert.match(err.message, new RegExp(target));
    return true;
  });
});

test('toolDirs defaults to project scope rooted at projectRoot', () => {
  const dirs = toolDirs({ projectRoot: '/tmp/some-project' });
  assert.strictEqual(dirs.claude, '/tmp/some-project/.claude');
  assert.strictEqual(dirs.codex, '/tmp/some-project/.codex');
  assert.strictEqual(dirs.gemini, '/tmp/some-project/.agents');
  assert.strictEqual(dirs.copilot, '/tmp/some-project/.github');
  assert.strictEqual(dirs.kiro, '/tmp/some-project/.kiro');
  assert.strictEqual(dirs.opencode, '/tmp/some-project/.opencode');
  assert.strictEqual(dirs.pi, '/tmp/some-project/.pi');
});

test('toolDirs defaults projectRoot to cwd when omitted', () => {
  const dirs = toolDirs();
  assert.strictEqual(dirs.claude, path.join(process.cwd(), '.claude'));
});

test('toolDirs global:true resolves under $HOME', () => {
  const dirs = toolDirs({ global: true });
  assert.strictEqual(dirs.claude, path.join(os.homedir(), '.claude'));
  assert.strictEqual(dirs.codex, path.join(os.homedir(), '.codex'));
  assert.strictEqual(dirs.gemini, path.join(os.homedir(), '.gemini'));
  assert.strictEqual(dirs.copilot, path.join(os.homedir(), '.copilot'));
  assert.strictEqual(dirs.kiro, path.join(os.homedir(), '.kiro'));
  assert.strictEqual(dirs.opencode, path.join(os.homedir(), '.config', 'opencode'));
  assert.strictEqual(dirs.pi, path.join(os.homedir(), '.pi', 'agent'));
});

test('manifest keeps legacy state readable without a managed-resource ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-manifest-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(manifestPath(claudeDir), JSON.stringify({
    script_version: '2.4.4', last_operation: 'install', last_run: '2026-07-24T00:00:00Z',
    source_path: REPO, source_commit: 'legacy', last_backup_id: 'install_legacy', tools: {},
  }));

  const manifest = readManifest(claudeDir);
  assert.strictEqual(manifest.operation, 'install');
  assert.deepStrictEqual(manifest.managedResources, []);
});

test('manifest writes and reads Codex managed-resource ownership records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-manifest-'));
  const claudeDir = path.join(root, '.claude');
  const managedResources = [{
    target: 'codex', scope: 'project', kind: 'mcp-server', identity: 'doflow.context7',
    sourceVersion: '2.4.4', fingerprint: 'sha256:managed-value', selection: true,
    recoveryPoint: 'install_2026-07-24_00-00-00',
  }];

  writeManifest({
    claudeDir, scriptVersion: '2.4.4', operation: 'install', repoRoot: REPO,
    tools: ['codex'], date: new Date('2026-07-24T00:00:00Z'), sourceCommit: 'test',
    managedResources,
  });

  const raw = JSON.parse(fs.readFileSync(manifestPath(claudeDir), 'utf8'));
  assert.deepStrictEqual(raw.managed_resources, managedResources);
  assert.deepStrictEqual(readManifest(claudeDir).managedResources, managedResources);
});

test('manifest preserves a managed-resource ledger when legacy callers omit it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-manifest-'));
  const claudeDir = path.join(root, '.claude');
  const managedResources = [{ target: 'codex', scope: 'global', kind: 'asset', identity: 'doflow.config', sourceVersion: '2.4.4', fingerprint: 'sha256:config', selection: null, recoveryPoint: 'backup_1' }];
  const common = { claudeDir, scriptVersion: '2.4.4', repoRoot: REPO, tools: ['codex'], sourceCommit: 'test' };

  writeManifest({ ...common, operation: 'install', date: new Date('2026-07-24T00:00:00Z'), managedResources });
  writeManifest({ ...common, operation: 'update', date: new Date('2026-07-25T00:00:00Z') });

  assert.deepStrictEqual(readManifest(claudeDir).managedResources, managedResources);
});

test('resolveContext exposes an optional managed-resource ledger without changing legacy context', () => {
  const base = { repoRoot: REPO, global: false, projectRoot: '/tmp/project', targets: ['codex'], dirs: { codex: '/tmp/project/.codex' }, sourceCommit: 'test' };
  assert.ok(!Object.hasOwn(resolveContext(base), 'managedResources'));

  const managedResources = [{ target: 'codex', scope: 'project', kind: 'hook-handler', identity: 'doflow.pre-implement', sourceVersion: '2.4.4', fingerprint: 'sha256:hook', selection: true, recoveryPoint: 'backup_2' }];
  assert.deepStrictEqual(resolveContext({ ...base, managedResources }).managedResources, managedResources);
});
