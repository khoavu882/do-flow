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

// ── Failure capture (feature 046: IC-010, IC-011, IC-014, IC-015, IC-018) ─────────────────────────
//
// Hook files are installed without DoFlow's runtime library, so this runner carries its own copy of
// the IC-010 classifier and of the Node failure writer (src/runtime/failure/{classifier,home,capture}.js);
// a test runs both classifier copies over one fixture set and requires equal answers. Capture is a
// side channel at exactly two points, never changes the runner's stdout, stderr or exit status,
// never throws, and is a no-op while capture is off or when no failure home can be resolved. A line
// holds only names from DoFlow's own code and the working directory, never the payload.

const CAPTURE_MAX_LINE_BYTES = 2048;
const CAPTURE_ROTATE_AT_BYTES = 1048576;
const CAPTURE_KEEP_ROTATED = 4;
const CAPTURE_OFF_VALUES = ['off', '0', 'false', 'no'];
const ROTATED_FILE = /^events-\d{8}T\d{6}Z-\d+\.jsonl$/;
const PROGRAMMING_ERROR_NAMES = ['TypeError', 'RangeError', 'ReferenceError'];

/** Reads one property without ever throwing (a throwing getter reads as undefined). */
function readProp(error, key) {
  try { return error[key]; } catch { return undefined; }
}

function isInstance(error, Class) {
  try { return error instanceof Class; } catch { return false; }
}

/** IC-010. Pure and total: never throws whatever it is handed. Kept equal to src/runtime/failure/classifier.js. */
function isProgrammingError(error) {
  try {
    if (error === null || typeof error !== 'object') return false;
    const code = readProp(error, 'code');
    const name = readProp(error, 'name');
    if (code === 'EPIPE') return false;
    if (isInstance(error, SyntaxError) || name === 'SyntaxError') return false;
    if (isInstance(error, TypeError) || isInstance(error, RangeError) || isInstance(error, ReferenceError)) return true;
    if (PROGRAMMING_ERROR_NAMES.includes(name)) return true;
    if (name === 'AssertionError' || code === 'ERR_ASSERTION') return true;
    if (code === 'MODULE_NOT_FOUND') return true;
    return typeof code === 'string' && (typeof readProp(error, 'syscall') === 'string' || typeof readProp(error, 'errno') === 'number');
  } catch {
    return false;
  }
}

/** IC-011: `$XDG_CONFIG_HOME/doflow/failures` when absolute, else `$HOME/.config/doflow/failures` when HOME is absolute, else null. */
function failureHome(env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && xdg !== '') return path.isAbsolute(xdg) ? path.join(xdg, 'doflow', 'failures') : null;
  const home = env.HOME;
  return typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.config', 'doflow', 'failures') : null;
}

/** IC-014: the environment first, then one stat of the sentinel file. */
function captureIsOff(home, env) {
  const setting = env.DOFLOW_FAILURE_CAPTURE;
  if (typeof setting === 'string' && CAPTURE_OFF_VALUES.includes(setting.trim().toLowerCase())) return true;
  try { return fs.statSync(path.join(home, 'off')).isFile(); } catch { return false; }
}

/** The first stack frame inside this hooks folder as `<path relative to it>:<function>`, no line number. */
function runnerFrame(error) {
  try {
    const root = __dirname + path.sep;
    for (const line of String(error.stack || '').split('\n')) {
      const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):\d+:\d+\)?$/.exec(line);
      if (!match) continue;
      const file = match[2].replace(/^file:\/\//, '');
      if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const fn = (match[1] || '').replace(/^new /, '').split('.').pop().replace(/\s.*$/, '') || '<anonymous>';
      return `${path.relative(__dirname, file).split(path.sep).join('/')}:${fn}`;
    }
  } catch { /* no frame */ }
  return null;
}

/** The package version in a checkout, else `script_version` of the nearest install manifest, else `unknown`. */
function hookVersion(env) {
  const valid = (v) => (typeof v === 'string' && /^[A-Za-z0-9._+-]{1,40}$/.test(v) ? v : null);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'));
    if (/doflow$/.test(pkg.name) && valid(pkg.version)) return pkg.version;
  } catch { /* not a checkout */ }
  const starts = [__dirname];
  if (typeof env.HOME === 'string' && path.isAbsolute(env.HOME)) starts.push(env.HOME);
  for (const start of starts) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      try {
        const version = valid(JSON.parse(fs.readFileSync(path.join(dir, '.doflow', '.install-manifest.json'), 'utf8')).script_version);
        if (version) return version;
      } catch { /* none here */ }
      if (path.dirname(dir) === dir || start === env.HOME) break;
    }
  }
  return 'unknown';
}

/**
 * IC-015: at 1 MiB the live file is renamed and only the newest four full rotated files are kept. A
 * rename that took a not-full file (a lost race) is linked back as the live file, or kept as a small
 * rotated file that never counts toward the four and is removed after an hour. Same rules as
 * src/runtime/failure/capture.js.
 */
function rotateFailures(home) {
  const live = path.join(home, 'events.jsonl');
  try {
    if (fs.statSync(live).size < CAPTURE_ROTATE_AT_BYTES) return;
  } catch { return; }
  // Never rename onto an earlier rotated file of this process (same second, same pid): take the next free second.
  const stampAt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let rotatedPath = path.join(home, `events-${stampAt(Date.now())}-${process.pid}.jsonl`);
  for (let i = 1; i < 120 && fs.existsSync(rotatedPath); i++) {
    rotatedPath = path.join(home, `events-${stampAt(Date.now() + i * 1000)}-${process.pid}.jsonl`);
  }
  try {
    fs.renameSync(live, rotatedPath);
  } catch { return; }
  try {
    if (fs.statSync(rotatedPath).size < CAPTURE_ROTATE_AT_BYTES) {
      try { fs.linkSync(rotatedPath, live); fs.unlinkSync(rotatedPath); } catch { /* the live file exists again: the small file stays */ }
      return;
    }
  } catch { return; }
  try {
    const files = fs.readdirSync(home).filter((name) => ROTATED_FILE.test(name)).map((name) => {
      let size = 0;
      let mtime = 0;
      try { const st = fs.statSync(path.join(home, name)); size = st.size; mtime = st.mtimeMs; } catch { /* gone */ }
      return { name, size, mtime };
    }).sort((x, y) => x.mtime - y.mtime || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const full = files.filter((f) => f.size >= CAPTURE_ROTATE_AT_BYTES);
    const doomed = [
      ...full.slice(0, Math.max(0, full.length - CAPTURE_KEEP_ROTATED)),
      ...files.filter((f) => f.size < CAPTURE_ROTATE_AT_BYTES && Date.now() - f.mtime > 60 * 60 * 1000),
    ];
    for (const f of doomed) {
      try { fs.unlinkSync(path.join(home, f.name)); } catch { /* ignored */ }
    }
  } catch { /* ignored */ }
}

/**
 * Appends one `source: "hook"` line (IC-011) with an empty `message` and `exit: null`. Silent and
 * best-effort: every failure is swallowed.
 * @param {{command: string, kind: string, frame?: string|null}} fields
 * @param {Object} [env]
 * @returns {boolean} whether a line was written
 */
function captureHookFailure({ command, kind, frame = null }, env = process.env) {
  try {
    const home = failureHome(env);
    if (!home || captureIsOff(home, env)) return false;
    let project = '';
    try {
      const cwd = process.cwd();
      const hp = typeof env.HOME === 'string' ? env.HOME.replace(/\/+$/, '') : '';
      project = hp && (cwd === hp || cwd.startsWith(`${hp}/`)) ? `~${cwd.slice(hp.length)}` : cwd;
    } catch { project = ''; }
    const record = {
      v: 1,
      at: new Date().toISOString(),
      source: 'hook',
      command: /^[a-z][a-z0-9-]{0,39}$/.test(command) ? command : 'unknown',
      harness: /^[A-Za-z0-9._-]{1,40}$/.test(env.DOFLOW_AGENT || '') ? env.DOFLOW_AGENT : 'none',
      version: hookVersion(env),
      project: project.slice(0, 200),
      kind: String(kind).slice(0, 80),
      message: '',
      frame: typeof frame === 'string' ? frame : null,
      exit: null,
    };
    const bytes = (r) => Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
    while (bytes(record) > CAPTURE_MAX_LINE_BYTES && record.project.length > 0) {
      record.project = record.project.slice(0, Math.max(0, record.project.length - Math.max(8, bytes(record) - CAPTURE_MAX_LINE_BYTES)));
    }
    if (bytes(record) > CAPTURE_MAX_LINE_BYTES) return false;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    rotateFailures(home);
    fs.appendFileSync(path.join(home, 'events.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Canonical script name -> pre-normalization per-harness file name, for the fallback search only.
const LEGACY_SCRIPT_NAMES = {
  'session-context.sh': 'session-start.sh',
  'pre-implementation-gate.sh': 'pre-implement-gate.sh',
  'mcp-tool-guard.sh': 'mcp-tool-guard.sh',
  'stop-check.sh': 'stop-check.sh',
  'pre-bash-guard.sh': 'pre-bash-guard.sh',
};

// A hook payload is one tool call's JSON — a few KB in the overwhelming majority of cases, a few
// hundred KB for a large file edit at most. These bounds exist only to stop a misbehaving harness
// process (stdin that never closes, or streams unboundedly) from hanging this front door forever;
// they are far above anything a real payload should ever reach.
const MAX_STDIN_BYTES = 10 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 5000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(data), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_STDIN_BYTES) settle(data);
    });
    process.stdin.on('end', () => {
      settle(data);
    });
    if (process.stdin.isTTY) {
      settle('');
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
    // A real policy deny has a numeric exit status — the script ran and its own canonical exit
    // code (1 = deny) is the contract this delegates to. `err.status` is null/undefined when the
    // process never produced an exit code at all (bash missing from PATH, EACCES, etc.) — that is
    // an execution fault, not a policy decision, and every sourced .sh policy in this library
    // fails open on its own uncertainty (`command -v jq || exit 0`); this delegator matches that
    // posture instead of turning an environment fault into a silent deny.
    if (typeof err.status !== 'number') {
      // A policy killed by a signal is a fault in DoFlow's own install worth recording (IC-018); a
      // missing `bash` or a permission error is the user's environment and is not. Either way the
      // decision is the same as it always was.
      // SIGTERM, SIGINT and SIGPIPE are the user or the harness stopping the process (DEC-031), not
      // a fault. Any other signal is recorded under its own kind, so a SEGV and a KILL do not share a fingerprint.
      if (typeof err.signal === 'string' && err.signal && !['SIGTERM', 'SIGINT', 'SIGPIPE'].includes(err.signal)) {
        captureHookFailure({ command: scriptName.replace(/\.sh$/, ''), kind: `policy-exec-fault:${err.signal}` });
      }
      return { decision: 'allow' };
    }
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
    // Recorded silently when it is a programming error (IC-018); the output below is unchanged.
    if (isProgrammingError(err)) captureHookFailure({ command: 'stream-hook-runner', kind: 'runner-exception', frame: runnerFrame(err) });
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
  isProgrammingError,
  captureHookFailure,
};
