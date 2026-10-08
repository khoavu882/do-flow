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
const fs = require('node:fs');
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
const { handleResearchRequestCommand } = require('../runtime/research-request');
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
const { handleDecisionCommand } = require('../runtime/decision-register');
const { handleFollowupCommand, handleLifecycleCommand, handleGoalCommand } = require('../runtime/lifecycle/cli');
// Required on first use, so a CLI whose failure modules cannot be loaded still runs every other verb.
function handleFailureCommand(options) { return require('../runtime/failure/cli').handleFailureCommand(options); }
const { handleInventoryCommand } = require('../runtime/inventory');
const { finishRuntime, usageError } = require('../runtime/cli-result');
const { setDefaultSlug, invalidSlugRefusal, slugNamesNoFeature } = require('../runtime/task-scope');
const { listCheckouts } = require('../runtime/checkouts');
const { featureSlugFor } = require('../runtime/implementation-gate');
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

/** Verbs that read or write per-task records, and so accept `--slug` (IC-002). */
const TASK_STORE_VERBS = new Set(['evidence', 'claim', 'readiness', 'context-pack', 'research-request', 'outcome', 'retrieval-plan']);

/** Verbs that build a task's readiness: run from a linked worktree whose feature folder lives only
 * in the main checkout, they keep the task's records there, beside the folder their evidence names. */
const FEATURE_STORE_VERBS = new Set(['evidence', 'claim', 'readiness']);

/**
 * The main checkout, when `o` runs one of FEATURE_STORE_VERBS in a linked worktree that lacks the
 * task's feature folder and the main checkout holds it; null otherwise. The feature is `--slug`,
 * else the branch's. A locator such as `agent-docs/doflow/<slug>/plan.md` resolves only there, and
 * the readiness record written there is the one verify, orchestrate and the edit hook read from
 * the worktree.
 * @param {Object} o parsed arguments
 * @returns {{root: string, slug: string}|null}
 */
function featureStoreRoot(o) {
  if (!FEATURE_STORE_VERBS.has(o.cmd) || o.global) return null;
  const checkouts = listCheckouts({ cwd: evidenceRoot(o) });
  if (!checkouts.isLinked) return null;
  const slug = featureSlugFor({ projectRoot: checkouts.current, slug: o.slug });
  const folder = (root) => path.join(root, 'agent-docs', 'doflow', slug || '');
  if (!slug || fs.existsSync(folder(checkouts.current)) || !fs.existsSync(folder(checkouts.main))) return null;
  return { root: checkouts.main, slug };
}

/**
 * Forward one parsed invocation to its runtime verb's implementation, or exit 1 naming an unknown
 * command. Argument shaping stays here (requireTaskClass/requireTaskId/evidenceItemFromFlags
 * validate parsed CLI arguments, which is the CLI's job, not a library's); everything else belongs
 * to the engine module each case names.
 * @param {Object} o parsed arguments
 */
function dispatchRuntimeCommand(o) {
  // A slug becomes a directory name and a state key, so one that could name a path is refused
  // here, once, for every verb that reads `--slug`, before any of them reads or writes state
  // (FR-013, IC-009). A well-formed slug that names no feature is the verbs' own business.
  const refusal = invalidSlugRefusal(o.slug);
  if (refusal) {
    if (o.json) console.log(JSON.stringify(refusal, null, 2));
    else console.error(`doflow ${o.cmd}: ${refusal.error}: ${refusal.message}`);
    return finishRuntime(2);
  }
  // `--slug` names the feature a task-store verb's records belong to (task-scope.js). Set once
  // here so the verbs whose handlers build their own ledger (readiness, evidence) route the same
  // way as the ones that take `slug` directly. The orchestration journal is keyed by slug already.
  // Reset on every dispatch, so one invocation's slug can never carry into the next in-process call.
  const featureStore = featureStoreRoot(o);
  const storeRoot = featureStore ? featureStore.root : evidenceRoot(o);
  const storeSlug = featureStore ? featureStore.slug : o.slug;
  setDefaultSlug(TASK_STORE_VERBS.has(o.cmd) ? storeSlug : null);
  if (featureStore) {
    console.error(`doflow ${o.cmd}: note: feature '${storeSlug}' lives in the main checkout ${storeRoot}; this task's records are read and written there`);
  }
  // A well-formed slug that names no feature changes nothing (the records go to the shared task
  // store), but the caller typed it expecting an effect, so say so once, on stderr only.
  if (!featureStore && TASK_STORE_VERBS.has(o.cmd) && typeof o.slug === 'string' && o.slug !== ''
    && slugNamesNoFeature({ projectRoot: evidenceRoot(o), slug: o.slug })) {
    console.error(`doflow ${o.cmd}: note: --slug '${o.slug}' names no feature; using the shared task store`);
  }
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
    case 'readiness': return handleReadinessCommand({ taskClass: requireTaskClass(o), taskId: requireTaskId(o), verificationPlan: o.verificationPlan, scopeClear: o.scope, invariants: o.invariants, userDecisionPending: o.userDecisionPending, mode: o.mode, slug: storeSlug, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot });
    case 'evidence': return handleEvidenceCommand({ taskId: requireTaskId(o), action: o.action, item: evidenceItemFromFlags(o), batchPath: o.batchPath, evidenceId: o.evidenceId, replacedBy: o.replacedBy, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot });
    // Run-ledger views. They resolve their own ledger the way the dispatcher does (nearest
    // `.doflow` walking up, or the global one) rather than assuming cwd is the project root, so
    // a view invoked from a subdirectory reads the runs that were actually recorded.
    // Exit codes follow design §4.2 and are set by the handler itself: 0 = answered, 1 = a
    // finding the caller must act on.
    case 'trace': return handleTraceCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    case 'stats': return handleStatsCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    case 'indicators': return handleIndicatorsCommand({ json: o.json, projectRoot: evidenceRoot(o) });
    case 'discover': return handleDiscoverCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    // Deliberately NOT evidenceRoot(o): this is the one verb that reads both scopes in one
    // invocation (IC-001), so the project root is always the positional (default cwd) and never
    // $HOME, and `-g` is forwarded to be refused by the handler rather than silently narrowing a
    // report whose whole purpose is to be cross-scope. The global scope's own root is derived from
    // the process home directory inside the lifecycle view (design R7) and is not an argument.
    case 'inventory': return handleInventoryCommand({ json: o.json, global: o.global, targets: o.targets, repoRoot: REPO_ROOT, projectRoot: path.resolve(o.positional[0] || '.') });
    // No REPO_ROOT: the scaffold's repo root is the *caller's* repo, reported by the resolver,
    // because the plan's `files:` paths are relative to it. Passing the DoFlow install here
    // would detect the wrong language and mirror the wrong tree.
    case 'scaffold': return handleScaffoldCommand({ json: o.json, projectRoot: evidenceRoot(o), slug: o.slug });
    // The feature is resolved from the working directory (or --slug) by the same resolver
    // `scaffold` uses; the flags are the caller's own statements, validated by the register module.
    case 'decision': return handleDecisionCommand({ action: o.action, projectRoot: evidenceRoot(o), slug: o.slug, json: o.json, flags: { topic: o.topic, statement: o.statement, channel: o.channel, stage: o.stage, rationale: o.rationale, supersedes: o.supersedes, refs: o.refs, source: o.source, batch: o.batchPath, all: o.all } });
    // Feature 046: the project's follow-up store lives at the repository root (never `-g`, which
    // the handlers refuse), so the working directory is the starting point, not a scope switch.
    case 'followup': return handleFollowupCommand({ action: o.actionGiven ? o.action : undefined, cwd: evidenceRoot(o), global: o.global, slug: o.slug, json: o.json, flags: { statement: o.statement, stage: o.stage, source: o.source, taskClass: o.taskClass, taskId: o.taskId, release: o.release, batch: o.batchPath, channel: o.channel, state: o.state, ids: o.ids, as: o.as, reason: o.reason, evidence: o.evidence, title: o.title, file: o.file, stdin: o.stdin, text: o.text, feature: o.feature, tag: o.tag, confirm: o.confirm, exclude: o.exclude } });
    case 'lifecycle': return handleLifecycleCommand({ action: o.actionGiven ? o.action : undefined, cwd: evidenceRoot(o), global: o.global, slug: o.slug, json: o.json, flags: { take: o.take, intent: o.intent, goal: o.goal, maintain: o.maintain, since: o.since, tag: o.tag, confirm: o.confirm, feature: o.feature, exclude: o.exclude, reason: o.reason, channel: o.channel } });
    case 'goal': return handleGoalCommand({ action: o.actionGiven ? o.action : undefined, cwd: evidenceRoot(o), global: o.global, slug: o.slug, json: o.json, flags: { goal: o.goal, statement: o.statement, item: o.item, text: o.text, evidence: o.evidence, unmet: o.unmet, replace: o.replace, reason: o.reason, channel: o.channel } });
    // The failure store is per machine, so `-g` changes nothing and the working directory only matters
    // to `settle --as imported`, which looks for the DoFlow repository from there.
    case 'failure': return handleFailureCommand({ action: o.actionGiven ? o.action : undefined, cwd: path.resolve(o.positional[0] || '.'), json: o.json, all: o.all, flags: { fp: o.fp, as: o.as, reason: o.reason, set: o.set } });
    // The rest of design §4.2's Node arm. REPO_ROOT locates the registries that ship with the
    // package (workflows, capabilities, verification); evidenceRoot(o) locates the caller's own
    // state and source tree, following the same scope rules as every other command.
    case 'classify': return handleClassifyCommand({ taskClass: o.taskClass, rationale: o.rationale, proposedBy: o.proposedBy, callingSkill: o.callingSkill, json: o.json });
    case 'workflow': return handleWorkflowCommand({ taskClass: o.taskClass, json: o.json });
    case 'orchestrate': return handleOrchestrateCommand({ action: o.action, taskId: o.taskId, taskClass: o.taskClass, stage: o.stage, gate: o.gate, node: o.node, decision: o.decision, note: o.note, reason: o.reason, forced: o.forced, verificationPlan: o.verificationPlan, scope: o.scope, invariants: o.invariants, result: o.result, callingSkill: o.callingSkill, slug: o.slug, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'research-request': return handleResearchRequestCommand({ slug: o.slug, action: o.action === 'status' ? 'list' : o.action, taskId: requireTaskId(o), stageId: o.stageId, question: o.question, reason: o.reason, blocking: o.blocking === undefined ? undefined : o.blocking === 'true' ? true : o.blocking === 'false' ? false : o.blocking, requestId: o.requestId, outcome: o.researchOutcome, claimId: o.claimId, evidenceIds: o.evidenceIds, gap: o.gap, json: o.json, projectRoot: evidenceRoot(o) });
    case 'retrieve': return handleRetrieveCommand({ query: o.query, top: o.top, json: o.json });
    case 'model-role': return handleModelRoleCommand({ role: o.role, exclude: o.exclude, json: o.json, repoRoot: REPO_ROOT });
    case 'route': return handleRouteCommand({ intent: o.intent, query: o.query, check: o.check, json: o.json, projectRoot: evidenceRoot(o) });
    case 'claim': return handleClaimCommand({ slug: storeSlug, taskId: requireTaskId(o), action: o.action, statement: o.statement, claimId: o.claimId, evidenceId: o.evidenceId, replacedBy: o.replacedBy, relation: o.relation, role: o.role, json: o.json, stateRoot: storeRoot });
    case 'context-pack': return handleContextPackCommand({ taskId: requireTaskId(o), taskClass: o.taskClass, objective: o.objective, json: o.json, stateRoot: evidenceRoot(o), slug: o.slug });
    case 'retrieval-plan': return handleRetrievalPlanCommand({ slug: o.slug, taskId: requireTaskId(o), action: o.action, need: o.need, stage: o.stage, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'outcome': return handleOutcomeCommand({ slug: o.slug, taskId: requireTaskId(o), action: o.action, state: o.state, taskClass: o.taskClass, stage: o.stage, readiness: o.readiness, verification: o.verification, json: o.json, repoRoot: REPO_ROOT, stateRoot: evidenceRoot(o) });
    case 'verify': return handleVerifyCommand({ slug: o.slug, taskId: requireTaskId(o), action: o.action, risk: o.risk, planPath: o.planPath, scope: o.scope, json: o.json, projectRoot: evidenceRoot(o) });
    case 'leak-scan': return handleLeakScanCommand({ paths: o.paths, exclude: o.exclude, json: o.json, repoRoot: evidenceRoot(o) });
    case 'recover': return handleRecoverCommand({ errorMessage: o.errorMessage, failedChecks: o.failedChecks, iteration: o.iteration, agent: o.agent, json: o.json });
    default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
  }
}

module.exports = { dispatchRuntimeCommand };
