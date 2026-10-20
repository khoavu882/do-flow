'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// WorkflowOrchestrator — deterministic execution over the workflow registry. The registry
// declares WHAT a class's
// stages are (workflow-engine resolves that); this module owns the state machine that walks it:
// one linear program per task, human gates as first-class pause points, readiness as a scripted
// cascade gate before any source-mutating stage completes, and every transition journaled to
// neutral state so runs survive process death. The orchestrator never asks a model what runs next;
// callers assert stage completion, exactly like they assert evidence.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkflowEngine } = require('./workflow-engine.ts');
const { updateTaskState, readTaskState } = require('./task-state.ts');
const { recordIn, isSafeSlug } = require('./task-scope.ts');
const { ResearchRequestStore } = require('./research-request.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { resolveActiveFeature } = require('./feature-resolve.ts');
const { compactDecisions, addDecisions } = require('./decision-register.ts');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { resolveConsultations } = require('./mcp-consultations.ts');
const { mcpReach } = require('./mcp-reach.ts');
const { loadRegistry } = require('../registry/index.ts');
const { loadStorageRegistry } = require('./storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('./storage/roots.ts');
const { checkCompletion: checkTaskAttemptCompletion, storeFile: taskAttemptStoreFile } = require('./task-attempts.ts');
const { runKeyFor, refuseSolo } = require('./task-run.ts');
const { projectRoot: lifecycleProjectRoot } = require('./lifecycle/root.ts');
const { appendOutcome, findPick, readWindow } = require('./advice/record.ts');
const {
  checkReadiness, harnessHookNote, featureSlugFor, runSlugOf, findRunFile, orchestrationRuns,
} = require('./implementation-gate.ts');

/** Appended to the note of an implementation stage completed with no task-attempt ledger (FR-006). */
const NO_LEDGER_NOTE = 'No task-attempt ledger exists for this feature, so its tasks were not verified; outcome recorded as unverified.';

const RUN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);

/**
 * Every write to `run.state` passes through here, so RUN_STATES is the closed set it is declared to
 * be rather than a comment that happens to list four strings.
 *
 * It was the latter: the set was frozen and exported while all six state writes were bare literals,
 * so `'COMPLETE'` for `'COMPLETED'` would have produced a run in a state no branch tests for — and
 * every one of those branches reads `!== 'RUNNING'` or `=== 'COMPLETED'`, so the run would simply
 * stop responding to stage completions with no error naming the cause. Throwing is right here
 * precisely because the value is always a literal in this file: a failure can only be a typo
 * introduced while editing, which is a defect to surface at once, never data to tolerate.
 *
 * @param {string} state
 * @returns {string} the same state, once it is known to be one
 */
function runState(state: any) {
  if (!RUN_STATES.includes(state)) {
    throw new Error(`Unknown run state '${state}' (expected one of: ${RUN_STATES.join(', ')})`);
  }
  return state;
}

/** The stable status shape shared by the status action and the read-only list action. */
function snapshotRun(run: any) {
  const current = run.cursor < run.program.length ? run.program[run.cursor] : null;
  const done = run.program.filter((n: any) => n.status === 'completed' || n.status === 'skipped' || n.status === 'approved').length;
  return {
    taskId: run.taskId,
    taskClass: run.taskClass,
    workflowName: run.workflowName,
    state: run.state,
    current: current ? { type: current.type, id: current.id, kind: current.kind ?? null, mutatesSource: current.mutatesSource ?? null, readinessTemplate: current.readinessTemplate ?? null } : null,
    awaitingGate: run.state === 'AWAITING_GATE' && current ? { gateId: current.id, name: current.name, prompt: current.prompt } : null,
    progress: { done, total: run.program.length },
    terminalStage: run.terminalStage,
    revision: Number.isInteger(run.revision) ? run.revision : 0,
  };
}

const GATE_DECISIONS = Object.freeze(['approve', 'reject']);
/** IC-005: the register stage a policy approval of each gate is recorded under. */
const POLICY_GATE_STAGE: Record<string, string> = Object.freeze({ 'gate-0': 'discovery', 'gate-a': 'planning', 'gate-b': 'review' });
/** What a completed stage established, separate from the fact it was walked past (review A1). */
const STAGE_OUTCOMES = new Set(['passed', 'failed', 'unverified']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Why a handoff with no run and no class records nothing, as the result and the CLI line say. */
const STANDALONE_REASON = 'no run exists for this task and no --task-class was given, so nothing was recorded and no readiness was required';

function assertSafeId(value: any, label: any) {
  if (!ID_PATTERN.test(String(value ?? ''))) throw new Error(`Invalid ${label}: '${value}'`);
  return String(value);
}

function iso(now: any) { return (now ?? new Date()).toISOString(); }

/** Interleave stages with their gates: each gate sits immediately after the stage named by its
 * `afterStage`. A gate anchored to an unknown stage is a compile error here, not a silent orphan. */
function compileProgram(workflow: any) {
  const gates = [...(workflow.gates || [])];
  const nodes = [];
  for (const stage of workflow.stages || []) {
    nodes.push({
      type: 'stage', id: stage.id, skill: stage.skill, kind: stage.kind,
      mutatesSource: Boolean(stage.mutatesSource),
      readinessTemplate: stage.readinessTemplate ?? null,
      optional: Boolean(stage.optional),
      status: 'pending',
    });
    for (let i = gates.length - 1; i >= 0; i -= 1) {
      const gate = gates[i];
      if (gate.afterStage !== stage.id) continue;
      nodes.push({
        type: 'gate', id: gate.id, name: gate.name ?? gate.id,
        kind: gate.kind ?? 'approval', trigger: gate.trigger ?? null,
        prompt: gate.prompt ?? null, status: 'pending',
      });
      gates.splice(i, 1);
    }
  }
  if (gates.length) throw new Error(`Unanchored gate(s) in workflow '${workflow.taskClass}': ${gates.map((g) => g.id).join(', ')}`);
  return nodes;
}

class WorkflowOrchestrator {
  declare fsImpl: any;
  declare repoRoot: any;
  declare projectRoot: any;
  declare engine: any;
  declare stateDir: any;
  declare readinessEvaluate: any;
  declare taskAttemptCheck: any;
  declare featureSlug: any;
  declare buildAdapters: any;
  declare env: any;
  declare cwd: any;
  declare sourceRoot: string;
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot] install root owning core/registry + default state dir.
   * @param {string} [options.stateDir] where run journals live.
   * @param {WorkflowEngine} [options.engine] pre-built engine (injected workflows in tests).
   * @param {(node: object, run: object) => string|{verdict: string, message?: string}|null} [options.readinessEvaluate]
   *   cascade gate: returns a readiness verdict, as a string or with the refusal message; anything
   *   but READY blocks completion of a source-mutating gated stage.
   *   Unwired means such stages cannot be completed — fail closed, never open.
   * @param {(node: object, run: object) => {state: 'none'|'complete'|'incomplete', slug?: string|null, incomplete?: Array<string>}|null} [options.taskAttemptCheck]
   *   FR-006 gate for the do-execute-plan implementation stage: reports whether the feature's
   *   task-attempt ledger exists and is complete. `incomplete` refuses completion naming the tasks;
   *   `none` (no ledger) records the stage as `unverified` whatever outcome was supplied. Unwired
   *   means the stage is not checked, which only a unit test that builds the orchestrator by hand
   *   relies on: the CLI always wires the real one.
   * @param {object} [options.fsImpl]
   * @param {string|null} [options.featureSlug] the feature a run started here belongs to
   * @param {object} [options.env] the environment `start` reads the caller's identity and the telemetry switch from
   * @param {string} [options.cwd] the directory `start` resolves the caller's run key and the 080 store from
   * @param {() => object} [options.buildAdapters] builds the adapter registry `mcpReach` reads installs
   *   through; without it install facts are unknown and no outcome is inferred from them
   */
  constructor({ repoRoot = REPO_ROOT, projectRoot, sourceRoot, stateDir, engine, readinessEvaluate, taskAttemptCheck, fsImpl, featureSlug = null, buildAdapters = null, env = process.env, cwd = process.cwd() }: any = {}) {
    this.fsImpl = fsImpl || fs;
    this.repoRoot = repoRoot;
    this.projectRoot = projectRoot || (stateDir?.endsWith(path.join('.doflow', 'state', 'orchestration'))
      ? path.resolve(stateDir, '../../..') : repoRoot);
    this.sourceRoot = sourceRoot || this.projectRoot;
    this.engine = engine || new WorkflowEngine({ repoRoot });
    this.stateDir = stateDir || path.join(this.projectRoot, '.doflow', 'state', 'orchestration');
    this.readinessEvaluate = readinessEvaluate || null;
    this.taskAttemptCheck = taskAttemptCheck || null;
    this.featureSlug = featureSlug;
    this.buildAdapters = buildAdapters;
    this.env = env;
    this.cwd = cwd;
  }

  /** The task's run (115 C-1): `<stateDir>/<featureSlug>/<taskId>.json` for a task id other than its
   * feature's slug, else `<stateDir>/<taskId>.json`; a flat run of a namespaced id is read, and copied
   * into the namespace on its next write, only when it is this feature's or names none (D-3). */
  runRecord(taskId: any) {
    const id = assertSafeId(taskId, 'taskId');
    const namespace = isSafeSlug(this.featureSlug) && this.featureSlug !== id ? this.featureSlug : null;
    return recordIn({ base: this.stateDir, namespace, name: `${id}.json`, fsImpl: this.fsImpl });
  }

  runFile(taskId: any) {
    return this.runRecord(taskId).file;
  }

  readRun(taskId: any) {
    const file = this.runRecord(taskId).read;
    if (!this.fsImpl.existsSync(file)) return null;
    return readTaskState(this.fsImpl, file);
  }

  writeRun(run: any, now: any, beforeWrite?: any) {
    run.updatedAt = iso(now);
    const { file, seed } = this.runRecord(run.taskId);
    this.fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const expectedRevision = run.revision || 0;
    updateTaskState({ file, fsImpl: this.fsImpl, prepare: seed, build: (disk: any) => {
      if ((disk?.revision || 0) !== expectedRevision) {
        throw new Error(`Concurrent workflow update for '${run.taskId}'; reload the run before retrying. Nothing was written.`);
      }
      if (beforeWrite) beforeWrite();
      return run;
    } });
    run.revision = expectedRevision + 1;
    return run;
  }

  /** Begin a new run. An existing run for the same task id is refused — resume instead. */
  start({ taskId, taskClass, now }: any = {}) {
    assertSafeId(taskId, 'taskId');
    if (this.readRun(taskId)) throw new Error(`Workflow run '${taskId}' already exists; resume it instead of restarting`);
    const workflow = this.engine.resolveWorkflow(taskClass); // unknown classes are rejected loudly
    const program = compileProgram(workflow);
    const run = {
      version: 1,
      taskId,
      taskClass,
      workflowName: workflow.name ?? taskClass,
      terminalStage: workflow.terminalStage ?? null,
      state: runState('RUNNING'),
      cursor: 0,
      program,
      history: [{ at: iso(now), action: 'start', detail: `task-class=${taskClass}` }],
      startedAt: iso(now),
      // The feature the run belongs to, so another checkout can tell it from a run with the same id.
      ...(this.featureSlug ? { featureSlug: this.featureSlug } : {}),
      ...this.traceFields(),
    };
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /**
   * 088 IC-010 / DD-5: the caller's 080 run key and, when the 080 store already holds that run with
   * a trace id, a copy of the id. Empty with telemetry off, for a solo lineage, or on any fault:
   * nothing here can fail or change a start. No id is minted here and no action is added.
   */
  traceFields(): { runKey?: string; traceId?: string } {
    try {
      const key = runKeyFor(this.env, this.cwd);
      if (!key.traceIds || refuseSolo(key.identity)) return {};
      const out: { runKey?: string; traceId?: string } = { runKey: key.runKey };
      if (this.featureSlug) {
        try {
          const store = readTaskState(this.fsImpl, taskAttemptStoreFile(lifecycleProjectRoot(this.cwd), this.featureSlug));
          const record = store && store.runs && Object.hasOwn(store.runs, key.runKey) ? store.runs[key.runKey] : null;
          if (record && typeof record.traceId === 'string' && /^[0-9a-f]{32}$/.test(record.traceId)) out.traceId = record.traceId;
        } catch { /* an unreadable 080 store means no copy */ }
      }
      return out;
    } catch { return {}; }
  }

  snapshot(run: any) {
    return snapshotRun(run);
  }

  status(taskId: any) {
    const run = this.requireRun(taskId);
    return this.snapshot(run);
  }

  /** Record completed work by skill identity. Gate decisions remain a separate action.
   * With no existing run and no explicit class this is a standalone no-op, not a new workflow.
   *
   * The MCP servers the stage names get one outcome each (062, IC-008): resolved here, stored on the
   * entry this handoff writes, and returned as `consultations` and `mcpWarnings`. Only a handoff
   * that completes a stage or annotates one stores a record; a standalone one reports and stores
   * nothing, a deferred one does neither. Nothing in that path can fail or refuse the handoff. */
  handoff({ taskId, taskClass, callingSkill, note, outcome, mcpOutcomes, now }: any = {}) {
    assertSafeId(taskId, 'taskId');
    assertSafeId(callingSkill, 'callingSkill');
    if (!note || !String(note).trim()) throw new Error('handoff requires a note describing the work recorded');
    if (outcome !== undefined && !STAGE_OUTCOMES.has(outcome)) throw new Error(`Unknown stage outcome '${outcome}'`);
    const existing = this.readRun(taskId);
    if (!existing && !taskClass) {
      const mcp = this.resolveMcp({ taskId, stageId: null, skill: callingSkill, flags: mcpOutcomes });
      return {
        taskId, disposition: 'standalone', state: null, awaitingGate: null, reason: STANDALONE_REASON,
        consultations: null, mcpWarnings: mcp ? mcp.messages : [],
      };
    }
    if (existing && taskClass && taskClass !== existing.taskClass) throw new Error(`Task class '${taskClass}' does not match run '${existing.taskClass}'`);
    const resolvedClass = existing?.taskClass || taskClass;
    const stages = existing ? existing.program.filter((n: any) => n.type === 'stage')
      : this.engine.resolveWorkflow(resolvedClass).stages;
    const candidates = stages.filter((n: any) => n.skill === callingSkill).map((n: any) => n.id);
    if (!candidates.length) throw new Error(`Skill '${callingSkill}' owns no stage in '${resolvedClass}'`);
    // The stage this handoff would complete is known before anything is written, so a gated stage
    // without readiness is refused before catch-up starts a run or backfills a stage.
    const preview = this.previewHandoff({ taskId, taskClass: resolvedClass, candidateStageIds: candidates });
    if (preview.reason === 'reached-candidate' && preview.node.mutatesSource && preview.node.readinessTemplate) {
      this.assertReady(preview.node, existing || { taskId, taskClass: resolvedClass });
    }
    // The ledger is checked here too, before catch-up writes anything, so a refused implementation
    // handoff leaves no backfilled stage behind.
    if (preview.reason === 'reached-candidate') this.assertTaskAttempts(preview.node, existing || { taskId, taskClass: resolvedClass });
    const positioned = this.catchUp({ taskId, taskClass: resolvedClass, candidateStageIds: candidates, note, now });
    if (positioned.reason === 'reached-candidate') {
      // A run this handoff started has no earlier stage: every evidence item counts.
      const since = existing ? this.stageSince(taskId, positioned.caughtUpTo) : null;
      const mcp = this.resolveMcp({ taskId, stageId: positioned.caughtUpTo, skill: callingSkill, flags: mcpOutcomes, since });
      const consultations = mcp ? this.storeToolsUsed(mcp) : null;
      const snapshot: any = this.completeStage({ taskId, stageId: positioned.caughtUpTo, note, outcome, consultations, now });
      return { ...snapshot, disposition: 'completed', recordedStage: positioned.caughtUpTo, consultations, mcpWarnings: mcp ? mcp.messages : [] };
    }
    if (positioned.reason.startsWith('already-completed:')) {
      // A rerun after all occurrences is an annotation on the latest occurrence, never a replay.
      const recordedStage = candidates[candidates.length - 1];
      const mcp = this.resolveMcp({ taskId, stageId: recordedStage, skill: callingSkill, flags: mcpOutcomes, since: this.stageSince(taskId, recordedStage) });
      const consultations = mcp ? this.storeToolsUsed(mcp) : null;
      return {
        ...this.annotate({ taskId, node: recordedStage, note, consultations, now }), disposition: 'annotated', recordedStage,
        consultations, mcpWarnings: mcp ? mcp.messages : [],
      };
    }
    return { ...positioned, disposition: 'deferred', recordedStage: null, consultations: null, mcpWarnings: [] };
  }

  /**
   * Resolve one stage run's MCP outcomes from what is on disk. Reads only: the evidence ledger, the
   * research requests, the brief records under the feature's `exec/` folder, the reports they name,
   * and the install facts `mcpReach` reads. `since` bounds the evidence rule 3 counts (stageSince).
   * Any failure to read one of them means that source
   * contributes nothing, and a registry that cannot load means no record at all (NFR-003).
   * @returns {{record: object, messages: object[], evidenceToAdd: object[], ledger: EvidenceLedger}|null}
   */
  resolveMcp({ taskId, stageId, skill, flags, since = null }: any) {
    let registry;
    try { registry = loadRegistry({ repoRoot: this.repoRoot }); } catch { return null; }
    const ledger = new EvidenceLedger({ repoRoot: this.projectRoot, slug: this.featureSlug, fsImpl: this.fsImpl });
    const loaded = new Set();
    let reachMemo: any;
    const reachOf = () => {
      if (reachMemo === undefined) {
        try {
          reachMemo = this.buildAdapters
            ? mcpReach({ registry, projectRoot: this.projectRoot, fsImpl: this.fsImpl, adapters: this.buildAdapters() })
            : null;
        } catch { reachMemo = null; }
      }
      return reachMemo;
    };
    const displayName = (id: any) => {
      const harness = (registry.harnesses || []).find((item: any) => item.id === id);
      return harness ? harness.displayName || harness.id : id;
    };
    const { briefRecords, repoRoot } = stageId ? this.readBriefRecords(taskId) : { briefRecords: [], repoRoot: this.sourceRoot };
    // Advice picks are project state, kept with the run's records, not in the feature folder's checkout.
    if (stageId) this.recordBriefTierAdvice({ briefRecords, taskId, stageId, repoRoot: this.projectRoot });
    try {
      const result = resolveConsultations({
        taskId, stageId, skill, flags, registry, ledger: {
          queryEvidence: ({ taskId: id }: any) => {
            if (!loaded.has(id)) { loaded.add(id); ledger.load(id); }
            return ledger.queryEvidence({ taskId: id });
          },
        },
        requests: new ResearchRequestStore({ projectRoot: this.projectRoot, sourceRoot: this.sourceRoot, fsImpl: this.fsImpl, slug: this.featureSlug }),
        briefRecords,
        readReport: (file: any) => {
          const target = path.resolve(repoRoot, file);
          // A brief record is project data: a report path that leaves the project is not read.
          if (path.relative(repoRoot, target).startsWith('..') || path.isAbsolute(path.relative(repoRoot, target))) return null;
          try { return this.fsImpl.readFileSync(target, 'utf8'); } catch { return null; }
        },
        reach: {
          anyHarnessHas: (server: any) => { const reach = reachOf(); return reach ? reach.anyHarnessHas(server) : null; },
          harnessWith: (server: any) => {
            const row = reachOf()?.harnesses.find((item: any) => ['selected', 'configured'].includes(item.servers[server]));
            return row ? displayName(row.id) : null;
          },
        },
        harnessName: displayName,
        since,
        addCommand: (server: any) => {
          const reach = reachOf();
          const row = reach?.harnesses.find((item: any) => !['selected', 'configured'].includes(item.servers[server]));
          return row ? reach.addCommand(row.id, row.scope, server) : null;
        },
      });
      return { record: result.record, messages: [...result.warnings, ...result.notices], evidenceToAdd: result.evidenceToAdd, ledger };
    } catch { return null; }
  }

  /** When this stage run began, for counting its evidence (IC-008 rule 3): the `at` of the last
   * stage completed or skipped before it that was not backfilled, else the run start. A stage
   * already completed (an annotation) is measured from the completion before its own. */
  stageSince(taskId: any, stageId: any) {
    try {
      const run = this.readRun(taskId);
      const history = Array.isArray(run?.history) ? run.history : [];
      let end = history.length;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i]?.action === 'complete-stage' && history[i].node === stageId) { end = i; break; }
      }
      for (let i = end - 1; i >= 0; i -= 1) {
        const item = history[i];
        if ((item?.action === 'complete-stage' || item?.action === 'skip-stage') && !item.backfilled && item.node !== stageId) return item.at;
      }
      return run?.startedAt || history[0]?.at || null;
    } catch { return null; }
  }

  /** Record advice outcomes for the same brief records the IC-008 handoff pass consumes. This is
   * advisory telemetry only: every storage/read failure is ignored and never affects the handoff.
   */
  recordBriefTierAdvice({ briefRecords, taskId, stageId, repoRoot }: any) {
    try {
      const storage = loadStorageRegistry({ repoRoot: this.repoRoot });
      const roots = resolveRoots({ registry: storage, projectRoot: repoRoot || this.projectRoot });
      const declaredStores = new Map((storage.stores || []).map((store: any) => [store.id, store]));
      const safeRoots = { ...roots };
      for (const id of ['advice-picks-project', 'advice-picks-user']) {
        const store: any = declaredStores.get(id);
        if (!store) return;
        if (!resolveStorePath({ store, roots, fsImpl: this.fsImpl })) safeRoots[store.root] = null;
      }

      const existing = readWindow({ roots: safeRoots, fsImpl: this.fsImpl }).records
        .filter(({ record }: any) => record.type === 'outcome')
        .map(({ record }: any) => record.pickId);
      const seen = new Set(existing);
      for (const record of briefRecords) {
        const advice = record?.advice;
        const pickId = advice?.pickId;
        if (record?.runTaskId !== taskId || record?.stage !== stageId
          || advice?.kind !== 'tier' || advice?.status !== 'answered'
          || typeof pickId !== 'string' || !pickId || seen.has(pickId)) continue;
        const pick = findPick({ pickId, roots: safeRoots, fsImpl: this.fsImpl });
        if (!pick || pick.pick.kind !== 'tier' || !Array.isArray(pick.pick.options)
          || !pick.pick.options.includes(record.tier)) continue;
        seen.add(pickId);
        appendOutcome({
          roots: safeRoots, fsImpl: this.fsImpl, store: pick.store,
          pickId, actual: record.tier, source: 'brief-record',
        });
      }
    } catch { /* advice storage must never change a handoff */ }
  }

  /** The brief records (`*-brief.json`) of the feature this run belongs to, parsed; unreadable ones
   * are left out. They are feature-folder files, so they are resolved from the checkout the verb runs
   * in with the resolver's `feature_root` (that checkout's folder, else the main checkout's), never
   * from the state root (115 C-10). Resolving the feature spawns the resolver, so it is only done
   * where a feature folder exists above one of the two. */
  readBriefRecords(taskId: any) {
    const none = { briefRecords: [], repoRoot: this.sourceRoot };
    try {
      const hasFolder = [this.sourceRoot, this.projectRoot].some((root) => {
        for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
          if (this.fsImpl.existsSync(path.join(dir, 'agent-docs', 'doflow'))) return true;
          if (path.dirname(dir) === dir) return false;
        }
      });
      if (!hasFolder) return none;
      const feature = resolveActiveFeature({ projectRoot: this.sourceRoot, slug: taskId });
      if (feature.error) return none;
      const exec = path.join(feature.featureFolder, 'exec');
      const briefRecords = [];
      for (const name of this.fsImpl.readdirSync(exec).filter((entry: any) => entry.endsWith('-brief.json')).sort()) {
        try { briefRecords.push(JSON.parse(this.fsImpl.readFileSync(path.join(exec, name), 'utf8'))); } catch { /* an unreadable record contributes nothing */ }
      }
      return { briefRecords, repoRoot: feature.featureRoot };
    } catch { return none; }
  }

  /** Add the Tools used evidence items the resolver asked for, and stamp each `recorded` row with
   * its evidence id. Evidence goes in before the stage entry is written, so the entry carries the
   * ids; a retry after a refused completion finds the items and reports them `already-recorded`.
   * A ledger that cannot be written leaves the rows without an id and never stops the handoff. */
  storeToolsUsed({ record, evidenceToAdd, ledger }: any) {
    if (!evidenceToAdd.length) return record;
    try {
      const idsByTask = new Map();
      for (const item of evidenceToAdd) {
        if (!idsByTask.has(item.taskId)) ledger.load(item.taskId);
        idsByTask.set(item.taskId, [...(idsByTask.get(item.taskId) || []), ledger.addEvidence(item)]);
      }
      for (const taskId of idsByTask.keys()) ledger.save(taskId);
      for (const row of record.toolsUsed) {
        if (row.status === 'recorded') row.evidenceId = idsByTask.get(row.taskId)?.shift();
      }
    } catch { /* the rows stay as resolved */ }
    return record;
  }

  requireRun(taskId: any) {
    const run = this.readRun(taskId);
    if (!run) throw new Error(`No workflow run for task '${taskId}'`);
    return run;
  }

  currentNode(run: any) {
    return run.cursor < run.program.length ? run.program[run.cursor] : null;
  }

  expectOpenStage(run: any, stageId: any) {
    if (run.state !== 'RUNNING') throw new Error(`Run '${run.taskId}' is ${run.state}, not RUNNING`);
    const node = this.currentNode(run);
    if (!node || node.type !== 'stage') throw new Error(`Run '${run.taskId}' has no stage to complete next`);
    if (node.id !== stageId) throw new Error(`Expected stage '${node.id}' next, got '${stageId}'`);
    return node;
  }

  /** Complete the current stage. A source-mutating stage carrying a readiness template must pass
   * the injected evaluator with READY first — the cascade rule: cheap scripted verdicts gate
   * expensive work, and NEEDS_EVIDENCE / NEEDS_USER_DECISION / BLOCKED stop the run here.
   *
   * Execution status and outcome are separate facts on the node (review A1): `status: 'completed'`
   * only ever says the program walked past this stage. `executionStatus` says HOW — 'completed'
   * (the owning skill ran it) or 'imported' (catch-up backfilled it, nobody ran it here) — and
   * `outcome` says what the run established: 'passed', 'failed', or 'unverified'. A backfilled
   * stage is always imported+unverified, whatever the caller says: catch-up importing history
   * cannot import a verification. A 'failed' outcome still advances — recording the failure
   * honestly beats refusing to record it, and a bug reproduction legitimately completes by
   * observing the expected failure — but the record no longer reads as success. */
  completeStage({ taskId, stageId, note, outcome, backfilled = false, consultations, now }: any = {}) {
    const run = this.requireRun(taskId);
    const node = this.expectOpenStage(run, stageId);
    if (outcome !== undefined && !STAGE_OUTCOMES.has(outcome)) {
      throw new Error(`Unknown stage outcome '${outcome}'. Valid: ${[...STAGE_OUTCOMES].join(', ')} — omit the flag to record 'unverified'.`);
    }
    if (node.mutatesSource && node.readinessTemplate) this.assertReady(node, run);
    const attempts = backfilled ? null : this.assertTaskAttempts(node, run);
    // No ledger for the feature: the stage is recorded, but nothing verified its tasks, and the
    // record says so whatever outcome the caller supplied (FR-006).
    const unledgered = attempts?.state === 'none';
    node.status = 'completed';
    node.executionStatus = backfilled ? 'imported' : 'completed';
    node.outcome = backfilled || unledgered ? 'unverified' : (outcome ?? 'unverified');
    run.history.push({
      at: iso(now), action: 'complete-stage', node: node.id,
      note: unledgered ? [note, NO_LEDGER_NOTE].filter(Boolean).join(' ') : (note ?? null),
      backfilled: Boolean(backfilled), executionStatus: node.executionStatus, outcome: node.outcome,
      ...(consultations ? { consultations } : {}),
    });
    this.advance(run, now);
    this.writeRun(run, now, () => {
      if (run.taskClass !== 'feature') return;
      const request = new ResearchRequestStore({ projectRoot: this.projectRoot, sourceRoot: this.sourceRoot, fsImpl: this.fsImpl })
        .blockingGap(taskId, stageId);
      if (request) throw new Error(`Research request '${request.id}' blocks stage '${stageId}': ${request.failureReason || request.gap || request.status}`);
    });
    return this.snapshot(run);
  }

  /** Skip the current OPTIONAL stage without running it. Gates anchored directly to a skipped
   * stage cannot fire, so they are recorded as skipped too rather than blocking forever. */
  skipStage({ taskId, stageId, reason, backfilled = false, now }: any = {}) {
    const run = this.requireRun(taskId);
    const node = this.expectOpenStage(run, stageId);
    if (!node.optional) throw new Error(`Stage '${node.id}' is required and cannot be skipped`);
    node.status = 'skipped';
    run.history.push({ at: iso(now), action: 'skip-stage', node: node.id, note: reason ?? null, backfilled: Boolean(backfilled) });
    let lookahead = run.cursor + 1;
    while (lookahead < run.program.length) {
      const nextNode = run.program[lookahead];
      // A gate sits immediately after its anchor in the program, so any pending gate directly
      // following the skipped stage is anchored to it and can never fire.
      if (nextNode.type !== 'gate' || nextNode.status !== 'pending') break;
      nextNode.status = 'skipped';
      run.history.push({ at: iso(now), action: 'skip-gate', node: nextNode.id, note: 'anchor stage skipped', backfilled: Boolean(backfilled) });
      lookahead += 1;
    }
    this.advance(run, now);
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** Advance the run toward whichever of `candidateStageIds` the cursor reaches first, starting
   * the run if none exists yet. A skill knows its OWN stage, not where the cursor happens to be:
   * `start` always begins at the first stage, so any skill but the first one could never record
   * its handoff on a fresh run, and a skill occupying two stages of one class (do-test owns both
   * `reproduction` and `regression-verification` in `bug`) cannot tell which occurrence is live.
   * Catch-up resolves both by walking the cursor forward for the caller and stopping ON the node
   * the caller must act on — it never completes a candidate stage itself, since only the owning
   * skill knows whether its own work is actually done.
   *
   * A candidate already behind the cursor (`already-completed:<id>`) means this same skill already
   * recorded this handoff on an earlier invocation; walking forward from here would complete later
   * stages as a side effect of a skill re-run, which the caller does not own. Callers must use
   * `annotate` for that case instead.
   *
   * Every stage walked through on the way to a candidate is marked `backfilled: true` in the
   * journal, distinct from a stage the owning skill actually completed — a stage nobody ran must
   * never be indistinguishable, in `audit.md`, from one that was. It stops, advancing no further,
   * at: a candidate stage (the normal case), ANY gate (a human — or the gate's own owning skill —
   * decides it; catch-up decides nothing), a non-candidate stage carrying a readiness template
   * (that stage mutates source and only its owner may complete it), or a terminal run state. An
   * optional non-candidate stage is skipped rather than completed, matching what its own skill
   * would have done with it. */
  catchUp({ taskId, taskClass, candidateStageIds, note, now }: any = {}) {
    if (!Array.isArray(candidateStageIds) || candidateStageIds.length === 0) {
      throw new Error('catch-up requires at least one candidate stage id');
    }
    for (const id of candidateStageIds) assertSafeId(id, 'stageId');
    let run = this.readRun(taskId);
    if (run && typeof taskClass === 'string' && taskClass.trim() !== '' && taskClass !== run.taskClass) {
      throw new Error(`Run '${taskId}' was started as task class '${run.taskClass}', not '${taskClass}' — a caller must not walk a run under a class it did not start`);
    }
    // Candidates are validated before `start` ever runs, so a typo'd first catch-up for a fresh
    // task cannot persist a durable, unrecoverable orphan run pinned to whatever class the failed
    // call happened to carry (no CLI verb can undo it — `start` refuses on an existing run). The
    // SOURCE of truth for "known stage id" differs by whether a run already exists, and that split
    // matters: a run's own `program` is the side that goes STALE relative to the registry (compiled
    // once at `start`, so a later registry rename or removal leaves a stage id in the program the
    // registry no longer declares — exactly the drift this check exists to catch), while for a
    // fresh task there is no program yet to consult, so the registry is the only source available.
    // Validating a run that already exists against the registry instead of its own program was
    // tried and reverted — it stopped catching stale ids from a registry rename, silently backfilling
    // through them instead of refusing.
    let unknownCandidates;
    if (run) {
      const programStageIds = new Set(run.program.filter((n: any) => n.type === 'stage').map((n: any) => n.id));
      unknownCandidates = candidateStageIds.filter((id) => !programStageIds.has(id));
    } else {
      const workflow = this.engine.resolveWorkflow(taskClass); // unknown classes are rejected loudly, same as start()
      const workflowStageIds = new Set((workflow.stages || []).map((s: any) => s.id));
      unknownCandidates = candidateStageIds.filter((id) => !workflowStageIds.has(id));
    }
    if (unknownCandidates.length > 0) {
      const where = run ? `in run '${taskId}''s program` : `declared by task class '${taskClass}'`;
      throw new Error(`catch-up: candidate stage id(s) not ${where}: ${unknownCandidates.join(', ')} — check the workflow's own stage ids rather than walking the run forward on an unresolvable candidate`);
    }
    if (!run) {
      this.start({ taskId, taskClass, now });
      run = this.requireRun(taskId);
    }
    const candidates = new Set(candidateStageIds);
    // A REJECTED run answers with its own terminal state first — before the already-completed
    // pre-check below, which would otherwise misreport a REJECTED run whose named candidates
    // happen to already be complete (discovery finished, then gate-0 was rejected, say) as
    // `already-completed` instead of the more informative `run-rejected`. A COMPLETED run needs no
    // such override and must NOT be included here: every one of its stages reached a terminal
    // per-node status by definition (that is what COMPLETED means — settleCursor only sets it once
    // every node has been walked past as completed/skipped/approved), so any validated candidate is
    // always caught by the already-completed check below on its own. Special-casing COMPLETED here
    // too was tried and reverted — it pre-empted `already-completed:<id>` with a bare
    // `run-completed` for a re-invocation naming an already-recorded terminal stage, and six chain
    // skills branch on that exact distinction in opposite directions (annotate vs. stop-and-report),
    // so the trail silently stopped recording the re-run.
    if (run.state === 'REJECTED') {
      return { ...this.snapshot(run), caughtUpTo: null, reason: 'run-rejected' };
    }
    // ALL candidates already done means this caller's own handoff already happened — detect it
    // before the walk below can complete anything past it as a side effect. A caller with more than
    // one candidate (do-test owns two occurrences in `bug`/`refactor`) is not done until every
    // occurrence is: one completed and one still pending must still walk forward to the pending one.
    const candidateNodes = run.program.filter((n: any) => candidates.has(n.id));
    if (candidateNodes.length > 0 && candidateNodes.every((n: any) => n.status === 'completed' || n.status === 'approved' || n.status === 'skipped')) {
      return { ...this.snapshot(run), caughtUpTo: null, reason: `already-completed:${candidateNodes.map((n: any) => n.id).join(',')}` };
    }
    for (;;) {
      if (run.state === 'COMPLETED' || run.state === 'REJECTED') {
        return { ...this.snapshot(run), caughtUpTo: null, reason: `run-${run.state.toLowerCase()}` };
      }
      const node = this.currentNode(run);
      if (!node) return { ...this.snapshot(run), caughtUpTo: null, reason: 'run-completed' };
      if (node.type === 'stage') {
        if (candidates.has(node.id)) {
          return { ...this.snapshot(run), caughtUpTo: node.id, reason: 'reached-candidate' };
        }
        // Gated on `mutatesSource` — not `readinessTemplate` — because the safety boundary this
        // exists to protect ("only a stage's own owner may complete a stage that mutates source")
        // is about mutation, not about whether a template happens to be attached. Every shipped
        // mutatesSource stage also carries a template today, so the two conditions currently agree;
        // gating on the template alone would silently backfill-complete a hypothetical
        // mutatesSource stage with no template, which is exactly the mutation this check exists to
        // block.
        if (node.mutatesSource) {
          return { ...this.snapshot(run), caughtUpTo: null, reason: `blocked-on-mutating-stage:${node.id}` };
        }
        if (node.optional) {
          this.skipStage({ taskId, stageId: node.id, reason: note ?? 'catch-up: backfilled', backfilled: true, now });
        } else {
          this.completeStage({ taskId, stageId: node.id, note: note ?? 'catch-up: backfilled', backfilled: true, now });
        }
        run = this.requireRun(taskId);
        continue;
      }
      // Every gate — clarification-kind included — is a stop, not a walk-through: only its own
      // owning skill (or a human) may decide it. `gate-0` is `clarification`-kind and is resolved
      // explicitly by do-brainstorm's own step 8; auto-approving it here on a later skill's catch-up
      // call bypassed exactly the "leave it for a human" case do-brainstorm's own prose documents.
      return { ...this.snapshot(run), caughtUpTo: null, reason: `awaiting-gate:${node.id}` };
    }
  }

  /** Resolve the gate the run is paused on. approve resumes; reject terminates the run. A
   * `forced` decision (e.g. approving despite unresolved clarification markers) requires an
   * explicit `note` reason — never a silent override — and is flagged in history for
   * `render-audit.sh` to distinguish from a routine handoff. */
  decideGate({ taskId, gateId, decision, policy, by, note, forced = false, now, bindHead }: any = {}) {
    assertSafeId(gateId, 'gateId');
    if (bindHead !== undefined && (policy === undefined || !/^[0-9a-f]{40}$/.test(String(bindHead)))) throw new Error('bindHead is a 40-hex feature head and needs --policy');
    // IC-005: the decider is derived, never named by a caller; `autopilot` is recorded only by --policy.
    if (by !== undefined) throw new Error('decide-gate takes no decider (by); only --policy records autopilot');
    if (policy !== undefined) {
      if (policy !== gateId) throw new Error('--policy must name the gate being decided');
      if (decision !== undefined || forced) throw new Error('--policy refuses --decision and --forced');
    } else if (!GATE_DECISIONS.includes(decision)) throw new Error(`Invalid gate decision '${decision}'; valid: ${GATE_DECISIONS.join(', ')}`);
    if (forced && (!note || !String(note).trim())) throw new Error('A forced gate decision requires a --note reason');
    const run = this.requireRun(taskId);
    if (run.state !== 'AWAITING_GATE') throw new Error(`Run '${run.taskId}' is not awaiting a gate (state=${run.state})`);
    const node = this.currentNode(run);
    if (!node || node.type !== 'gate') throw new Error('Run state says AWAITING_GATE but no gate is at the cursor');
    if (node.id !== gateId) throw new Error(`Expected gate '${node.id}' next, got '${gateId}'`);
    if (policy !== undefined) return this.decideGateByPolicy(run, node, policy, now, bindHead);
    node.status = decision === 'approve' ? 'approved' : 'rejected';
    node.decision = decision;
    run.history.push({ at: iso(now), action: 'decide-gate', node: node.id, detail: decision, note: note ?? null, forced: Boolean(forced) });
    if (decision === 'reject') {
      run.state = runState('REJECTED');
    } else {
      run.state = runState('RUNNING');
      run.cursor += 1;
      this.settleCursor(run);
    }
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** IC-005: the feature checkout cannot grant itself a weaker gate policy. Denies write nothing. */
  decideGateByPolicy(run: any, node: any, policyId: string, now: any, bindHead?: string) {
    // Decision C9: the autopilot kill switch binds every policy decision, not only the loop's. Off on
    // any layer (env, sentinel, settings; an unreadable setting fails safe to off) denies before any
    // fact is read, and records nothing.
    const { readKillSwitch } = require('./settings/autopilot.ts');
    const killSwitch = readKillSwitch(this.env);
    if (!killSwitch.enabled) {
      return { ...this.snapshot(run), decision: 'deny', reason: 'autopilot-disabled', reasons: ['autopilot-disabled'],
        rule: `${node.id}/autopilot`, policy: { id: policyId, digest: null }, inputs: [], annotations: { switch: killSwitch.switch } };
    }
    // Loaded here, not at module top: every other orchestrator path (and a dry-run install) must not import them.
    const { listCheckouts } = require('./checkouts.ts');
    const { projectLayerSource } = require('./settings/project-layers.ts');
    const { parseSeed } = require('./roadmap/rows.ts');
    const { loadPolicy, evaluate } = require('./roadmap/gates.ts');
    const { gatherGateFacts } = require('./roadmap/facts.ts');
    const root = this.sourceRoot;
    const checkouts = listCheckouts({ cwd: root });
    const mainRoot = checkouts.ok && checkouts.main ? checkouts.main : root;
    const execOptions = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    let developHead: string | undefined;
    let baseBytes: string | null = null;
    // The base policy is develop's committed blob, never the worktree or the feature branch: a
    // branch that weakens `never` to `approve` must not approve itself. No textconv filter applies.
    try {
      const head: string = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/develop'], execOptions).trim();
      developHead = head;
      if (/^[0-9a-f]{40}$/.test(head)) {
        baseBytes = execFileSync('git', ['show', '--no-textconv', `${head}:core/registry/gates.json`], execOptions);
      }
    } catch { /* loadPolicy returns no-policy; never fall back to the feature copy. */ }
    const layers = projectLayerSource(mainRoot, this.fsImpl);
    let overrideBytes: string | null = null;
    if (layers.layersFrom) {
      try { overrideBytes = this.fsImpl.readFileSync(path.join(layers.layersFrom, 'gates.override.json'), 'utf8'); }
      catch (error: any) { if (error.code !== 'ENOENT') overrideBytes = ''; }
    }
    const loaded = loadPolicy(baseBytes, overrideBytes);
    const policy = { id: policyId, digest: loaded.digest };
    if (!loaded.ok) return { ...this.snapshot(run), decision: 'deny', reasons: loaded.reasons, reason: loaded.reason, policy, inputs: [] };

    const slug = runSlugOf(run, root) || this.featureSlug || run.taskId;
    let seed: any = null;
    let row: any = null;
    try {
      seed = parseSeed(this.fsImpl.readFileSync(path.join(mainRoot, 'agent-docs/roadmap/rows.json'), 'utf8'));
      row = seed.rows.find((entry: any) => entry.slug === slug && entry.class === run.taskClass) || null;
    } catch (error: any) {
      if (error.code === 'seed-typed-status') return { ...this.snapshot(run), decision: 'deny', reason: error.code, reasons: [error.code], policy, inputs: [] };
      // Invalid or unreadable seed means no trustworthy row; evaluate returns row-unknown.
    }
    // The feature folder follows the feature-store rule: the calling checkout's own, else the main
    // checkout's when a linked worktree does not hold it. The resolver names `<checkout>/agent-docs/
    // doflow/<slug>` whether or not it exists, so a linked worktree without the folder would read
    // no artifacts (a false `unresolved-clarifications`) and register into a missing folder.
    let feature = resolveActiveFeature({ projectRoot: root, slug });
    if (!feature.error && !this.fsImpl.existsSync(feature.featureDir) && mainRoot !== root) {
      feature = resolveActiveFeature({ projectRoot: mainRoot, slug });
    }
    if (feature.error) throw new Error(`Cannot resolve policy gate artifacts: ${feature.message}`);
    const facts = gatherGateFacts({ root, mainRoot, registryRoot: this.repoRoot, artifactRoot: feature.featureDir,
      gateId: node.id, policy: loaded.policy, row, rows: seed?.rows, developHead, featureBranch: `feat/${slug}`, fsImpl: this.fsImpl });
    const evaluation = evaluate(loaded.policy, run.taskClass, node.id, facts);
    // A deny changes nothing: the run stays AWAITING_GATE and autopilot never rejects.
    if (evaluation.decision === 'deny') return { ...this.snapshot(run), ...evaluation, policy };

    const audit = `approved by policy ${policyId}@${loaded.digest} (${evaluation.inputs.length} inputs)`;
    node.status = 'approved';
    node.decision = 'approve';
    // `policy.digest` and every fact's {locator, sha256} let a later reader re-derive this decision.
    // C15: the roadmap loop names the feature head it read before deciding (bindHead). The entry keeps
    // it as `approvedHead` only when the gate's own heads fact evaluated that same head, so the merge
    // binds to it across loop runs; an approval without it falls back to the both-heads digest.
    const heads = facts.find((fact: any) => fact.name === 'heads' && !fact.unreadable)?.value;
    const approvedHead = bindHead && heads?.featureHead === bindHead ? { approvedHead: bindHead } : {};
    run.history.push({ at: iso(now), action: 'decide-gate', node: node.id, detail: 'approve', by: 'autopilot',
      policy, inputs: evaluation.inputs, ...approvedHead, note: audit, forced: false });
    run.state = runState('RUNNING');
    run.cursor += 1;
    this.settleCursor(run);
    // The optimistic revision check runs before registering a decision, so a stale run cannot
    // leave a forged approval. A register refusal likewise prevents the journal from advancing.
    this.writeRun(run, now, () => {
      const registered = addDecisions({ featureDir: feature.featureDir, slug, now: now ?? new Date(), fsImpl: this.fsImpl, items: [{
        topic: node.id, statement: `${node.id} ${audit}.`, channel: 'policy', stage: POLICY_GATE_STAGE[node.id],
        rationale: `Every predicate of ${node.id} passed on the inputs digest ${evaluation.inputsDigest}.`,
        source: `git:${developHead}:core/registry/gates.json`,
      }] });
      if (registered.finding) throw new Error(`Cannot register policy approval: ${registered.finding}: ${registered.message}`);
    });
    return { ...this.snapshot(run), ...evaluation, policy };
  }

  /** Append a pure audit-trail entry — a stage re-run after its own handoff, or an artifact
   * hand-edited after that stage's own handoff — without touching program/cursor/state. Not a
   * stage completion or a gate decision, so it never collides with the state machine's ordering
   * rules (D3). `forced` requires an explicit `note` reason, same rule as decideGate. */
  annotate({ taskId, node: nodeId, note, forced = false, consultations, now }: any = {}) {
    // Id validated before the run is loaded, matching decideGate's order exactly: an unsafe id is
    // the caller's problem to hear about first, whether or not the run happens to exist.
    assertSafeId(nodeId, 'node');
    if (forced && (!note || !String(note).trim())) throw new Error('A forced annotation requires a --note reason');
    const run = this.requireRun(taskId);
    const found = run.program.find((n: any) => n.id === nodeId);
    if (!found) throw new Error(`Invalid node: '${nodeId}' is not part of the program for run '${taskId}'`);
    run.history.push({ at: iso(now), action: 'annotate', node: nodeId, note, forced: Boolean(forced), ...(consultations ? { consultations } : {}) });
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** After any advance: walk past finished nodes, land on the next pending action point, and set
   * the run state from what is found there. Cursor always sits ON the node awaiting action. */
  settleCursor(run: any) {
    for (;;) {
      if (run.cursor >= run.program.length) { run.state = runState('COMPLETED'); return; }
      const node = run.program[run.cursor];
      if (node.status === 'completed' || node.status === 'skipped' || node.status === 'approved') { run.cursor += 1; continue; }
      if (node.type === 'gate' && node.status === 'pending') { run.state = runState('AWAITING_GATE'); return; }
      run.state = runState('RUNNING');
      return;
    }
  }

  advance(run: any, now: any) {
    run.cursor += 1;
    this.settleCursor(run);
    if (run.state === 'COMPLETED') run.history.push({ at: iso(now), action: 'complete-run' });
  }

  /** Refuses a gated stage unless the evaluator answers READY. The evaluator returns a verdict
   * string, or `{ verdict, message }`: `message` replaces the generic refusal. */
  assertReady(node: any, run: any) {
    if (!this.readinessEvaluate) {
      // Fail closed: without an evaluator there is no way to know the tree is safe to mutate.
      throw new Error(`Stage '${node.id}' is gated by the '${node.readinessTemplate}' readiness template but no readiness evaluator is wired into this orchestrator`);
    }
    const answer = this.readinessEvaluate(node, run);
    if (!answer) throw new Error(`Readiness evaluator returned no verdict for stage '${node.id}'`);
    const { verdict, message = null } = typeof answer === 'string' ? { verdict: answer } : answer;
    if (verdict !== 'READY') {
      throw new Error(message || `Readiness for stage '${node.id}' returned ${verdict}; expected READY — resolve evidence or the user decision first`);
    }
  }

  /** FR-006: the implementation stage of a run (the `do-execute-plan` stage that mutates source)
   * cannot complete while its feature's task-attempt ledger exists and is incomplete. Returns the
   * checker's answer for a stage the rule applies to, `null` otherwise. */
  assertTaskAttempts(node: any, run: any) {
    if (!this.taskAttemptCheck || node.skill !== 'do-execute-plan' || !node.mutatesSource) return null;
    const answer = this.taskAttemptCheck(node, run);
    if (!answer || !['none', 'complete', 'incomplete'].includes(answer.state)) {
      throw new Error(`Task-attempt check returned no usable answer for stage '${node.id}'`);
    }
    if (answer.state === 'incomplete') {
      const names = (answer.incomplete || []).join(', ') || 'unknown';
      throw new Error(`Stage '${node.id}' cannot be completed: the task-attempt ledger${answer.slug ? ` for '${answer.slug}'` : ''} is incomplete — no COMPLETED attempt for ${names}. `
        + 'Claim, verify and finish each task with doflow-run task-attempt, then complete the stage.');
    }
    return answer;
  }

  /** Where `catchUp` would stop for these candidates, worked out on a copy of the run's program (or
   * of a fresh run's) without writing anything. Same stop rules and reason vocabulary as `catchUp`;
   * `stageId` is what `catchUp` reports as `caughtUpTo`, and `node` the program node it stops on.
   * @returns {{reason: string, stageId: string|null, node: Object|null}} */
  previewHandoff({ taskId, taskClass, candidateStageIds }: any) {
    const existing = this.readRun(taskId);
    const run = existing
      ? { state: existing.state, cursor: existing.cursor, program: structuredClone(existing.program) }
      : { state: 'RUNNING', cursor: 0, program: compileProgram(this.engine.resolveWorkflow(taskClass)) };
    const candidates = new Set(candidateStageIds);
    const stop = (reason: any, node: any = null) => ({ reason, stageId: reason === 'reached-candidate' ? node.id : null, node });
    if (run.state === 'REJECTED') return stop('run-rejected');
    const candidateNodes = run.program.filter((n: any) => candidates.has(n.id));
    if (candidateNodes.length > 0 && candidateNodes.every((n: any) => n.status === 'completed' || n.status === 'approved' || n.status === 'skipped')) {
      return stop(`already-completed:${candidateNodes.map((n: any) => n.id).join(',')}`);
    }
    for (;;) {
      if (run.state === 'COMPLETED' || run.state === 'REJECTED') return stop(`run-${run.state.toLowerCase()}`);
      const node = this.currentNode(run);
      if (!node) return stop('run-completed');
      if (node.type !== 'stage') return stop(`awaiting-gate:${node.id}`, node);
      if (candidates.has(node.id)) return stop('reached-candidate', node);
      if (node.mutatesSource) return stop(`blocked-on-mutating-stage:${node.id}`, node);
      node.status = node.optional ? 'skipped' : 'completed';
      if (node.optional) {
        for (let next = run.cursor + 1; next < run.program.length; next += 1) {
          const gate = run.program[next];
          if (gate.type !== 'gate' || gate.status !== 'pending') break;
          gate.status = 'skipped';
        }
      }
      run.cursor += 1;
      this.settleCursor(run);
    }
  }
}

/**
 * IC-013: fold the finished stage's History into the feature's archive. The task id is the feature
 * slug. This is housekeeping after a recorded handoff, so it reports and never throws: the
 * disposition and the exit code stay whatever the handoff itself decided.
 * @returns {{status:'compacted'|'unchanged'|'partial'|'skipped'|'failed', reason?:string, moved?:Array,
 *   failed?:Array<{artifact:string, path:string, message:string}>}} `partial` carries `failed`, one entry per refused artifact
 */
function compactAfterHandoff({ taskId, projectRoot }: any) {
  try {
    const feature = resolveActiveFeature({ projectRoot, slug: taskId });
    if (feature.error) return { status: 'skipped', reason: feature.message };
    // A task id such as a plan task (`B.1`) resolves on a feature branch to a folder that was
    // never created; say that, rather than blaming a missing register.
    if (!fs.existsSync(feature.featureDir)) return { status: 'skipped', reason: `no feature folder for task id "${taskId}"` };
    const result = compactDecisions({
      featureDir: feature.featureDir, slug: feature.paths.feature_slug, repoRoot: feature.repoRoot, paths: feature.paths,
    });
    if (result.finding === 'no-register') return { status: 'skipped', reason: result.message };
    // Some artifacts compacted and some were refused: `partial`, with each refusal named (IC-005).
    if (result.finding === 'compaction-failed') {
      return { status: 'partial', reason: result.message, moved: result.moved, failed: result.failed };
    }
    if (result.finding) return { status: 'failed', reason: result.message };
    return { status: result.status, moved: result.moved };
  } catch (error: any) {
    return { status: 'failed', reason: error.message };
  }
}

/**
 * IC-001: `orchestrate --action list`, every run the resolver can see as a prompt-free row plus the
 * records it could not read, by reason code only. Reads and prints; writes nothing.
 */
function listRuns({ taskId, gate, decision, policy, forced, note, stage, node, json, stateRoot }: any) {
  const { finishRuntime, usageError } = require('./cli-result.ts');
  const supplied = (value: any) => value !== undefined && value !== null;
  const noEffect = [
    ['--task-id', supplied(taskId)], ['--gate', supplied(gate)],
    ['--decision', supplied(decision)], ['--policy', supplied(policy)],
    ['--forced', forced], ['--note', supplied(note)], ['--stage', supplied(stage)],
    ['--node', supplied(node)],
  ].find(([, given]) => given);
  if (noEffect) return usageError('orchestrate', `'${noEffect[0]}' has no effect on action 'list'`, json);

  const resolverFailure = () => {
    if (json) console.log(JSON.stringify({ v: 1, error: 'cannot-list-checkouts' }, null, 2));
    else console.error('[ERROR] orchestrate: cannot list checkouts');
    return finishRuntime(1);
  };
  let resolved: any;
  try { resolved = orchestrationRuns({ stateRoot: stateRoot || process.cwd() }); } catch { return resolverFailure(); }
  if (!resolved.ok) return resolverFailure();

  const runs: any[] = [];
  const unreadable: any[] = [];
  const storePath = path.join('.doflow', 'state', 'orchestration');
  const textCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const slugCompare = (a: string|null, b: string|null) => a === null ? (b === null ? 0 : -1)
    : b === null ? 1 : textCompare(a, b);
  const addUnreadable = (entry: any, reason: string) => {
    const relative = path.relative(path.join(entry.root, storePath), entry.file);
    const parts = relative.split(path.sep);
    unreadable.push({
      taskId: path.basename(entry.file, '.json'),
      featureSlug: parts.length > 1 ? parts[0] : null,
      origin: entry.origin,
      reason,
    });
  };
  const journalTime = (value: any) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;

  for (const entry of resolved.entries) {
    if (entry.error) {
      addUnreadable(entry, entry.error);
      continue;
    }
    const record = entry.record;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      addUnreadable(entry, 'shape');
      continue;
    }
    if (record.version !== 1) {
      addUnreadable(entry, 'schema-version');
      continue;
    }
    const relative = path.relative(path.join(entry.root, storePath), entry.file);
    const parts = relative.split(path.sep);
    const folderSlug = parts.length > 1 ? parts[0] : null;
    const stem = path.basename(entry.file, '.json');
    if (typeof record.taskId !== 'string' || !ID_PATTERN.test(record.taskId) || record.taskId !== stem
      || (folderSlug && typeof record.featureSlug === 'string' && record.featureSlug !== folderSlug)) {
      addUnreadable(entry, 'id-mismatch');
      continue;
    }
    if (!RUN_STATES.includes(record.state)) {
      addUnreadable(entry, 'shape');
      continue;
    }
    let snapshot: any;
    try { snapshot = snapshotRun(record); } catch {
      addUnreadable(entry, 'shape');
      continue;
    }
    runs.push({
      taskId: snapshot.taskId,
      featureSlug: entry.slug,
      taskClass: snapshot.taskClass,
      workflowName: snapshot.workflowName,
      state: snapshot.state,
      current: snapshot.current,
      awaitingGate: snapshot.awaitingGate ? { gateId: snapshot.awaitingGate.gateId, name: snapshot.awaitingGate.name } : null,
      progress: snapshot.progress,
      terminalStage: snapshot.terminalStage,
      revision: snapshot.revision,
      startedAt: journalTime(record.startedAt),
      updatedAt: journalTime(record.updatedAt),
      origin: entry.origin,
    });
  }

  runs.sort((a, b) => {
    if (a.updatedAt === null && b.updatedAt !== null) return 1;
    if (a.updatedAt !== null && b.updatedAt === null) return -1;
    if (a.updatedAt !== null && b.updatedAt !== null) {
      const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (byTime !== 0) return byTime;
    }
    return slugCompare(a.featureSlug, b.featureSlug) || textCompare(a.taskId, b.taskId);
  });
  unreadable.sort((a, b) => textCompare(a.origin, b.origin)
    || slugCompare(a.featureSlug, b.featureSlug) || textCompare(a.taskId, b.taskId));

  if (json) {
    console.log(JSON.stringify({ v: 1, runs, unreadable }, null, 2));
  } else {
    for (const row of runs) console.log(`${row.state} ${row.featureSlug || '-'} ${row.taskId} ${row.current ? row.current.id : '-'} rev ${row.revision}`);
    if (unreadable.length > 0) console.log(`unreadable: ${unreadable.length}`);
  }
  return finishRuntime(0);
}

/** CLI handler for `doflow orchestrate`. The run journal lives in the CALLER's project state
 * (like evidence), while templates come from this install — same two-roots split readiness uses.
 * Completing a source-mutating gated stage needs a READY readiness record of the stage's template,
 * made by `doflow readiness` before this call; nothing is evaluated here. */
function handleOrchestrateCommand({
  action = 'status', taskId, taskClass, stage, gate, node, decision, policy, note, reason, forced = false,
  verificationPlan, scope, invariants, result, mcpOutcome, callingSkill, json = false, repoRoot, stateRoot, sourceRoot, slug = null, recordSlug, buildAdapters = null,
}: any = {}) {
  const { finishRuntime, usageError } = require('./cli-result.ts');

  if (action === 'list') return listRuns({ taskId, gate, decision, policy, forced, note, stage, node, json, stateRoot });

  const root = repoRoot || REPO_ROOT;
  // Same scope rule every other stateful command uses (evidenceRoot(o) in runtime-commands.js):
  // a bare `stateRoot: stateRoot || process.cwd()` silently ignored `--global`, so `orchestrate`
  // wrote its journal to $PWD while a `--global` `evidence`/`readiness` call on the same task read
  // and wrote $HOME — two roots disagreeing about where one task's state lives.
  const state = stateRoot || process.cwd();
  // The checkout the verb runs in: its branch and feature folder name the feature; `state` (the main
  // checkout for a linked worktree, 115 IC-004) holds the records.
  const source = sourceRoot || state;
  const safeId = ID_PATTERN.test(String(taskId ?? ''));
  // The feature this task belongs to: recorded on a run this command starts, the namespace its run
  // and readiness record live under (115 C-1), and matched against a run found in another checkout.
  // The dispatcher passes the call's record slug, computed once for every store the call touches.
  const featureSlug = recordSlug !== undefined ? recordSlug : safeId ? featureSlugFor({ projectRoot: source, taskId, slug }) : slug;
  // A run started in another checkout of this repository for the same feature is read and updated
  // where it is. `start` is always local: an unrelated run with the same id elsewhere neither
  // refuses nor satisfies it.
  let runRoot = state;
  if (safeId && action !== 'start') {
    const found = findRunFile({ stateRoot: state, taskId, slug: featureSlug });
    if (found.status === 'ambiguous') {
      console.error(`[ERROR] orchestrate: run '${taskId}' exists in more than one other checkout (${found.candidates.join(', ')}); run the command from the checkout that holds the run you mean. Nothing was changed.`);
      return finishRuntime(1);
    }
    if (found.status === 'found') runRoot = found.root;
  }
  const orchestrator = new WorkflowOrchestrator({
    repoRoot: root, projectRoot: runRoot, sourceRoot: source,
    stateDir: path.join(runRoot, '.doflow', 'state', 'orchestration'),
    featureSlug, buildAdapters,
  });
  orchestrator.readinessEvaluate = (node: any, run: any) => {
    // This closure only ever runs for a stage that is actually gated (evaluateReadiness only calls
    // it for a mutating stage carrying a readiness template) — so a missing --task-class here is a
    // caller mistake on THIS command, not a fact about the task's readiness. Reported before the
    // ledger/engine machinery below turns it into a generic readiness-layer exception.
    if (action !== 'handoff' && (typeof taskClass !== 'string' || taskClass.trim() === '')) {
      throw new Error("orchestrate complete-stage: this stage is gated by a readiness template, so --task-class is required — pass the same class this run was started/caught-up with.");
    }
    // The gate must grade this stage against the contract the run was actually started under, not
    // whatever class the caller happened to pass on THIS command — catchUp already refuses a
    // mismatched class for the same reason (a caller must not walk, or complete, a run under a
    // class it did not start). Without this, `--task-class trivial-edit` on a `bug` run's gated
    // `implementation` stage would grade source mutation against a 2-requirement contract instead
    // of the 5-requirement one the run actually declared, silently.
    if (taskClass && taskClass !== run.taskClass) {
      throw new Error(`orchestrate complete-stage: --task-class '${taskClass}' does not match run '${run.taskId}''s own class '${run.taskClass}' — pass the class this run was started under, not a different one.`);
    }
    // The record `doflow readiness` wrote before this call decides; inputs stated here would let a
    // handoff grade itself with whatever it was handed at the last moment.
    const template = node.readinessTemplate;
    const check = checkReadiness({ stateRoot: state, taskId: run.taskId, slug: runSlugOf(run, runRoot) || featureSlug, template, now: new Date() });
    if (check.ok) return { verdict: 'READY', message: null };
    return { verdict: check.code, message: [check.message, harnessHookNote({ repoRoot: root })].filter(Boolean).join(' ') };
  };

  // FR-006. The ledger lives under the main worktree, so the plan and the store are found from any
  // linked worktree; a run whose feature cannot be named has no ledger to check.
  orchestrator.taskAttemptCheck = (node: any, run: any) => checkTaskAttemptCompletion({
    slug: runSlugOf(run, runRoot) || featureSlug, cwd: state,
  });

  if ((action === 'handoff' || action === 'complete-stage')
    && [verificationPlan, scope, invariants].some((v) => typeof v === 'string' && v.trim() !== '')) {
    console.error(`orchestrate: note: --verification-plan, --scope and --invariants are inputs to doflow-run readiness; this ${action} did not read them.`);
  }

  try {
    if (policy !== undefined && (action !== 'decide-gate' || decision !== undefined || forced || policy !== gate)) {
      return usageError('orchestrate', '--policy requires decide-gate with the matching --gate and refuses --decision and --forced', json);
    }
    // `--forced` is only read by the two actions that can override a decision. Accepting it
    // silently on any other action lets an operator believe a stage completion or skip was
    // recorded as forced when nothing recorded it — refuse instead of dropping the flag.
    if (forced && action !== 'decide-gate' && action !== 'annotate') {
      return usageError('orchestrate', `'--forced' has no effect on action '${action}' — only decide-gate and annotate read it`, json);
    }
    // Same rule for --result: dropping it silently would let an operator believe an outcome was
    // recorded when nothing recorded it.
    if (result !== undefined && action !== 'complete-stage' && action !== 'handoff') {
      return usageError('orchestrate', `'--result' has no effect on action '${action}' — only complete-stage and handoff record a stage outcome`, json);
    }
    // And for --mcp-outcome: an outcome that nothing records must not look recorded.
    if (mcpOutcome !== undefined && action !== 'handoff') {
      return usageError('orchestrate', `'--mcp-outcome' has no effect on action '${action}' — only handoff records MCP outcomes`, json);
    }
    let snapshot;
    switch (action) {
      case 'handoff':
        snapshot = orchestrator.handoff({ taskId, taskClass, callingSkill, note, outcome: result, mcpOutcomes: mcpOutcome });
        break;
      case 'start':
        if (!taskId || !taskClass) return usageError('orchestrate', 'start requires --task-id and --task-class', json);
        snapshot = orchestrator.start({ taskId, taskClass });
        break;
      case 'complete-stage':
        if (!taskId || !stage) return usageError('orchestrate', 'complete-stage requires --task-id and --stage', json);
        snapshot = orchestrator.completeStage({ taskId, stageId: stage, note, outcome: result });
        break;
      case 'catch-up': {
        if (!taskId || !taskClass || !stage) return usageError('orchestrate', 'catch-up requires --task-id, --task-class and --stage (comma-separated candidate ids)', json);
        const candidateStageIds = String(stage).split(',').map((s) => s.trim()).filter(Boolean);
        snapshot = orchestrator.catchUp({ taskId, taskClass, candidateStageIds, note });
        break;
      }
      case 'skip-stage':
        if (!taskId || !stage) return usageError('orchestrate', 'skip-stage requires --task-id and --stage', json);
        snapshot = orchestrator.skipStage({ taskId, stageId: stage, reason: reason ?? note });
        break;
      case 'decide-gate':
        if (!taskId || !gate || (policy === undefined && !decision)) return usageError('orchestrate', 'decide-gate requires --task-id, --gate and --decision approve|reject or --policy <gateId>', json);
        snapshot = orchestrator.decideGate({ taskId, gateId: gate, decision, policy, note, forced });
        break;
      case 'annotate':
        if (!taskId || !node || !note) return usageError('orchestrate', 'annotate requires --task-id, --node and --note', json);
        snapshot = orchestrator.annotate({ taskId, node, note, forced });
        break;
      case 'status':
        if (!taskId) return usageError('orchestrate', 'status requires --task-id', json);
        snapshot = orchestrator.status(taskId);
        break;
      default:
        return usageError('orchestrate', `unknown action '${action}'; valid: start | status | list | handoff | catch-up | complete-stage | skip-stage | decide-gate | annotate`, json);
    }
    // Only a handoff that recorded work compacts; `deferred` and `standalone` recorded nothing.
    if (action === 'handoff' && (snapshot.disposition === 'completed' || snapshot.disposition === 'annotated')) {
      snapshot = { ...snapshot, compaction: compactAfterHandoff({ taskId, projectRoot: source }) };
    }
    if (json) { console.log(JSON.stringify(snapshot, null, 2)); return finishRuntime(0); }
    console.log(`Workflow ${snapshot.taskId} [${snapshot.taskClass}] — ${snapshot.state}`);
    if (snapshot.disposition === 'standalone') console.log(`Handoff: standalone (${snapshot.reason})`);
    else if (snapshot.disposition) console.log(`Handoff: ${snapshot.disposition}`);
    if (snapshot.compaction) console.log(`Compaction: ${snapshot.compaction.status}${snapshot.compaction.reason ? ` — ${snapshot.compaction.reason}` : ''}`);
    if (snapshot.policy) console.log(snapshot.decision === 'pass'
      ? `${gate} ${snapshot.taskId} approved by policy ${snapshot.policy.id}@${snapshot.policy.digest} (${snapshot.inputs.length} inputs)`
      : `${gate} ${snapshot.taskId} denied by policy: ${snapshot.reasons.join(', ')}`);
    if (snapshot.progress) console.log(`Progress: ${snapshot.progress.done}/${snapshot.progress.total}`);
    if (snapshot.current) {
      console.log(snapshot.awaitingGate
        ? `Awaiting gate ${snapshot.awaitingGate.gateId}${snapshot.awaitingGate.prompt ? `: ${snapshot.awaitingGate.prompt}` : ''}`
        : `Next: ${snapshot.current.type} '${snapshot.current.id}'${snapshot.current.mutatesSource ? ' (mutates source)' : ''}`);
    }
    // MCP warnings go to stderr and notices to stdout, after everything else (IC-011).
    for (const message of snapshot.mcpWarnings || []) (message.text.startsWith('[WARN]') ? console.error : console.log)(message.text);
    return finishRuntime(0);
  } catch (error: any) {
    // Transition refusals are findings, not crashes: out-of-order stages and unready gates are
    // exactly what an operator asked about when they ran this.
    console.error(`[ERROR] orchestrate: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { WorkflowOrchestrator, RUN_STATES, GATE_DECISIONS, STAGE_OUTCOMES, handleOrchestrateCommand };
