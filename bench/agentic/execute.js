'use strict';

/**
 * Agentic baseline executor (feature 097, IC-003 to IC-006): reads the agentic config, picks the one
 * worker recipe that can run read-only and one-shot from the registry, projects the cost of an
 * iteration offline (`planIteration`), and runs it under a hard token cap (`executeIteration`).
 *
 * Why bench-local instead of `worker run`: the supervised launch path prepends a context pack to the
 * prompt (`launch.ts`), which would hand both arms extra, unequal text. Here the argv comes straight
 * from `assembleArgv` over the registry recipe and the prompt is exactly the IC-011 template.
 *
 * Why a scratch profile: the harness reads global guidance and tool registrations from its home
 * directory, which would leak a retrieval tool into the arm that must not have it. Every run gets a
 * fresh HOME and harness-home holding only the listed credential files, removed in `finally`.
 *
 * No harness name appears in this file: the harness is chosen by registry capability and its binary,
 * version argv, parser and argv groups all come from the recipe. Plan E.1 greps for that.
 *
 * Money rule: `plan` and `loadConfig` spawn nothing. `executeIteration` is the only spawner and it
 * refuses (exit 2, nothing written) before the first run on any doubt.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { UsageError, loadTaskSet, buildPrompt, promptSha256 } = require('./tasks.js');
const { materialiseExport } = require('../retrieval/lib/environment.js');
const launch = require('../../src/runtime/worker/launch.ts');
const { parserFor } = require('../../src/runtime/worker/parsers.ts');
const processTree = require('../../src/runtime/worker/process-tree.ts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const REGISTRY_REL = path.join('core', 'registry', 'harnesses.json');

/** File names inside an iteration / run directory (IC-006), shared with the grader and the report. */
const RUN_FILES = Object.freeze({
  iteration: 'iteration.json',
  launch: 'launch.json',
  transcript: 'transcript.jsonl',
  lastMessage: 'last-message.txt',
  runStatus: 'run_status.json',
  timing: 'timing.json',
  grading: 'grading.json',
});

/** The `pathAdd` entry that stands for the per-run `doflow` shim directory (IC-003). */
const SHIM_ENTRY = 'doflow-shim';
/** Variables copied from the caller when present; everything else is dropped (NFR-010). */
const ENV_PASSTHROUGH = Object.freeze(['TMPDIR', 'LANG', 'LC_ALL', 'TERM']);
/** The capabilities a recipe must support for `assembleArgv` to build a read-only one-shot argv. */
const REQUIRED_GROUPS = launch.RECIPE_ORDER;
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** How long to wait for the output pipe to drain after the process tree is gone. */
const DRAIN_MS = 2000;

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

function configError(field, message) {
  const err = new UsageError('config-invalid', `agentic config: ${field} ${message}`);
  err.field = field;
  return err;
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

function checkRegexList(field, list) {
  if (!isStringArray(list)) throw configError(field, 'must be an array of regular-expression strings');
  list.forEach((source, i) => {
    try {
      new RegExp(source);
    } catch (e) {
      throw configError(`${field}[${i}]`, `is not a valid regular expression (${e.message})`);
    }
  });
}

/**
 * IC-003. A malformed config is refused with the offending field named, never defaulted: a silently
 * defaulted timeout or leak list would change what a paid run measures.
 */
function loadConfig(file = CONFIG_PATH) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw configError('(file)', `is missing or not valid JSON: ${file} (${e.message})`);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw configError('(file)', 'must be a JSON object');
  if (cfg.schemaVersion !== 1) throw configError('schemaVersion', `must be 1, got ${JSON.stringify(cfg.schemaVersion)}`);

  const h = cfg.harness;
  if (!h || typeof h !== 'object') throw configError('harness', 'must be an object');
  if (typeof h.select !== 'string' || !/^worker\.[A-Za-z]+$/.test(h.select)) {
    throw configError('harness.select', 'must name a registry capability such as "worker.<capability>"');
  }
  if (h.pin !== null && !isNonEmptyString(h.pin)) throw configError('harness.pin', 'must be null or a harness id');

  const m = cfg.model;
  if (!m || typeof m !== 'object') throw configError('model', 'must be an object');
  if (!isNonEmptyString(m.label)) throw configError('model.label', 'must be a non-empty string');
  if (!isStringArray(m.argv)) throw configError('model.argv', 'must be an array of strings');

  const home = cfg.home;
  if (!home || typeof home !== 'object') throw configError('home', 'must be an object');
  if (!isNonEmptyString(home.env) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(home.env)) throw configError('home.env', 'must be an environment variable name');
  if (!isNonEmptyString(home.source)) throw configError('home.source', 'must be a non-empty string');
  if (!isStringArray(home.copy) || home.copy.some((f) => f === '' || f.includes('/') || f.includes('\\') || f === '..' || f === '.')) {
    throw configError('home.copy', 'must be an array of plain file names (no path separators)');
  }

  if (!isStringArray(cfg.path) || cfg.path.some((t) => t === '' || t.includes('/'))) {
    throw configError('path', 'must be an array of bare tool names');
  }

  if (!cfg.arms || typeof cfg.arms !== 'object' || Array.isArray(cfg.arms) || Object.keys(cfg.arms).length === 0) {
    throw configError('arms', 'must be an object with at least one arm');
  }
  for (const [name, arm] of Object.entries(cfg.arms)) {
    const at = `arms.${name}`;
    if (!arm || typeof arm !== 'object') throw configError(at, 'must be an object');
    if (!isNonEmptyString(arm.paragraph)) throw configError(`${at}.paragraph`, 'must be a non-empty string');
    if (!isStringArray(arm.pathAdd)) throw configError(`${at}.pathAdd`, 'must be an array of strings');
    checkRegexList(`${at}.leak`, arm.leak);
    if (arm.count !== undefined) checkRegexList(`${at}.count`, arm.count);
  }

  if (typeof cfg.timeoutSeconds !== 'number' || !Number.isFinite(cfg.timeoutSeconds) || cfg.timeoutSeconds <= 0) {
    throw configError('timeoutSeconds', 'must be a positive number');
  }
  if (!Number.isSafeInteger(cfg.maxTokensPerRun) || cfg.maxTokensPerRun <= 0) {
    throw configError('maxTokensPerRun', 'must be a positive integer');
  }
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Harness selection and argv
// ---------------------------------------------------------------------------------------------

/**
 * IC-003: the harness whose worker block supports the named capability plus every recipe group the
 * argv assembly needs. More than one qualifying harness needs `config.harness.pin`; none is an error.
 * @returns {{id: string, recipe: object}}
 */
function selectHarness(registry, config) {
  const capability = config.harness.select.replace(/^worker\./, '');
  const needed = [...new Set([capability, ...REQUIRED_GROUPS])];
  const qualifying = (registry?.harnesses || []).filter((h) => {
    const w = h.worker;
    return w && needed.every((group) => w[group]?.status === 'supported') && typeof w.cli?.binary === 'string';
  });
  if (qualifying.length === 0) {
    throw new UsageError('harness-none', `no registry harness supports ${needed.join(', ')}`);
  }
  const ids = qualifying.map((h) => h.id);
  if (config.harness.pin) {
    const pinned = qualifying.find((h) => h.id === config.harness.pin);
    if (!pinned) throw new UsageError('harness-none', `pinned harness "${config.harness.pin}" does not qualify (qualifying: ${ids.join(', ')})`);
    return { id: pinned.id, recipe: pinned.worker };
  }
  if (qualifying.length > 1) {
    throw new UsageError('harness-ambiguous', `${qualifying.length} harnesses qualify (${ids.join(', ')}); set harness.pin to one of them`);
  }
  return { id: qualifying[0].id, recipe: qualifying[0].worker };
}

/**
 * The model's argv goes right after the first recipe group (the read-only group), so it lands among
 * the harness's own subcommand options and before the output options. Works for both the real argv
 * and the redacted `argvShape` because the group length is the same.
 */
function insertModelArgv(recipe, argv, modelArgv) {
  const at = recipe[REQUIRED_GROUPS[0]].argv.length;
  return [...argv.slice(0, at), ...modelArgv, ...argv.slice(at)];
}

function wrapLaunch(fn) {
  try {
    return fn();
  } catch (e) {
    if (e?.name === 'LaunchUsageError') throw new UsageError('launch', e.message);
    throw e;
  }
}

function readRegistry(repoRoot) {
  const file = path.join(repoRoot, REGISTRY_REL);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError('registry-unreadable', `harness registry is missing or unreadable: ${file} (${e.message})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Run directories
// ---------------------------------------------------------------------------------------------

const defaultRunRoot = (repoRoot) => path.join(repoRoot, 'bench', 'runs', 'agentic');

/** IC-006: `<runRoot>/<iteration>/<taskId>/`. */
const runDirOf = (runRoot, iteration, taskId) => path.join(runRoot, iteration, taskId);

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The parsed `iteration.json` of `<runRoot>/<iteration>`; a missing or unreadable one is a refusal. */
function readIteration(dir) {
  const file = path.join(dir, RUN_FILES.iteration);
  const iteration = readJsonIfPresent(file);
  if (iteration === null) throw new UsageError('iteration-missing', `iteration record is missing or unreadable: ${file}`);
  return iteration;
}

/** Run directories under an iteration directory: those holding a launch record. */
function runDirsOf(iterDir) {
  let entries;
  try {
    entries = fs.readdirSync(iterDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(iterDir, e.name, RUN_FILES.launch)))
    .map((e) => path.join(iterDir, e.name));
}

/**
 * Tokens spent so far in one iteration: each run's recorded `total_tokens`, a run with unknown usage
 * counted at `maxTokensPerRun` (the unsafe-low direction would let a blind run hide spend).
 */
function spentOf(iterDir, maxTokensPerRun) {
  let spent = 0;
  for (const dir of runDirsOf(iterDir)) {
    const tokens = readJsonIfPresent(path.join(dir, RUN_FILES.timing))?.total_tokens;
    spent += Number.isFinite(tokens) && tokens >= 0 ? tokens : maxTokensPerRun;
  }
  return spent;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `total_tokens` of every recorded run on `model` under `runRoot` (other models never mix in). */
function recordedTokens(runRoot, model) {
  let iterations;
  try {
    iterations = fs.readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const it of iterations) {
    const iterDir = path.join(runRoot, it.name);
    if (readJsonIfPresent(path.join(iterDir, RUN_FILES.iteration))?.model !== model) continue;
    for (const dir of runDirsOf(iterDir)) {
      const tokens = readJsonIfPresent(path.join(dir, RUN_FILES.timing))?.total_tokens;
      if (Number.isFinite(tokens) && tokens >= 0) out.push(tokens);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Plan (IC-004)
// ---------------------------------------------------------------------------------------------

function checkIteration(iteration) {
  if (typeof iteration !== 'string' || !ITERATION_NAME.test(iteration)) {
    throw new UsageError('iteration-invalid', `iteration name must match ${ITERATION_NAME}: ${JSON.stringify(iteration)}`);
  }
}

/**
 * Offline projection of one iteration. Spawns nothing and does not run the harness for its version
 * (`harnessVersion` is null here; `executeIteration` records the real one).
 */
function planIteration({
  repoRoot = REPO_ROOT, config = loadConfig(), taskSet, registry, arm, iteration, tasks: only, runRoot,
} = {}) {
  checkIteration(iteration);
  if (!Object.prototype.hasOwnProperty.call(config.arms, arm)) {
    throw new UsageError('arm-unknown', `arm "${arm}" is not in the config (arms: ${Object.keys(config.arms).join(', ')})`);
  }
  const root = runRoot || defaultRunRoot(repoRoot);
  const { id: harness, recipe } = selectHarness(registry || readRegistry(repoRoot), config);
  const set = taskSet || loadTaskSet({ repoRoot });

  let chosen = set.tasks;
  if (only !== undefined && only !== null) {
    const ids = typeof only === 'string' ? only.split(',').map((s) => s.trim()).filter(Boolean) : only;
    if (!Array.isArray(ids) || ids.length === 0) throw new UsageError('tasks-empty', '--tasks must list at least one task id');
    for (const id of ids) {
      if (!set.tasks.some((t) => t.id === id)) throw new UsageError('task-unknown', `task id ${id} is not in the task set`);
    }
    chosen = set.tasks.filter((t) => ids.includes(t.id));
  }

  const paragraph = config.arms[arm].paragraph;
  const runs = chosen.map((task) => {
    const prompt = buildPrompt(task, paragraph);
    const shape = wrapLaunch(() => insertModelArgv(recipe, launch.argvShape(recipe, prompt), config.model.argv));
    return {
      id: task.id, key: task.key, split: task.split, kind: task.kind,
      runDir: runDirOf(root, iteration, task.id),
      argvShape: shape, promptSha256: promptSha256(prompt), promptBytes: Buffer.byteLength(prompt, 'utf8'),
    };
  });

  const recorded = recordedTokens(root, config.model.label);
  return {
    arm, iteration, harness, harnessBinary: recipe.cli.binary, harnessVersion: null,
    model: config.model.label, snapshot: set.snapshot.commit, runs,
    projection: {
      runs: runs.length,
      maxTokensPerRun: config.maxTokensPerRun,
      ceilingTokens: runs.length * config.maxTokensPerRun,
      typicalTokens: recorded.length === 0 ? null : Math.round(runs.length * median(recorded)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Execute (IC-005)
// ---------------------------------------------------------------------------------------------

const refused = (e) => ({ exit: 2, reason: e.reason, refusal: e.message, ran: [], undone: [], spent: 0 });

/** `--cap` must be a positive integer (a digits-only string from the CLI is accepted). */
function parseCap(cap) {
  const n = typeof cap === 'string' && /^[1-9][0-9]*$/.test(cap) ? Number(cap) : cap;
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError('cap-invalid', `--cap must be a positive integer of tokens, got ${JSON.stringify(cap)}`);
  return n;
}

function git(repoRoot, args) {
  return childProcess.spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/** First executable file called `name` on `searchPath` (absolute entries only), or null. */
function findOnPath(name, searchPath) {
  for (const dir of String(searchPath || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

const expandHome = (p, sourceHome) => (p === '~' ? sourceHome : p.startsWith('~/') ? path.join(sourceHome, p.slice(2)) : p);

/**
 * The run's tool directory: one symlink per configured tool, named like the tool and pointing at the
 * path found on the caller's PATH (a symlinked tool keeps pointing at its own path, never at the real
 * file's directory). Why links and not the tools' directories: a directory such as `~/.local/bin` also
 * holds `doflow` and the harness binary, which would hand arm N the very tool the contrast removes.
 */
function makeToolBin(dir, tools) {
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [name, target] of Object.entries(tools)) fs.symlinkSync(target, path.join(dir, name));
  return dir;
}

/**
 * IC-003 `home`: `<tmp>/doflow-agentic-<random>/` (mode 0700, from mkdtemp) with `home/` as HOME and
 * `harness-home/` as the harness's own home variable. Only the listed files are copied; a missing
 * one is recorded (`credentialCopied: false`) and the run goes on, because the harness failing to
 * sign in is itself a recorded outcome.
 */
function makeProfile({ config, arm, sourceHome, repoRoot, tmpDir, tools }) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'doflow-agentic-'));
  fs.chmodSync(dir, 0o700);
  const home = path.join(dir, 'home');
  const harnessHome = path.join(dir, 'harness-home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(harnessHome, { mode: 0o700 });
  const binDir = makeToolBin(path.join(dir, 'bin'), tools);

  const source = expandHome(config.home.source, sourceHome);
  let credentialCopied = true;
  for (const name of config.home.copy) {
    const from = path.join(source, name);
    try {
      if (!fs.statSync(from).isFile()) throw new Error('not a file');
      fs.copyFileSync(from, path.join(harnessHome, name));
      fs.chmodSync(path.join(harnessHome, name), 0o600);
    } catch {
      credentialCopied = false;
    }
  }

  const pathAddDirs = config.arms[arm].pathAdd.map((entry) => {
    if (entry !== SHIM_ENTRY) return entry;
    const shimDir = path.join(dir, 'shim');
    fs.mkdirSync(shimDir, { mode: 0o700 });
    const target = path.join(repoRoot, 'bin', 'doflow.js').replace(/'/g, "'\\''");
    fs.writeFileSync(path.join(shimDir, 'doflow'), `#!/bin/sh\nexec node '${target}' "$@"\n`, { mode: 0o755 });
    return shimDir;
  });
  return { dir, home, harnessHome, binDir, credentialCopied, pathAddDirs };
}

/**
 * A throwaway workspace that is its own git root, so the harness cannot read the measured
 * checkout's history. `materialise` is injectable because exporting the whole snapshot is the slow
 * part of every run.
 */
function prepareWorkspace({ commit, snapshot, repoRoot, parent, home, materialise = materialiseExport }) {
  const dir = fs.mkdtempSync(path.join(parent, 'doflow-agentic-ws-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const { treeRoot } = materialise(commit, dir, snapshot, { repoRoot });
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const identity = ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false'];
    for (const args of [['init', '-q'], ['add', '-A'], [...identity, 'commit', '-q', '--allow-empty', '-m', 'snapshot']]) {
      const r = childProcess.spawnSync('git', args, { cwd: treeRoot, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`workspace git ${args.includes('commit') ? 'commit' : args[0]} failed: ${String(r.stderr).trim()}`);
    }
    return { root: treeRoot, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const cutChars = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/**
 * Spawns the harness once and resolves `{ report, timedOut, spawnError, durationMs }`. The child is
 * detached so its whole group can be ended by `escalate` when the timer fires; stdout is streamed to
 * the transcript and fed line by line to the recipe's parser.
 */
async function spawnHarness({ binary, argv, cwd, env, prompt, viaStdin, timeoutMs, transcriptFile, lastMessageFile, parser, now }) {
  const started = now().getTime();
  const transcript = fs.createWriteStream(transcriptFile);
  const transcriptDone = new Promise((resolve) => transcript.once('close', resolve));
  const child = childProcess.spawn(binary, argv, { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stderr.resume();

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
  const outClosed = new Promise((resolve) => child.stdout.once('close', resolve));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => parser.line(line));
  child.stdout.on('data', (chunk) => transcript.write(chunk));

  if (viaStdin) child.stdin.end(prompt);
  else child.stdin.end();

  let timedOut = false;
  let ended = Promise.resolve();
  const timer = setTimeout(() => {
    timedOut = true;
    const proc = { pid: child.pid, pgid: child.pid, start: processTree.procStart(child.pid) };
    ended = processTree.escalate({ proc });
  }, timeoutMs);

  const result = await exited;
  clearTimeout(timer);
  await ended;
  await Promise.race([outClosed, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
  child.stdout.destroy();
  rl.close();
  transcript.end();
  await transcriptDone;

  try {
    parser.lastMessage?.(fs.readFileSync(lastMessageFile, 'utf8'));
  } catch { /* the harness wrote no final message */ }
  return { report: parser.end(), timedOut, spawnError: result.error, durationMs: now().getTime() - started };
}

/** The recorded outcome of one run (IC-006 `run_status`). */
function statusOf({ report, timedOut, spawnError, timeoutSeconds }) {
  if (timedOut) return { status: 'timeout', evidence: `no exit within ${timeoutSeconds}s` };
  if (spawnError) return { status: 'api-error', evidence: cutChars(`spawn failed: ${spawnError.code || spawnError.message}`, 200) };
  if (report.status === 'failure' && report.reason !== 'spawn-observed') {
    return { status: 'api-error', evidence: cutChars(report.summary || report.reason || 'failure', 200) };
  }
  if (report.reason === 'spawn-observed') return { status: 'completed', evidence: 'spawn-observed' };
  return { status: 'completed' };
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Runs the planned tasks of one iteration under a token cap. Refuses (exit 2, nothing written, no
 * process started) when the cap is missing or not a positive integer, the working tree is dirty, a
 * listed task already has a run directory, the plan's ceiling exceeds the cap, or the plan itself is
 * invalid. Exit 3 means the cap stopped it before a run that could overshoot; `undone` lists those.
 * Options beyond `plan`'s are injectable for tests: `env` (the caller env), `extraEnv` (added to the
 * child env, tests only), `sourceHome`, `tmpDir`, `materialise`, `now`.
 */
async function executeIteration(opts = {}) {
  const {
    repoRoot = REPO_ROOT, env = process.env, extraEnv = {}, sourceHome = os.homedir(), tmpDir = os.tmpdir(),
    materialise = materialiseExport, now = () => new Date(),
  } = opts;
  let plan;
  let taskSet;
  let config;
  let cap;
  let recipe;
  let binary;
  let tools;
  let sourceAt;
  let iterDir;
  let runRoot;
  try {
    config = opts.config || loadConfig();
    cap = parseCap(opts.cap);
    runRoot = opts.runRoot || defaultRunRoot(repoRoot);
    const registry = opts.registry || readRegistry(repoRoot);
    taskSet = opts.taskSet || loadTaskSet({ repoRoot });
    plan = planIteration({ ...opts, repoRoot, config, registry, taskSet, runRoot });
    recipe = selectHarness(registry, config).recipe;

    const status = git(repoRoot, ['status', '--porcelain']);
    if (status.status !== 0) throw new UsageError('git-status-failed', `cannot read the working tree state of ${repoRoot}: ${String(status.stderr).trim()}`);
    if (status.stdout.trim() !== '') throw new UsageError('tree-dirty', 'the working tree has uncommitted changes; commit or stash them before a measured run');
    const head = git(repoRoot, ['rev-parse', 'HEAD']);
    if (head.status !== 0) throw new UsageError('git-head-failed', `cannot read HEAD of ${repoRoot}`);
    sourceAt = head.stdout.trim();

    const existing = plan.runs.filter((r) => fs.existsSync(r.runDir)).map((r) => r.id);
    if (existing.length > 0) throw new UsageError('run-exists', `run directory already exists for: ${existing.join(', ')}`);
    if (plan.projection.ceilingTokens > cap) {
      throw new UsageError('over-cap', `ceiling ${plan.projection.ceilingTokens} tokens (${plan.projection.runs} runs x ${plan.projection.maxTokensPerRun}) exceeds --cap ${cap}`);
    }

    binary = findOnPath(recipe.cli.binary, env.PATH);
    if (!binary) throw new UsageError('harness-binary-missing', `harness binary "${recipe.cli.binary}" is not on PATH`);
    tools = {};
    for (const tool of config.path) {
      const found = findOnPath(tool, env.PATH);
      if (!found) throw new UsageError('tool-missing', `tool "${tool}" from the config path list is not on PATH`);
      tools[tool] = found;
    }

    iterDir = path.join(runRoot, plan.iteration);
    const prior = readJsonIfPresent(path.join(iterDir, RUN_FILES.iteration));
    if (prior && (prior.arm !== plan.arm || prior.model !== plan.model || prior.sourceAt !== sourceAt || prior.snapshot !== plan.snapshot)) {
      throw new UsageError('iteration-mismatch', `iteration "${plan.iteration}" already exists with a different arm, model, source or snapshot`);
    }
  } catch (e) {
    if (e instanceof UsageError) return refused(e);
    throw e;
  }

  // Everything that could refuse has run. From here on a harness failure is a recorded outcome.
  const versionBin = makeToolBin(path.join(fs.mkdtempSync(path.join(tmpDir, 'doflow-agentic-ver-')), 'bin'), tools);
  const versionEnv = { PATH: [versionBin, '/usr/bin', '/bin'].join(path.delimiter), ...extraEnv };
  const versionRun = childProcess.spawnSync(binary, recipe.cli.versionArgv || ['--version'], { env: versionEnv, encoding: 'utf8', timeout: 15000 });
  fs.rmSync(path.dirname(versionBin), { recursive: true, force: true });
  const harnessVersion = versionRun.status === 0 ? (String(versionRun.stdout).split(/\r?\n/).find((l) => l.trim()) || '').trim() || null : null;

  fs.mkdirSync(iterDir, { recursive: true });
  const iterationFile = path.join(iterDir, RUN_FILES.iteration);
  if (!fs.existsSync(iterationFile)) {
    writeJson(iterationFile, {
      arm: plan.arm, model: plan.model, sourceAt, snapshot: plan.snapshot, harness: plan.harness, harnessVersion,
      startedAt: now().toISOString(),
    });
  }

  const max = config.maxTokensPerRun;
  const tasksById = new Map(taskSet.tasks.map((t) => [t.id, t]));
  const ran = [];
  const undone = [];
  const viaStdin = recipe.oneShot?.promptVia === 'stdin';
  for (let i = 0; i < plan.runs.length; i++) {
    if (spentOf(iterDir, max) + max > cap) {
      undone.push(...plan.runs.slice(i).map((r) => r.id));
      break;
    }
    const run = plan.runs[i];
    const task = tasksById.get(run.id);
    const prompt = buildPrompt(task, config.arms[plan.arm].paragraph);
    const lastMessageFile = path.join(run.runDir, RUN_FILES.lastMessage);
    fs.mkdirSync(run.runDir, { recursive: true });
    let profile = null;
    let workspace = null;
    try {
      profile = makeProfile({ config, arm: plan.arm, sourceHome, repoRoot, tmpDir, tools });
      workspace = prepareWorkspace({
        commit: plan.snapshot, snapshot: taskSet.snapshot, repoRoot, parent: tmpDir, home: profile.home, materialise,
      });
      const startedAt = now().toISOString();
      const argv = wrapLaunch(() => insertModelArgv(recipe, launch.assembleArgv(recipe, prompt, false, lastMessageFile), config.model.argv));
      writeJson(path.join(run.runDir, RUN_FILES.launch), {
        key: run.key, arm: plan.arm, harness: plan.harness, harnessVersion, model: plan.model,
        argvShape: run.argvShape, promptSha256: run.promptSha256, promptBytes: run.promptBytes,
        toolProfile: { pathDirs: ['<profile>/bin'], tools, pathAdd: config.arms[plan.arm].pathAdd },
        snapshot: plan.snapshot, startedAt, credentialCopied: profile.credentialCopied,
      });

      const childEnv = {
        PATH: [profile.binDir, '/usr/bin', '/bin', ...profile.pathAddDirs].join(path.delimiter),
        HOME: profile.home,
        [config.home.env]: profile.harnessHome,
      };
      for (const name of ENV_PASSTHROUGH) if (env[name] !== undefined) childEnv[name] = env[name];
      Object.assign(childEnv, extraEnv);

      const parser = parserFor(recipe.structuredOutput.parser).create();
      const outcome = await spawnHarness({
        binary, argv, cwd: workspace.root, env: childEnv, prompt, viaStdin,
        timeoutMs: config.timeoutSeconds * 1000, transcriptFile: path.join(run.runDir, RUN_FILES.transcript),
        lastMessageFile, parser, now,
      });
      writeJson(path.join(run.runDir, RUN_FILES.runStatus), statusOf({ ...outcome, timeoutSeconds: config.timeoutSeconds }));
      const tokens = outcome.report.usage?.tokens;
      writeJson(path.join(run.runDir, RUN_FILES.timing), {
        ...(Number.isFinite(tokens) ? { total_tokens: tokens } : {}),
        duration_ms: outcome.durationMs,
      });
      ran.push(run.id);
    } catch (e) {
      // An executor failure (not a harness outcome) leaves no half-written run behind.
      fs.rmSync(run.runDir, { recursive: true, force: true });
      throw e;
    } finally {
      workspace?.cleanup();
      if (profile) fs.rmSync(profile.dir, { recursive: true, force: true });
    }
  }
  return { exit: undone.length > 0 ? 3 : 0, ran, undone, spent: spentOf(iterDir, max) };
}

module.exports = {
  CONFIG_PATH, RUN_FILES, SHIM_ENTRY,
  loadConfig, selectHarness, insertModelArgv, planIteration, executeIteration, prepareWorkspace,
  runDirOf, readIteration,
};
