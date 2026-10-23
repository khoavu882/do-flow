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
 * unreadable. A rename is two entries, so it counts both paths. `floor` is the gate-b minimum seat count.
 */
function decideDepth({ policy, risk, paths, floor }: any): Decision {
  const scope = !Array.isArray(paths) ? 'unknown'
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

function parseRecordLines(file: string): { records: any[] } | { error: string } {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') return { error: error?.message || String(error) };
  }
  const records: any[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (error: any) { return { error: `line ${index + 1}: ${error.message}` }; }
  }
  return { records };
}

/** The task class of the slug's orchestration run through the runtime's run locator, or null when there is none. */
function runTaskClass(cwd: string, slug: string): string | null {
  const { findRunFile } = require('../implementation-gate.ts');
  const found = findRunFile({ stateRoot: cwd, taskId: slug, slug });
  if (found.status !== 'found') return null;
  try {
    const run = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    return typeof run?.taskClass === 'string' && run.taskClass ? run.taskClass : null;
  } catch {
    return null;
  }
}

/** The gate-b seat floor of a class from the shipped gates.json, through its loader; 0 when the class has none. */
function gateFloor(taskClass: string | null): number {
  if (!taskClass) return 0;
  const loaded = loadPolicy(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'gates.json'), 'utf8'));
  if (!loaded.ok) throw new Error(`core/registry/gates.json: ${loaded.reason}`);
  const floor = loaded.policy.classes?.[taskClass]?.['gate-b']?.minSeats;
  return Number.isInteger(floor) && floor > 0 ? floor : 0;
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

    let resolvedSlug: string | null = typeof slug === 'string' ? slug : null;
    if (resolvedSlug === null) {
      let feature: any;
      try { feature = resolve({ projectRoot: cwd, slug: null }); } catch { feature = null; }
      const candidate = feature && !feature.error ? feature.paths?.feature_slug : null;
      resolvedSlug = validSlug(candidate) ? candidate : null;
    }

    const result: any = {
      schema: 1, slug: resolvedSlug, taskClass: null, applicable: false, notApplicable: null, head: null, clean: null,
      ok: true, reasons: [], depth: null, seats: null, risk: defaultRisk, riskSource: 'default', depthBasis: null,
      advice: { status: 'off', pick: null },
    };
    let taskClass: string | null = null;
    if (resolvedSlug === null) result.notApplicable = 'no-feature';
    else {
      taskClass = runTaskClass(verificationRunsRoot(cwd), resolvedSlug);
      result.taskClass = taskClass;
      if (taskClass === null) result.notApplicable = 'no-run';
      else if (!reviewApplies(new WorkflowEngine({ repoRoot: REPO_ROOT }).classes, taskClass)) result.notApplicable = 'class-exempt';
    }
    result.applicable = result.notApplicable === null;

    let nextCommand: string | null = null;
    if (result.applicable) {
      const state = readHeadState(cwd, env);
      result.head = state.head;
      result.clean = state.clean;
      const parsed = parseRecordLines(verificationRunRecordFile(verificationRunsRoot(cwd), resolvedSlug));
      if ('error' in parsed) {
        const failure = { ...result, ok: false, error: 'records-unreadable', message: parsed.error };
        out(json ? JSON.stringify(failure) : `review start: records-unreadable: ${parsed.error}`);
        return finishRuntime(1);
      }
      result.reasons = reviewPrecondition({ records: parsed.records, head: state.head, clean: state.clean, slug: resolvedSlug });
      if (result.reasons.length) {
        result.ok = false;
        nextCommand = `doflow verify --action report --task-id ${resolvedSlug}${typeof base === 'string' ? ` --baseline-ref ${base}` : ''}`;
        emit(out, json, result, nextCommand);
        return finishRuntime(1);
      }
      Object.assign(result, riskOfRecords({ records: parsed.records, head: state.head, slug: resolvedSlug, levels: registry.riskLevels, defaultRisk }));
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
    const floor = gateFloor(taskClass);
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
