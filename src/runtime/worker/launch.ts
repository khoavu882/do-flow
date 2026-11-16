'use strict';

// Feature 081 B.3 (IC-003, IC-012; DEC-030, DEC-037, DEC-045): the real launcher.
//
// `launchEnv` names the worker in the caller's environment: the caller's variables are inherited
// unchanged (DEC-045), except for the five identity variables and DOFLOW_WORKER_RUN. The run segment of
// the claim's run key is the worker's run, or, when that segment is the default `local`, the run
// id without its `w-` prefix (DEC-037), so the worker always resolves to a launched identity and
// its 078 unit `L.<run>.<lineage>.<token>` is unique to this run. A child run (082 IC-015) is
// always run-scoped, so its unit differs from its granter's.
//
// `assembleArgv` builds the IC-003 argv: `readOnly`, `spawnDenial`, `structuredOutput` and
// `oneShot` argv in that order (082 IC-014: an edit run puts `isolatedEdit` first in place of
// `readOnly`). 120 IC-011 inserts `model` second only for a supported binding. The `{prompt}`,
// `{lastMessageFile}` and `{model}` elements are replaced whole, never inside a longer string.
// `argvShape` writes the prompt as `<prompt sha256:<hex> bytes:<n>>`, the output path as
// `<last-message-file>` and the model as the original `{model}` placeholder.
// 169 IC-002: the model part comes from `composeModelPart` (the model, plus a bound provider and effort as the
// descriptor's `provider` and `effort` entries say). A transport flag the part adds is removed from `oneShot`,
// `structuredOutput` and `mainSession` (`F v` and `F=v`), so it appears once; with no provider or effort bound nothing
// is removed and the argv is what it was. The shape keeps `{model}`, `{provider}` and `{effort}`.
//
// `launchWorker` runs IC-012 steps 1 to 5: the environment, the optional 078 grant, the launch
// emission in process, the emission text before the brief, then `spawn` with no shell. It returns a
// promise that resolves once the process has spawned and rejects on any throw or a spawn `error`
// (for example ENOENT); the supervisor ends such a run `not-started`. No variable's value is stored,
// and the emission text is never returned for storage.
//
// 165 IC-006, D1, D9: a started main session (`kind: 'main-session'`) launches through the same spawn
// with its own recipe. `mainArgv` takes `mainSession.argv` and splices the model part (`model.argv`
// with `{model}` replaced whole, absent for the harness default) in before the first positional tail
// element (`-`, `--` or `{prompt}`), else at the end: claude `-p --output-format text --model M`,
// codex `exec --json -o F -m M -`, opencode `run --format json --model M <prompt>`, pi
// `-p --mode json --model M -- <prompt>`. `mainEnv` drops the five identity variables,
// DOFLOW_WORKER_RUN and the primary declaration (it names the caller's session, not this one), sets
// nothing worker-ish and adds DOFLOW_STARTED_RUN=<runId>. No context emission is prepended.

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { emitContext, utf8Bytes } = require('../context/arbitrate.ts');
const { grantSummary } = require('../context/summary-store.ts');
const { wideningProblem, wideningFlagsProblem } = require('../../registry/widening-flags.ts');
const { choiceOf, composeModelPart } = require('./model-choice.ts');

/** The parser table, required on first use as before (171 IC-003 resolves every parser id through it). */
function parsers() { return require('./parsers.ts'); }

type Env = Record<string, string | undefined>;
/** 120 IC-011 / IC-012, 169 IC-002: the binding shape consumed by the recipe assembler; `provider` and `effort` are absent or null for a plain model. */
type ModelBinding = { model: string | null; provider?: string | null; effort?: string | null; flag: 'supported' | 'unevidenced' | 'n/a' };
type ModelChoice = { model: string; provider: string | null; effort: string | null };

/** IC-012: the names a launch may set, in the order the run record lists them. The first five are the
 * identity contract; `DOFLOW_WORKER_RUN` (110) carries the worker run id `w-<12 hex>` and nothing else,
 * so the worker's telemetry can name its own run. It is not part of the stored identity. */
const WORKER_RUN_VAR = 'DOFLOW_WORKER_RUN';
const ENV_SET = Object.freeze(['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', WORKER_RUN_VAR]);
const PROMPT_ELEMENT = '{prompt}';
const LAST_MESSAGE_FILE_ELEMENT = '{lastMessageFile}';
/** IC-003 prompt limits in bytes. argv is one under Linux MAX_ARG_STRLEN, which counts the NUL (DEC-062). */
const PROMPT_LIMITS = Object.freeze({ argv: 131071, stdin: 1048576 });
const DEFAULT_RUN = 'local';
const RUN_ID = /^w-[0-9a-f]{12}$/;
/** 165 D9: names the run a started main session belongs to, so a start from inside it is `nested-start`. */
const STARTED_RUN_VAR = 'DOFLOW_STARTED_RUN';
/** 165 IC-006: the elements that open a main-session argv's positional tail; the model part goes before the first. */
const MAIN_TAIL = new Set(['-', '--', '{prompt}']);
/** IC-003 / 120 IC-011: order of the run recipe's argv; model is conditional on its binding. */
const RECIPE_ORDER = Object.freeze(['readOnly', 'model', 'spawnDenial', 'structuredOutput', 'oneShot']);
/** 082 IC-014 / 120 IC-011: the order of an edit run's recipe argv. */
const EDIT_RECIPE_ORDER = Object.freeze(['isolatedEdit', 'model', 'spawnDenial', 'structuredOutput', 'oneShot']);

interface WorkerIdentity {
  run: string;
  lineage: string;
  attempt: string;
  runSource: 'claim' | 'run-scoped';
}

/** A caller error, not a refusal: exit 2 `usage` with `reason`. */
class LaunchUsageError extends Error {
  declare code: string;
  declare reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'LaunchUsageError';
    this.code = reason;
    this.reason = reason;
  }
}

/** The five identity variables and the optional worker run id. The run id replaces (or removes) the
 * caller's value; the caller's environment is never mutated. */
function withIdentity(env: Env, identity: WorkerIdentity, execWorktree: string, runId?: string): Env {
  if (runId !== undefined && !RUN_ID.test(runId)) throw new LaunchUsageError('run-id-malformed', `launch: run id must match ${RUN_ID}: ${runId}`);
  const out: Env = {
    ...env,
    DOFLOW_RUN_ID: identity.run,
    DOFLOW_LINEAGE_ID: identity.lineage,
    DOFLOW_ATTEMPT: identity.attempt,
    DOFLOW_SESSION_ROLE: 'worker',
    DOFLOW_WORKTREE: execWorktree,
  };
  if (runId !== undefined) out[WORKER_RUN_VAR] = runId;
  else delete out[WORKER_RUN_VAR];
  // 120 IC-003: the primary declaration names the person's main session, never a worker.
  delete out.DOFLOW_PRIMARY_HARNESS;
  delete out.DOFLOW_PRIMARY_MODEL;
  return out;
}

/** IC-012: the worker environment and identity from the claim's run key `<hash>/<run>/<lineage>`.
 * `runScoped` (082 IC-015, a child run) takes the run id as the run whatever the claim's run is. */
function launchEnv({ env, runKey, token, execWorktree, runId, runScoped = false }: { env: Env; runKey: string; token: number | string; execWorktree: string; runId: string; runScoped?: boolean }): { env: Env; identity: WorkerIdentity } {
  const segments = String(runKey).split('/');
  if (segments.length !== 3 || segments.some((s) => s === '')) throw new LaunchUsageError('run-key-malformed', `launchEnv: run key must be <hash>/<run>/<lineage>: ${runKey}`);
  const [, claimRun, lineage] = segments;
  let identity: WorkerIdentity;
  if (claimRun === DEFAULT_RUN || runScoped) {
    if (!RUN_ID.test(runId)) throw new LaunchUsageError('run-id-malformed', `launchEnv: run id must match ${RUN_ID}: ${runId}`);
    identity = { run: runId.slice(2), lineage, attempt: String(token), runSource: 'run-scoped' };
  } else {
    identity = { run: claimRun, lineage, attempt: String(token), runSource: 'claim' };
  }
  return { env: withIdentity(env, identity, execWorktree, runId), identity };
}

/** 120 IC-011: only a supported binding supplies a choice (169: the model with its optional provider and effort). */
function boundChoice(binding?: ModelBinding | null): ModelChoice | null {
  if (binding?.flag !== 'supported') return null;
  if (typeof binding.model !== 'string' || binding.model.length === 0) {
    throw new LaunchUsageError('model-invalid', 'assembleArgv: a supported model binding requires a non-empty model string');
  }
  return { model: binding.model, provider: binding.provider ?? null, effort: binding.effort ?? null };
}

/** 169 IC-002: `argv` without every `F v` pair and `F=v` token for each flag `F` in `flags` (the flags the model part now owns). */
function withoutFlags(argv: string[], flags: string[]): string[] {
  if (flags.length === 0) return argv;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (flags.includes(argv[i])) i += 1;
    else if (!flags.some((flag) => argv[i].startsWith(`${flag}=`))) out.push(argv[i]);
  }
  return out;
}

/** The pieces whose transport flags the model part may take over; a safety piece (readOnly, spawnDenial, isolatedEdit) is never stripped. */
const STRIPPABLE = new Set(['oneShot', 'structuredOutput', 'mainSession']);

/**
 * 165 review B-2: the final argv, the model already in it and the prompt and output path still placeholders, holds no
 * widening flag (the validator's own matcher), so a model id or a descriptor that skipped the validator cannot add one.
 */
function refuseWidening(recipe: any, argv: string[], mainSession: boolean): void {
  const declared = Array.isArray(recipe?.wideningFlags) && wideningFlagsProblem(recipe.wideningFlags) === null ? recipe.wideningFlags : [];
  const widening = wideningProblem(argv, { binary: recipe?.cli?.binary, declared, mainSession });
  if (widening) throw new LaunchUsageError('widening-flag', `the ${mainSession ? 'main-session' : 'worker'} argv holds the widening flag '${widening}'`);
}

/** IC-003 / 120 IC-011 / 169 IC-002: replace prompt, output path and the model part only as whole elements; `shape` keeps the placeholders. */
function assemble(recipe: any, element: string, edit = false, lastMessageFile?: string, binding?: ModelBinding | null, shape = false): string[] {
  const choice = boundChoice(binding);
  let model: { argv: string[]; strip: string[] } | null = null;
  if (choice !== null) {
    if (recipe?.model?.status !== 'supported' || !Array.isArray(recipe.model.argv)) {
      throw new LaunchUsageError('recipe-incomplete', "assembleArgv: worker 'model' is not supported with an argv");
    }
    model = composeModelPart(recipe, choice, { shape });
  }
  const argv: string[] = [];
  for (const key of edit ? EDIT_RECIPE_ORDER : RECIPE_ORDER) {
    if (key === 'model') {
      if (model !== null) argv.push(...model.argv);
      continue;
    }
    const entry = recipe?.[key];
    if (!entry || entry.status !== 'supported' || !Array.isArray(entry.argv)) {
      throw new LaunchUsageError('recipe-incomplete', `assembleArgv: worker '${key}' is not supported with an argv`);
    }
    argv.push(...(model !== null && STRIPPABLE.has(key) ? withoutFlags(entry.argv, model.strip) : entry.argv));
  }
  refuseWidening(recipe, argv, false);
  return argv.map((value) => {
    if (value === LAST_MESSAGE_FILE_ELEMENT) {
      if (lastMessageFile === undefined) {
        throw new LaunchUsageError('last-message-file-missing', "assembleArgv: worker recipe needs a '{lastMessageFile}' output path");
      }
      return lastMessageFile;
    }
    if (value === PROMPT_ELEMENT && recipe.oneShot.promptVia === 'argv') return element;
    return value;
  });
}

function promptVia(recipe: any): 'argv' | 'stdin' {
  return recipe?.oneShot?.promptVia === 'stdin' ? 'stdin' : 'argv';
}

/** 171 IC-005: what launch sends for `prompt`: one whole argv element, or the exact stdin bytes (UTF-8, then end).
 * `main` reads mainSession's transport, else oneShot's. Conform checks the fake received exactly this. */
function promptInput(recipe: any, prompt: string, main = false): { via: 'argv' | 'stdin'; element: string | null; stdin: Buffer | null } {
  const via = main ? (recipe?.mainSession?.promptVia === 'argv' ? 'argv' : 'stdin') : promptVia(recipe);
  return via === 'stdin' ? { via, element: null, stdin: Buffer.from(prompt, 'utf8') } : { via, element: prompt, stdin: null };
}

/** IC-003: the worker argv for `prompt`; a prompt over its mode's limit is `prompt-too-large`.
 * `edit` selects the edit recipe order (082 IC-014); 120 IC-011 optionally inserts the bound model. */
function assembleArgv(recipe: any, prompt: string, edit = false, lastMessageFile?: string, binding?: ModelBinding | null): string[] {
  const mode = promptVia(recipe);
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > PROMPT_LIMITS[mode]) {
    throw new LaunchUsageError('prompt-too-large', `assembleArgv: the prompt is ${bytes} bytes; ${mode} mode allows ${PROMPT_LIMITS[mode]}`);
  }
  return assemble(recipe, prompt, edit, lastMessageFile, binding);
}

/** IC-003 / 120 IC-011 / 169 IC-002: the stored shape hashes the prompt and keeps the {model}, {provider} and {effort} placeholders. */
function argvShape(recipe: any, prompt: string, edit = false, binding?: ModelBinding | null): string[] {
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  return assemble(recipe, `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt, 'utf8')}>`, edit, '<last-message-file>', binding, true);
}

/** IC-012 / data-model §1: the launch fields a run record stores. Names only, never a value. */
function launchRecord(recipe: any, identity: WorkerIdentity, prompt: string, edit = false, binding?: ModelBinding | null) {
  return {
    identity: { run: identity.run, lineage: identity.lineage, attempt: identity.attempt, runSource: identity.runSource },
    recipe: {
      binary: recipe.cli.binary,
      argvShape: argvShape(recipe, prompt, edit, binding),
      promptVia: promptVia(recipe),
      parser: parsers().parserIdOf(recipe.structuredOutput),
      profile: recipe.profile ?? null,
    },
    envSet: [...ENV_SET],
    envInherited: true,
  };
}

/** 169: a main-session model as a choice. `model` is a plain id, a ModelChoice-shaped object or null (the harness default). */
function mainChoice(model: unknown): ModelChoice | null {
  if (model === null || model === undefined) return null;
  const choice = choiceOf(model);
  if (choice === null) throw new LaunchUsageError('model-invalid', 'mainArgv: a model must be a non-empty string');
  return choice;
}

/** 165 IC-006, 169 IC-002: `mainSession.argv` with the model part spliced in and the placeholders replaced whole.
 * `model` null is the harness default (no model part). */
function mainArgvOf(recipe: any, element: string, lastMessageFile: string | undefined, model: unknown, shape: boolean): string[] {
  const entry = recipe?.mainSession;
  if (!entry || entry.status !== 'supported' || !Array.isArray(entry.argv)) {
    throw new LaunchUsageError('recipe-incomplete', "mainArgv: worker 'mainSession' is not supported with an argv");
  }
  if ((entry.promptVia === 'argv') !== entry.argv.includes(PROMPT_ELEMENT)) {
    throw new LaunchUsageError('recipe-incomplete', `mainArgv: promptVia '${entry.promptVia}' and the argv's '{prompt}' element disagree`);
  }
  const choice = mainChoice(model);
  let modelPart: string[] = [];
  let tail: string[] = entry.argv;
  if (choice !== null) {
    if (recipe.model?.status !== 'supported' || !Array.isArray(recipe.model.argv)) {
      throw new LaunchUsageError('recipe-incomplete', "mainArgv: worker 'model' is not supported with an argv");
    }
    const composed = composeModelPart(recipe, choice, { shape });
    modelPart = composed.argv;
    tail = withoutFlags(entry.argv, composed.strip);
  }
  const at = tail.findIndex((value: string) => MAIN_TAIL.has(value));
  const spliced = at === -1 ? [...tail, ...modelPart] : [...tail.slice(0, at), ...modelPart, ...tail.slice(at)];
  refuseWidening(recipe, spliced, true);
  return spliced.map((value: string) => {
    if (value === LAST_MESSAGE_FILE_ELEMENT) {
      if (lastMessageFile === undefined) throw new LaunchUsageError('last-message-file-missing', "mainArgv: the recipe needs a '{lastMessageFile}' output path");
      return lastMessageFile;
    }
    return value === PROMPT_ELEMENT ? element : value;
  });
}

function mainArgv(recipe: any, element: string, lastMessageFile?: string, model: string | ModelChoice | null = null): string[] {
  return mainArgvOf(recipe, element, lastMessageFile, model, false);
}

/** 165 IC-003: the stored main-session argv, the prompt hashed, the output path and the model part as placeholders. */
function mainArgvShape(recipe: any, prompt: string, model: string | ModelChoice | null = null): string[] {
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  return mainArgvOf(recipe, `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt, 'utf8')}>`, '<last-message-file>', model, true);
}

/** 165 D9: the caller's environment without any identity, worker or primary variable, plus DOFLOW_STARTED_RUN. */
function mainEnv(env: Env, runId: string): Env {
  if (!RUN_ID.test(runId)) throw new LaunchUsageError('run-id-malformed', `mainEnv: run id must match ${RUN_ID}: ${runId}`);
  const out: Env = { ...env };
  for (const name of ENV_SET) delete out[name];
  delete out.DOFLOW_PRIMARY_HARNESS;
  delete out.DOFLOW_PRIMARY_MODEL;
  out[STARTED_RUN_VAR] = runId;
  return out;
}

/** 165 IC-003: the launch fields a main-session record stores. Names only, never a value. */
function mainLaunchRecord(recipe: any, prompt: string, model: string | ModelChoice | null) {
  return {
    recipe: {
      binary: recipe.cli.binary,
      argvShape: mainArgvShape(recipe, prompt, model),
      promptVia: recipe.mainSession.promptVia === 'argv' ? 'argv' : 'stdin',
      parser: parsers().parserIdOf(recipe.mainSession),
      profile: 'main-session',
    },
    envSet: [STARTED_RUN_VAR],
    envInherited: true,
  };
}

/** Spawns `file` detached; `input.stdin`, when set, is written to stdin and ended. Resolves `{ child, ...extra }` once spawned. */
function spawnHarness(file: string, args: string[], options: any, input: { stdin: Buffer | null }, extra: any): Promise<any> {
  const viaStdin = input.stdin !== null;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    // Kept attached: a reject after the resolve is a no-op, and an early error never goes unhandled.
    child.on('error', reject);
    child.once('spawn', () => {
      if (viaStdin) {
        // A process that exits before reading closes the pipe; its exit is what the supervisor records.
        child.stdin.on('error', () => {});
        child.stdin.end(input.stdin);
      }
      resolve({ child, ...extra });
    });
  });
}

/** 171 IC-003: the main session's parser is a code parser, or this descriptor's own structuredOutput.fieldMap id;
 * one that resolves to unparsed throws `parser-unknown`. launchMainSession and conform's main-session part call it. */
function refuseUnknownMainParser(recipe: any): void {
  const { parserIdOf, parserOf, UNPARSED } = parsers();
  const parser = parserIdOf(recipe.mainSession);
  if (parser !== null && parserOf(recipe, 'main').id === UNPARSED) {
    throw new LaunchUsageError('parser-unknown', `launchMainSession: parser '${parser}' is not in core PARSERS`);
  }
}

/** 165 D1, D9: launches a started main session from its recipe in `execWorktree`. No context emission, no grant. */
function launchMainSession({ recipe, prompt, execWorktree, env, runId, model = null, lastMessageFile }: {
  recipe: any; prompt: string; execWorktree: string; env: Env; runId: string; model?: string | ModelChoice | null; lastMessageFile?: string;
}): Promise<any> {
  return Promise.resolve().then(() => {
    const sessionEnv = mainEnv(env, runId);
    const argv = mainArgv(recipe, prompt, lastMessageFile, model);
    refuseUnknownMainParser(recipe);
    return spawnHarness(recipe.cli?.binary, argv, { cwd: execWorktree, env: sessionEnv, shell: false }, promptInput(recipe, prompt, true), { env: sessionEnv, launched: null });
  });
}

interface LaunchOptions {
  recipe: any;
  prompt: string;
  identity: WorkerIdentity;
  execWorktree: string;
  env: Env;
  taskId?: string;
  grant?: Record<string, unknown>;
  /** 082 IC-014: launch with the edit recipe order. */
  edit?: boolean;
  /** IC-004: absolute path for the whole `{lastMessageFile}` argv element. */
  lastMessageFile?: string;
  /** 110: the worker run id (`w-<12 hex>`), set as `DOFLOW_WORKER_RUN`; absent leaves the variable unset. */
  runId?: string;
  /** 120 IC-011: insert model.argv only for a supported binding. */
  binding?: ModelBinding | null;
}

/** IC-012 steps 1 to 5. Resolves `{ child, env, launched: { reason, bytes } }` once the process has spawned. */
function launchWorker({ recipe, prompt, identity, execWorktree, env, taskId, grant, edit = false, lastMessageFile, runId, binding }: LaunchOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerEnv = withIdentity(env, identity, execWorktree, runId);
    if (grant) grantSummary({ ...grant, toRun: identity.run, toLineage: identity.lineage, env });
    const emitted = emitContext({ event: 'launch', cwd: execWorktree, env: workerEnv, ...(taskId ? { taskId } : {}) });
    const reason: string = emitted.decision.reason;
    // DEC-052: any returned text is delivered, a refused emission's included (it carries the pack and the pointer).
    const delivered = typeof emitted.text === 'string' ? emitted.text : null;
    const text = delivered !== null ? `${delivered}\n\n${prompt}` : prompt;
    const launched = { reason, bytes: delivered !== null ? utf8Bytes(delivered) : 0 };
    const argv = assembleArgv(recipe, text, edit, lastMessageFile, binding);
    const { parserIdOf, parserOf, UNPARSED } = parsers();
    const parser = parserIdOf(recipe?.structuredOutput);
    if (parser && parserOf(recipe, 'structured').id === UNPARSED) {
      throw new LaunchUsageError('parser-unknown', `launchWorker: parser '${parser}' is not in core PARSERS`);
    }
    let file = recipe.cli?.binary;
    let spawnArgs = argv;
    let spawnOptions: any = { cwd: execWorktree, env: workerEnv, shell: false };
    if (recipe.program && recipe.storeEntry) {
      const { launchSpec } = require('../packages/programs.ts');
      const spec = launchSpec({
        program: recipe.program,
        storeEntry: recipe.storeEntry,
        recipeArgv: argv,
        cwd: execWorktree,
        env: workerEnv,
      });
      file = spec.file;
      spawnArgs = spec.args;
      spawnOptions = spec.options;
    }
    spawnHarness(file, spawnArgs, spawnOptions, promptInput(recipe, text), { env: workerEnv, launched }).then(resolve, reject);
  });
}

module.exports = {
  ENV_SET, PROMPT_LIMITS, RECIPE_ORDER, EDIT_RECIPE_ORDER, STARTED_RUN_VAR, LaunchUsageError, argvShape, assembleArgv,
  launchEnv, launchRecord, launchWorker, mainArgv, mainArgvShape, mainEnv, mainLaunchRecord, launchMainSession, promptInput,
  refuseUnknownMainParser,
};
