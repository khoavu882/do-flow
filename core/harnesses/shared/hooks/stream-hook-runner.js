#!/usr/bin/env node
'use strict';

/**
 * DoFlow Cross-Harness Hook Runner — front door for every in-scope lifecycle
 * event (SessionStart, PreToolUse, PostToolUse, Stop, PreInvocation) for Antigravity. The Gemini
 * adapter branch is retained but unwired. It owns event dispatch and native payload/decision
 * translation (delegated to adapters/{gemini,antigravity}.js) and delegates every policy decision
 * to the shared lifecycle bridge — it implements no guard policy logic itself.
 *
 * Invocation: `node stream-hook-runner.js [EventName]`, JSON payload on stdin, JSON decision on
 * stdout. EventName is the preferred way to select which canonical policy applies; when omitted
 * (older hooks.json wiring that doesn't yet pass it), the event is inferred from the payload's
 * own shape as a fallback, matching this runner's behavior before event names were threaded
 * through argv.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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
 * The working directory with the home prefix as `~`, matching HOME as given, its real path and
 * `os.homedir()`; under no known home, when HOME is not usable, only the folder name. Same rule as
 * projectName in src/runtime/failure/capture.js (this file ships without src/).
 */
function hookProject(cwd, env) {
  const homes = [];
  const add = (value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const home = value.replace(/\/+$/, '');
    if (home.length > 1 && !homes.includes(home)) homes.push(home);
  };
  add(env.HOME);
  if (typeof env.HOME === 'string' && path.isAbsolute(env.HOME)) { try { add(fs.realpathSync(env.HOME)); } catch { /* HOME does not exist */ } }
  try { add(os.homedir()); add(fs.realpathSync(os.homedir())); } catch { /* no home known to the system */ }
  const home = homes.find((h) => cwd === h || cwd.startsWith(`${h}/`));
  if (home) return `~${cwd.slice(home.length)}`;
  return typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? cwd : path.basename(cwd);
}

/**
 * Appends one line only when `file` is absent or a regular file: a FIFO there would block the open
 * until something reads it and stall a guarded tool call. Same rule as appendRegular in
 * src/runtime/failure/capture.js (this file ships without src/).
 */
function appendRegularLine(file, line) {
  const c = fs.constants;
  let fd;
  try {
    fd = fs.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0), 0o600);
    if (!fs.fstatSync(fd).isFile()) return false;
    fs.writeSync(fd, line);
    return true;
  } catch { return false; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing more to do */ } }
  }
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
    try { project = hookProject(process.cwd(), env); } catch { project = ''; }
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
    return appendRegularLine(path.join(home, 'events.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {
    return false;
  }
}

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
 * Delegate the native payload to the shared lifecycle bridge. The bridge owns encoding,
 * classification, effects and diagnostics; this runner only applies Antigravity's native render.
 */
function delegateToPolicy(projectRoot, agent, event, policyId, nativeRaw) {
  const bridgeSh = path.join(__dirname, 'bridge', 'bridge.sh');
  const profile = process.env.DOFLOW_FAULT_PROFILE || 'compat-1';
  const effectiveProfile = profile === 'compat-1' || profile === 'strict-1' ? profile : 'compat-1';
  if (profile !== effectiveProfile) captureHookFailure({ command: policyId, kind: 'fault-profile-unknown' });
  const blockingPolicy = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check'].includes(policyId);
  const faultEffect = effectiveProfile === 'strict-1' && blockingPolicy ? 'block' : 'proceed';
  const faultDecision = (code) => ({
    v: 1, harness: agent, event, policy: policyId, policyVersion: 0,
    outcome: 'error', code, reason: code, faultProfile: effectiveProfile, effect: faultEffect,
  });
  const result = spawnSync('bash', [bridgeSh, agent, event, policyId, '--emit', 'decision'], {
    cwd: projectRoot,
    input: nativeRaw,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, DOFLOW_PROJECT_DIR: projectRoot, DOFLOW_AGENT: agent },
  });

  if (result.error && result.error.code === 'ETIMEDOUT') {
    captureHookFailure({ command: policyId, kind: 'bridge-timeout' });
    return faultDecision('bridge-timeout');
  }
  if (result.error || result.status === null) {
    if (result.signal && !['SIGTERM', 'SIGINT', 'SIGPIPE'].includes(result.signal)) {
      captureHookFailure({ command: policyId, kind: `bridge-exec-fault:${result.signal}` });
    }
    return faultDecision('bridge-spawn');
  }
  try {
    const decision = JSON.parse(result.stdout.trim());
    if (decision && typeof decision === 'object' && typeof decision.effect === 'string') return decision;
  } catch { /* malformed bridge output is a bridge fault */ }
  captureHookFailure({ command: policyId, kind: 'bridge-answer-invalid' });
  return faultDecision('bridge-answer-invalid');
}

function classifyPreToolUsePolicy(toolName) {
  if (MCP_TOOL_PATTERN.test(toolName)) return 'mcp-tool-guard.sh';
  if (EDIT_TOOL_PATTERN.test(toolName)) return 'pre-implementation-gate.sh';
  if (COMMAND_TOOL_PATTERN.test(toolName)) return 'pre-bash-guard.sh';
  return null;
}

function evaluatePreToolUsePolicy(payload, nativeRaw, projectRoot, agent) {
  const toolName = payload && payload.toolCall && payload.toolCall.name || payload && payload.tool_name || '';
  const scriptName = classifyPreToolUsePolicy(toolName);
  if (!scriptName) return { decision: 'allow' };
  return delegateToPolicy(projectRoot, agent, 'PreToolUse', scriptName.replace(/\.sh$/, ''), nativeRaw);
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
function evaluateEvent(event, payload, nativeRaw, projectRoot, agent) {
  switch (event) {
    case 'SessionStart':
      delegateToPolicy(projectRoot, agent, event, 'session-context', nativeRaw);
      return { decision: 'allow' };

    case 'PreToolUse':
      return evaluatePreToolUsePolicy(payload, nativeRaw, projectRoot, agent);

    case 'Stop':
      return delegateToPolicy(projectRoot, agent, event, 'stop-check', nativeRaw);

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
// evaluateToolCall/evaluatePayload remain test and library entry points over native payloads.

function evaluateToolCall(toolCall, projectRoot) {
  if (!toolCall || typeof toolCall !== 'object') {
    return { decision: 'allow' };
  }
  const payload = { toolCall };
  return evaluatePreToolUsePolicy(payload, JSON.stringify(payload), projectRoot, 'antigravity');
}

function evaluatePayload(payload, projectRoot) {
  if (!payload || typeof payload !== 'object') {
    return { decision: 'allow' };
  }

  // PreToolUse: toolCall object present
  if (payload.toolCall) {
    return evaluatePreToolUsePolicy(payload, JSON.stringify(payload), projectRoot, 'antigravity');
  }

  // PreInvocation: injection hook
  if (payload.invocationNum !== undefined) {
    return { injectSteps: [] };
  }

  // Stop hook: delegate to the canonical stop-check policy
  if (payload.terminationReason !== undefined) {
    return delegateToPolicy(projectRoot, 'antigravity', 'Stop', 'stop-check', JSON.stringify(payload));
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

    const decision = evaluateEvent(event, payload, rawInput, projectRoot, agent);
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
  classifyPreToolUsePolicy,
  sniffEventFromPayload,
  isProgrammingError,
  captureHookFailure,
};
