'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `doflow review --action start` (095b IC-001) and the pure depth rule `decideDepth` (IC-002).
 * The verb checks the verify precondition on HEAD and decides the review depth in one call. It never
 * prompts, reads no stdin and writes no file and no telemetry line.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { verifyRecordReasons, loadPolicy } = require('../roadmap/gates.ts');
const { finishRuntime, captureCaught } = require('../cli-result.ts');

type Env = Record<string, string | undefined>;
type Decision = { depth: string; seats: number; scope: string; raisedBy: string | null };

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const HEX_HEAD = /^[0-9a-f]{40}$/;
// Inherited location variables would point the checks at another repository.
const GIT_LOCATION_KEYS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function validSlug(value: unknown): boolean {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/** Whether `policy.lightPaths` covers `file`: a `/`-ending entry covers its subtree, any other entry that exact path. */
function lightCovers(lightPaths: string[], file: string): boolean {
  const normal = String(file).replace(/^(\.\/)+/, '');
  return lightPaths.some((entry) => (entry.endsWith('/') ? normal.startsWith(entry) : normal === entry));
}

/**
 * IC-002: the pure depth rule. `paths` is the changed repository-relative paths, or null when
 * unreadable; an empty list is also an unknown scope (the base resolved to HEAD). A rename is two entries, so it counts both paths. `floor` is the gate-b minimum seat count.
 */
function decideDepth({ policy, risk, paths, floor }: any): Decision {
  // An empty list is an unknown scope, not "only light paths": the verb does not know what the review covers.
  const scope = !Array.isArray(paths) || paths.length === 0 ? 'unknown'
    : paths.every((file: string) => lightCovers(policy.lightPaths, file)) ? 'light' : 'code';
  const single = scope === 'light' && typeof risk === 'string' && policy.singleRisks.includes(risk);
  let depth = single ? 'single' : 'deep';
  let raisedBy: string | null = single ? null : 'policy';
  let seats: number = policy.depths[depth].seats;
  const needed = Number.isInteger(floor) && floor > 0 ? floor : 0;
  if (needed > seats) {
    const bySeats = Object.keys(policy.depths).sort((a, b) => policy.depths[a].seats - policy.depths[b].seats);
    depth = bySeats.find((id) => policy.depths[id].seats >= needed) ?? bySeats[bySeats.length - 1];
    seats = needed;
    raisedBy = 'gate-floor';
  }
  return { depth, seats, scope, raisedBy };
}

/** IC-001 step 6: advice only raises. A `deep` pick over a decided `single` gives `deep`; anything else changes nothing. */
function raiseByAdvice({ policy, decision, pick, floor }: any): Decision {
  if (pick !== 'deep' || decision.depth !== 'single') return decision;
  const needed = Number.isInteger(floor) && floor > 0 ? floor : 0;
  return { depth: 'deep', seats: Math.max(policy.depths.deep.seats, needed), scope: decision.scope, raisedBy: 'advice' };
}

/** IC-001 step 4: gate-b's verify rule plus the clean-tree rule, sorted and unique. */
function reviewPrecondition({ records, head, clean, slug }: any): string[] {
  const reasons = new Set<string>(verifyRecordReasons(records, head, slug));
  if (!clean) reasons.add('tree-dirty');
  return [...reasons].sort();
}

/** The risk of the last clean line for `slug` on `head` when it is a known level, else the default. */
function riskOfRecords({ records, head, slug, levels, defaultRisk }: any): { risk: string; riskSource: string } {
  const matching = records.filter((run: any) => run && typeof run === 'object' && run.head === head
    && run.taskId === slug && run.clean === true);
  const risk = matching.length ? matching[matching.length - 1].risk : undefined;
  return typeof risk === 'string' && Object.hasOwn(levels, risk)
    ? { risk, riskSource: 'record' }
    : { risk: defaultRisk, riskSource: 'default' };
}

/** IC-001 step 3, from workflows data only: a review stage directly after a required verification stage. */
function reviewApplies(classes: any, taskClass: string): boolean {
  const stages = classes?.[taskClass]?.stages;
  if (!Array.isArray(stages)) return false;
  const at = stages.findIndex((stage: any) => stage.kind === 'review');
  const before = at > 0 ? stages[at - 1] : null;
  return Boolean(before) && before.kind === 'verification' && before.optional === false;
}

function gitRun(cwd: string, env: Env, args: string[]): { status: number | null; stdout: string } {
  const gitEnv = { ...env };
  for (const key of GIT_LOCATION_KEYS) delete gitEnv[key];
  const res = spawnSync('git', ['-C', cwd, ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
  return { status: res.status, stdout: typeof res.stdout === 'string' ? res.stdout : '' };
}

/** HEAD and the clean flag. A tree git cannot report on is not clean. */
function readHeadState(cwd: string, env: Env): { head: string | null; clean: boolean } {
  const rev = gitRun(cwd, env, ['rev-parse', '--verify', 'HEAD']);
  const head = rev.status === 0 && HEX_HEAD.test(rev.stdout.trim()) ? rev.stdout.trim() : null;
  const status = gitRun(cwd, env, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
  return { head, clean: status.status === 0 && status.stdout.length === 0 };
}

/** The changed paths from the base to the working tree (HEAD on a clean tree); a rename lists both paths. Null when unreadable. */
function changedPaths(cwd: string, env: Env, baseSha: string | null): string[] | null {
  if (!baseSha) return null;
  const diff = gitRun(cwd, env, ['diff', '--no-renames', '--name-only', '-z', baseSha]);
  return diff.status === 0 ? diff.stdout.split('\0').filter(Boolean) : null;
}

/** The largest verify record file the verb reads; a bigger one is `records-unreadable`. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * A runtime-owned file's text through a bounded, non-blocking read (the pattern of
 * task-scope.ts `readRegularFileText`): `lstat`, then `O_NOFOLLOW|O_NONBLOCK`, `fstat` on the
 * descriptor and a size cap. `missing` for ENOENT; any non-regular target (link, FIFO, device, folder)
 * or oversized file is an error, never a blocking read.
 */
function readBounded(file: string, maxBytes: number): { text: string } | { missing: true } | { error: string } {
  const flags = fs.constants;
  let fd: number | undefined;
  try {
    let st = fs.lstatSync(file);
    if (!st.isFile()) return { error: 'not a regular file' };
    fd = fs.openSync(file, flags.O_RDONLY | (flags.O_NOFOLLOW || 0) | (flags.O_NONBLOCK || 0));
    st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: 'not a regular file' };
    if (st.size > maxBytes) return { error: `larger than ${maxBytes} bytes` };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let n = -1; n !== 0 && length <= maxBytes; length += n) n = fs.readSync(fd, buffer, length, buffer.length - length, null);
    return length > maxBytes ? { error: `larger than ${maxBytes} bytes` } : { text: buffer.subarray(0, length).toString('utf8') };
  } catch (error: any) {
    return error?.code === 'ENOENT' ? { missing: true } : { error: error?.message || String(error) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the read is done */ } }
  }
}

function parseRecordLines(file: string): { records: any[] } | { error: string } {
  const read = readBounded(file, MAX_RECORD_BYTES);
  if ('error' in read) return { error: read.error };
  const records: any[] = [];
  for (const [index, line] of ('text' in read ? read.text : '').split('\n').entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (error: any) { return { error: `line ${index + 1}: ${error.message}` }; }
  }
  return { records };
}

type RunLookup = { status: 'none' } | { status: 'found'; taskId: string; taskClass: string }
  | { status: 'ambiguous' | 'unreadable'; message: string };

/**
 * The slug's orchestration run in either record layout (flat `<id>.json` whose run names the slug or
 * whose id is the slug, or `<slug>/<id>.json`), through the runtime's own listing so every read is
 * bounded. `none` only when no layout holds one; every uncertain case is `ambiguous` or `unreadable`.
 * The run's own `taskId` keys its verify records; a run that names none falls back to the slug.
 */
function lookupRun(stateRoot: string, slug: string): RunLookup {
  const { orchestrationRuns, selectRunEntries } = require('../implementation-gate.ts');
  const store = path.join(stateRoot, '.doflow', 'state', 'orchestration');
  // The runtime's listing treats a folder it cannot read as empty, which would read as no run. ENOENT is
  // the one error that means absent; any other error on the store or on `<slug>/` is unreadable.
  const listDir = (dir: string): { entries: any[] } | { error: string } => {
    try { return { entries: fs.readdirSync(dir, { withFileTypes: true }) }; } catch (error: any) {
      return error?.code === 'ENOENT' ? { entries: [] } : { error: `${dir} cannot be listed (${error?.code || error?.message || String(error)})` };
    }
  };
  const flat = listDir(store);
  if ('error' in flat) return { status: 'unreadable', message: flat.error };
  const nested = listDir(path.join(store, slug));
  if ('error' in nested) return { status: 'unreadable', message: nested.error };
  // A FIFO or device at a run path is not listed by the runtime (it lists regular files and links), so it
  // would read as absent; a non-regular `.json` entry in the flat layer or in `<slug>/` could be this
  // slug's run and cannot be attributed, so it is unreadable.
  const odd = (dir: string, entries: any[]): string | null => {
    const entry = entries.find((e: any) => e.name.endsWith('.json') && !e.isFile() && !e.isSymbolicLink() && !e.isDirectory());
    return entry ? path.join(dir, entry.name) : null;
  };
  const strange = odd(store, flat.entries) ?? odd(path.join(store, slug), nested.entries);
  if (strange) return { status: 'unreadable', message: `${strange} is not a regular file` };
  const listed = orchestrationRuns({ stateRoot });
  if (!listed.ok) return { status: 'unreadable', message: `the run records could not be listed (${listed.error})` };
  const mine = selectRunEntries(listed.entries).filter((entry: any) => {
    const namespaced = path.relative(path.join(entry.root, '.doflow', 'state', 'orchestration'), entry.file).split(path.sep).length > 1;
    // `slug` names the feature like `featureSlug` does (the runtime's flatRecordIsOurs honours both).
    const named = typeof entry.record?.featureSlug === 'string' && entry.record.featureSlug !== '' ? null : entry.record?.slug;
    return entry.slug === slug || (typeof named === 'string' && named === slug)
      || (!namespaced && path.basename(entry.file, '.json') === slug);
  });
  if (mine.length === 0) {
    // No entry names this slug. A flat run of this store that could not be read (io/unparseable, or a
    // link) cannot be attributed to any slug, so it could be this one's: fail closed and name the file.
    const blind = selectRunEntries(listed.entries).find((entry: any) => entry.error && entry.origin === 'current'
      && path.dirname(entry.file) === store);
    if (blind) return { status: 'unreadable', message: `${blind.file} is ${blind.error === 'io' ? 'not a readable regular file' : 'not valid JSON'} and cannot be ruled out as the run of ${slug}` };
    return { status: 'none' };
  }
  if (mine.length > 1) return { status: 'ambiguous', message: `more than one run belongs to ${slug}: ${mine.map((e: any) => e.file).join(', ')}` };
  const [entry] = mine;
  if (entry.error) return { status: 'unreadable', message: `${entry.file} is ${entry.error === 'io' ? 'not a readable regular file' : 'not valid JSON'}` };
  const { taskClass, taskId } = entry.record ?? {};
  if (typeof taskClass !== 'string' || !taskClass) return { status: 'unreadable', message: `${entry.file} names no taskClass` };
  if (taskId !== undefined && !validSlug(taskId)) return { status: 'unreadable', message: `${entry.file} has a task id that is not a plain name` };
  return { status: 'found', taskId: taskId ?? slug, taskClass };
}

/**
 * The gate-b seat floor of a class: the shipped gates.json narrowed by the project's
 * `.doflow/gates.override.json`, read as roadmap gate-b reads it (IC-005). 0 when the class has none; a base or
 * override the loader rejects is a refusal carrying the loader's reason and the override file.
 */
function gateFloor(taskClass: string | null, cwd: string): { floor: number } | { error: string; message: string } {
  if (!taskClass) return { floor: 0 };
  const { projectLayerSource } = require('../settings/project-layers.ts');
  const layers = projectLayerSource(cwd, fs);
  const overrideFile: string | null = layers.layersFrom ? path.join(layers.layersFrom, 'gates.override.json') : null;
  let override: string | null = null;
  if (overrideFile) {
    try { override = fs.readFileSync(overrideFile, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') override = ''; }
  }
  const loaded = loadPolicy(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'gates.json'), 'utf8'), override);
  if (!loaded.ok) {
    return { error: String(loaded.reason).split(':')[0], message: `${loaded.reason} (core/registry/gates.json narrowed by ${overrideFile ?? 'no project override'})` };
  }
  const floor = loaded.policy.classes?.[taskClass]?.['gate-b']?.minSeats;
  return { floor: Number.isInteger(floor) && floor > 0 ? floor : 0 };
}

/** The decision model's opinion on the decided depth. Never throws: any failure is `unavailable`. */
async function askAdvice({ decision, risk, taskClass, slug, files, cwd, env, adviceClient }: any): Promise<{ status: string; pick: string | null }> {
  try {
    const { loadAdviceRegistry } = require('../advice/registry.ts');
    const { loadStorageRegistry } = require('../storage/registry.ts');
    const { resolveRoots } = require('../storage/roots.ts');
    const { resolveSetting } = require('../advice/config.ts');
    const { materializeKind } = require('../advice/kinds.ts');
    const { createAdviceClient } = require('../advice/client.ts');
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    if (!loaded.ok) return { status: 'unavailable', pick: null };
    const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: path.resolve(cwd), env });
    if (resolveSetting({ adviceRegistry: loaded.registry, roots, env }).state !== 'on') return { status: 'off', pick: null };
    const built = materializeKind('review-depth', { adviceRegistry: loaded.registry });
    if (!built.ok) return { status: 'unavailable', pick: null };
    const client = adviceClient || createAdviceClient({ adviceRegistry: loaded.registry, roots });
    const state = [`task class: ${taskClass ?? 'none'}`, `risk: ${risk}`, `scope: ${decision.scope}`,
      `changed files: ${files ?? 'unknown'}`, `decided depth: ${decision.depth}`].join('\n');
    // record: false keeps the verb write-free (IC-001); the pick is not stored.
    const result = await client.ask({
      questionSet: { state, questions: [built.question] },
      kind: 'review-depth', staticAnswer: decision.depth, caller: 'review', taskId: slug, record: false,
    });
    const pick = result?.answers?.[0]?.pick;
    if (result?.status === 'answered' && (pick === 'single' || pick === 'deep')) return { status: 'answered', pick };
    return { status: result?.status === 'off' ? 'off' : 'unavailable', pick: null };
  } catch {
    return { status: 'unavailable', pick: null };
  }
}

function renderText(result: any, nextCommand: string | null): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) lines.push(`${key}: ${value.length ? value.join(',') : 'none'}`);
    else if (typeof value === 'object') {
      lines.push(`${key}: ${Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } else lines.push(`${key}: ${value}`);
  }
  if (nextCommand) lines.push(nextCommand);
  return lines;
}

function emit(out: (line: string) => void, json: boolean, result: any, nextCommand: string | null): void {
  if (json) out(JSON.stringify(result));
  else for (const line of renderText(result, nextCommand)) out(line);
}

/**
 * IC-001. Exit 0 applicable and ok, or not applicable; 1 refused or records-unreadable.
 * Usage errors (2) are decided by the caller before this runs.
 */
async function handleReviewStart({ slug, base, json = false, cwd, env, resolve, adviceClient, out }: any): Promise<number> {
  try {
    const { WorkflowEngine } = require('../workflow-engine.ts');
    const { loadVerificationRegistry, reviewDepthPolicy } = require('../verification/registry.ts');
    const { verificationRunRecordFile, verificationRunsRoot } = require('../verification/engine.ts');
    const { resolveExplicitBaseline, resolveIntegrationBase } = require('../verification/scope-bound.ts');

    const registry = loadVerificationRegistry({ repoRoot: REPO_ROOT });
    const policy = reviewDepthPolicy(registry);
    const defaultRisk: string = registry.policy.defaultRiskLevel;

    const result: any = {
      schema: 1, slug: null, taskClass: null, applicable: false, notApplicable: null, head: null, clean: null,
      ok: true, reasons: [], depth: null, seats: null, risk: defaultRisk, riskSource: 'default', depthBasis: null,
      advice: { status: 'off', pick: null },
    };
    // An uncertain applicability is a refusal with a named reason, never a silent not-applicable.
    const refuse = (error: string, message: string): number => {
      // applicable is null on every error refusal.
      out(json ? JSON.stringify({ ...result, applicable: null, ok: false, error, message }) : `review start: ${error}: ${message}`);
      return finishRuntime(1);
    };

    let resolvedSlug: string | null = typeof slug === 'string' ? slug : null;
    if (resolvedSlug === null) {
      let feature: any;
      try { feature = resolve({ projectRoot: cwd, slug: null }); } catch (error: any) {
        return refuse('feature-unresolved', `the active feature could not be resolved: ${error?.message || String(error)}`);
      }
      // Only a resolver that names no active feature (or returns nothing) is a known absence; any other
      // resolver error, or a slug that is not a plain name, is an uncertain applicability.
      if (feature && typeof feature === 'object') {
        if (feature.error && feature.error !== 'no-active-feature') {
          return refuse('feature-unresolved', `${String(feature.error)}: ${feature.message ?? 'the active feature could not be resolved'}`);
        }
        if (!feature.error) {
          const candidate = feature.paths?.feature_slug;
          if (!validSlug(candidate)) return refuse('feature-unresolved', `invalid-slug: the resolved feature slug ${JSON.stringify(candidate ?? null)} is not a plain feature name`);
          resolvedSlug = candidate;
        }
      }
    }
    result.slug = resolvedSlug;

    let taskClass: string | null = null;
    let verifyId: string | null = null;
    if (resolvedSlug === null) result.notApplicable = 'no-feature';
    else {
      const run = lookupRun(verificationRunsRoot(cwd), resolvedSlug);
      if (run.status === 'ambiguous') return refuse('run-ambiguous', run.message);
      if (run.status === 'unreadable') return refuse('run-unreadable', run.message);
      if (run.status === 'found') {
        taskClass = run.taskClass;
        verifyId = run.taskId;
        result.taskClass = taskClass;
        const classes = new WorkflowEngine({ repoRoot: REPO_ROOT }).classes;
        if (!Object.hasOwn(classes ?? {}, taskClass)) return refuse('class-unknown', `task class '${taskClass}' is not in the workflows data`);
        if (!reviewApplies(classes, taskClass)) result.notApplicable = 'class-exempt';
      } else result.notApplicable = 'no-run';
    }
    result.applicable = result.notApplicable === null;

    let nextCommand: string | null = null;
    if (result.applicable) {
      const state = readHeadState(cwd, env);
      result.head = state.head;
      result.clean = state.clean;
      const parsed = parseRecordLines(verificationRunRecordFile(verificationRunsRoot(cwd), verifyId as string));
      if ('error' in parsed) return refuse('records-unreadable', parsed.error);
      result.reasons = reviewPrecondition({ records: parsed.records, head: state.head, clean: state.clean, slug: verifyId });
      if (result.reasons.length) {
        result.ok = false;
        nextCommand = `doflow verify --action report --task-id ${verifyId}${typeof base === 'string' ? ` --baseline-ref ${base}` : ''}`;
        emit(out, json, result, nextCommand);
        return finishRuntime(1);
      }
      Object.assign(result, riskOfRecords({ records: parsed.records, head: state.head, slug: verifyId, levels: registry.riskLevels, defaultRisk }));
    }

    let baseSha: string | null = null;
    if (typeof base === 'string') {
      const explicit = resolveExplicitBaseline({ cwd, ref: base });
      baseSha = explicit.ok ? explicit.sha : null;
    } else {
      const integration = resolveIntegrationBase({ cwd });
      baseSha = typeof integration.mergeBase === 'string' && integration.mergeBase ? integration.mergeBase : null;
    }
    const paths = changedPaths(cwd, env, baseSha);
    const gate = gateFloor(taskClass, cwd);
    if ('error' in gate) return refuse(gate.error, gate.message);
    const { floor } = gate;
    let decision = decideDepth({ policy, risk: result.risk, paths, floor });
    const advice = await askAdvice({ decision, risk: result.risk, taskClass, slug: resolvedSlug, files: paths ? paths.length : null, cwd, env, adviceClient });
    decision = raiseByAdvice({ policy, decision, pick: advice.pick, floor });
    result.depth = decision.depth;
    result.seats = decision.seats;
    result.depthBasis = { scope: decision.scope, files: paths ? paths.length : null, base: paths ? baseSha : null, floor, raisedBy: decision.raisedBy };
    result.advice = advice;
    emit(out, json, result, null);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'review', 1);
    console.error(`[ERROR] review start: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { decideDepth, raiseByAdvice, reviewPrecondition, handleReviewStart, validSlug };
