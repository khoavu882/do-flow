'use strict';
// kiro-cli discovers custom agents as .kiro/agents/<name>.json (2.27.1 `kiro-cli agent list` did not
// list .md agents). These tests cover the `kiro-agent-json` layout, the `kiro-agents` transform, the
// static `doflow` agent, and their install/verify/uninstall through the Kiro adapter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../../helper/tmp');
const { createKiroAdapter } = require('../../../src/adapters/kiro/index.ts');
const { TRANSFORMS, LAYOUTS, resolveLayout, kiroPreToolUseHooks, kiroHook } = require('../../../src/adapters/copy-tree.ts');
const { loadRegistry, selectAssets } = require('../../../src/registry/index.ts');
const { projectAdapterInput } = require('../../../src/adapters/index.ts');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SPECS_DIR = path.join(REPO_ROOT, 'core', 'shared', 'agent-specs');
const DOFLOW_AGENT = path.join(REPO_ROOT, 'core', 'harnesses', 'kiro', 'agents', 'doflow.json');
const SPEC_NAMES = ['core-implementer', 'quality-guardian', 'research-writer', 'spec-analyst', 'system-architect'];

const scratch = () => suiteTempDir('doflow-kiro-agents-');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const render = (name, text) => TRANSFORMS['kiro-agents'](name, Buffer.from(text)).toString('utf8');

/** The real registry's agent assets for kiro, as the adapter receives them. */
function kiroAgentAssets() {
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const harness = registry.harnesses.find((item) => item.id === 'kiro');
  const assets = selectAssets(registry, { harness: 'kiro', capability: 'agents' });
  return projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: '/unused', assets }).assets;
}

const ledgerFor = (changes) => ({
  resources: changes.map((c) => ({ harness: 'kiro', assetId: c.assetId, kind: 'copy-tree-file', identity: c.identity, target: c.target, fingerprint: c.fingerprint })),
});

test('kiro-agent-json layout maps <name>.md to <name>.json', () => {
  assert.ok(LAYOUTS['kiro-agent-json']);
  assert.equal(resolveLayout('kiro-agent-json')('core-implementer.md'), 'core-implementer.json');
});

test('kiro-agents transform: deterministic bytes, valid JSON, prompt equals the spec body', () => {
  for (const name of SPEC_NAMES) {
    const source = fs.readFileSync(path.join(SPECS_DIR, `${name}.md`), 'utf8');
    const first = render(`${name}.md`, source);
    const second = render(`${name}.md`, source);
    assert.equal(first, second, `${name}: two runs must give identical bytes`);
    assert.ok(first.endsWith('}\n'), `${name}: ends with a newline`);

    const agent = JSON.parse(first);
    assert.deepEqual(Object.keys(agent), ['name', 'description', 'prompt', 'tools', 'hooks']);
    assert.equal(agent.name, name);
    assert.ok(agent.description.length > 0);
    const body = source.slice(source.indexOf('\n---', 3) + 4).replace(/^\n+/, '').replace(/\s+$/, '');
    assert.equal(agent.prompt, `${body}\n`);
    assert.deepEqual(agent.tools, ['*']);
    assert.equal(first, `${JSON.stringify(agent, null, 2)}\n`, `${name}: canonical two-space JSON`);
  }
});

test('kiro-agents transform: no model key for model: inherit, and effort is dropped', () => {
  const source = fs.readFileSync(path.join(SPECS_DIR, 'core-implementer.md'), 'utf8');
  assert.match(source, /^model: inherit$/m);
  const agent = JSON.parse(render('core-implementer.md', source));
  assert.equal('model' in agent, false);
  assert.equal('effort' in agent, false);
});

test('kiro-agents transform: exactly three preToolUse hooks with the documented matchers', () => {
  const agent = JSON.parse(render('spec-analyst.md', fs.readFileSync(path.join(SPECS_DIR, 'spec-analyst.md'), 'utf8')));
  assert.equal(agent.hooks.length, 3);
  assert.deepEqual(agent.hooks.map((hook) => [hook.name, hook.trigger, hook.matcher, hook.timeout]), [
    ['doflow-pre-implementation-gate', 'preToolUse', 'write', 10],
    ['doflow-pre-bash-guard', 'preToolUse', 'shell', 10],
    ['doflow-mcp-tool-guard', 'preToolUse', '*', 10],
  ]);
  const scripts = agent.hooks.map((hook) => hook.action.command.match(/\.kiro\/hooks\/([a-z-]+\.sh)'/)[1]);
  assert.deepEqual(scripts, ['pre-implement-gate.sh', 'pre-bash-guard.sh', 'mcp-tool-guard.sh']);
  for (const hook of agent.hooks) assert.equal(hook.action.type, 'command');
});

test('static doflow agent: valid shape, shared hooks identical to the generated ones', () => {
  const doflow = JSON.parse(fs.readFileSync(DOFLOW_AGENT, 'utf8'));
  assert.equal(doflow.name, 'doflow');
  assert.ok(doflow.description.length > 0);
  assert.ok(doflow.prompt.length > 0);
  assert.deepEqual(doflow.tools, ['*']);

  const specialist = JSON.parse(render('spec-analyst.md', fs.readFileSync(path.join(SPECS_DIR, 'spec-analyst.md'), 'utf8')));
  assert.deepEqual(doflow.hooks.slice(0, 3), specialist.hooks, 'the three preToolUse hooks match what the transform generates');
  assert.deepEqual(doflow.hooks.slice(0, 3), kiroPreToolUseHooks());

  const extra = doflow.hooks.slice(3);
  assert.deepEqual(extra, [
    kiroHook({ name: 'doflow-session-context', trigger: 'agentSpawn', script: 'session-start.sh', timeout: 10 }),
    kiroHook({ name: 'doflow-stop-check', trigger: 'stop', script: 'stop-check.sh', timeout: 30 }),
  ]);
  assert.equal(fs.readFileSync(DOFLOW_AGENT, 'utf8'), `${JSON.stringify(doflow, null, 2)}\n`);
});

test('the registry projects shared agents to JSON and declares the doflow agent asset', () => {
  const assets = kiroAgentAssets();
  const shared = assets.find((asset) => asset.id === 'agents.shared');
  assert.equal(shared.renderer, 'kiro-agents');
  assert.equal(shared.layout, 'kiro-agent-json');
  assert.equal(shared.transform, 'kiro-agents');
  const own = assets.find((asset) => asset.id === 'kiro.doflow-agent');
  assert.equal(own.renderer, 'copy-tree');
  assert.equal(own.nativeDir, 'agents');
  assert.equal(own.source, 'core/harnesses/kiro/agents');
});

test('adapter installs <name>.json for all five specs plus doflow.json, verifies managed, and uninstalls', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const assets = kiroAgentAssets();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources: [] } });
  assert.deepEqual(planned.conflicts, []);
  adapter.apply({ changes: planned.changes });

  const agentsDir = path.join(root, '.kiro', 'agents');
  assert.deepEqual(fs.readdirSync(agentsDir).sort(), [...SPEC_NAMES, 'doflow'].map((name) => `${name}.json`).sort());
  for (const name of SPEC_NAMES) {
    const installed = fs.readFileSync(path.join(agentsDir, `${name}.json`), 'utf8');
    assert.equal(installed, render(`${name}.md`, fs.readFileSync(path.join(SPECS_DIR, `${name}.md`), 'utf8')));
  }
  assert.equal(fs.readFileSync(path.join(agentsDir, 'doflow.json'), 'utf8'), fs.readFileSync(DOFLOW_AGENT, 'utf8'));

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets, context });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.conflicts, []);
  for (const id of ['agents.shared', 'kiro.doflow-agent']) {
    assert.equal(verified.statuses.copyTree.find((status) => status.assetId === id).status, 'managed', id);
  }

  const ledger = ledgerFor(planned.changes);
  const replan = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger });
  assert.deepEqual(replan.changes, []);
  assert.deepEqual(replan.conflicts, []);

  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { ...context, operation: 'remove' }, ledger });
  assert.deepEqual(removal.conflicts, []);
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(agentsDir), false, 'every agent file is removed and the empty directory pruned');
});

test('a verify after hand-editing an installed agent reports a conflict', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const assets = kiroAgentAssets();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  fs.writeFileSync(path.join(root, '.kiro', 'agents', 'core-implementer.json'), '{}\n');
  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets, context });
  assert.equal(verified.ok, false);
  assert.match(verified.conflicts.join('\n'), /core-implementer\.json does not match source/);
});

test('an untampered <name>.md recorded by an earlier install is removed when the JSON agents are installed', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const assets = kiroAgentAssets();
  const context = { repoRoot: REPO_ROOT };
  const agentsDir = path.join(root, '.kiro', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  // The earlier release mirrored the spec files verbatim as <name>.md.
  const resources = SPEC_NAMES.map((name) => {
    const bytes = fs.readFileSync(path.join(SPECS_DIR, `${name}.md`));
    const target = path.join(agentsDir, `${name}.md`);
    fs.writeFileSync(target, bytes);
    return { harness: 'kiro', assetId: 'agents.shared', kind: 'copy-tree-file', identity: `${name}.md`, target, fingerprint: sha256(bytes) };
  });

  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources } });
  assert.deepEqual(planned.conflicts, []);
  adapter.apply({ changes: planned.changes });

  for (const name of SPEC_NAMES) {
    assert.equal(fs.existsSync(path.join(agentsDir, `${name}.md`)), false, `${name}.md is removed`);
    assert.equal(fs.existsSync(path.join(agentsDir, `${name}.json`)), true, `${name}.json is written`);
  }
});

test('a hand-edited <name>.md from an earlier install is kept, not deleted', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const assets = kiroAgentAssets();
  const context = { repoRoot: REPO_ROOT };
  const agentsDir = path.join(root, '.kiro', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const original = fs.readFileSync(path.join(SPECS_DIR, 'spec-analyst.md'));
  const target = path.join(agentsDir, 'spec-analyst.md');
  fs.writeFileSync(target, 'my own agent\n');
  const resources = [{ harness: 'kiro', assetId: 'agents.shared', kind: 'copy-tree-file', identity: 'spec-analyst.md', target, fingerprint: sha256(original) }];

  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources } });
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(target, 'utf8'), 'my own agent\n');
  assert.ok(planned.notices.some((notice) => /kept hand-edited .*spec-analyst\.md/.test(notice)));
});

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const KIRO_CLI = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
const OPTED_IN = process.env.DOFLOW_LIVE_KIRO === '1';
const ON_PATH = KIRO_CLI.status === 0;
const LIVE_SKIP = !OPTED_IN
  ? 'live Kiro test is opt-in: set DOFLOW_LIVE_KIRO=1 to run it'
  : (!ON_PATH ? 'kiro-cli is not on PATH' : false);

test('live: kiro-cli agent list shows the installed project agents', { skip: LIVE_SKIP }, () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const assets = kiroAgentAssets();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: REPO_ROOT }, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  // `agent list` only reads. It runs with the real HOME because kiro-cli refuses to run logged out;
  // the Workspace column proves the agents came from the scratch project, not from ~/.kiro.
  const result = spawnSync('kiro-cli', ['agent', 'list'], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, output);
  assert.match(output, /^\s*core-implementer\s+Workspace\b/m);
  assert.match(output, /^\s*doflow\s+Workspace\b/m);
});
