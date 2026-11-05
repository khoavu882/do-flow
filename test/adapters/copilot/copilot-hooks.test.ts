'use strict';

// Copilot CLI hooks end to end: a real `doflow install/update/remove -t copilot` into a scratch HOME,
// then the installed doflow.json commands run against Copilot payloads. Gated by `hooks.harnesses`
// like every other adapter (copilot is outside the shipped default).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../../helper/bash-locator.ts');
const { tempDir, run, cleanup } = require('../../e2e/cli-e2e.shared.ts');
const { loadRegistry, capabilityMapData, selectAssets } = require('../../../src/registry/index.ts');
const { tieredRegistry } = require('../../../src/lifecycle/hook-tier.ts');
const { expectExecutable } = require('../../helper-platform.ts');

const REPO = path.resolve(__dirname, '../../..');
const DOORS = ['pre-implement-gate', 'mcp-tool-guard', 'session-start', 'stop-check', 'subagent-start', 'subagent-stop'].map((name) => `doflow-${name}.sh`);
const EVENTS = ['agentStop', 'preToolUse', 'sessionStart', 'subagentStart', 'subagentStop'];

after(cleanup);

function settings(xdg: any, hookHarnesses: any) {
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'hooks.harnesses': hookHarnesses }));
}

function gitProject(t: any) {
  const project = tempDir(t, 'doflow-copilot-hooks-project-');
  spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  return project;
}

const PATCH = '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch\n';

/** A feature-branch repo with no requirement/design/plan: the edit gate advises on a source edit in it. */
function gatedRepo(t: any) {
  const repo = gitProject(t);
  spawnSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/021-demo'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'agent-docs', 'doflow', '021-demo'), { recursive: true });
  return repo;
}

/** Run the installed command of one doflow.json entry the way Copilot does: through a shell, in `cwd`. */
function runEntry(entry: any, payload: any, { cwd, home, xdg, copilotHome }: any) {
  return spawnSync(bashPath(), ['-c', entry.bash], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}), DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

test('the shipped default hooks.harnesses leaves Copilot content-only: no hook file is written', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const installed = run(['install', project, '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(path.join(project, '.github', 'hooks')), false);
  assert.equal(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge')), false);
  const status = JSON.parse(run(['status', project, '--target', 'copilot', '--json'], { home, env: { XDG_CONFIG_HOME: xdg } }).stdout);
  assert.equal(status.context.copilot.hooks.status, 'absent');
});

test('naming copilot in hooks.harnesses projects doflow.json, the front doors and the shared bridge; leaving it removes them', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const env = { XDG_CONFIG_HOME: xdg };
  settings(xdg, ['copilot']);
  let r = run(['install', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);

  const hooksDir = path.join(project, '.github', 'hooks');
  for (const name of ['doflow.json', 'doflow-lib.sh', ...DOORS]) assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} is installed`);
  for (const name of DOORS) expectExecutable(fs, path.join(hooksDir, name), `${name} is executable`);
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'doflow.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks).sort(), EVENTS);
  assert.deepEqual(config.hooks.preToolUse.map((entry: any) => entry.bash.match(/doflow-[\w-]+\.sh/)[0]), ['doflow-pre-implement-gate.sh', 'doflow-mcp-tool-guard.sh']);

  const status = JSON.parse(run(['status', project, '--target', 'copilot', '--json'], { home, env }).stdout);
  assert.deepEqual(status.context.copilot.hooks, { status: 'active', prerequisites: [] });

  // An unchanged second run plans nothing new and keeps the files.
  r = run(['update', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(hooksDir, 'doflow.json')));

  settings(xdg, ['claude']);
  r = run(['update', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['doflow.json', 'doflow-lib.sh', ...DOORS]) assert.equal(fs.existsSync(path.join(hooksDir, name)), false, `${name} is removed`);
  assert.equal(fs.existsSync(path.join(project, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')), false);
  assert.ok(fs.existsSync(path.join(project, '.github', 'copilot-instructions.md')), 'Copilot content stays');
});

test('a hook file the user keeps beside doflow.json is left alone, and `remove` takes only DoFlow\'s own', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  const env = { XDG_CONFIG_HOME: xdg };
  settings(xdg, ['copilot']);
  const own = path.join(project, '.github', 'hooks', 'mine.json');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '{"version":1,"hooks":{}}\n');
  let r = run(['install', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  r = run(['remove', project, '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(own, 'utf8'), '{"version":1,"hooks":{}}\n');
  assert.equal(fs.existsSync(path.join(project, '.github', 'hooks', 'doflow.json')), false);
});

test('the installed project commands advise on a gated source edit, deny a blocked MCP tool, and allow a plain command', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const project = gitProject(t);
  settings(xdg, ['copilot']);
  const r = run(['install', project, '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(project, '.github', 'hooks', 'doflow.json'), 'utf8'));
  const ctx = { cwd: project, home, xdg };
  const [gate, mcp] = config.hooks.preToolUse;

  const allowedEdit = runEntry(gate, { sessionId: 's1', cwd: project, toolName: 'apply_patch', toolArgs: PATCH }, ctx);
  assert.equal(allowedEdit.status, 0, allowedEdit.stderr);
  assert.equal(allowedEdit.stdout, '', 'off a feature branch the gate allows an edit');

  spawnSync('git', ['-C', project, 'checkout', '-q', '-b', 'feat/021-demo'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(project, 'agent-docs', 'doflow', '021-demo'), { recursive: true });
  const gated = runEntry(gate, { sessionId: 's1', cwd: project, toolName: 'apply_patch', toolArgs: PATCH }, ctx);
  assert.equal(gated.status, 0, gated.stderr);
  assert.equal(gated.stdout, '', 'the gate only advises: no permission decision reaches Copilot');

  fs.appendFileSync(path.join(project, '.doflow', 'shared', 'hooks', 'policies', 'mcp-policy.conf'), 'mcp__evil__drop\tCopilot MCP test blocked\n');
  const blocked = runEntry(mcp, { sessionId: 's1', cwd: project, toolName: 'mcp__evil__drop', toolArgs: {} }, ctx);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).permissionDecision, 'deny', 'a blocked MCP pattern still denies');

  const passed = runEntry(mcp, { sessionId: 's1', cwd: project, toolName: 'bash', toolArgs: { command: 'ls' } }, ctx);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, '');
});

test('a global install writes ~/.copilot/hooks and ~/.doflow/shared/hooks, and its commands resolve from outside any repository', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  settings(xdg, ['copilot']);
  const r = run(['install', '-g', '--force', '--target', 'copilot'], { home, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(r.status, 0, r.stderr);
  const hooksDir = path.join(home, '.copilot', 'hooks');
  for (const name of ['doflow.json', ...DOORS]) assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} is installed`);
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'doflow.json'), 'utf8'));
  const elsewhere = gatedRepo(t);
  const advised = runEntry(config.hooks.preToolUse[0], { sessionId: 's1', cwd: elsewhere, toolName: 'apply_patch', toolArgs: PATCH }, { cwd: elsewhere, home, xdg });
  assert.equal(advised.status, 0, advised.stderr);
  assert.equal(advised.stdout, '', 'the global front door finds the bridge and the gate advises without a decision');
  fs.appendFileSync(path.join(home, '.doflow', 'shared', 'hooks', 'policies', 'mcp-policy.conf'), 'mcp__evil__drop\tCopilot MCP test blocked\n');
  const denied = runEntry(config.hooks.preToolUse[1], { sessionId: 's1', cwd: elsewhere, toolName: 'mcp__evil__drop', toolArgs: {} }, { cwd: elsewhere, home, xdg });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
});

test('a global install follows COPILOT_HOME: hooks land in $COPILOT_HOME/hooks, run from anywhere, and update/remove take them from there', (t: any) => {
  const home = tempDir(t, 'doflow-copilot-hooks-home-');
  const xdg = tempDir(t, 'doflow-copilot-hooks-xdg-');
  const copilotHome = path.join(tempDir(t, 'doflow-copilot-hooks-custom-'), 'copilot');
  settings(xdg, ['copilot']);
  const env = { XDG_CONFIG_HOME: xdg, COPILOT_HOME: copilotHome };
  let r = run(['install', '-g', '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  const hooksDir = path.join(copilotHome, 'hooks');
  for (const name of ['doflow.json', 'doflow-lib.sh', ...DOORS]) assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} is under $COPILOT_HOME/hooks`);
  assert.equal(fs.existsSync(path.join(home, '.copilot', 'hooks')), false, 'nothing under ~/.copilot/hooks');
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')), 'the shared bridge stays under ~/.doflow');

  const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'doflow.json'), 'utf8'));
  const elsewhere = gatedRepo(t);
  const ctx = { cwd: elsewhere, home, xdg, copilotHome };
  const advised = runEntry(config.hooks.preToolUse[0], { sessionId: 's1', cwd: elsewhere, toolName: 'apply_patch', toolArgs: PATCH }, ctx);
  assert.equal(advised.status, 0, advised.stderr);
  assert.equal(advised.stdout, '', 'the gate only advises: no permission decision reaches Copilot');
  fs.appendFileSync(path.join(home, '.doflow', 'shared', 'hooks', 'policies', 'mcp-policy.conf'), 'mcp__evil__drop\tCopilot MCP test blocked\n');
  const denied = runEntry(config.hooks.preToolUse[1], { sessionId: 's1', cwd: elsewhere, toolName: 'mcp__evil__drop', toolArgs: {} }, ctx);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny', 'the front door finds the bridge although it sits beside neither $COPILOT_HOME nor a project');

  r = run(['update', '-g', '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(hooksDir, 'doflow.json')));
  settings(xdg, ['claude']);
  r = run(['update', '-g', '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['doflow.json', ...DOORS]) assert.equal(fs.existsSync(path.join(hooksDir, name)), false, `${name} is removed from $COPILOT_HOME/hooks`);
  settings(xdg, ['copilot']);
  r = run(['update', '-g', '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  r = run(['remove', '-g', '--force', '--target', 'copilot'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(hooksDir, 'doflow.json')), false, 'remove takes the hooks from $COPILOT_HOME/hooks');
});

test('the capability map and the hook tier agree: supported hooks, five wired events, tiered off outside hooks.harnesses', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const row = capabilityMapData(registry).find((item: any) => item.harness === 'copilot' && item.capability === 'hooks');
  assert.equal(row.status, 'supported');
  assert.equal(row.nativeTarget, '.github/hooks');
  assert.ok(row.evidence.includes('https://docs.github.com/en/copilot/reference/hooks-reference'));
  const copilot = registry.harnesses.find((item: any) => item.id === 'copilot');
  const wired = Object.entries(copilot.capabilities.hooks.events).filter(([, detail]: any) => detail.status === 'supported').map(([event]) => event).sort();
  const contract = registry.contracts.find((item: any) => item.harness === 'copilot');
  assert.deepEqual(wired, [...contract.hookEvents].sort());
  assert.deepEqual(wired, ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(selectAssets(registry, { harness: 'copilot', capability: 'hooks' }).map((asset: any) => asset.id).sort(), ['copilot.hooks-scripts', 'hooks.shared']);
  // Claude and Copilot installs side by side: the registry says what that duplicates (subagent-audit), not "idempotent".
  assert.match(copilot.capabilities.hooks.note, /subagent-audit appends unconditionally, so one subagent completion writes two stop records/);
  assert.doesNotMatch(copilot.capabilities.hooks.note, /idempotent, not deduplicated/);
  const tiered = tieredRegistry(registry, ['claude']);
  assert.deepEqual(selectAssets(tiered, { harness: 'copilot', capability: 'hooks' }), []);
  assert.equal(tiered.harnesses.find((item: any) => item.id === 'copilot').capabilities.hooks.status, 'unavailable');
});
