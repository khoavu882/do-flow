'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `doflow review --action start` (095b IC-001). The verb checks the verify precondition on HEAD and
 * resolves the review protocol (119 IC-003/IC-005, `resolve-protocol.ts`) in one call. It never
 * prompts, reads no stdin and writes no file and no telemetry line.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { verifyRecordReasons, loadPolicy } = require('../roadmap/gates.ts');
const { finishRuntime, captureCaught } = require('../cli-result.ts');
const { invalidProjectCandidate, invalidPresetCandidate } = require('./findings.ts');
const { resolveProtocol, protocolLines, protocolDigest, pathScope, gateMinSeats } = require('./resolve-protocol.ts');

type Env = Record<string, string | undefined>;

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

// The settings keys `resolveProtocol` reads (119 IC-006), by their resolution's value and origin layer.
const PROTOCOL_SETTINGS = ['review.preset', 'review.rounds', 'review.sameFamily', 'review.crossFamilyRereview',
  'review.extraLenses', 'review.blockerClauses', 'debate.preset'];

/**
 * 119 FR-008: the two inputs `resolveProtocol` turns into `enforcement`: `agentAccess` (the access of every agent
 * the registry seats) and `readOnlyLimits` (each harness's `agentLimits.readOnly`, registry order). The access comes
 * from core/registry/workflows.json `agents.access` (G63 holds it equal to the spec frontmatter), never from
 * core/shared/agent-specs: an installed runtime ships core/registry only. An agent whose access cannot be read is
 * `unknown`, never `write` and never a refusal: the seat binding stands and its enforcement rows say unknown. A
 * harness registry that cannot be read, or that lacks a value, is an error for the caller to refuse with.
 */
function loadEnforcementInputs(registry: any, { harnessesFile = path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), workflowsFile = path.join(REPO_ROOT, 'core', 'registry', 'workflows.json') }: { harnessesFile?: string; workflowsFile?: string } = {}):
  { agentAccess: Record<string, string>; readOnlyLimits: { harness: string; status: string; reason: string | null }[] } | { error: string; message: string } {
  const fail = (message: string) => ({ error: 'protocols-invalid', message });
  let declared: any = null;
  try { declared = JSON.parse(fs.readFileSync(workflowsFile, 'utf8'))?.agents?.access; } catch { declared = null; }
  const agentAccess: Record<string, string> = {};
  for (const preset of Object.values<any>(registry?.presets ?? {})) {
    for (const seat of preset?.seats ?? []) {
      const access = declared && Object.hasOwn(declared, seat.agent) ? declared[seat.agent] : undefined;
      agentAccess[seat.agent] = access === 'read-only' || access === 'write' ? access : 'unknown';
    }
  }
  let harnesses: any;
  try { harnesses = JSON.parse(fs.readFileSync(harnessesFile, 'utf8')).harnesses; } catch {
    return fail(`the harnesses registry (core/registry/harnesses.json) cannot be read`);
  }
  if (!Array.isArray(harnesses) || harnesses.length === 0) return fail('the harnesses registry lists no harness');
  const readOnlyLimits: { harness: string; status: string; reason: string | null }[] = [];
  for (const harness of harnesses) {
    const limit = harness?.agentLimits?.readOnly;
    if (typeof harness?.id !== 'string' || (limit?.status !== 'native' && limit?.status !== 'unenforced')) {
      return fail(`harness '${harness?.id}' has no agentLimits.readOnly.status of native or unenforced`);
    }
    readOnlyLimits.push({ harness: harness.id, status: limit.status, reason: typeof limit.reason === 'string' ? limit.reason : null });
  }
  return { agentAccess, readOnlyLimits };
}

/**
 * The inputs `resolveProtocol` needs beyond the change facts: the project's settings as the plain `settingsView`
 * the resolver reads (`{ key: { value, layer } }`, 119 L-B8), the gate policy (the shipped gates.json narrowed by the
 * project's `.doflow/gates.override.json`, read as roadmap gate-b reads it, 119 IC-005; null when there is no task class, so
 * no floor), the protocols registry and the enforcement inputs (`loadEnforcementInputs`). A base, override or registry the loaders reject is a refusal carrying the loader's
 * reason (and the override file). Shared with the `protocol` verb.
 */
function loadProtocolInputs(taskClass: string | null, cwd: string, env: Record<string, string | undefined> = process.env):
  { gatePolicy: any; registry: any; settingsView: Record<string, { value: unknown; layer: string }>; agentAccess: Record<string, string>; readOnlyLimits: any[] } | { error: string; message: string } {
  const settingsView: Record<string, { value: unknown; layer: string }> = {};
  try {
    const settings = require('../settings/resolve.ts').loadSettings({ projectRoot: path.resolve(cwd), env });
    for (const key of PROTOCOL_SETTINGS) {
      const resolution = settings.get(key);
      // C-6: an invalid project or local review.* candidate would silently fall back to the default: refuse instead.
      // A preset key refuses an invalid user candidate too.
      const invalid = key.endsWith('.preset') ? invalidPresetCandidate(resolution)
        : key.startsWith('review.') ? invalidProjectCandidate(resolution) : undefined;
      if (invalid) return { error: 'settings-unavailable', message: `${key} in ${invalid.source}: ${invalid.reason}` };
      settingsView[key] = { value: resolution.value, layer: resolution.origin.layer };
    }
  } catch (error: any) {
    return { error: 'settings-unavailable', message: error?.message || String(error) };
  }
  let gatePolicy: any = null;
  if (taskClass) {
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
    gatePolicy = loaded.policy;
  }
  const protocols = require('./protocols.ts').loadProtocols();
  if (!protocols.ok) return { error: 'protocols-invalid', message: protocols.errors.join('; ') };
  const enforcement = loadEnforcementInputs(protocols.registry);
  if ('error' in enforcement) return enforcement;
  return { gatePolicy, registry: protocols.registry, settingsView, ...enforcement };
}

/** The decision model's opinion on the decided depth. Never throws: any failure is `unavailable`. */
async function askAdvice({ decision, risk, taskClass, slug, files, cwd, env, adviceClient }: any): Promise<{ status: string; pick: string | null; reason?: string | null }> {
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
    const { resolveShadowConfig } = require('../advice/shadow-config.ts');
    const shadow = resolveShadowConfig('review-depth', { projectRoot: path.resolve(cwd), env, roots });
    if (!shadow.kindSet) {
      // advice.kinds.review-depth unset: ask the client directly, as before the dispatcher. A chosen rollout profile
      // caps it: off asks nothing, and shadow asks nothing too, since a write-free verb could not record the answer.
      const { profileAdvisorCap, unsetKindPath } = require('../advice/mode.ts');
      const route = unsetKindPath(profileAdvisorCap({ projectRoot: path.resolve(cwd), env }));
      if (route === 'off') return { status: 'off', pick: null };
      if (route === 'shadow') return { status: 'shadow', pick: null, reason: null };
      const result = await client.ask({
        questionSet: { state, questions: [built.question] },
        kind: 'review-depth', staticAnswer: decision.depth, caller: 'review', taskId: slug, record: false,
      });
      const pick = result?.answers?.[0]?.pick;
      if (result?.status === 'answered' && (pick === 'single' || pick === 'deep')) return { status: 'answered', pick };
      return { status: result?.status === 'off' ? 'off' : 'unavailable', pick: null };
    }
    const { interceptDecisionPoint } = require('../advice/shadow-dispatcher.ts');
    const intercepted = await interceptDecisionPoint({
      kind: 'review-depth', caller: 'review', state, staticPick: decision.depth,
      questionSet: { state, questions: [built.question] }, adviceRegistry: loaded.registry,
      taskId: slug, projectRoot: path.resolve(cwd), env, record: false,
    }, { adviceClient: client, roots, shadowConfig: shadow });
    // Only act applies a pick, and it is the decision after the raise-only rule.
    const pick = intercepted.effectiveDecision;
    if (intercepted.mode === 'act' && intercepted.advisorPick && (pick === 'single' || pick === 'deep')) return { status: 'answered', pick };
    if (intercepted.mode === 'shadow') return { status: 'shadow', pick: null, reason: intercepted.warning || null };
    return { status: intercepted.mode === 'off' ? 'off' : 'unavailable', pick: null };
  } catch {
    return { status: 'unavailable', pick: null };
  }
}

function renderText(result: any, nextCommand: string | null): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    if (key === 'protocol') lines.push(...protocolLines(value));
    else if (key === 'authors') {
      const formatted = Array.isArray(value) && value.length
        ? value.map((a: any) => `${a.kind}:${a.harness}/${a.model}(${a.channel})`).join(' ')
        : 'none';
      lines.push(`authors: ${formatted}`);
    } else if (key === 'forbidden') {
      const formatted = Array.isArray(value) && value.length
        ? value.map((p: any) => `(${p[0]}, ${p[1]})`).join(', ')
        : 'none';
      lines.push(`forbidden: ${formatted}`);
    } else if (Array.isArray(value)) lines.push(`${key}: ${value.length ? value.join(',') : 'none'}`);
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
async function handleReviewStart({ slug, base, preset, json = false, cwd, env, resolve, adviceClient, out }: any): Promise<number> {
  try {
    const { WorkflowEngine } = require('../workflow-engine.ts');
    const { loadVerificationRegistry, reviewDepthPolicy } = require('../verification/registry.ts');
    const { verificationRunRecordFile, verificationRunsRoot } = require('../verification/engine.ts');
    const { resolveExplicitBaseline, resolveIntegrationBase } = require('../verification/scope-bound.ts');

    const registry = loadVerificationRegistry({ repoRoot: REPO_ROOT });
    const riskPolicy = reviewDepthPolicy(registry);
    const defaultRisk: string = registry.policy.defaultRiskLevel;

    const result: any = {
      schema: 1, slug: null, taskClass: null, applicable: false, notApplicable: null, head: null, clean: null,
      ok: true, reasons: [], depth: null, seats: null, risk: defaultRisk, riskSource: 'default', protocol: null, protocolDigest: null, depthBasis: null,
      advice: { status: 'off', pick: null },
      authors: [], forbidden: [],
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

    let primary: any = null;
    if (result.applicable) {
      const { resolvePrimary } = require('../context/primary.ts');
      try {
        primary = resolvePrimary({ projectRoot: cwd ? path.resolve(cwd) : process.cwd(), env });
        if (primary?.state === 'refused') {
          const msg = primary.warnings?.length ? primary.warnings.join('; ') : (primary.reason || 'primary is contradicted');
          return refuse('primary-refused', msg);
        }
      } catch {}
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
    const inputs = loadProtocolInputs(taskClass, cwd, env);
    if ('error' in inputs) return refuse(inputs.error, inputs.message);

    if (result.applicable) {
      const { authoringIdentities } = require('./identity.ts');
      const authors = authoringIdentities({
        slug: resolvedSlug ?? undefined,
        cwd,
        env,
        primary,
      });
      result.authors = authors;

      const inv8 = inputs.registry?.invariants?.find((inv: any) => inv.id === 'INV-8');
      const authorKinds: string[] = Array.isArray(inv8?.authorKinds) ? inv8.authorKinds : ['subagent', 'sequential'];
      const forbidden: [string, string][] = [];
      const seenForbidden = new Set<string>();
      for (const a of authors) {
        if (!authorKinds.includes(a.kind)) continue;
        if (!a.harness || !a.model || a.model === 'unknown') continue;
        const key = `${a.harness}:${a.model}`;
        if (!seenForbidden.has(key)) {
          seenForbidden.add(key);
          forbidden.push([a.harness, a.model]);
        }
      }
      result.forbidden = forbidden;
    }
    const scope = pathScope(riskPolicy, paths);
    const floor = gateMinSeats(inputs.gatePolicy, taskClass);
    const facts = { kind: 'review', taskClass, risk: result.risk, paths, runPreset: preset ?? null, ...inputs, riskPolicy };
    const REFUSALS: Record<string, string> = {
      'preset-unknown': `--preset '${preset}' is not a review preset`,
      'preset-looser': `--preset '${preset}' is looser than the protocol this change needs; a run preset can only raise it`,
      'registry-incomplete': 'the protocols registry has no review preset for the decided depth',
    };
    const refuseResolution = (reason: string): number => refuse(reason, REFUSALS[reason] ?? reason);
    // Once without advice for the depth the advice question is asked about, then with the pick.
    const decided = resolveProtocol({ ...facts, advicePick: null });
    if (!decided.ok) return refuseResolution(decided.reason);
    const advice = await askAdvice({ decision: { depth: decided.protocol.depth, scope }, risk: result.risk, taskClass, slug: resolvedSlug, files: paths ? paths.length : null, cwd, env, adviceClient });
    const resolved = resolveProtocol({ ...facts, advicePick: advice.pick });
    if (!resolved.ok) return refuseResolution(resolved.reason);
    const { protocol } = resolved;
    const raisedBy = ({ floor: 'gate-floor', advice: 'advice', run: 'run', user: 'setting', project: 'setting', local: 'setting', env: 'setting' } as Record<string, string>)[protocol.origins.id]
      ?? (protocol.depth === 'single' ? null : 'policy');
    result.depth = protocol.depth;
    result.seats = protocol.seats.length;
    result.protocol = protocol;
    result.protocolDigest = protocolDigest(protocol);
    result.depthBasis = { scope, files: paths ? paths.length : null, base: paths ? baseSha : null, floor, raisedBy };
    result.advice = advice;
    emit(out, json, result, null);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'review', 1);
    console.error(`[ERROR] review start: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { reviewPrecondition, handleReviewStart, loadProtocolInputs, loadEnforcementInputs, validSlug };
