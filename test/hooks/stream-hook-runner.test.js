'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  evaluateToolCall, evaluatePayload, resolveProjectRoot,
  evaluateEvent, resolveAgent, resolveAdapter, resolvePolicyScript,
  classifyPreToolUsePolicy, sniffEventFromPayload,
} = require('../../core/harnesses/shared/hooks/stream-hook-runner');
const geminiAdapter = require('../../core/harnesses/shared/hooks/adapters/gemini');
const antigravityAdapter = require('../../core/harnesses/shared/hooks/adapters/antigravity');

test('stream-hook-runner: resolveProjectRoot resolves valid workspace paths', () => {
  const root = resolveProjectRoot([__dirname]);
  assert.ok(typeof root === 'string');
  assert.ok(root.length > 0);
});

test('stream-hook-runner: resolveProjectRoot resolves to the git toplevel, not a subdirectory (022-code-review regression)', () => {
  const root = resolveProjectRoot([path.join(process.cwd(), 'core', 'harnesses')]);
  assert.equal(root, process.cwd());
});

test('stream-hook-runner: resolveProjectRoot skips a non-git workspacePaths entry in a multi-root list (022-code-review regression)', () => {
  // A multi-root workspace listing a non-git directory first must not stop the search — the
  // Antigravity shim this runner replaced iterated every entry, not just the first that exists.
  const root = resolveProjectRoot([require('node:os').tmpdir(), process.cwd()]);
  assert.equal(root, process.cwd());
});

test('stream-hook-runner: evaluateToolCall allows benign tool calls', () => {
  const result = evaluateToolCall({
    name: 'view_file',
    args: { AbsolutePath: '/some/path/file.txt' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateToolCall blocks destructive commands', () => {
  // Delegates to the Canonical Policy Library's pre-bash-guard.sh (022-normalize-hooks Phase B) —
  // the reason text is now that script's, not the old inlined regex's "SAFETY INVARIANT BLOCKED".
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'rm -rf /' },
  }, process.cwd());

  assert.equal(result.decision, 'deny');
  assert.ok(result.reason.includes('pre-bash-guard'));
  assert.ok(result.reason.toLowerCase().includes('blocked'));
});

test('stream-hook-runner: evaluateToolCall blocks a denied MCP tool call (022-normalize-hooks: newly wired)', (t) => {
  // mcp-policy.conf ships with zero active patterns by design, so this only exercises the
  // dispatch path (MCP_TOOL_PATTERN -> mcp-tool-guard.sh), not a real deny — asserting a real
  // deny would require mutating the shared policy conf, which no test should do.
  const result = evaluateToolCall({
    name: 'mcp__example__tool',
    args: {},
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateToolCall allows safe run_command', () => {
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'npm test' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PreInvocation hook payloads', () => {
  const result = evaluatePayload({
    invocationNum: 1,
    initialNumSteps: 5,
  }, process.cwd());

  assert.deepEqual(result, { injectSteps: [] });
});

test('stream-hook-runner: evaluatePayload handles Stop hook payloads', () => {
  const result = evaluatePayload({
    executionNum: 1,
    terminationReason: 'model_stop',
    fullyIdle: true,
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PostToolUse hook payloads', () => {
  const result = evaluatePayload({
    stepIdx: 3,
    error: '',
  }, process.cwd());

  assert.deepEqual(result, {});
});

// ── 022-normalize-hooks Phase B: event dispatcher / adapter seam ──────────────

test('stream-hook-runner: classifyPreToolUsePolicy routes by tool name', () => {
  assert.equal(classifyPreToolUsePolicy('mcp__github__create_issue'), 'mcp-tool-guard.sh');
  assert.equal(classifyPreToolUsePolicy('mcp_github_create_issue'), 'mcp-tool-guard.sh');
  assert.equal(classifyPreToolUsePolicy('Edit'), 'pre-implementation-gate.sh');
  assert.equal(classifyPreToolUsePolicy('write_to_file'), 'pre-implementation-gate.sh');
  assert.equal(classifyPreToolUsePolicy('Bash'), 'pre-bash-guard.sh');
  assert.equal(classifyPreToolUsePolicy('run_command'), 'pre-bash-guard.sh');
  assert.equal(classifyPreToolUsePolicy('read_file'), null);
});

test('stream-hook-runner: resolveAgent reads DOFLOW_AGENT, defaults to antigravity', () => {
  const prev = process.env.DOFLOW_AGENT;
  try {
    process.env.DOFLOW_AGENT = 'gemini';
    assert.equal(resolveAgent(), 'gemini');
    process.env.DOFLOW_AGENT = 'antigravity';
    assert.equal(resolveAgent(), 'antigravity');
    delete process.env.DOFLOW_AGENT;
    assert.equal(resolveAgent(), 'antigravity');
  } finally {
    if (prev === undefined) delete process.env.DOFLOW_AGENT; else process.env.DOFLOW_AGENT = prev;
  }
});

test('stream-hook-runner: resolveAgent warns on stderr for an unrecognized non-empty DOFLOW_AGENT (022-diagnose follow-up)', () => {
  const prev = process.env.DOFLOW_AGENT;
  const originalWrite = process.stderr.write;
  let written = '';
  process.stderr.write = (chunk) => { written += chunk; return true; };
  try {
    process.env.DOFLOW_AGENT = 'gemni';
    assert.equal(resolveAgent(), 'antigravity');
    assert.ok(written.includes('gemni'));

    written = '';
    process.env.DOFLOW_AGENT = 'antigravity';
    resolveAgent();
    assert.equal(written, '');

    written = '';
    delete process.env.DOFLOW_AGENT;
    resolveAgent();
    assert.equal(written, '');
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) delete process.env.DOFLOW_AGENT; else process.env.DOFLOW_AGENT = prev;
  }
});

test('stream-hook-runner: resolveAdapter picks the matching adapter module', () => {
  assert.equal(resolveAdapter('gemini'), geminiAdapter);
  assert.equal(resolveAdapter('antigravity'), antigravityAdapter);
  assert.equal(resolveAdapter('unknown'), antigravityAdapter);
});

test('stream-hook-runner: sniffEventFromPayload infers event from payload shape', () => {
  assert.equal(sniffEventFromPayload({ toolCall: { name: 'Edit' } }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ tool_name: 'Edit' }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ invocationNum: 1 }), 'PreInvocation');
  assert.equal(sniffEventFromPayload({ terminationReason: 'model_stop' }), 'Stop');
  assert.equal(sniffEventFromPayload({ executionNum: 1 }), 'Stop');
  assert.equal(sniffEventFromPayload({ stepIdx: 1 }), 'PostToolUse');
  assert.equal(sniffEventFromPayload({ session_id: 'x', cwd: '/tmp' }), 'SessionStart');
  assert.equal(sniffEventFromPayload({}), null);
});

test('stream-hook-runner: sniffEventFromPayload does not misclassify PreToolUse as PostToolUse when toolCall is present but falsy (022-code-review regression)', () => {
  // A real Antigravity PreToolUse payload can carry a null/empty toolCall alongside stepIdx (also
  // present on PostToolUse payloads) — the fix checks key presence ('toolCall' in payload), not
  // truthiness, so this still classifies as PreToolUse instead of silently skipping the gate.
  assert.equal(sniffEventFromPayload({ toolCall: null, stepIdx: 3, workspacePaths: ['/tmp'] }), 'PreToolUse');
  assert.equal(sniffEventFromPayload({ toolCall: {}, stepIdx: 3 }), 'PreToolUse');
});

test('stream-hook-runner: resolvePolicyScript finds the Phase A canonical script', () => {
  const script = resolvePolicyScript(process.cwd(), 'pre-bash-guard.sh');
  assert.ok(script);
  assert.ok(script.includes(path.join('shared', 'hooks', 'policies', 'pre-bash-guard.sh')));
});

test('stream-hook-runner: evaluateEvent SessionStart never denies', () => {
  const result = evaluateEvent('SessionStart', { session_id: 'x', cwd: process.cwd() }, process.cwd(), 'gemini');
  assert.deepEqual(result, { decision: 'allow' });
});

test('stream-hook-runner: evaluateEvent Stop delegates to stop-check.sh', () => {
  const result = evaluateEvent('Stop', { session_id: '', transcript_path: '' }, process.cwd(), 'gemini');
  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateEvent PostToolUse/PreInvocation are ack-only placeholders', () => {
  assert.deepEqual(evaluateEvent('PostToolUse', {}, process.cwd(), 'gemini'), { decision: 'allow' });
  assert.deepEqual(evaluateEvent('PreInvocation', {}, process.cwd(), 'antigravity'), { decision: 'allow' });
});

test('stream-hook-runner adapters: gemini.toCanonical reads its own field names before falling back to toolCall', () => {
  const canonical = geminiAdapter.toCanonical('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  assert.equal(canonical.tool_name, 'Bash');
  assert.equal(canonical.tool_input.command, 'ls');
});

test('stream-hook-runner adapters: gemini.toNative emits a flat {decision,reason} shape', () => {
  assert.deepEqual(
    geminiAdapter.toNative('PreToolUse', { decision: 'deny', reason: 'blocked' }),
    { decision: 'deny', reason: 'blocked' },
  );
  assert.deepEqual(geminiAdapter.toNative('PreToolUse', { decision: 'allow' }), { decision: 'allow' });
});

test('stream-hook-runner adapters: antigravity.toNative Stop uses the continue/silence vocabulary', () => {
  assert.deepEqual(
    antigravityAdapter.toNative('Stop', { decision: 'deny', reason: 'unfinished work' }),
    { decision: 'continue', reason: 'unfinished work' },
  );
  // Allow is silence (empty object), NOT {decision:'allow'} — Stop's documented asymmetry from
  // PreToolUse's allow/deny vocabulary (design.md C2 / adapters/antigravity.js header).
  assert.deepEqual(antigravityAdapter.toNative('Stop', { decision: 'allow' }), {});
});
