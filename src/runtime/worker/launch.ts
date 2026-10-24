'use strict';

// Feature 081 B.3 (IC-003, IC-012; DEC-030, DEC-037, DEC-045): the real launcher.
//
// `launchEnv` names the worker in the caller's environment: the caller's variables are inherited
// unchanged (DEC-045), except for the five identity variables, DOFLOW_WORKER_RUN and the optional
// project-only DOFLOW_GUARD_DROP_DATABASES launch snapshot (112). The run segment of
// the claim's run key is the worker's run, or, when that segment is the default `local`, the run
// id without its `w-` prefix (DEC-037), so the worker always resolves to a launched identity and
// its 078 unit `L.<run>.<lineage>.<token>` is unique to this run. A child run (082 IC-015) is
// always run-scoped, so its unit differs from its granter's.
//
// `assembleArgv` builds the IC-003 argv: `readOnly`, `spawnDenial`, `structuredOutput` and
// `oneShot` argv in that order (082 IC-014: an edit run puts `isolatedEdit` first in place of
// `readOnly`), the `{prompt}` element replaced whole. `{lastMessageFile}` is also replaced whole
// with its output path. Substitution never interpolates inside a longer string. `argvShape` is the
// same argv with the prompt written `<prompt sha256:<hex> bytes:<n>>` and the path written
// `<last-message-file>`, the only forms a run record stores.
//
// `launchWorker` runs IC-012 steps 1 to 5: the environment, the optional 078 grant, the launch
// emission in process, the emission text before the brief, then `spawn` with no shell. It returns a
// promise that resolves once the process has spawned and rejects on any throw or a spawn `error`
// (for example ENOENT); the supervisor ends such a run `not-started`. No variable's value is stored,
// and the emission text is never returned for storage.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { emitContext, utf8Bytes } = require('../context/arbitrate.ts');
const { grantSummary } = require('../context/summary-store.ts');
const { loadSettings } = require('../settings/resolve.ts');

type Env = Record<string, string | undefined>;

/** IC-012: the names a launch may set, in the order the run record lists them. The first five are the
 * identity contract; `DOFLOW_WORKER_RUN` (110) carries the worker run id `w-<12 hex>` and nothing else,
 * so the worker's telemetry can name its own run. The seventh variable (112) is an optional
 * snapshot of project-only database names. Neither is part of the stored identity. */
const WORKER_RUN_VAR = 'DOFLOW_WORKER_RUN';
const DROP_DATABASES_VAR = 'DOFLOW_GUARD_DROP_DATABASES';
const ENV_SET = Object.freeze(['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', WORKER_RUN_VAR, DROP_DATABASES_VAR]);
const PROMPT_ELEMENT = '{prompt}';
const LAST_MESSAGE_FILE_ELEMENT = '{lastMessageFile}';
/** IC-003 prompt limits in bytes. argv is one under Linux MAX_ARG_STRLEN, which counts the NUL (DEC-062). */
const PROMPT_LIMITS = Object.freeze({ argv: 131071, stdin: 1048576 });
const DEFAULT_RUN = 'local';
const RUN_ID = /^w-[0-9a-f]{12}$/;
/** IC-003 order of the run recipe's argv. */
const RECIPE_ORDER = Object.freeze(['readOnly', 'spawnDenial', 'structuredOutput', 'oneShot']);
/** 082 IC-014: the order of an edit run's recipe argv. */
const EDIT_RECIPE_ORDER = Object.freeze(['isolatedEdit', 'spawnDenial', 'structuredOutput', 'oneShot']);

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

/** 112: read the owning project's layers at launch, never the worker checkout, caller snapshot or
 * the launcher's process environment. Every fault omits the exemption. A fresh env copy bypasses
 * settings memoisation so an earlier launch cannot pin stale authorisation. */
function dropDatabases(execWorktree: string, env: Env): string | null {
  try {
    if (!path.isAbsolute(execWorktree)) return null;
    const canonical = fs.realpathSync(execWorktree);
    if (!fs.statSync(canonical).isDirectory()) return null;
    const dispatch = /^(.*)\/\.doflow\/state\/dispatch-worktrees\/d-[0-9a-f]{12}$/.exec(canonical);
    if (!dispatch || dispatch[0] !== canonical) return null;
    const projectRoot = dispatch[1] || path.parse(canonical).root;
    const resolved = loadSettings({ projectRoot, env: { ...env } }).get('guard.workerDropDatabases', 'project');
    // 086's linked-checkout fallback is not authority for this exemption. An invalid project file
    // also voids the snapshot, even if a different layer could have supplied a usable value.
    if (resolved.origin.checkout !== 'own' || !['project', 'local'].includes(resolved.origin.layer)
      || resolved.candidates.some((c: any) => ['project', 'local'].includes(c.layer) && c.status === 'invalid')) return null;
    const value = resolved.value;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024
      || /^[a-z][a-z0-9_]{0,62}( [a-z][a-z0-9_]{0,62})*$/.exec(value)?.[0] !== value || value.split(' ').length > 32) return null;
    return value;
  } catch { return null; }
}

/** The five identity variables, optional worker run id and project-only guard snapshot. Both
 * launch-only values replace (or remove) caller values; the caller's environment is never mutated. */
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
  delete out[DROP_DATABASES_VAR];
  // 120 IC-003: the primary declaration names the person's main session, never a worker.
  delete out.DOFLOW_PRIMARY_HARNESS;
  delete out.DOFLOW_PRIMARY_MODEL;
  const databases = dropDatabases(execWorktree, env);
  if (databases !== null) out[DROP_DATABASES_VAR] = databases;
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

/** The recipe argv with the `{prompt}` element replaced whole by `element`; a longer string is kept as written. */
function assemble(recipe: any, element: string, edit = false, lastMessageFile?: string): string[] {
  const argv: string[] = [];
  for (const key of edit ? EDIT_RECIPE_ORDER : RECIPE_ORDER) {
    const entry = recipe?.[key];
    if (!entry || entry.status !== 'supported' || !Array.isArray(entry.argv)) {
      throw new LaunchUsageError('recipe-incomplete', `assembleArgv: worker '${key}' is not supported with an argv`);
    }
    argv.push(...entry.argv);
  }
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

/** IC-003: the worker argv for `prompt`; a prompt over its mode's limit is `prompt-too-large`.
 * `edit` selects the edit recipe order (082 IC-014). */
function assembleArgv(recipe: any, prompt: string, edit = false, lastMessageFile?: string): string[] {
  const mode = promptVia(recipe);
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > PROMPT_LIMITS[mode]) {
    throw new LaunchUsageError('prompt-too-large', `assembleArgv: the prompt is ${bytes} bytes; ${mode} mode allows ${PROMPT_LIMITS[mode]}`);
  }
  return assemble(recipe, prompt, edit, lastMessageFile);
}

/** IC-003: the argv a record stores, the prompt element written `<prompt sha256:<hex> bytes:<n>>`. */
function argvShape(recipe: any, prompt: string, edit = false): string[] {
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  return assemble(recipe, `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt, 'utf8')}>`, edit, '<last-message-file>');
}

/** IC-012 / data-model §1: the launch fields a run record stores. Names only, never a value. */
function launchRecord(recipe: any, identity: WorkerIdentity, prompt: string, edit = false) {
  return {
    identity: { run: identity.run, lineage: identity.lineage, attempt: identity.attempt, runSource: identity.runSource },
    recipe: {
      binary: recipe.cli.binary,
      argvShape: argvShape(recipe, prompt, edit),
      promptVia: promptVia(recipe),
      parser: recipe.structuredOutput.parser,
      profile: recipe.profile ?? null,
    },
    envSet: [...ENV_SET],
    envInherited: true,
  };
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
}

/** IC-012 steps 1 to 5. Resolves `{ child, env, launched: { reason, bytes } }` once the process has spawned. */
function launchWorker({ recipe, prompt, identity, execWorktree, env, taskId, grant, edit = false, lastMessageFile, runId }: LaunchOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerEnv = withIdentity(env, identity, execWorktree, runId);
    if (grant) grantSummary({ ...grant, toRun: identity.run, toLineage: identity.lineage, env });
    const emitted = emitContext({ event: 'launch', cwd: execWorktree, env: workerEnv, ...(taskId ? { taskId } : {}) });
    const reason: string = emitted.decision.reason;
    // DEC-052: any returned text is delivered, a refused emission's included (it carries the pack and the pointer).
    const delivered = typeof emitted.text === 'string' ? emitted.text : null;
    const text = delivered !== null ? `${delivered}\n\n${prompt}` : prompt;
    const launched = { reason, bytes: delivered !== null ? utf8Bytes(delivered) : 0 };
    const argv = assembleArgv(recipe, text, edit, lastMessageFile);
    const viaStdin = promptVia(recipe) === 'stdin';
    const child = spawn(recipe.cli.binary, argv, {
      cwd: execWorktree,
      env: workerEnv,
      detached: true,
      shell: false,
      stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    // Kept attached: a reject after the resolve is a no-op, and an early error never goes unhandled.
    child.on('error', reject);
    child.once('spawn', () => {
      if (viaStdin) {
        // A worker that exits before reading closes the pipe; its exit is what the supervisor records.
        child.stdin.on('error', () => {});
        child.stdin.end(text);
      }
      resolve({ child, env: workerEnv, launched });
    });
  });
}

module.exports = { ENV_SET, PROMPT_LIMITS, RECIPE_ORDER, EDIT_RECIPE_ORDER, LaunchUsageError, argvShape, assembleArgv, launchEnv, launchRecord, launchWorker };
