'use strict';

// WorkflowOrchestrator — deterministic execution over the workflow registry. The registry
// declares WHAT a class's
// stages are (workflow-engine resolves that); this module owns the state machine that walks it:
// one linear program per task, human gates as first-class pause points, readiness as a scripted
// cascade gate before any source-mutating stage completes, and every transition journaled to
// neutral state so runs survive process death. The orchestrator never asks a model what runs next;
// callers assert stage completion, exactly like they assert evidence.

const fs = require('node:fs');
const path = require('node:path');
const { WorkflowEngine } = require('./workflow-engine');
const { atomicJsonWrite } = require('../state');
const { REPO_ROOT } = require('../helper/repo-root');

const RUN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);
const GATE_DECISIONS = Object.freeze(['approve', 'reject']);
/** What a completed stage established, separate from the fact it was walked past (review A1). */
const STAGE_OUTCOMES = new Set(['passed', 'failed', 'unverified']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(value, label) {
  if (!ID_PATTERN.test(String(value ?? ''))) throw new Error(`Invalid ${label}: '${value}'`);
  return String(value);
}

function iso(now) { return (now ?? new Date()).toISOString(); }

/** Interleave stages with their gates: each gate sits immediately after the stage named by its
 * `afterStage`. A gate anchored to an unknown stage is a compile error here, not a silent orphan. */
function compileProgram(workflow) {
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
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot] install root owning core/registry + default state dir.
   * @param {string} [options.stateDir] where run journals live.
   * @param {WorkflowEngine} [options.engine] pre-built engine (injected workflows in tests).
   * @param {(node: object, run: object) => string|null} [options.readinessEvaluate] cascade gate:
   *   returns a readiness verdict string; anything but READY blocks completion of a source-mutating
   *   gated stage. Unwired means such stages cannot be completed — fail closed, never open.
   * @param {object} [options.fsImpl]
   */
  constructor({ repoRoot = REPO_ROOT, stateDir, engine, readinessEvaluate, fsImpl } = {}) {
    this.fsImpl = fsImpl || fs;
    this.repoRoot = repoRoot;
    this.engine = engine || new WorkflowEngine({ repoRoot });
    this.stateDir = stateDir || path.join(repoRoot, '.doflow', 'state', 'orchestration');
    this.readinessEvaluate = readinessEvaluate || null;
  }

  runFile(taskId) {
    return path.join(this.stateDir, `${assertSafeId(taskId, 'taskId')}.json`);
  }

  readRun(taskId) {
    const file = this.runFile(taskId);
    if (!this.fsImpl.existsSync(file)) return null;
    return JSON.parse(this.fsImpl.readFileSync(file, 'utf8'));
  }

  writeRun(run, now) {
    run.updatedAt = iso(now);
    this.fsImpl.mkdirSync(this.stateDir, { recursive: true });
    atomicJsonWrite(path.join(this.stateDir, `${run.taskId}.json`), run, { fsImpl: this.fsImpl });
    return run;
  }

  /** Begin a new run. An existing run for the same task id is refused — resume instead. */
  start({ taskId, taskClass, now } = {}) {
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
      state: 'RUNNING',
      cursor: 0,
      program,
      history: [{ at: iso(now), action: 'start', detail: `task-class=${taskClass}` }],
      startedAt: iso(now),
    };
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  snapshot(run) {
    const current = run.cursor < run.program.length ? run.program[run.cursor] : null;
    const done = run.program.filter((n) => n.status === 'completed' || n.status === 'skipped' || n.status === 'approved').length;
    return {
      taskId: run.taskId,
      taskClass: run.taskClass,
      workflowName: run.workflowName,
      state: run.state,
      current: current ? { type: current.type, id: current.id, kind: current.kind ?? null, mutatesSource: current.mutatesSource ?? null, readinessTemplate: current.readinessTemplate ?? null } : null,
      awaitingGate: run.state === 'AWAITING_GATE' && current ? { gateId: current.id, name: current.name, prompt: current.prompt } : null,
      progress: { done, total: run.program.length },
      terminalStage: run.terminalStage,
    };
  }

  status(taskId) {
    const run = this.requireRun(taskId);
    return this.snapshot(run);
  }

  requireRun(taskId) {
    const run = this.readRun(taskId);
    if (!run) throw new Error(`No workflow run for task '${taskId}'`);
    return run;
  }

  currentNode(run) {
    return run.cursor < run.program.length ? run.program[run.cursor] : null;
  }

  expectOpenStage(run, stageId) {
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
  completeStage({ taskId, stageId, note, outcome, backfilled = false, now } = {}) {
    const run = this.requireRun(taskId);
    const node = this.expectOpenStage(run, stageId);
    if (outcome !== undefined && !STAGE_OUTCOMES.has(outcome)) {
      throw new Error(`Unknown stage outcome '${outcome}'. Valid: ${[...STAGE_OUTCOMES].join(', ')} — omit the flag to record 'unverified'.`);
    }
    if (node.mutatesSource && node.readinessTemplate) {
      const verdict = this.evaluateReadiness(node, run);
      if (verdict !== 'READY') throw new Error(`Readiness for stage '${node.id}' returned ${verdict}; expected READY — resolve evidence or the user decision first`);
    }
    node.status = 'completed';
    node.executionStatus = backfilled ? 'imported' : 'completed';
    node.outcome = backfilled ? 'unverified' : (outcome ?? 'unverified');
    run.history.push({
      at: iso(now), action: 'complete-stage', node: node.id, note: note ?? null,
      backfilled: Boolean(backfilled), executionStatus: node.executionStatus, outcome: node.outcome,
    });
    this.advance(run, now);
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** Skip the current OPTIONAL stage without running it. Gates anchored directly to a skipped
   * stage cannot fire, so they are recorded as skipped too rather than blocking forever. */
  skipStage({ taskId, stageId, reason, backfilled = false, now } = {}) {
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
  catchUp({ taskId, taskClass, candidateStageIds, note, now } = {}) {
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
      const programStageIds = new Set(run.program.filter((n) => n.type === 'stage').map((n) => n.id));
      unknownCandidates = candidateStageIds.filter((id) => !programStageIds.has(id));
    } else {
      const workflow = this.engine.resolveWorkflow(taskClass); // unknown classes are rejected loudly, same as start()
      const workflowStageIds = new Set((workflow.stages || []).map((s) => s.id));
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
    const candidateNodes = run.program.filter((n) => candidates.has(n.id));
    if (candidateNodes.length > 0 && candidateNodes.every((n) => n.status === 'completed' || n.status === 'approved' || n.status === 'skipped')) {
      return { ...this.snapshot(run), caughtUpTo: null, reason: `already-completed:${candidateNodes.map((n) => n.id).join(',')}` };
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
  decideGate({ taskId, gateId, decision, note, forced = false, now } = {}) {
    assertSafeId(gateId, 'gateId');
    if (!GATE_DECISIONS.includes(decision)) throw new Error(`Invalid gate decision '${decision}'; valid: ${GATE_DECISIONS.join(', ')}`);
    if (forced && (!note || !String(note).trim())) throw new Error('A forced gate decision requires a --note reason');
    const run = this.requireRun(taskId);
    if (run.state !== 'AWAITING_GATE') throw new Error(`Run '${run.taskId}' is not awaiting a gate (state=${run.state})`);
    const node = this.currentNode(run);
    if (!node || node.type !== 'gate') throw new Error('Run state says AWAITING_GATE but no gate is at the cursor');
    if (node.id !== gateId) throw new Error(`Expected gate '${node.id}' next, got '${gateId}'`);
    node.status = decision === 'approve' ? 'approved' : 'rejected';
    node.decision = decision;
    run.history.push({ at: iso(now), action: 'decide-gate', node: node.id, detail: decision, note: note ?? null, forced: Boolean(forced) });
    if (decision === 'reject') {
      run.state = 'REJECTED';
    } else {
      run.state = 'RUNNING';
      run.cursor += 1;
      this.settleCursor(run);
    }
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** Append a pure audit-trail entry — a stage re-run after its own handoff, or an artifact
   * hand-edited after that stage's own handoff — without touching program/cursor/state. Not a
   * stage completion or a gate decision, so it never collides with the state machine's ordering
   * rules (D3). `forced` requires an explicit `note` reason, same rule as decideGate. */
  annotate({ taskId, node: nodeId, note, forced = false, now } = {}) {
    // Id validated before the run is loaded, matching decideGate's order exactly: an unsafe id is
    // the caller's problem to hear about first, whether or not the run happens to exist.
    assertSafeId(nodeId, 'node');
    if (forced && (!note || !String(note).trim())) throw new Error('A forced annotation requires a --note reason');
    const run = this.requireRun(taskId);
    const found = run.program.find((n) => n.id === nodeId);
    if (!found) throw new Error(`Invalid node: '${nodeId}' is not part of the program for run '${taskId}'`);
    run.history.push({ at: iso(now), action: 'annotate', node: nodeId, note, forced: Boolean(forced) });
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** After any advance: walk past finished nodes, land on the next pending action point, and set
   * the run state from what is found there. Cursor always sits ON the node awaiting action. */
  settleCursor(run) {
    for (;;) {
      if (run.cursor >= run.program.length) { run.state = 'COMPLETED'; return; }
      const node = run.program[run.cursor];
      if (node.status === 'completed' || node.status === 'skipped' || node.status === 'approved') { run.cursor += 1; continue; }
      if (node.type === 'gate' && node.status === 'pending') { run.state = 'AWAITING_GATE'; return; }
      run.state = 'RUNNING';
      return;
    }
  }

  advance(run, now) {
    run.cursor += 1;
    this.settleCursor(run);
    if (run.state === 'COMPLETED') run.history.push({ at: iso(now), action: 'complete-run' });
  }

  evaluateReadiness(node, run) {
    if (!this.readinessEvaluate) {
      // Fail closed: without an evaluator there is no way to know the tree is safe to mutate.
      throw new Error(`Stage '${node.id}' is gated by the '${node.readinessTemplate}' readiness template but no readiness evaluator is wired into this orchestrator`);
    }
    const verdict = this.readinessEvaluate(node, run);
    if (!verdict) throw new Error(`Readiness evaluator returned no verdict for stage '${node.id}'`);
    return verdict;
  }
}

/** CLI handler for `doflow orchestrate`. The run journal lives in the CALLER's project state
 * (like evidence), while templates come from this install — same two-roots split readiness uses.
 * The cascade gate wires the real ReadinessEngine: completing a source-mutating gated stage
 * evaluates the task's live evidence ledger and refuses anything but READY. */
function handleOrchestrateCommand({
  action = 'status', taskId, taskClass, stage, gate, node, decision, note, reason, forced = false,
  verificationPlan, scope, result, json = false, repoRoot, stateRoot,
} = {}) {
  const { evaluateTaskReadiness } = require('./readiness');
  const { finishRuntime, usageError } = require('./cli-result');

  const root = repoRoot || REPO_ROOT;
  // Same scope rule every other stateful command uses (evidenceRoot(o) in runtime-commands.js):
  // a bare `stateRoot: stateRoot || process.cwd()` silently ignored `--global`, so `orchestrate`
  // wrote its journal to $PWD while a `--global` `evidence`/`readiness` call on the same task read
  // and wrote $HOME — two roots disagreeing about where one task's state lives.
  const state = stateRoot || process.cwd();
  const orchestrator = new WorkflowOrchestrator({
    repoRoot: root,
    stateDir: path.join(state, '.doflow', 'state', 'orchestration'),
  });
  orchestrator.readinessEvaluate = (node, run) => {
    // This closure only ever runs for a stage that is actually gated (evaluateReadiness only calls
    // it for a mutating stage carrying a readiness template) — so a missing --task-class here is a
    // caller mistake on THIS command, not a fact about the task's readiness. Reported before the
    // ledger/engine machinery below turns it into a generic readiness-layer exception.
    if (typeof taskClass !== 'string' || taskClass.trim() === '') {
      throw new Error("orchestrate complete-stage: this stage is gated by a readiness template, so --task-class is required — pass the same class this run was started/caught-up with.");
    }
    // The gate must grade this stage against the contract the run was actually started under, not
    // whatever class the caller happened to pass on THIS command — catchUp already refuses a
    // mismatched class for the same reason (a caller must not walk, or complete, a run under a
    // class it did not start). Without this, `--task-class trivial-edit` on a `bug` run's gated
    // `implementation` stage would grade source mutation against a 2-requirement contract instead
    // of the 5-requirement one the run actually declared, silently.
    if (taskClass !== run.taskClass) {
      throw new Error(`orchestrate complete-stage: --task-class '${taskClass}' does not match run '${run.taskId}''s own class '${run.taskClass}' — pass the class this run was started under, not a different one.`);
    }
    // Caller-stated inputs reach the cascade here, same rule as `doflow readiness`: an absent key
    // stays absent rather than becoming a falsy default, because the engine reads presence, not
    // truth. Without this the two requirements readiness_gate.md says are satisfiable by
    // assertion (`verification_plan`, `scope_clear`) had no path in at all, so every gated stage
    // completion returned NEEDS_EVIDENCE even when the caller had the answers to give.
    const profile = { taskId, taskClass: run.taskClass };
    if (typeof verificationPlan === 'string' && verificationPlan.trim() !== '') profile.verificationPlan = verificationPlan;
    if (typeof scope === 'string' && scope.trim() !== '') profile.scopeClear = scope;
    const report = evaluateTaskReadiness({ taskProfile: profile, repoRoot: root, projectRoot: state });
    return report.state;
  };

  try {
    // `--forced` is only read by the two actions that can override a decision. Accepting it
    // silently on any other action lets an operator believe a stage completion or skip was
    // recorded as forced when nothing recorded it — refuse instead of dropping the flag.
    if (forced && action !== 'decide-gate' && action !== 'annotate') {
      return usageError('orchestrate', `'--forced' has no effect on action '${action}' — only decide-gate and annotate read it`, json);
    }
    // Same rule for --result: dropping it silently would let an operator believe an outcome was
    // recorded when nothing recorded it.
    if (result !== undefined && action !== 'complete-stage') {
      return usageError('orchestrate', `'--result' has no effect on action '${action}' — only complete-stage records a stage outcome`, json);
    }
    let snapshot;
    switch (action) {
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
        if (!taskId || !gate || !decision) return usageError('orchestrate', 'decide-gate requires --task-id, --gate and --decision approve|reject', json);
        snapshot = orchestrator.decideGate({ taskId, gateId: gate, decision, note, forced });
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
        return usageError('orchestrate', `unknown action '${action}'; valid: start | status | catch-up | complete-stage | skip-stage | decide-gate | annotate`, json);
    }
    if (json) { console.log(JSON.stringify(snapshot, null, 2)); return finishRuntime(0); }
    console.log(`Workflow ${snapshot.taskId} [${snapshot.taskClass}] — ${snapshot.state}`);
    console.log(`Progress: ${snapshot.progress.done}/${snapshot.progress.total}`);
    if (snapshot.current) {
      console.log(snapshot.awaitingGate
        ? `Awaiting gate ${snapshot.awaitingGate.gateId}${snapshot.awaitingGate.prompt ? `: ${snapshot.awaitingGate.prompt}` : ''}`
        : `Next: ${snapshot.current.type} '${snapshot.current.id}'${snapshot.current.mutatesSource ? ' (mutates source)' : ''}`);
    }
    return finishRuntime(0);
  } catch (error) {
    // Transition refusals are findings, not crashes: out-of-order stages and unready gates are
    // exactly what an operator asked about when they ran this.
    console.error(`[ERROR] orchestrate: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { WorkflowOrchestrator, RUN_STATES, GATE_DECISIONS, STAGE_OUTCOMES, handleOrchestrateCommand };
