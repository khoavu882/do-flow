'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planCodexHooks, deployCodexHooks } = require('../src/codex-hooks');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-hooks-')); }
function hookConfig(command = 'bash "$(root)/hooks/session-start.sh"') {
  return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command, statusMessage: 'Preparing context' }] }] } };
}
function wrapper(root, name = 'session-start.sh', mode = 0o755) {
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, name); fs.writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n'); fs.chmodSync(file, mode); return hooks;
}

test('validates documented Codex hook event structure', () => {
  assert.equal(validateHooksConfig(hookConfig()).ok, true);
  const invalid = validateHooksConfig({ hooks: { ConfigChange: [{ hooks: [{ type: 'command', command: 'echo no' }] }] } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors[0], /Unsupported Codex hook event 'ConfigChange'/);
});

test('classifies only Codex-supported Claude guardrail mappings', () => {
  const result = classifyClaudeGuardrails({ SessionStart: [], PreToolUse: [], ConfigChange: [] });
  assert.deepEqual(result.supported.map((item) => item.targetEvent), ['SessionStart', 'PreToolUse']);
  assert.deepEqual(result.unsupported.map((item) => item.sourceEvent), ['ConfigChange']);
});

test('fails closed for missing or non-executable command wrappers', () => {
  const root = scratch();
  let result = verifyHookCommands(hookConfig(), { scriptsDir: path.join(root, 'hooks') });
  assert.equal(result.ok, false); assert.equal(result.checks[0].reason, 'Hook script is missing');
  const hooks = wrapper(root, 'session-start.sh', 0o644);
  result = verifyHookCommands(hookConfig(), { scriptsDir: hooks });
  assert.equal(result.ok, false); assert.equal(result.checks[0].reason, 'Hook script is not executable');
});

test('reports hook trust as a prerequisite instead of bypassing it', () => {
  const root = scratch(); const hooks = wrapper(root);
  const untrusted = verifyHookCommands(hookConfig(), { scriptsDir: hooks });
  const trusted = verifyHookCommands(hookConfig(), { scriptsDir: hooks, trusted: true });
  assert.equal(untrusted.ok, true); assert.equal(untrusted.trust.status, 'review-required');
  assert.equal(trusted.trust.status, 'trusted');
});

test('plans and deploys hook config using an explicit project destination', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root); const projectRoot = path.join(root, 'project');
  const plan = planCodexHooks({ config: hookConfig(), sourceHooksDir, trusted: false,
    destinationContext: { scope: 'project', projectRoot } });
  assert.equal(plan.ok, true); assert.equal(plan.destination, path.join(projectRoot, '.codex', 'hooks.json'));
  assert.equal(plan.trust.status, 'review-required');
  const deployed = deployCodexHooks(plan);
  assert.equal(deployed.applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(plan.destination, 'utf8')), hookConfig());
  assert.equal(fs.statSync(path.join(projectRoot, '.codex', 'hooks', 'session-start.sh')).mode & 0o111, 0o111);
});

test('deploy copies every file in scriptsDir, not just ones named in a hooks.json command', () => {
  // Regression test: a sourced helper (lib.sh) or runtime-read config (*.conf) is never named
  // literally in a command string, so commandScriptNames() can't discover it — deployCodexHooks
  // used to copy only command-referenced scripts, silently dropping such sidecar files from the
  // deployed install even though the hook script itself depends on them at runtime.
  const root = scratch(); const sourceHooksDir = wrapper(root); const projectRoot = path.join(root, 'project');
  fs.writeFileSync(path.join(sourceHooksDir, 'lib.sh'), '#!/usr/bin/env bash\necho lib\n');
  fs.writeFileSync(path.join(sourceHooksDir, 'patterns.conf'), 'deny-me\n');
  const plan = planCodexHooks({ config: hookConfig(), sourceHooksDir, trusted: false,
    destinationContext: { scope: 'project', projectRoot } });
  deployCodexHooks(plan);
  const deployedHooks = path.join(projectRoot, '.codex', 'hooks');
  assert.equal(fs.readFileSync(path.join(deployedHooks, 'lib.sh'), 'utf8'), '#!/usr/bin/env bash\necho lib\n');
  assert.equal(fs.readFileSync(path.join(deployedHooks, 'patterns.conf'), 'utf8'), 'deny-me\n');
  // hooks.json itself lives alongside the scripts in the source tree but is deployed separately
  // to .codex/hooks.json (not .codex/hooks/hooks.json) — must not be duplicated into hooks/.
  assert.equal(fs.existsSync(path.join(deployedHooks, 'hooks.json')), false);
});

test('every Codex hook script that delegates to a sibling script names a file other than itself', () => {
  // Regression test: a thin wrapper that delegates via `bash "$(dirname "$0")/<name>"` must name a
  // *different* file — if the wrapper's own filename matches its delegation target, invoking it
  // causes infinite self-recursion (a real bug this migration introduced by renaming the wrapper
  // to the same name as its exec target, then fixed via distinctly-named .impl.sh copies).
  const hooksDir = path.resolve(__dirname, '..', 'core', 'harnesses', 'codex', 'hooks');
  for (const file of fs.readdirSync(hooksDir)) {
    if (!file.endsWith('.sh')) continue;
    const codeLines = fs.readFileSync(path.join(hooksDir, file), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('#'));
    for (const line of codeLines) {
      for (const match of line.matchAll(/\$\(dirname "\$0"\)\/([A-Za-z0-9_.-]+\.sh)/g)) {
        assert.notEqual(match[1], file, `${file} must not delegate to a script named identically to itself (self-recursion)`);
      }
    }
  }
});
