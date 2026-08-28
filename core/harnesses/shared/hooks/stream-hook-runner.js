#!/usr/bin/env node
'use strict';

/**
 * DoFlow Cross-Harness Hook Runner (design.md C2) — front door for every in-scope lifecycle
 * event (SessionStart, PreToolUse, PostToolUse, Stop, PreInvocation) for the two harnesses whose
 * native hook contract speaks JSON stdin/stdout rather than a bare exit code: Gemini CLI and
 * Antigravity. It owns event dispatch and per-harness payload/decision translation (delegated to
 * adapters/{gemini,antigravity}.js, D2) and delegates every policy decision to the Canonical
 * Policy Library (core/harnesses/shared/hooks/policies/*.sh, Phase A) — it implements no guard
 * policy logic itself.
 *
 * Invocation: `node stream-hook-runner.js [EventName]`, JSON payload on stdin, JSON decision on
 * stdout. EventName is the preferred way to select which canonical policy applies; when omitted
 * (older hooks.json wiring that doesn't yet pass it), the event is inferred from the payload's
 * own shape as a fallback, matching this runner's behavior before event names were threaded
 * through argv.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const geminiAdapter = require('./adapters/gemini');
const antigravityAdapter = require('./adapters/antigravity');

// Tool-name classification for PreToolUse, generalized to the union every Phase A canonical
// script's own case statement already recognizes (session-context.sh/pre-implementation-gate.sh/
// mcp-tool-guard.sh/pre-bash-guard.sh headers) rather than only the two harnesses this runner
// drives — kept in sync with those scripts, not redefined independently of them.
const MCP_TOOL_PATTERN = /^mcp_/i;
const EDIT_TOOL_PATTERN = /^(replace_file_content|write_to_file|multi_replace_file_content|edit_file|write_file|create_file|replace_file|replace|Edit|Write|MultiEdit|apply_patch)$/i;
const COMMAND_TOOL_PATTERN = /^(run_command|run_shell_command|Bash|bash)$/i;

// Canonical script name -> pre-normalization per-harness file name, for the fallback search only.
const LEGACY_SCRIPT_NAMES = {
  'session-context.sh': 'session-start.sh',
  'pre-implementation-gate.sh': 'pre-implement-gate.sh',
  'mcp-tool-guard.sh': 'mcp-tool-guard.sh',
  'stop-check.sh': 'stop-check.sh',
  'pre-bash-guard.sh': 'pre-bash-guard.sh',
};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

// Resolve <dir>'s git toplevel, the way `git rev-parse --show-toplevel` would, without shelling
// out — this runner is invoked once per hook event, so avoiding a subprocess here matters for
// NFR-001. Walks up from <dir> looking for a `.git` entry (directory or file — a submodule/
// worktree gitlink is a file, not a directory) and returns the directory that contains it, which
// may differ from <dir> itself when <dir> is a subdirectory of the repo. Returns null if <dir> is
// not inside a git working tree at all.
function gitToplevelOf(dir) {
  let d = dir;
  while (true) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function resolveProjectRoot(workspacePaths) {
  // The replaced Antigravity shim (pre-implementation-gate.sh) iterated every documented
  // workspacePaths entry, verifying each is a real git repo via `git -C "$dir" rev-parse
  // --show-toplevel`, rather than trusting the first existing path — restored here so a
  // multi-root workspace listing a non-git directory first still resolves to the actual
  // DoFlow-tracked repo's toplevel rather than failing the gate open against the wrong directory.
  if (Array.isArray(workspacePaths)) {
    for (const candidate of workspacePaths) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const toplevel = gitToplevelOf(candidate);
      if (toplevel) return toplevel;
    }
    // No candidate was inside a verified git repo; fall through rather than trusting an
    // unverified one.
  }
  let d = process.cwd();
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, '.doflow'))) {
      return d;
    }
    d = path.dirname(d);
  }
  return process.cwd();
}

/**
 * Resolve a Canonical Policy Library script's absolute path. Primary location is this runner's
 * own `policies/` sibling directory (core/harnesses/shared/hooks/policies/) — the canonical
 * source of truth (design.md C1) that ships alongside this file, so the lookup needs no
 * project-root guessing and works identically in-repo and once installed, as long as the
 * `shared/hooks/` tree is projected together. The per-harness candidate search below is kept only
 * as a fallback for an install that hasn't picked up the canonical policies/ directory yet.
 */
function resolvePolicyScript(projectRoot, scriptName) {
  const primary = path.join(__dirname, 'policies', scriptName);
  if (fs.existsSync(primary)) return primary;

  const legacyName = LEGACY_SCRIPT_NAMES[scriptName] || scriptName;
  const candidates = [
    path.join(projectRoot, '.gemini/hooks', legacyName),
    path.join(projectRoot, '.claude/hooks', legacyName),
    path.join(projectRoot, '.codex/hooks', legacyName),
    path.join(projectRoot, '.doflow/scripts', legacyName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Delegate one canonical-decision evaluation to a Phase A policy script (design.md's Canonical
 * Policy Script Contract): the canonical payload goes in on stdin, DOFLOW_PROJECT_DIR/DOFLOW_AGENT
 * are set, and the exit code decides allow/deny — exit 0 = allow, non-zero = deny with the reason
 * read from stderr (falling back to stdout if a script has none). Returns the CANONICAL decision
 * shape ({decision:'allow'} | {decision:'deny', reason}); harness-native translation happens one
 * layer up, in the adapter's toNative, not here — this function never speaks a harness-specific
 * decision vocabulary.
 */
function delegateToPolicy(projectRoot, agent, scriptName, canonicalPayload) {
  const scriptPath = resolvePolicyScript(projectRoot, scriptName);
  if (!scriptPath) return { decision: 'allow' };

  try {
    execFileSync('bash', [scriptPath], {
      cwd: projectRoot,
      input: JSON.stringify(canonicalPayload || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOFLOW_PROJECT_DIR: projectRoot, DOFLOW_AGENT: agent },
    });
    return { decision: 'allow' };
  } catch (err) {
    const reason = err.stderr ? err.stderr.toString().trim() : (err.stdout ? err.stdout.toString().trim() : '');
    return {
      decision: 'deny',
      reason: reason || `[${scriptName}] blocked by DoFlow guard policy`,
    };
  }
}

function classifyPreToolUsePolicy(toolName) {
  if (MCP_TOOL_PATTERN.test(toolName)) return 'mcp-tool-guard.sh';
  if (EDIT_TOOL_PATTERN.test(toolName)) return 'pre-implementation-gate.sh';
  if (COMMAND_TOOL_PATTERN.test(toolName)) return 'pre-bash-guard.sh';
  return null;
}

function evaluatePreToolUsePolicy(canonicalPayload, projectRoot, agent) {
  const toolName = (canonicalPayload && canonicalPayload.tool_name) || '';
  const scriptName = classifyPreToolUsePolicy(toolName);
  if (!scriptName) return { decision: 'allow' };
  return delegateToPolicy(projectRoot, agent, scriptName, canonicalPayload);
}

/**
 * Evaluate one lifecycle event against the Canonical Policy Library, returning a CANONICAL
 * decision. Every event this runner drives maps to at most one Phase A script:
 *   SessionStart -> session-context.sh (side-effect only; the script's own contract says it never
 *                   denies, so its exit code is not propagated as a decision)
 *   PreToolUse   -> mcp-tool-guard.sh | pre-implementation-gate.sh | pre-bash-guard.sh, chosen by
 *                   the tool-name classification above
 *   Stop         -> stop-check.sh
 *   PostToolUse, PreInvocation -> no Phase A policy owns these yet (post-edit-lint.sh's collector
 *                   role is out of FR-001's four-policy scope) — ack only; the adapter's toNative
 *                   decides the harness-native shape regardless of this placeholder decision.
 */
function evaluateEvent(event, canonicalPayload, projectRoot, agent) {
  switch (event) {
    case 'SessionStart':
      delegateToPolicy(projectRoot, agent, 'session-context.sh', canonicalPayload);
      return { decision: 'allow' };

    case 'PreToolUse':
      return evaluatePreToolUsePolicy(canonicalPayload, projectRoot, agent);

    case 'Stop':
      return delegateToPolicy(projectRoot, agent, 'stop-check.sh', canonicalPayload);

    case 'PostToolUse':
    case 'PreInvocation':
    default:
      return { decision: 'allow' };
  }
}

// Falls back to 'antigravity' (this runner's legacy default) for any value other than
// 'gemini', including unset/empty. An unrecognized non-empty value is likely a typo, so it
// gets a stderr warning even though the fallback still applies.
function resolveAgent() {
  const raw = process.env.DOFLOW_AGENT || '';
  const agent = raw.toLowerCase();
  if (agent === 'gemini') return 'gemini';
  if (raw && agent !== 'antigravity') {
    process.stderr.write(`stream-hook-runner: unrecognized DOFLOW_AGENT="${raw}", falling back to antigravity\n`);
  }
  return 'antigravity';
}

function resolveAdapter(agent) {
  return agent === 'gemini' ? geminiAdapter : antigravityAdapter;
}

function sniffEventFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // 'toolCall' in payload (key presence), not payload.toolCall (truthiness): a real Antigravity
  // PreToolUse payload can carry a null/empty toolCall alongside stepIdx (also present on
  // PostToolUse payloads) — truthiness alone let such a payload fall through to the stepIdx check
  // below and get misclassified as PostToolUse, silently skipping the gate entirely
  // (022-code-review finding). Checked before Stop/PostToolUse since a missed PreToolUse
  // classification fails the gate open, the worse failure mode of the two.
  if ('toolCall' in payload || payload.tool_name !== undefined) return 'PreToolUse';
  if (payload.invocationNum !== undefined) return 'PreInvocation';
  if (payload.terminationReason !== undefined || payload.executionNum !== undefined) return 'Stop';
  if (payload.stepIdx !== undefined || payload.terminationBehavior !== undefined) return 'PostToolUse';
  if (payload.session_id !== undefined && payload.cwd !== undefined) return 'SessionStart';
  return null;
}

// ── Back-compat helpers ──────────────────────────────────────────────────────
//
// evaluateToolCall/evaluatePayload predate the event-dispatcher/adapter split and are kept for
// callers (including test/hooks/stream-hook-runner.test.js) that evaluate a single Antigravity-
// shaped payload directly without going through main()'s argv/env-driven dispatch. Both return the
// CANONICAL decision shape (never harness-native-translated) exactly as they always have.

function evaluateToolCall(toolCall, projectRoot) {
  if (!toolCall || typeof toolCall !== 'object') {
    return { decision: 'allow' };
  }
  const canonicalPayload = antigravityAdapter.toCanonical('PreToolUse', { toolCall });
  return evaluatePreToolUsePolicy(canonicalPayload, projectRoot, 'antigravity');
}

function evaluatePayload(payload, projectRoot) {
  if (!payload || typeof payload !== 'object') {
    return { decision: 'allow' };
  }

  // PreToolUse: toolCall object present
  if (payload.toolCall) {
    return evaluateToolCall(payload.toolCall, projectRoot);
  }

  // PreInvocation: injection hook
  if (payload.invocationNum !== undefined) {
    return { injectSteps: [] };
  }

  // Stop hook: delegate to the canonical stop-check policy
  if (payload.terminationReason !== undefined) {
    const canonicalPayload = antigravityAdapter.toCanonical('Stop', payload);
    return delegateToPolicy(projectRoot, 'antigravity', 'stop-check.sh', canonicalPayload);
  }

  // PostToolUse / PostInvocation: empty object response
  if (payload.stepIdx !== undefined || payload.terminationBehavior !== undefined) {
    return {};
  }

  return { decision: 'allow' };
}

async function main() {
  try {
    const explicitEvent = process.argv[2] || null;
    const rawInput = await readStdin();

    let payload = {};
    if (rawInput && rawInput.trim()) {
      try {
        payload = JSON.parse(rawInput);
      } catch {
        payload = {};
      }
    }

    const projectRoot = resolveProjectRoot(payload.workspacePaths);
    const agent = resolveAgent();
    const adapter = resolveAdapter(agent);
    const event = explicitEvent || sniffEventFromPayload(payload);

    if (!event) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    const canonicalPayload = adapter.toCanonical(event, payload);
    const decision = evaluateEvent(event, canonicalPayload, projectRoot, agent);
    const native = adapter.toNative(event, decision);

    // An empty object is a harness's documented "say nothing" answer (e.g. Antigravity's Stop
    // contract: "silence (exit 0, no stdout) lets the session end" — a positive field, not a
    // missing one, is what a real decision looks like). Writing literal "{}" instead of true
    // silence would be a byte-for-byte behavior change from every native shim this runner
    // replaces, all of which stayed genuinely silent on this path.
    if (native && typeof native === 'object' && Object.keys(native).length > 0) {
      process.stdout.write(JSON.stringify(native) + '\n');
    }
  } catch (err) {
    process.stderr.write(`[stream-hook-runner error] ${err.message}\n`);
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateToolCall,
  evaluatePayload,
  resolveProjectRoot,
  evaluateEvent,
  resolveAgent,
  resolveAdapter,
  resolvePolicyScript,
  classifyPreToolUsePolicy,
  sniffEventFromPayload,
};
