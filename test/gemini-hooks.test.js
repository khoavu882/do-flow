'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planGeminiHooks, deployGeminiHooks, planRemoveGeminiHooks, deployRemoveGeminiHooks } = require('../src/gemini-hooks');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-gemini-hooks-')); }
function hookConfig(command = 'bash "$GEMINI_PROJECT_DIR/.gemini/hooks/session-start.sh"') {
  return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } };
}
function wrapper(root, name = 'session-start.sh', mode = 0o755) {
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, name); fs.writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n'); fs.chmodSync(file, mode); return hooks;
}

test('validates the documented Gemini hook event set', () => {
  assert.equal(validateHooksConfig(hookConfig()).ok, true);
  const invalid = validateHooksConfig({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo no' }] }] } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors[0], /Unsupported Gemini hook event 'PreToolUse'/);
});

test('classifies Claude guardrails onto their real Gemini event, never approximating an unmapped one', () => {
  const result = classifyClaudeGuardrails({ PreToolUse: [], PostToolUse: [], PreCompact: [], Stop: [], SubagentStart: [] });
  assert.deepEqual(result.supported.map((item) => `${item.sourceEvent}->${item.targetEvent}`),
    ['PreToolUse->BeforeTool', 'PostToolUse->AfterTool', 'PreCompact->PreCompress']);
  assert.deepEqual(result.unsupported.map((item) => item.sourceEvent), ['Stop', 'SubagentStart']);
});

test('fails closed for missing or non-executable command wrappers', () => {
  const root = scratch();
  let result = verifyHookCommands(hookConfig(), { scriptsDir: path.join(root, 'hooks') });
  assert.equal(result.ok, false); assert.equal(result.checks[0].reason, 'Hook script is missing');
  const hooks = wrapper(root, 'session-start.sh', 0o644);
  result = verifyHookCommands(hookConfig(), { scriptsDir: hooks });
  assert.equal(result.ok, false); assert.equal(result.checks[0].reason, 'Hook script is not executable');
});

test('reports hook trust as a prerequisite instead of assuming Gemini activated it', () => {
  const root = scratch(); const hooks = wrapper(root);
  const untrusted = verifyHookCommands(hookConfig(), { scriptsDir: hooks });
  const trusted = verifyHookCommands(hookConfig(), { scriptsDir: hooks, trusted: true });
  assert.equal(untrusted.trust.status, 'review-required'); assert.equal(trusted.trust.status, 'trusted');
});

test('plans a key-scoped merge into settings.json, preserving every unrelated key (FR-002)', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ mcpServers: { foo: { command: 'bar' } }, ui: { theme: 'dark' } }));

  const plan = planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile });
  assert.equal(plan.ok, true); assert.equal(plan.status, 'change');
  const deployed = deployGeminiHooks(plan);
  assert.equal(deployed.applied, true);

  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(written.mcpServers, { foo: { command: 'bar' } }, 'pre-existing mcpServers must survive the merge');
  assert.deepEqual(written.ui, { theme: 'dark' }, 'pre-existing ui settings must survive the merge');
  assert.deepEqual(written.hooks, hookConfig().hooks);
  assert.equal(fs.statSync(path.join(root, '.gemini', 'hooks', 'session-start.sh')).mode & 0o111, 0o111, 'script must be deployed and executable');
});

test('creates settings.json from scratch when none exists yet', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  const plan = planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile });
  assert.equal(plan.ok, true);
  deployGeminiHooks(plan);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks, hookConfig().hooks);
});

test('refuses to touch a malformed settings.json rather than silently discarding its content', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{ not valid json');
  const plan = planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile });
  assert.equal(plan.ok, false); assert.equal(plan.status, 'malformed');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ not valid json', 'malformed file must be left untouched');
});

test('deploy is idempotent — a second plan over unchanged state reports unchanged, applies nothing', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  deployGeminiHooks(planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile }));
  const second = planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile });
  assert.equal(second.status, 'unchanged');
  const deployed = deployGeminiHooks(second);
  assert.equal(deployed.applied, false);
});

test('does not duplicate hooks.json itself into the deployed hooks/ scripts dir', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  fs.writeFileSync(path.join(sourceHooksDir, 'hooks.json'), JSON.stringify(hookConfig()));
  fs.writeFileSync(path.join(sourceHooksDir, 'lib.sh'), '#!/usr/bin/env bash\necho lib\n');
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  const plan = planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile });
  deployGeminiHooks(plan);
  const deployedHooksDir = path.join(root, '.gemini', 'hooks');
  assert.equal(fs.existsSync(path.join(deployedHooksDir, 'hooks.json')), false, 'the source template hooks.json must not be copied as a sidecar file');
  assert.equal(fs.readFileSync(path.join(deployedHooksDir, 'lib.sh'), 'utf8'), '#!/usr/bin/env bash\necho lib\n', 'non-.json sidecar files (lib.sh) must still be deployed');
});

test('removal strips only the hooks key, preserving every unrelated key (FR-002)', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root);
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ mcpServers: { foo: { command: 'bar' } } }));
  deployGeminiHooks(planGeminiHooks({ config: hookConfig(), sourceHooksDir, settingsFile }));

  const removePlan = planRemoveGeminiHooks({ settingsFile });
  assert.equal(removePlan.ok, true); assert.equal(removePlan.status, 'change');
  const removed = deployRemoveGeminiHooks(removePlan);
  assert.equal(removed.applied, true);

  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal('hooks' in written, false, 'hooks key must be gone');
  assert.deepEqual(written.mcpServers, { foo: { command: 'bar' } }, 'unrelated mcpServers must survive removal');
});

test('removal is a no-op when settings.json has no hooks key (nothing to strip)', () => {
  const root = scratch();
  const settingsFile = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ui: { theme: 'dark' } }));
  const removePlan = planRemoveGeminiHooks({ settingsFile });
  assert.equal(removePlan.status, 'unchanged');
  const removed = deployRemoveGeminiHooks(removePlan);
  assert.equal(removed.applied, false);
});

test('removal is a no-op when settings.json does not exist at all', () => {
  const root = scratch();
  const removePlan = planRemoveGeminiHooks({ settingsFile: path.join(root, '.gemini', 'settings.json') });
  assert.equal(removePlan.ok, true); assert.equal(removePlan.status, 'unchanged');
});
