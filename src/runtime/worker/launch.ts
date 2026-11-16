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

type Env = Record<string, string | undefined>;
/** 120 IC-011 / IC-012: the binding shape consumed by the recipe assembler. */
type ModelBinding = { model: string | null; flag: 'supported' | 'unevidenced' | 'n/a' };

/** IC-012: the names a launch may set, in the order the run record lists them. The first five are the
 * identity contract; `DOFLOW_WORKER_RUN` (110) carries the worker run id `w-<12 hex>` and nothing else,
 * so the worker's telemetry can name its own run. It is not part of the stored identity. */
const WORKER_RUN_VAR = 'DOFLOW_WORKER_RUN';
const ENV_SET = Object.freeze(['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', WORKER_RUN_VAR]);
const PROMPT_ELEMENT = '{prompt}';
const LAST_MESSAGE_FILE_ELEMENT = '{lastMessageFile}';
const MODEL_ELEMENT = '{model}';
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

/** 120 IC-011: only a supported binding supplies a non-empty model element. */
function boundModel(binding?: ModelBinding | null): string | null {
  if (binding?.flag !== 'supported') return null;
  if (typeof binding.model !== 'string' || binding.model.length === 0) {
    throw new LaunchUsageError('model-invalid', 'assembleArgv: a supported model binding requires a non-empty model string');
  }
  return binding.model;
}

/**
 * 165 review B-2: the final argv, the model already in it and the prompt and output path still placeholders, holds no
 * widening flag (the validator's own matcher), so a model id or a descriptor that skipped the validator cannot add one.
 */
function refuseWidening(recipe: any, argv: string[], mainSession: boolean): void {
  const declared = Array.isArray(recipe?.wideningFlags) && wideningFlagsProblem(recipe.wideningFlags) === null ? recipe.wideningFlags : [];
  const widening = wideningProblem(argv, { binary: recipe?.cli?.binary, declared, mainSession });
  if (widening) throw new LaunchUsageError('widening-flag', `the ${mainSession ? 'main-session' : 'worker'} argv holds the widening flag '${widening}'`);
}

/** IC-003 / 120 IC-011: replace prompt, output path and bound model only as whole elements. */
function assemble(recipe: any, element: string, edit = false, lastMessageFile?: string, binding?: ModelBinding | null): string[] {
  const model = boundModel(binding);
  const argv: string[] = [];
  for (const key of edit ? EDIT_RECIPE_ORDER : RECIPE_ORDER) {
    if (key === 'model' && model === null) continue;
    const entry = recipe?.[key];
    if (!entry || entry.status !== 'supported' || !Array.isArray(entry.argv)) {
      throw new LaunchUsageError('recipe-incomplete', `assembleArgv: worker '${key}' is not supported with an argv`);
    }
    argv.push(...entry.argv);
  }
  refuseWidening(recipe, argv.map((value) => (value === MODEL_ELEMENT && model !== null ? model : value)), false);
  return argv.map((value) => {
    if (value === LAST_MESSAGE_FILE_ELEMENT) {
      if (lastMessageFile === undefined) {
        throw new LaunchUsageError('last-message-file-missing', "assembleArgv: worker recipe needs a '{lastMessageFile}' output path");
      }
      return lastMessageFile;
    }
    if (value === MODEL_ELEMENT && model !== null) return model;
    if (value === PROMPT_ELEMENT && recipe.oneShot.promptVia === 'argv') return element;
    return value;
  });
}

function promptVia(recipe: any): 'argv' | 'stdin' {
  return recipe?.oneShot?.promptVia === 'stdin' ? 'stdin' : 'argv';
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

/** IC-003 / 120 IC-011: the stored shape hashes the prompt and preserves the model placeholder. */
function argvShape(recipe: any, prompt: string, edit = false, binding?: ModelBinding | null): string[] {
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const shapeBinding: ModelBinding | null | undefined = boundModel(binding) === null
    ? binding : { model: MODEL_ELEMENT, flag: 'supported' };
  return assemble(recipe, `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt, 'utf8')}>`, edit, '<last-message-file>', shapeBinding);
}

/** IC-012 / data-model §1: the launch fields a run record stores. Names only, never a value. */
function launchRecord(recipe: any, identity: WorkerIdentity, prompt: string, edit = false, binding?: ModelBinding | null) {
  return {
    identity: { run: identity.run, lineage: identity.lineage, attempt: identity.attempt, runSource: identity.runSource },
    recipe: {
      binary: recipe.cli.binary,
      argvShape: argvShape(recipe, prompt, edit, binding),
      promptVia: promptVia(recipe),
      parser: recipe.structuredOutput.parser,
      profile: recipe.profile ?? null,
    },
    envSet: [...ENV_SET],
    envInherited: true,
  };
}

/** 165 IC-006: `mainSession.argv` with the model part spliced in and the placeholders replaced whole.
 * `model` null is the harness default (no model part). */
function mainArgv(recipe: any, element: string, lastMessageFile?: string, model: string | null = null): string[] {
  const entry = recipe?.mainSession;
  if (!entry || entry.status !== 'supported' || !Array.isArray(entry.argv)) {
    throw new LaunchUsageError('recipe-incomplete', "mainArgv: worker 'mainSession' is not supported with an argv");
  }
  if ((entry.promptVia === 'argv') !== entry.argv.includes(PROMPT_ELEMENT)) {
    throw new LaunchUsageError('recipe-incomplete', `mainArgv: promptVia '${entry.promptVia}' and the argv's '{prompt}' element disagree`);
  }
  let modelPart: string[] = [];
  if (model !== null) {
    if (typeof model !== 'string' || model === '') throw new LaunchUsageError('model-invalid', 'mainArgv: a model must be a non-empty string');
    if (recipe.model?.status !== 'supported' || !Array.isArray(recipe.model.argv)) {
      throw new LaunchUsageError('recipe-incomplete', "mainArgv: worker 'model' is not supported with an argv");
    }
    modelPart = recipe.model.argv.map((value: string) => (value === MODEL_ELEMENT ? model : value));
  }
  const at = entry.argv.findIndex((value: string) => MAIN_TAIL.has(value));
  const spliced = at === -1 ? [...entry.argv, ...modelPart] : [...entry.argv.slice(0, at), ...modelPart, ...entry.argv.slice(at)];
  refuseWidening(recipe, spliced, true);
  return spliced.map((value: string) => {
    if (value === LAST_MESSAGE_FILE_ELEMENT) {
      if (lastMessageFile === undefined) throw new LaunchUsageError('last-message-file-missing', "mainArgv: the recipe needs a '{lastMessageFile}' output path");
      return lastMessageFile;
    }
    return value === PROMPT_ELEMENT ? element : value;
  });
}

/** 165 IC-003: the stored main-session argv, the prompt hashed, the output path and the model as placeholders. */
function mainArgvShape(recipe: any, prompt: string, model: string | null = null): string[] {
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  return mainArgv(recipe, `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt, 'utf8')}>`, '<last-message-file>', model === null ? null : MODEL_ELEMENT);
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
function mainLaunchRecord(recipe: any, prompt: string, model: string | null) {
  return {
    recipe: {
      binary: recipe.cli.binary,
      argvShape: mainArgvShape(recipe, prompt, model),
      promptVia: recipe.mainSession.promptVia === 'argv' ? 'argv' : 'stdin',
      parser: recipe.mainSession.parser ?? null,
      profile: 'main-session',
    },
    envSet: [STARTED_RUN_VAR],
    envInherited: true,
  };
}

/** Spawns `file` detached; with `viaStdin` the text is written to stdin and ended. Resolves `{ child, ...extra }` once spawned. */
function spawnHarness(file: string, args: string[], options: any, viaStdin: boolean, text: string, extra: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    // Kept attached: a reject after the resolve is a no-op, and an early error never goes unhandled.
    child.on('error', reject);
    child.once('spawn', () => {
      if (viaStdin) {
        // A process that exits before reading closes the pipe; its exit is what the supervisor records.
        child.stdin.on('error', () => {});
        child.stdin.end(text);
      }
      resolve({ child, ...extra });
    });
  });
}

/** 165 D1, D9: launches a started main session from its recipe in `execWorktree`. No context emission, no grant. */
function launchMainSession({ recipe, prompt, execWorktree, env, runId, model = null, lastMessageFile }: {
  recipe: any; prompt: string; execWorktree: string; env: Env; runId: string; model?: string | null; lastMessageFile?: string;
}): Promise<any> {
  return Promise.resolve().then(() => {
    const sessionEnv = mainEnv(env, runId);
    const argv = mainArgv(recipe, prompt, lastMessageFile, model);
    const parser = recipe.mainSession.parser;
    if (parser !== null && parser !== undefined) {
      const { PARSERS } = require('./parsers.ts');
      if (!Object.hasOwn(PARSERS, parser)) throw new LaunchUsageError('parser-unknown', `launchMainSession: parser '${parser}' is not in core PARSERS`);
    }
    const viaStdin = recipe.mainSession.promptVia !== 'argv';
    return spawnHarness(recipe.cli?.binary, argv, { cwd: execWorktree, env: sessionEnv, shell: false }, viaStdin, prompt, { env: sessionEnv, launched: null });
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
    const viaStdin = promptVia(recipe) === 'stdin';
    if (recipe?.structuredOutput?.parser) {
      const { PARSERS } = require('./parsers.ts');
      if (!Object.hasOwn(PARSERS, recipe.structuredOutput.parser)) {
        throw new LaunchUsageError('parser-unknown', `launchWorker: parser '${recipe.structuredOutput.parser}' is not in core PARSERS`);
      }
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
    spawnHarness(file, spawnArgs, spawnOptions, viaStdin, text, { env: workerEnv, launched }).then(resolve, reject);
  });
}

module.exports = {
  ENV_SET, PROMPT_LIMITS, RECIPE_ORDER, EDIT_RECIPE_ORDER, STARTED_RUN_VAR, LaunchUsageError, argvShape, assembleArgv,
  launchEnv, launchRecord, launchWorker, mainArgv, mainArgvShape, mainEnv, mainLaunchRecord, launchMainSession,
};
