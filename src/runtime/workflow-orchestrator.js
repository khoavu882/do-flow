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
   * expensive work, and NEEDS_EVIDENCE / NEEDS_USER_DECISION / BLOCKED stop the run here. */
  completeStage({ taskId, stageId, note, now } = {}) {
    const run = this.requireRun(taskId);
    const node = this.expectOpenStage(run, stageId);
    if (node.mutatesSource && node.readinessTemplate) {
      const verdict = this.evaluateReadiness(node, run);
      if (verdict !== 'READY') throw new Error(`Readiness for stage '${node.id}' returned ${verdict}; expected READY — resolve evidence or the user decision first`);
    }
    node.status = 'completed';
    run.history.push({ at: iso(now), action: 'complete-stage', node: node.id, note: note ?? null });
    this.advance(run, now);
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** Skip the current OPTIONAL stage without running it. Gates anchored directly to a skipped
   * stage cannot fire, so they are recorded as skipped too rather than blocking forever. */
  skipStage({ taskId, stageId, reason, now } = {}) {
    const run = this.requireRun(taskId);
    const node = this.expectOpenStage(run, stageId);
    if (!node.optional) throw new Error(`Stage '${node.id}' is required and cannot be skipped`);
    node.status = 'skipped';
    run.history.push({ at: iso(now), action: 'skip-stage', node: node.id, note: reason ?? null });
    let lookahead = run.cursor + 1;
    while (lookahead < run.program.length) {
      const nextNode = run.program[lookahead];
      // A gate sits immediately after its anchor in the program, so any pending gate directly
      // following the skipped stage is anchored to it and can never fire.
      if (nextNode.type !== 'gate' || nextNode.status !== 'pending') break;
      nextNode.status = 'skipped';
      run.history.push({ at: iso(now), action: 'skip-gate', node: nextNode.id, note: 'anchor stage skipped' });
      lookahead += 1;
    }
    this.advance(run, now);
    this.writeRun(run, now);
    return this.snapshot(run);
  }

  /** Resolve the gate the run is paused on. approve resumes; reject terminates the run. */
  decideGate({ taskId, gateId, decision, note, now } = {}) {
    assertSafeId(gateId, 'gateId');
    if (!GATE_DECISIONS.includes(decision)) throw new Error(`Invalid gate decision '${decision}'; valid: ${GATE_DECISIONS.join(', ')}`);
    const run = this.requireRun(taskId);
    if (run.state !== 'AWAITING_GATE') throw new Error(`Run '${run.taskId}' is not awaiting a gate (state=${run.state})`);
    const node = this.currentNode(run);
    if (!node || node.type !== 'gate') throw new Error('Run state says AWAITING_GATE but no gate is at the cursor');
    if (node.id !== gateId) throw new Error(`Expected gate '${node.id}' next, got '${gateId}'`);
    node.status = decision === 'approve' ? 'approved' : 'rejected';
    node.decision = decision;
    run.history.push({ at: iso(now), action: 'decide-gate', node: node.id, detail: decision, note: note ?? null });
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
  action = 'status', taskId, taskClass, stage, gate, decision, note, reason,
  json = false, repoRoot, stateRoot,
} = {}) {
  const { EvidenceLedger } = require('./evidence-ledger');
  const { ClaimsManager } = require('./claims');
  const { ReadinessEngine } = require('./readiness');
  const { finishRuntime, usageError } = require('./cli-result');

  const root = repoRoot || REPO_ROOT;
  const state = stateRoot || process.cwd();
  const orchestrator = new WorkflowOrchestrator({
    repoRoot: root,
    stateDir: path.join(state, '.doflow', 'state', 'orchestration'),
  });
  orchestrator.readinessEvaluate = () => {
    let ledger;
    try {
      ledger = new EvidenceLedger({ repoRoot: state });
      ledger.load(taskId);
    } catch {
      return 'BLOCKED'; // an unreadable evidence ledger can never certify a safe mutation
    }
    const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: state });
    claims.load(taskId);
    const engine = new ReadinessEngine({ repoRoot: root, projectRoot: state });
    const report = engine.evaluateReadiness({ taskId, taskClass }, ledger, claims);
    return report.state;
  };

  try {
    let snapshot;
    switch (action) {
      case 'start':
        if (!taskId || !taskClass) return usageError('orchestrate', 'start requires --task-id and --task-class', json);
        snapshot = orchestrator.start({ taskId, taskClass });
        break;
      case 'complete-stage':
        if (!taskId || !stage) return usageError('orchestrate', 'complete-stage requires --task-id and --stage', json);
        snapshot = orchestrator.completeStage({ taskId, stageId: stage, note });
        break;
      case 'skip-stage':
        if (!taskId || !stage) return usageError('orchestrate', 'skip-stage requires --task-id and --stage', json);
        snapshot = orchestrator.skipStage({ taskId, stageId: stage, reason: reason ?? note });
        break;
      case 'decide-gate':
        if (!taskId || !gate || !decision) return usageError('orchestrate', 'decide-gate requires --task-id, --gate and --decision approve|reject', json);
        snapshot = orchestrator.decideGate({ taskId, gateId: gate, decision, note });
        break;
      case 'status':
        if (!taskId) return usageError('orchestrate', 'status requires --task-id', json);
        snapshot = orchestrator.status(taskId);
        break;
      default:
        return usageError('orchestrate', `unknown action '${action}'; valid: start | status | complete-stage | skip-stage | decide-gate`, json);
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

module.exports = { WorkflowOrchestrator, RUN_STATES, GATE_DECISIONS, handleOrchestrateCommand };
