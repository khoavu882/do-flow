'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planCodexHooks, deployCodexHooks } = require('../../../src/adapters/codex/hooks');

const CODEX_HOOKS_DIR = path.resolve(__dirname, '../../..', 'core', 'harnesses', 'codex', 'hooks');

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

test('merges into pre-existing hooks in .codex/hooks.json, preserving user custom hooks', () => {
  const root = scratch(); const sourceHooksDir = wrapper(root); const projectRoot = path.join(root, 'project');
  const hooksFile = path.join(projectRoot, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'custom-matcher', hooks: [{ type: 'command', command: 'echo user-custom-codex-hook' }] }],
    },
  }));

  const plan = planCodexHooks({ config: hookConfig(), sourceHooksDir, trusted: false,
    destinationContext: { scope: 'project', projectRoot } });
  assert.equal(plan.ok, true);
  deployCodexHooks(plan);

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.equal(written.hooks.SessionStart.length, 2, 'both custom and managed hook entries must be present');
  assert.equal(written.hooks.SessionStart[0].hooks[0].command, 'echo user-custom-codex-hook', 'user custom hook must remain first');
  assert.equal(written.hooks.SessionStart[1].hooks[0].command, 'bash "$(root)/hooks/session-start.sh"');
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

test('accepts PostToolUse and PreCompact — the two events closing the Claude/Codex hook-coverage gap', () => {
  const config = { hooks: {
    PostToolUse: [{ matcher: '^(apply_patch|Edit|Write)$', hooks: [{ type: 'command', command: 'bash "$(dirname)/post-edit-lint.sh"' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'bash "$(dirname)/pre-compact.sh"', timeout: 3 }] }],
  } };
  assert.equal(validateHooksConfig(config).ok, true);
  const classified = classifyClaudeGuardrails({ PostToolUse: [], PreCompact: [] });
  assert.deepEqual(classified.supported.map((item) => item.targetEvent), ['PostToolUse', 'PreCompact']);
  assert.deepEqual(classified.unsupported, []);
});

test('the real core/harnesses/codex/hooks/hooks.json fixture is itself valid per validateHooksConfig', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(CODEX_HOOKS_DIR, 'hooks.json'), 'utf8'));
  const result = validateHooksConfig(fixture);
  assert.equal(result.ok, true, `hooks.json fixture failed validation: ${JSON.stringify(result.errors)}`);
  assert.ok(result.events.includes('PostToolUse'), 'hooks.json should wire PostToolUse');
  assert.ok(result.events.includes('PreCompact'), 'hooks.json should wire PreCompact');
});

test('post-edit-lint.impl.sh extracts every file path from a multi-file apply_patch, not just Edit/Write file_path', () => {
  // Regression test: apply_patch's tool_input is
  // {"command": "<raw patch>"}, not {"file_path": "..."} — a naive Edit/Write-only port would
  // silently collect nothing for every Codex edit.
  const patch = [
    '*** Begin Patch',
    '*** Add File: foo/bar.txt',
    '+hello',
    '*** Update File: baz/qux.txt',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const sessionId = `test-apply-patch-${process.pid}-${Date.now()}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-post-edit-lint-'));
  try {
    execFileSync('bash', [path.join(CODEX_HOOKS_DIR, 'post-edit-lint.impl.sh')], {
      input: JSON.stringify({ session_id: sessionId, tool_name: 'apply_patch', tool_input: { command: patch } }),
      env: { ...process.env, XDG_CONFIG_HOME: stateDir },
    });
    const collected = fs.readFileSync(path.join(stateDir, 'doflow', 'session-env', 'sessions', sessionId, 'edited-files.txt'), 'utf8');
    assert.deepEqual(collected.trim().split('\n'), ['foo/bar.txt', 'baz/qux.txt']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('pre-compact.impl.sh emits valid JSON with only Codex-accepted universal fields', () => {
  // Regression test: Codex's PreCompact output schema is JSON-only (deny_unknown_fields on
  // HookUniversalOutputWire) — Claude's plain-string custom_instructions output would not parse.
  const out = execFileSync('bash', [path.join(CODEX_HOOKS_DIR, 'pre-compact.impl.sh')], {
    input: JSON.stringify({ cwd: process.cwd() }),
  }).toString('utf8');
  const parsed = JSON.parse(out); // throws if not valid JSON
  const allowedKeys = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage']);
  for (const key of Object.keys(parsed)) assert.ok(allowedKeys.has(key), `unexpected key '${key}' — Codex's schema rejects unknown fields`);
  assert.equal(typeof parsed.systemMessage, 'string');
  assert.ok(parsed.systemMessage.length <= 490);
});

test('every Codex hook script that delegates to a sibling script names a file other than itself', () => {
  // Regression test: a thin wrapper that delegates via `bash "$(dirname "$0")/<name>"` must name a
  // *different* file — if the wrapper's own filename matches its delegation target, invoking it
  // causes infinite self-recursion (a real bug this migration introduced by renaming the wrapper
  // to the same name as its exec target, then fixed via distinctly-named .impl.sh copies).
  const hooksDir = path.resolve(__dirname, '../../..', 'core', 'harnesses', 'codex', 'hooks');
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
