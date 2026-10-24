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
 * fresh HOME and harness-home holding only the listed credential files, removed after the run, on
 * an executor error and on SIGINT/SIGTERM/SIGHUP (review C-1). No path of this checkout is handed to
 * the worker (review C-4): its cwd, HOME, `-o` file and the arm D shim's tree all live in scratch.
 *
 * No harness name appears in this file: the harness is chosen by registry capability and its binary,
 * version argv, parser and argv groups all come from the recipe. Plan E.1 greps for that.
 *
 * Money rule: `plan` and `loadConfig` spawn nothing. `executeIteration` is the only spawner and it
 * refuses (exit 2, nothing written) before the first run on any doubt.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { UsageError, loadTaskSet, buildPrompt, promptSha256 } = require('./tasks.ts');
const { materialiseExport } = require('../retrieval/lib/environment.ts');
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
// IC-011: model is optional and assembled only for a supported binding.
const REQUIRED_GROUPS = launch.RECIPE_ORDER.filter((group) => group !== 'model');
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The iteration lock file: held by one `executeIteration` from before the run-exists check to its end. */
const LOCK_FILE = '.lock';
/** Signals that stop an execute: the worker group is ended and the run recorded before re-raising. */
const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
/** Top-level entries of the tree the arm D shim runs: the package files, never bench/ or agent-docs/. */
const TOOL_TREE = Object.freeze(['bin', 'src', 'core', 'types', 'package.json']);
/** How long to wait for the output pipe to drain after the process tree is gone. */
const DRAIN_MS = 2000;

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

function configError(field: string, message: string) {
  const err: any = new UsageError('config-invalid', `agentic config: ${field} ${message}`);
  err.field = field;
  return err;
}

const isNonEmptyString = (v: any) => typeof v === 'string' && v.trim() !== '';
const isStringArray = (v: any) => Array.isArray(v) && v.every((s: any) => typeof s === 'string');

function checkRegexList(field: string, list: any) {
  if (!isStringArray(list)) throw configError(field, 'must be an array of regular-expression strings');
  list.forEach((source: string, i: number) => {
    try {
      new RegExp(source);
    } catch (e: any) {
      throw configError(`${field}[${i}]`, `is not a valid regular expression (${e.message})`);
    }
  });
}

/**
 * IC-003. A malformed config is refused with the offending field named, never defaulted: a silently
 * defaulted timeout or leak list would change what a paid run measures.
 */
function loadConfig(file = CONFIG_PATH) {
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
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
  if (!isStringArray(home.copy) || home.copy.some((f: any) => f === '' || f.includes('/') || f.includes('\\') || f === '..' || f === '.')) {
    throw configError('home.copy', 'must be an array of plain file names (no path separators)');
  }

  if (!isStringArray(cfg.path) || cfg.path.some((t: any) => t === '' || t.includes('/'))) {
    throw configError('path', 'must be an array of bare tool names');
  }

  if (!cfg.arms || typeof cfg.arms !== 'object' || Array.isArray(cfg.arms) || Object.keys(cfg.arms).length === 0) {
    throw configError('arms', 'must be an object with at least one arm');
  }
  for (const [name, arm] of Object.entries(cfg.arms) as [string, any][]) {
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
function selectHarness(registry: any, config: any) {
  const capability = config.harness.select.replace(/^worker\./, '');
  const needed = [...new Set([capability, ...REQUIRED_GROUPS])];
  const qualifying = (registry?.harnesses || []).filter((h: any) => {
    const w = h.worker;
    return w && needed.every((group) => w[group]?.status === 'supported') && typeof w.cli?.binary === 'string';
  });
  if (qualifying.length === 0) {
    throw new UsageError('harness-none', `no registry harness supports ${needed.join(', ')}`);
  }
  const ids = qualifying.map((h: any) => h.id);
  if (config.harness.pin) {
    const pinned = qualifying.find((h: any) => h.id === config.harness.pin);
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
function insertModelArgv(recipe: any, argv: any[], modelArgv: any[]) {
  const at = recipe[REQUIRED_GROUPS[0]].argv.length;
  return [...argv.slice(0, at), ...modelArgv, ...argv.slice(at)];
}

function wrapLaunch(fn: any) {
  try {
    return fn();
  } catch (e: any) {
    if (e?.name === 'LaunchUsageError') throw new UsageError('launch', e.message);
    throw e;
  }
}

function readRegistry(repoRoot: string) {
  const file = path.join(repoRoot, REGISTRY_REL);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    throw new UsageError('registry-unreadable', `harness registry is missing or unreadable: ${file} (${e.message})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Run directories
// ---------------------------------------------------------------------------------------------

const defaultRunRoot = (repoRoot: string) => path.join(repoRoot, 'bench', 'runs', 'agentic');

/** IC-006: `<runRoot>/<iteration>/<taskId>/`. */
const runDirOf = (runRoot: string, iteration: string, taskId: string) => path.join(runRoot, iteration, taskId);

function readJsonIfPresent(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The parsed `iteration.json` of `<runRoot>/<iteration>`; a missing or unreadable one is a refusal. */
function readIteration(dir: string) {
  const file = path.join(dir, RUN_FILES.iteration);
  const iteration = readJsonIfPresent(file);
  if (iteration === null) throw new UsageError('iteration-missing', `iteration record is missing or unreadable: ${file}`);
  return iteration;
}

/**
 * Entries of an iteration directory, by `lstat` (a symlink is never followed): `runs` are real
 * directories holding a launch record, `links` are symlinked entries of any kind.
 */
function entriesOf(iterDir: string) {
  let entries: any[];
  try {
    entries = fs.readdirSync(iterDir, { withFileTypes: true });
  } catch {
    return { runs: [], links: [] };
  }
  return {
    runs: entries.filter((e: any) => e.isDirectory() && fs.existsSync(path.join(iterDir, e.name, RUN_FILES.launch))).map((e: any) => path.join(iterDir, e.name)),
    links: entries.filter((e: any) => e.isSymbolicLink()).map((e: any) => path.join(iterDir, e.name)),
  };
}

/** Run directories under an iteration directory: those holding a launch record. */
const runDirsOf = (iterDir: string) => entriesOf(iterDir).runs;

/**
 * Tokens spent so far in one iteration: each run's recorded `total_tokens`, a run with unknown usage
 * counted at `maxTokensPerRun` (the unsafe-low direction would let a blind run hide spend). A run that
 * did not complete (interrupted, timed out, truncated, failed, or with no status) counts at the larger
 * of its recorded sum and `maxTokensPerRun` (review R-1, R-6): a turn may have been in flight, and an
 * overshoot it already reported is never dropped. A symlinked entry counts at `maxTokensPerRun` too:
 * its target is not this iteration's record.
 */
function spentOf(iterDir: string, maxTokensPerRun: number) {
  const { runs, links } = entriesOf(iterDir);
  let spent = links.length * maxTokensPerRun;
  for (const dir of runs) {
    const raw = readJsonIfPresent(path.join(dir, RUN_FILES.timing))?.total_tokens;
    const tokens = Number.isFinite(raw) && raw >= 0 ? raw : null;
    const completed = readJsonIfPresent(path.join(dir, RUN_FILES.runStatus))?.status === 'completed';
    if (tokens === null) spent += maxTokensPerRun;
    else spent += completed ? tokens : Math.max(tokens, maxTokensPerRun);
  }
  return spent;
}

/**
 * The capture inputs of an iteration that both arms must share (C-12): harness choice, model, home
 * and tool list, timeout. The arm paragraphs and PATH additions differ by design and are left out.
 */
function captureSha256(config: any) {
  const inputs = { harness: config.harness, model: config.model, home: config.home, path: config.path, timeoutSeconds: config.timeoutSeconds };
  return crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/**
 * Tokens of one run from its transcript (C-6): the sum over every `turn.completed` of input plus
 * output tokens. No turn end, or a turn without both integer fields, is unknown usage, so every
 * spend reader counts the run at `maxTokensPerRun`.
 * @returns {{usage: 'reported'|'partial'|'unknown', total_tokens?: number}}
 */
function usageOf(transcriptFile: string): { usage: 'reported' | 'partial' | 'unknown'; total_tokens?: number } {
  let text: string;
  try {
    text = fs.readFileSync(transcriptFile, 'utf8');
  } catch {
    return { usage: 'unknown' };
  }
  let sum = 0;
  let turns = 0;
  let partial = false;
  for (const line of text.split('\n')) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'turn.completed') continue;
    turns++;
    const input = event.usage?.input_tokens;
    const output = event.usage?.output_tokens;
    if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) sum += input + output;
    else partial = true;
  }
  if (turns === 0) return { usage: 'unknown' };
  if (partial) return { usage: 'partial' };
  return { usage: 'reported', total_tokens: sum };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `total_tokens` of every recorded run on `model` under `runRoot` (other models never mix in). */
function recordedTokens(runRoot: string, model: string) {
  let iterations: any[];
  try {
    iterations = fs.readdirSync(runRoot, { withFileTypes: true }).filter((e: any) => e.isDirectory());
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

function checkIteration(iteration: any) {
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
}: any = {}) {
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
      if (!set.tasks.some((t: any) => t.id === id)) throw new UsageError('task-unknown', `task id ${id} is not in the task set`);
    }
    chosen = set.tasks.filter((t: any) => ids.includes(t.id));
  }

  const paragraph = config.arms[arm].paragraph;
  const runs = chosen.map((task: any) => {
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

const refused = (e: any) => ({ exit: 2, reason: e.reason, refusal: e.message, ran: [], undone: [], spent: 0 });

/** `--cap` must be a positive integer (a digits-only string from the CLI is accepted). */
function parseCap(cap: any) {
  const n = typeof cap === 'string' && /^[1-9][0-9]*$/.test(cap) ? Number(cap) : cap;
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError('cap-invalid', `--cap must be a positive integer of tokens, got ${JSON.stringify(cap)}`);
  return n;
}

function git(repoRoot: string, args: string[]) {
  return childProcess.spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/** First executable file called `name` on `searchPath` (absolute entries only), or null. */
function findOnPath(name: string, searchPath?: string) {
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

const expandHome = (p: string, sourceHome: string) => (p === '~' ? sourceHome : p.startsWith('~/') ? path.join(sourceHome, p.slice(2)) : p);

/** Removes a directory tree; returns the error instead of throwing, so one failed cleanup never skips another. */
function removeTree(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * The run's tool directory: one symlink per configured tool, named like the tool and pointing at the
 * path found on the caller's PATH (a symlinked tool keeps pointing at its own path, never at the real
 * file's directory). Why links and not the tools' directories: a directory such as `~/.local/bin` also
 * holds `doflow` and the harness binary, which would hand arm N the very tool the contrast removes.
 */
function makeToolBin(dir: string, tools: Record<string, string>) {
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [name, target] of Object.entries(tools)) fs.symlinkSync(target, path.join(dir, name));
  return dir;
}

/**
 * The tree the arm D shim runs (review C-4): an export of `commit` outside the checkout holding only
 * the package files (`TOOL_TREE`), so neither the shim nor anything it names leads the worker to the
 * live checkout, the task files or the run records. Made once per execute, removed with it.
 */
function exportToolTree({ repoRoot, commit, tmpDir }: { repoRoot: string; commit: string; tmpDir: string }) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'doflow-agentic-tool-'));
  try {
    const archive = childProcess.spawnSync('git', ['-C', repoRoot, 'archive', commit], { maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${String(archive.stderr).trim() || archive.error}`);
    const extract = childProcess.spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1024 * 1024 });
    if (extract.status !== 0) throw new Error(`tar extract failed: ${String(extract.stderr).trim() || extract.error}`);
    for (const name of fs.readdirSync(dir)) if (!TOOL_TREE.includes(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    return fs.realpathSync(dir);
  } catch (e) {
    removeTree(dir);
    throw e;
  }
}

/**
 * IC-003 `home`: `<tmp>/doflow-agentic-<random>/` (mode 0700, from mkdtemp) with `home/` as HOME and
 * `harness-home/` as the harness's own home variable. Only the listed files are copied, each mode
 * 0600; a missing one is recorded (`credentialCopied: false`) and the run goes on, because the
 * harness failing to sign in is itself a recorded outcome. The profile owns everything it creates
 * from the mkdtemp on: any failure inside removes the whole directory before the error leaves
 * (review C-1), so a credential copy never outlives a half-built profile. `shimRoot` is the
 * exported tool tree (`exportToolTree`), never the checkout.
 */
function makeProfile({ config, arm, sourceHome, shimRoot, tmpDir, tools, copyCredentials = true }: { config: any; arm: any; sourceHome: any; shimRoot?: any; tmpDir: any; tools: any; copyCredentials?: boolean }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, copyCredentials ? 'doflow-agentic-' : 'doflow-agentic-ver-')));
  try {
    fs.chmodSync(dir, 0o700);
    const home = path.join(dir, 'home');
    const harnessHome = path.join(dir, 'harness-home');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(harnessHome, { mode: 0o700 });
    const binDir = makeToolBin(path.join(dir, 'bin'), tools);

    const source = expandHome(config.home.source, sourceHome);
    let credentialCopied = copyCredentials;
    for (const name of copyCredentials ? config.home.copy : []) {
      const from = path.join(source, name);
      const to = path.join(harnessHome, name);
      try {
        if (!fs.statSync(from).isFile()) throw new Error('not a file');
        fs.copyFileSync(from, to);
        fs.chmodSync(to, 0o600);
      } catch {
        fs.rmSync(to, { force: true });
        credentialCopied = false;
      }
    }

    const pathAddDirs = arm === null ? [] : config.arms[arm].pathAdd.map((entry: any) => {
      if (entry !== SHIM_ENTRY) return entry;
      if (!shimRoot) throw new Error('the arm needs the doflow shim but no tool tree was exported');
      const shimDir = path.join(dir, 'shim');
      fs.mkdirSync(shimDir, { mode: 0o700 });
      const target = path.join(shimRoot, 'bin', 'doflow.js').replace(/'/g, "'\\''");
      fs.writeFileSync(path.join(shimDir, 'doflow'), `#!/bin/sh\nexec node '${target}' "$@"\n`, { mode: 0o755 });
      return shimDir;
    });
    return { dir, home, harnessHome, binDir, credentialCopied, pathAddDirs };
  } catch (e) {
    removeTree(dir);
    throw e;
  }
}

/**
 * A throwaway workspace that is its own git root, so the harness cannot read the measured
 * checkout's history. `materialise` is injectable because exporting the whole snapshot is the slow
 * part of every run. `dir` is the mkdtemp directory the caller must remove (via `cleanup`).
 */
function prepareWorkspace({ commit, snapshot, repoRoot, parent, home, materialise = materialiseExport }: { commit: string; snapshot: any; repoRoot: string; parent: string; home: string; materialise?: any }) {
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
    return { root: fs.realpathSync(treeRoot), dir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const cutChars = (text: any, n: number) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/**
 * Spawns the harness once and resolves `{ report, timedOut, spawnError, exitCode, signal, durationMs }`.
 * The child is detached so its whole group can be ended by `escalate` when the timer fires or the
 * executor is stopped by a signal (`onSpawn` hands the group to the caller's signal handler); stdout
 * is streamed to the transcript and fed line by line to the recipe's parser.
 */
async function spawnHarness({ binary, argv, cwd, env, prompt, viaStdin, timeoutMs, transcriptFile, lastMessageFile, parser, now, onSpawn = (_proc: any) => {} }: { binary: any; argv: any; cwd: any; env: any; prompt: any; viaStdin: any; timeoutMs: any; transcriptFile: any; lastMessageFile: any; parser: any; now: any; onSpawn?: (proc: any) => void }) {
  const started = now().getTime();
  const transcript = fs.createWriteStream(transcriptFile);
  const transcriptDone = new Promise((resolve) => transcript.once('close', resolve));
  const child = childProcess.spawn(binary, argv, { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const proc = Number.isInteger(child.pid) ? { pid: child.pid, pgid: child.pid, start: processTree.procStart(child.pid!) } : null;
  if (proc) onSpawn(proc);
  child.stdin.on('error', () => {});
  child.stderr.resume();

  const exited = new Promise<{ code: any; signal: any; error: any }>((resolve) => {
    child.once('exit', (code: any, signal: any) => resolve({ code, signal, error: null }));
    child.once('error', (error: any) => resolve({ code: null, signal: null, error }));
  });
  const outClosed = new Promise((resolve) => child.stdout.once('close', resolve));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line: string) => parser.line(line));
  child.stdout.on('data', (chunk: any) => transcript.write(chunk));

  if (viaStdin) child.stdin.end(prompt);
  else child.stdin.end();

  let timedOut = false;
  let ended = Promise.resolve();
  const timer = setTimeout(() => {
    timedOut = true;
    if (proc) ended = processTree.escalate({ proc });
  }, timeoutMs);

  const result = await exited;
  clearTimeout(timer);
  await ended;
  let drainTimer: any;
  await Promise.race([outClosed, new Promise((resolve) => { drainTimer = setTimeout(resolve, DRAIN_MS); })]);
  clearTimeout(drainTimer); // a pending drain timer would hold the process open after the last run
  child.stdout.destroy();
  rl.close();
  transcript.end();
  await transcriptDone;

  try {
    parser.lastMessage?.(fs.readFileSync(lastMessageFile, 'utf8'));
  } catch { /* the harness wrote no final message */ }
  return {
    report: parser.end(), timedOut, spawnError: result.error, exitCode: result.code, signal: result.signal,
    durationMs: now().getTime() - started,
  };
}

/**
 * The recorded outcome of one run (IC-006 `run_status`, review C-9). `truncated` covers a run that
 * did not end on its own terms: killed by a signal (not our timer), a nonzero exit without a
 * reported failure, or no turn end in the stream. The raw exit code and signal are always kept.
 */
function statusOf({ report, timedOut, spawnError, exitCode = null, signal = null, timeoutSeconds }: { report: any; timedOut: boolean; spawnError: any; exitCode?: any; signal?: any; timeoutSeconds: number }) {
  const codes = { exitCode: exitCode ?? null, signal: signal ?? null };
  if (timedOut) return { status: 'timeout', evidence: `no exit within ${timeoutSeconds}s`, ...codes };
  if (spawnError) return { status: 'api-error', evidence: cutChars(`spawn failed: ${spawnError.code || spawnError.message}`, 200), ...codes };
  if (report.status === 'failure' && report.reason !== 'spawn-observed') {
    return { status: 'api-error', evidence: cutChars(report.summary || report.reason || 'failure', 200), ...codes };
  }
  if (signal) return { status: 'truncated', evidence: `ended by ${signal}`, ...codes };
  if (report.status === 'unparsed' && ['no-turn-end', 'oversize-line'].includes(report.reason)) {
    return { status: 'truncated', evidence: `unparsed: ${report.reason}`, ...codes };
  }
  if (exitCode !== 0) return { status: 'truncated', evidence: `exit code ${exitCode}`, ...codes };
  if (report.reason === 'spawn-observed') return { status: 'completed', evidence: 'spawn-observed', ...codes };
  return { status: 'completed', ...codes };
}

const writeJson = (file: string, value: any) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Review C-11: the run root and the iteration directory are real directories, never symlinks, and
 * the default run root resolves inside the checkout (a symlinked `bench/runs` would send records,
 * and the spend they hold, somewhere the stop rule does not look).
 */
function checkRunRoot({ runRoot, iterDir, repoRoot, defaultRoot }: { runRoot: string; iterDir: string; repoRoot: string; defaultRoot: boolean }) {
  for (const p of [runRoot, iterDir]) {
    if (isLink(p)) throw new UsageError('run-root-symlink', `${p} is a symlink; the run records must live in a real directory`);
  }
  if (defaultRoot && fs.existsSync(runRoot)) {
    const real = fs.realpathSync(runRoot);
    const repo = fs.realpathSync(repoRoot);
    if (real !== path.join(repo, path.relative(repoRoot, runRoot))) {
      throw new UsageError('run-root-symlink', `${runRoot} resolves outside the checkout (${real}); the run records must live in it`);
    }
  }
}

/**
 * Review C-2: the iteration lock, taken before any check that reads the iteration's state and held to
 * the end of the execute. `openSync(..., 'wx')` fails when another execute holds it, whatever its arm.
 * Release removes the lock, and the iteration directory when this execute created it and left it empty.
 */
function lockIteration(runRoot: string, iterDir: string) {
  fs.mkdirSync(runRoot, { recursive: true });
  let created = false;
  try {
    fs.mkdirSync(iterDir);
    created = true;
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
  }
  if (isLink(iterDir)) throw new UsageError('run-root-symlink', `${iterDir} is a symlink; the run records must live in a real directory`);
  const file = path.join(iterDir, LOCK_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    const holder = Number(String(readTextIfPresent(file)).trim());
    let running = false;
    try {
      process.kill(holder, 0);
      running = Number.isInteger(holder) && holder > 0;
    } catch { /* not running */ }
    if (running) throw new UsageError('iteration-locked', `iteration is held by another execute (pid ${holder}); wait for it to finish`);
    // R-2: an executor ended by SIGKILL ran no cleanup. Its worker may still be running (no timer
    // ends it any more) and its scratch profile still holds the credential copy.
    const left = leftProfiles(iterDir);
    throw new UsageError('iteration-locked', `iteration lock ${file} is left by pid ${holder}, which is not running. `
      + 'Its worker may still be running and spending, no longer bounded by timeoutSeconds: check for it and end it. '
      + (left.length
        ? `The scratch profile it left still holds the credential copy: delete ${left.join(', ')}. `
        : 'If the profileRoot named in a run\'s launch.json still exists, it holds the credential copy: delete it. ')
      + 'Then remove the lock.');
  }
  fs.writeSync(fd, `${process.pid}\n`);
  fs.closeSync(fd);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(file);
      } catch { /* already gone */ }
      if (created) {
        try {
          fs.rmdirSync(iterDir);
        } catch { /* not empty: it holds records */ }
      }
    },
  };
}

/** `profileRoot` of each run record under `iterDir` whose directory still exists (review R-2). */
function leftProfiles(iterDir: string) {
  const out: string[] = [];
  for (const dir of runDirsOf(iterDir)) {
    const root = readJsonIfPresent(path.join(dir, RUN_FILES.launch))?.profileRoot;
    if (typeof root === 'string' && root && fs.existsSync(root)) out.push(root);
  }
  return out;
}

function readTextIfPresent(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs the planned tasks of one iteration under a token cap. Refuses (exit 2, nothing written, no
 * process started) when the cap is missing or not a positive integer, the working tree is dirty,
 * another execute holds the iteration, a listed task already has a run directory, the run root or
 * iteration is a symlink, the plan's ceiling exceeds the cap, or the plan itself is invalid. Exit 3
 * means the cap stopped it before a run that could overshoot (`undone` lists those), or a run's real
 * usage passed the cap (`capExceeded: { by, task }`): the cap is a projected ceiling for this one
 * command, so the worst case is the cap plus one run's overshoot beyond `maxTokensPerRun`, bounded only
 * by the timeout (and not at all after a SIGKILL of the executor, review R-2).
 *
 * Interruption (review C-1, R-1): while it runs, SIGINT, SIGTERM and SIGHUP end the worker's process
 * group, record the run as `truncated` with the usage its transcript already holds (it counts at the
 * larger of that sum and `maxTokensPerRun`), remove
 * every scratch directory and the lock, and then re-raise the signal. Once a worker may have started,
 * its run directory is never removed (review C-3): an executor error leaves the record counted.
 *
 * Options beyond `plan`'s are injectable for tests: `env` (the caller env), `extraEnv` (added to the
 * child env, tests only), `sourceHome`, `tmpDir`, `materialise`, `now`.
 */
async function executeIteration(opts: any = {}) {
  const {
    repoRoot = REPO_ROOT, env = process.env, extraEnv = {}, sourceHome = os.homedir(), tmpDir = os.tmpdir(),
    materialise = materialiseExport, now = () => new Date(),
  } = opts;
  let plan: any;
  let taskSet: any;
  let config: any;
  let cap: any;
  let recipe: any;
  let binary: any;
  let tools: any;
  let sourceAt: any;
  let iterDir: any;
  let runRoot: any;
  let lock: any = null;
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

    if (plan.projection.ceilingTokens > cap) {
      throw new UsageError('over-cap', `ceiling ${plan.projection.ceilingTokens} tokens (${plan.projection.runs} runs x ${plan.projection.maxTokensPerRun}) exceeds --cap ${cap}`);
    }
    binary = findOnPath(recipe.cli.binary, env.PATH);
    if (!binary) throw new UsageError('harness-binary-missing', `harness binary "${recipe.cli.binary}" is not on PATH`);
    tools = {} as Record<string, string>;
    for (const tool of config.path) {
      const found = findOnPath(tool, env.PATH);
      if (!found) throw new UsageError('tool-missing', `tool "${tool}" from the config path list is not on PATH`);
      tools[tool] = found;
    }

    iterDir = path.join(runRoot, plan.iteration);
    checkRunRoot({ runRoot, iterDir, repoRoot, defaultRoot: !opts.runRoot });
    // From here the iteration is ours: every check below reads its state under the lock.
    lock = lockIteration(runRoot, iterDir);
    const existing = plan.runs.filter((r: any) => fs.existsSync(r.runDir) || isLink(r.runDir)).map((r: any) => r.id);
    if (existing.length > 0) throw new UsageError('run-exists', `run directory already exists for: ${existing.join(', ')}`);
    const prior = readJsonIfPresent(path.join(iterDir, RUN_FILES.iteration));
    if (prior && (prior.arm !== plan.arm || prior.model !== plan.model || prior.sourceAt !== sourceAt || prior.snapshot !== plan.snapshot
      || prior.captureSha256 !== captureSha256(config))) {
      throw new UsageError('iteration-mismatch', `iteration "${plan.iteration}" already exists with a different arm, model, source, snapshot or capture config`);
    }
  } catch (e) {
    lock?.release();
    if (e instanceof UsageError) return refused(e);
    throw e;
  }

  // Everything that could refuse has run. From here on a harness failure is a recorded outcome, and
  // every scratch directory is registered in `scratch` so one cleanup path (normal end, error or
  // signal) removes each of them independently.
  const scratch = new Set<string>();
  const state: { proc: any; run: any; interrupted: any } = { proc: null, run: null, interrupted: null };
  const cleanupScratch = () => {
    const errors: any[] = [];
    for (const dir of scratch) {
      const err = removeTree(dir);
      if (err) errors.push(err);
      else scratch.delete(dir);
    }
    return errors;
  };
  const onSignal = (sig: any) => {
    if (state.interrupted) return;
    state.interrupted = sig;
    // Taken now: the main flow may clear them while the group is being ended.
    const { proc, run } = state;
    (async () => {
      try {
        if (proc) await processTree.escalate({ proc });
        if (run) {
          try {
            writeJson(path.join(run.runDir, RUN_FILES.runStatus), { status: 'truncated', evidence: `executor interrupted by ${sig}`, exitCode: null, signal: null });
            // R-1: usage the worker already reported is kept; spentOf counts this truncated run at
            // the larger of it and maxTokensPerRun.
            const usage = usageOf(run.transcriptFile);
            writeJson(path.join(run.runDir, RUN_FILES.timing), {
              ...(usage.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
              duration_ms: now().getTime() - run.started,
              usage: usage.usage,
            });
          } catch { /* launch.json alone already counts the run at maxTokensPerRun */ }
        }
        cleanupScratch();
        lock.release();
      } finally {
        for (const s of STOP_SIGNALS) process.removeListener(s, onSignal);
        process.kill(process.pid, sig);
      }
    })();
  };
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  // After a signal the handler owns the records and the cleanup; the main flow must not touch either.
  const halted = () => new Promise(() => {});

  try {
    const passthrough: Record<string, any> = {};
    for (const name of ENV_PASSTHROUGH) if (env[name] !== undefined) passthrough[name] = env[name];

    // N-1: the version check runs in its own scratch profile (no credential), never the caller HOME.
    const versionProfile = makeProfile({ config, arm: null, sourceHome, tmpDir, tools, copyCredentials: false });
    scratch.add(versionProfile.dir);
    const versionEnv = {
      PATH: [versionProfile.binDir, '/usr/bin', '/bin'].join(path.delimiter), HOME: versionProfile.home,
      [config.home.env]: versionProfile.harnessHome, ...passthrough, ...extraEnv,
    };
    const versionRun = childProcess.spawnSync(binary, recipe.cli.versionArgv || ['--version'], { env: versionEnv, encoding: 'utf8', timeout: 15000 });
    const versionErr = removeTree(versionProfile.dir);
    if (versionErr) throw versionErr;
    scratch.delete(versionProfile.dir);
    if (state.interrupted) return halted();
    const harnessVersion = versionRun.status === 0 ? (String(versionRun.stdout).split(/\r?\n/).find((l: string) => l.trim()) || '').trim() || null : null;

    const shimRoot = config.arms[plan.arm].pathAdd.includes(SHIM_ENTRY) ? exportToolTree({ repoRoot, commit: sourceAt, tmpDir }) : null;
    if (shimRoot) scratch.add(shimRoot);

    const iterationFile = path.join(iterDir, RUN_FILES.iteration);
    if (!fs.existsSync(iterationFile)) {
      writeJson(iterationFile, {
        arm: plan.arm, model: plan.model, sourceAt, snapshot: plan.snapshot, harness: plan.harness, harnessVersion,
        captureSha256: captureSha256(config), startedAt: now().toISOString(),
      });
    }

    const max = config.maxTokensPerRun;
    const tasksById = new Map(taskSet.tasks.map((t: any) => [t.id, t]));
    const ran: string[] = [];
    const undone: string[] = [];
    let capExceeded = null;
    const viaStdin = recipe.oneShot?.promptVia === 'stdin';
    for (let i = 0; i < plan.runs.length; i++) {
      if (spentOf(iterDir, max) + max > cap) {
        undone.push(...plan.runs.slice(i).map((r: any) => r.id));
        break;
      }
      const run = plan.runs[i];
      const task = tasksById.get(run.id);
      const prompt = buildPrompt(task, config.arms[plan.arm].paragraph);
      fs.mkdirSync(run.runDir); // not recursive: an existing directory stops the iteration (EEXIST)
      let profile: any = null;
      let workspace: any = null;
      let spawned = false;
      let failed = false;
      try {
        profile = makeProfile({ config, arm: plan.arm, sourceHome, shimRoot, tmpDir, tools });
        scratch.add(profile.dir);
        workspace = prepareWorkspace({
          commit: plan.snapshot, snapshot: taskSet.snapshot, repoRoot, parent: tmpDir, home: profile.home, materialise,
        });
        scratch.add(workspace.dir);
        // C-4: the final message is written inside the profile and copied back after the run, so no
        // argv element names the checkout.
        const profileMessage = path.join(profile.dir, RUN_FILES.lastMessage);
        const startedAt = now().toISOString();
        const argv = wrapLaunch(() => insertModelArgv(recipe, launch.assembleArgv(recipe, prompt, false, profileMessage), config.model.argv));
        writeJson(path.join(run.runDir, RUN_FILES.launch), {
          key: run.key, arm: plan.arm, harness: plan.harness, harnessVersion, model: plan.model,
          argvShape: run.argvShape, promptSha256: run.promptSha256, promptBytes: run.promptBytes,
          toolProfile: { pathDirs: ['<profile>/bin'], tools, pathAdd: config.arms[plan.arm].pathAdd },
          snapshot: plan.snapshot, startedAt, credentialCopied: profile.credentialCopied,
          workspaceRoot: workspace.root, profileRoot: profile.dir,
        });

        const childEnv = {
          PATH: [profile.binDir, '/usr/bin', '/bin', ...profile.pathAddDirs].join(path.delimiter),
          HOME: profile.home,
          [config.home.env]: profile.harnessHome,
          ...passthrough,
          ...extraEnv,
        };

        const parser = parserFor(recipe.structuredOutput.parser).create();
        if (state.interrupted) return halted();
        spawned = true; // from here the run may have spent: its directory is never removed
        const transcriptFile = path.join(run.runDir, RUN_FILES.transcript);
        state.run = { runDir: run.runDir, transcriptFile, started: now().getTime() };
        const outcome = await spawnHarness({
          binary, argv, cwd: workspace.root, env: childEnv, prompt, viaStdin,
          timeoutMs: config.timeoutSeconds * 1000, transcriptFile, lastMessageFile: profileMessage, parser, now,
          onSpawn: (proc) => { state.proc = proc; },
        });
        state.proc = null;
        if (state.interrupted) return halted();
        if (fs.existsSync(profileMessage)) fs.copyFileSync(profileMessage, path.join(run.runDir, RUN_FILES.lastMessage));
        writeJson(path.join(run.runDir, RUN_FILES.runStatus), statusOf({ ...outcome, timeoutSeconds: config.timeoutSeconds }));
        const usage = usageOf(transcriptFile);
        writeJson(path.join(run.runDir, RUN_FILES.timing), {
          ...(usage.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
          duration_ms: outcome.durationMs,
          usage: usage.usage,
        });
        ran.push(run.id);
      } catch (e) {
        // Before the spawn nothing was spent and the half-made directory goes; after it, the record
        // stays (launch.json without a usable timing.json counts at maxTokensPerRun).
        failed = true;
        if (!spawned) removeTree(run.runDir);
        throw e;
      } finally {
        state.run = null;
        if (!state.interrupted) {
          const errors = [];
          for (const dir of [workspace?.dir, profile?.dir]) {
            if (!dir) continue;
            const err = removeTree(dir);
            if (err) errors.push(err);
            else scratch.delete(dir);
          }
          if (errors.length && !failed) throw errors[0]; // eslint-disable-line no-unsafe-finally
        }
      }
      const spent = spentOf(iterDir, max);
      if (spent > cap) {
        capExceeded = { by: spent - cap, task: run.id };
        undone.push(...plan.runs.slice(i + 1).map((r: any) => r.id));
        break;
      }
    }
    return { exit: undone.length > 0 || capExceeded ? 3 : 0, ran, undone, spent: spentOf(iterDir, max), ...(capExceeded ? { capExceeded } : {}) };
  } finally {
    if (!state.interrupted) {
      for (const s of STOP_SIGNALS) process.removeListener(s, onSignal);
      const errors = cleanupScratch();
      lock.release();
      if (errors.length) throw errors[0]; // eslint-disable-line no-unsafe-finally
    }
  }
}

module.exports = {
  CONFIG_PATH, RUN_FILES, SHIM_ENTRY, TOOL_TREE,
  loadConfig, selectHarness, insertModelArgv, planIteration, executeIteration, prepareWorkspace,
  runDirOf, readIteration, captureSha256, usageOf, statusOf,
};
