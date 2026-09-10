'use strict';
// The runtime verbs (design §4.2) — dispatch only.
//
// Every verb's own implementation — `scaffold`, `classify`, `workflow`, `route`, `claim`,
// `context-pack`, `verify` and `recover` — lives in its engine module under src/runtime/ and is
// imported below; this file only forwards parsed CLI arguments to it, exactly as the verb-table
// doctrine requires: one implementation per verb, one table that names them. `bin/doflow.js`
// forwards here from src/cli/index.js; nothing outside src/runtime/ implements a verb.
//
// Uniform contract, shared by every one of those handlers: `--json` prints the library's own
// object, unmodified; exit 0 = answered, 1 = a finding the caller must act on, 2 = the CLI could
// not do what was asked (a missing or unusable argument, or input the library cannot resolve). No
// handler ever converts a library's own status into a different one, and none of them substitutes
// a default for an identity the library refuses to guess.
//
// Guard note: test/guards/reachability.test.js and test/guards/runtime-unification.test.js parse
// this switch — each case written as the single expression `case '<name>': return
// handle<Name>Command(...)` — to cross-check the dispatcher's verb table in both directions. Keep
// every case in exactly that shape.
const os = require('node:os');
const path = require('node:path');
const {
  handleCapabilitiesCommand, handleReadinessCommand, handleEvidenceCommand,
} = require('../runtime/cli');
// `doctor` comes from the health module rather than src/runtime/cli.js: the health-probe report
// (FR-013) supersedes the presence-check version, and one verb must have one implementation.
const { handleDoctorCommand } = require('../runtime/health');
const { handleTraceCommand, handleStatsCommand, handleDiscoverCommand } = require('../runtime/trace/ledger');
const { handleIndicatorsCommand } = require('../runtime/trace/indicators');
// The rest of the verb surface design §4.2 declares. `classify`, `workflow`, `route`, `claim`,
// `context-pack`, `verify`, `recover` and `scaffold` each have exactly one implementation, in the
// engine module named on the right; this file only dispatches to them.
const { ReadinessEngine } = require('../runtime/readiness');
const { handleClaimCommand } = require('../runtime/claims');
const { handleClassifyCommand } = require('../runtime/task-classifier');
const { handleWorkflowCommand } = require('../runtime/workflow-engine');
const { handleOrchestrateCommand } = require('../runtime/workflow-orchestrator');
const { handleRetrieveCommand } = require('../runtime/knowledge/retrieval');
const { handleModelRoleCommand } = require('../runtime/model-router');
const { handleRouteCommand } = require('../runtime/capability-router');
const { handleContextPackCommand } = require('../runtime/context-pack');
const { handleRetrievalPlanCommand } = require('../runtime/retrieval-plan');
const { handleOutcomeCommand } = require('../runtime/outcome');
const { handleVerifyCommand } = require('../runtime/verification/engine');
const { handleLeakScanCommand } = require('../runtime/leak-scan');
const { handleRecoverCommand } = require('../runtime/recovery');
const { handleScaffoldCommand } = require('../runtime/scaffold/generate');
const { finishRuntime, usageError } = require('../runtime/cli-result');
const { REPO_ROOT } = require('./shared');

/** Where `readiness`/`evidence` read and write per-task state. Mirrors scopeOf()'s rules so these
 * commands are scope-aware like the rest of the CLI, rather than defaulting to the DoFlow install
 * directory — which for an npm install is inside node_modules/. */
function evidenceRoot(o) {
  return o.global ? os.homedir() : path.resolve(o.positional[0] || '.');
}

/**
 * The task class the caller named, or exit 2 naming the valid set.
 *
 * `readiness` previously read `o.taskClass || 'feature'`. That is the identity defect readiness.js
 * fixed this morning, reinstated one layer up: omitting `--task-class` produced a confident
 * READY/NEEDS_EVIDENCE verdict computed from the wrong contract, and nothing in the output said so.
 * The valid set comes from the readiness registry rather than a list written here, so it cannot
 * drift from the templates that actually exist.
 * @param {Object} o parsed arguments
 * @returns {string}
 */
function requireTaskClass(o) {
  if (typeof o.taskClass === 'string' && o.taskClass.trim() !== '') return o.taskClass;
  let valid = '';
  try {
    valid = ` Valid: ${Object.keys(new ReadinessEngine({ repoRoot: REPO_ROOT }).templates).join(', ')}.`;
  } catch { /* the registry is unreadable; the missing argument is still the thing to report */ }
  usageError(o.cmd, `--task-class is required — the contract is per class, so guessing one would grade the wrong task.${valid}`, o.json);
  process.exit(2);
}

/** The task id the caller named, or exit 2. Same reasoning as requireTaskClass. */
function requireTaskId(o) {
  if (typeof o.taskId === 'string' && o.taskId.trim() !== '') return o.taskId;
  usageError(o.cmd, '--task-id is required — evidence and claims belong to one task, so guessing an id would report on a different one.', o.json);
  process.exit(2);
}

/**
 * The single-item spelling of an evidence write, assembled from exactly the flags the caller gave.
 *
 * Absent flags stay absent. Filling a gap here with 'unknown'/'general' would move the omission out
 * of the caller's error message and into the stored record, where it reads as a measurement.
 * @param {Object} o parsed arguments
 * @returns {Object} a raw item for the write boundary to validate
 */
function evidenceItemFromFlags(o) {
  const item = {};
  if (o.kind !== undefined) item.kind = o.kind;
  if (o.provenance !== undefined) item.provenance = o.provenance;
  if (o.locator !== undefined) item.locator = o.locator;
  if (o.content !== undefined) item.content = o.content;
  if (o.establishes !== undefined) item.establishes = o.establishes;
  // Both halves of an observation travel together; a lone half must reach the write boundary as
  // the partial object it is, so the refusal names the missing field instead of dropping the pair.
  if (o.observedCommand !== undefined || o.observedExit !== undefined) {
    item.observation = {};
    if (o.observedCommand !== undefined) item.observation.command = o.observedCommand;
    if (o.observedExit !== undefined) item.observation.exitCode = o.observedExit;
  }
  const source = {};
  if (o.provider !== undefined) source.provider = o.provider;
  if (o.capability !== undefined) source.capability = o.capability;
  if (Object.keys(source).length > 0) item.source = source;
  return item;
}

/**
 * Forward one parsed invocation to its runtime verb's implementation, or exit 1 naming an unknown
 * command. Argument shaping stays here (requireTaskClass/requireTaskId/evidenceItemFromFlags
 * validate parsed CLI arguments, which is the CLI's job, not a library's); everything else belongs
 * to the engine module each case names.
 * @param {Object} o parsed arguments
 */
function dispatchRuntimeCommand(o) {
  switch (o.cmd) {
    // REPO_ROOT locates the capability registry; projectRoot is the tree whose index freshness
    // and build/test commands are being reported on, which follows the usual scope rules.
    case 'capabilities': return handleCapabilitiesCommand({ json: o.json, check: o.check, repoRoot: REPO_ROOT });
    case 'doctor': return handleDoctorCommand({ json: o.json, repoRoot: REPO_ROOT, projectRoot: evidenceRoot(o) });
    // REPO_ROOT locates the registry (templates ship with the package); stateRoot locates the
    // caller's evidence, which follows the same scope rules as every other command: -g means
    // $HOME, otherwise the positional project root (default cwd).
    // `o.taskClass || 'feature'` and `o.taskId || 'default'` used to sit here. Both re-created
    // the identity defect readiness.js fails closed on: omitting either argument produced a
    // confident verdict about a task or a contract the caller never named. Required now, and the
    // valid class set is named in the refusal.
    // The task-profile arguments are the caller's own statements and are forwarded only when
    // given. They exist because without them no readiness template can ever reach READY —
    // every one of the five has at least one requirement satisfied from the profile rather
    // than from evidence, so the gate had one reachable answer for every task. Forwarding is
    // all this does: the handler names them back under `callerAsserted` so a stated input is
    // never mistaken for a measured one.
    case 'readiness': return handleReadinessCommand({ taskClass: requireTaskClass(o), taskId: requireTaskId(o), verificationPlan: o.verificationPlan, scopeClear: o.scope, invariants: o.invariants, userDecisionPending: o.userDecisionPending, mode: o.mode, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'evidence': return handleEvidenceCommand({ taskId: requireTaskId(o), action: o.action, item: evidenceItemFromFlags(o), batchPath: o.batchPath, evidenceId: o.evidenceId, replacedBy: o.replacedBy, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    // Run-ledger views. They resolve their own ledger the way the dispatcher does (nearest
    // `.doflow` walking up, or the global one) rather than assuming cwd is the project root, so
    // a view invoked from a subdirectory reads the runs that were actually recorded.
    // Exit codes follow design §4.2 and are set by the handler itself: 0 = answered, 1 = a
    // finding the caller must act on.
    case 'trace': return handleTraceCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    case 'stats': return handleStatsCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    case 'indicators': return handleIndicatorsCommand({ json: o.json, projectRoot: evidenceRoot(o) });
    case 'discover': return handleDiscoverCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    // No REPO_ROOT: the scaffold's repo root is the *caller's* repo, reported by the resolver,
    // because the plan's `files:` paths are relative to it. Passing the DoFlow install here
    // would detect the wrong language and mirror the wrong tree.
    case 'scaffold': return handleScaffoldCommand({ json: o.json, projectRoot: evidenceRoot(o), slug: o.slug });
    // The rest of design §4.2's Node arm. REPO_ROOT locates the registries that ship with the
    // package (workflows, capabilities, verification); evidenceRoot(o) locates the caller's own
    // state and source tree, following the same scope rules as every other command.
    case 'classify': return handleClassifyCommand({ taskClass: o.taskClass, rationale: o.rationale, proposedBy: o.proposedBy, callingSkill: o.callingSkill, json: o.json });
    case 'workflow': return handleWorkflowCommand({ taskClass: o.taskClass, json: o.json });
    case 'orchestrate': return handleOrchestrateCommand({ action: o.action, taskId: o.taskId, taskClass: o.taskClass, stage: o.stage, gate: o.gate, node: o.node, decision: o.decision, note: o.note, reason: o.reason, forced: o.forced, verificationPlan: o.verificationPlan, scope: o.scope, invariants: o.invariants, result: o.result, callingSkill: o.callingSkill, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'retrieve': return handleRetrieveCommand({ query: o.query, top: o.top, json: o.json });
    case 'model-role': return handleModelRoleCommand({ role: o.role, exclude: o.exclude, json: o.json, repoRoot: REPO_ROOT });
    case 'route': return handleRouteCommand({ intent: o.intent, query: o.query, check: o.check, json: o.json, projectRoot: evidenceRoot(o) });
    case 'claim': return handleClaimCommand({ taskId: requireTaskId(o), action: o.action, statement: o.statement, claimId: o.claimId, evidenceId: o.evidenceId, replacedBy: o.replacedBy, relation: o.relation, role: o.role, json: o.json, stateRoot: evidenceRoot(o) });
    case 'context-pack': return handleContextPackCommand({ taskId: requireTaskId(o), taskClass: o.taskClass, objective: o.objective, json: o.json, stateRoot: evidenceRoot(o) });
    case 'retrieval-plan': return handleRetrievalPlanCommand({ taskId: requireTaskId(o), action: o.action, need: o.need, stage: o.stage, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'outcome': return handleOutcomeCommand({ taskId: requireTaskId(o), action: o.action, state: o.state, taskClass: o.taskClass, stage: o.stage, readiness: o.readiness, verification: o.verification, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'verify': return handleVerifyCommand({ taskId: requireTaskId(o), action: o.action, risk: o.risk, planPath: o.planPath, json: o.json, projectRoot: evidenceRoot(o) });
    case 'leak-scan': return handleLeakScanCommand({ paths: o.paths, exclude: o.exclude, json: o.json, repoRoot: evidenceRoot(o) });
    case 'recover': return handleRecoverCommand({ errorMessage: o.errorMessage, failedChecks: o.failedChecks, iteration: o.iteration, agent: o.agent, json: o.json });
    default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
  }
}

module.exports = { dispatchRuntimeCommand };
