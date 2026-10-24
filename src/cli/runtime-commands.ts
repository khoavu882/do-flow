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
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const os = require('node:os');
const path = require('node:path');
const {
  handleCapabilitiesCommand, handleReadinessCommand, handleEvidenceCommand,
  handleContextEmitCommand, handleContextGrantCommand,
} = require('../runtime/cli.ts');
const { loadRegistry } = require('../registry/index.ts');
const { enforcementFor, UnknownEnforcementTarget } = require('../lifecycle/coverage.ts');
// `doctor` comes from the health module rather than src/runtime/cli.ts: the health-probe report
// (FR-013) supersedes the presence-check version, and one verb must have one implementation.
const { handleDoctorCommand } = require('../runtime/health.ts');
const { handleTraceCommand, handleStatsCommand, handleDiscoverCommand, resolveRunsLocation } = require('../runtime/trace/ledger.ts');
const { handleIndicatorsCommand } = require('../runtime/trace/indicators.ts');
// The rest of the verb surface design §4.2 declares. `classify`, `workflow`, `route`, `claim`,
// `context-pack`, `verify`, `recover` and `scaffold` each have exactly one implementation, in the
// engine module named on the right; this file only dispatches to them.
const { ReadinessEngine } = require('../runtime/readiness.ts');
const { handleClaimCommand } = require('../runtime/claims.ts');
const { handleClassifyCommand } = require('../runtime/task-classifier.ts');
const { handleWorkflowCommand } = require('../runtime/workflow-engine.ts');
const { handleOrchestrateCommand } = require('../runtime/workflow-orchestrator.ts');
const { handleResearchRequestCommand } = require('../runtime/research-request.ts');
const { handleTaskAttemptCommand } = require('../runtime/task-attempts.ts');
const { handleWorkerCommand } = require('../runtime/worker/command.ts');
const { handleDispatchCommand } = require('../runtime/dispatch/command.ts');
const { handleRetrieveCommand } = require('../runtime/knowledge/retrieval.ts');
const { handleModelRoleCommand } = require('../runtime/model-router.ts');
const { handleRouteCommand } = require('../runtime/capability-router.ts');
const { handleContextPackCommand } = require('../runtime/context-pack.ts');
const { handleRetrievalPlanCommand } = require('../runtime/retrieval-plan.ts');
const { handleOutcomeCommand } = require('../runtime/outcome.ts');
const { handleVerifyCommand, verifyStateRoot } = require('../runtime/verification/engine.ts');
const { handleLeakScanCommand } = require('../runtime/leak-scan.ts');
const { handleRecoverCommand } = require('../runtime/recovery.ts');
const { handleScaffoldCommand } = require('../runtime/scaffold/generate.ts');
const { handleDecisionCommand, isReservedChannel, CHANNEL_RESERVED } = require('../runtime/decision-register.ts');
const { handleFollowupCommand, handleLifecycleCommand, handleGoalCommand } = require('../runtime/lifecycle/cli.ts');
const { projectRoot: lifecycleProjectRoot } = require('../runtime/lifecycle/root.ts');
const { upkeepAfterVerb } = require('../runtime/storage/upkeep.ts');
const { handleStorageCommand } = require('../runtime/storage/cli.ts');
const { handleRoadmapCommand, resolveMainRoot } = require('../runtime/roadmap/loop.ts');
const { handlePlanCheckCommand } = require('../runtime/plan-check.ts');
const { handleSlotCommand } = require('../runtime/slot-command.ts');
const { handleReviewCommand } = require('../runtime/review/command.ts');
const { handleProtocolCommand } = require('../runtime/review/protocol-command.ts');
// `plan-check` is read-only (115 IC-001): no upkeep, which would write `.gitignore` and `upkeep-due`.
// `review` writes only its one telemetry line (095 IC-003).
// `protocol` only prints the registry and the resolved protocol (119 IC-004), so it has nothing to keep up.
// `primary` only prints the resolved main session (120 IC-008) and writes nothing.
const NO_UPKEEP = new Set(['storage', 'config', 'plan-check', 'review', 'protocol', 'primary']);
// Required on first use, so a CLI whose failure modules cannot be loaded still runs every other verb.
function handleFailureCommand(options: any): any { return require('../runtime/failure/cli.ts').handleFailureCommand(options); }
// The seed validator loads only for `roadmap seed`, and only this file may require it (G54).
function handleSeedCommand(options: any): any { return require('../runtime/roadmap/seed.ts').handleSeedCommand(options); }
// Settings support is needed only when the config verb runs.
function handleConfigCommand(options: any): any { return require('../runtime/settings/cli.ts').handleConfigCommand(options); }
// The primary verb (row 120 A.4) needs the settings resolver only when it runs.
function handlePrimaryCommand(options: any): any { return require('../runtime/context/primary-command.ts').handlePrimaryCommand(options); }
const { handleInventoryCommand } = require('../runtime/inventory/index.ts');
const { finishRuntime, usageError } = require('../runtime/cli-result.ts');
const { setRecordSlug, callerFeatureSlug, invalidSlugRefusal, slugNamesNoFeature } = require('../runtime/task-scope.ts');
const { listCheckouts, mayBeLinked } = require('../runtime/checkouts.ts');
const { taskStateRoot, sweepWorktreeRecords } = require('../runtime/state-root.ts');
const { featureSlugFor } = require('../runtime/implementation-gate.ts');
const { handleBriefToolsCommand } = require('../runtime/brief-tools.ts');
// Advice writers load settings/write.ts, so keep that surface off installer and other verb paths.
function handleAdviseCommand(options: any): any { return require('../runtime/advice/cli.ts').handleAdviseCommand(options); }
const { REPO_ROOT, buildAdapterRegistry } = require('./shared.ts');

/** Where `readiness`/`evidence` read and write per-task state. Mirrors scopeOf()'s rules so these
 * commands are scope-aware like the rest of the CLI, rather than defaulting to the DoFlow install
 * directory — which for an npm install is inside node_modules/. */
function evidenceRoot(o: any): string {
  if (o.global) return os.homedir();
  // `roadmap seed [<project>]` (113 IC-001): the sub-verb takes the first positional slot, so the project root is the one after it.
  if (o.cmd === 'roadmap' && o.positional[0] === 'seed') return path.resolve(o.positional[1] || '.');
  return path.resolve(o.positional[0] || '.');
}

/** The `trace` views that take the first positional slot: `spans` (088 IC-011), `analyze` (091 IC-001), `export` (091 IC-006). */
const TRACE_VIEWS = new Set(['spans', 'analyze', 'export']);

/** `trace spans|analyze|export [<project>]`: the view name takes the first positional slot, so the
 * project root is the one after it. Every other call is `evidenceRoot(o)`. */
function traceViewRoot(o: any): string {
  return o.cmd === 'trace' && TRACE_VIEWS.has(o.positional[0]) && !o.global ? path.resolve(o.positional[1] || '.') : evidenceRoot(o);
}

/** `roadmap`: the runner, or the `seed` sub-verb (113 IC-001), which takes the first positional slot and sets the exit code itself. */
function handleRoadmapVerbCommand(o: any): number {
  const action = o.actionGiven ? o.action : undefined;
  if (o.positional[0] === 'seed') return finishRuntime(handleSeedCommand({ action, draft: o.draft, json: o.json, cwd: process.cwd(), root: resolveMainRoot(evidenceRoot(o)) }));
  return handleRoadmapCommand({ action, check: o.check, json: o.json, run: o.run, row: o.row, cwd: evidenceRoot(o) });
}

/**
 * Where `trace analyze --emit followups --task-id` reads the task's evidence ledger: the store root
 * and record slug the `evidence` verb writes under (115 IC-004, C-1), so a linked worktree reads the
 * main checkout's namespaced ledger. Read only: no sweep, so a record still left in the worktree's
 * own store is not cited. Undefined when no ledger is read; the handler refuses the flag mix itself.
 */
function analyzeLedgerRoot(o: any): string | undefined {
  if (o.emit !== 'followups' || typeof o.taskId !== 'string') return undefined;
  const caller = traceViewRoot(o);
  const checkouts = !o.global && mayBeLinked(caller) ? listCheckouts({ cwd: caller }) : null;
  setRecordSlug(() => o.slug || callerFeatureSlug({ projectRoot: caller, taskId: o.taskId }) || null);
  return taskStateRoot({ global: o.global, positional: [caller] }, checkouts).root;
}

/** `trace`: the ledger trajectory, unchanged, or the `spans`, `analyze` or `export` view, whose modules load
 * only for that view so `trace` and `stats` read nothing new (NFR-010, 091 NFR-009). */
function handleTraceViewCommand(o: any): any {
  if (o.positional[0] === 'analyze') {
    return require('../runtime/trace/analyze.ts').handleTraceAnalyze({ positional: o.positional.slice(1), run: o.run, json: o.json, global: o.global,
      emit: o.emit, taskId: o.taskId, stateRoot: analyzeLedgerRoot(o) });
  }
  if (o.positional[0] === 'export') {
    return require('../runtime/trace/otlp-export.ts').handleTraceExport({
      positional: o.positional.slice(1),
      run: o.run,
      json: o.json,
      global: o.global,
      dryRun: o.dryRun,
      otlpHttp: o.otlpHttp,
    });
  }
  if (o.positional[0] !== 'spans') return handleTraceCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
  return require('../runtime/trace/spans.ts').handleTraceSpans({ positional: o.positional.slice(1), run: o.run, json: o.json, global: o.global });
}

/**
 * The task class the caller named, or exit 2 naming the valid set.
 *
 * `readiness` previously read `o.taskClass || 'feature'`. That is the identity defect readiness.ts
 * fixed this morning, reinstated one layer up: omitting `--task-class` produced a confident
 * READY/NEEDS_EVIDENCE verdict computed from the wrong contract, and nothing in the output said so.
 * The valid set comes from the readiness registry rather than a list written here, so it cannot
 * drift from the templates that actually exist.
 */
function requireTaskClass(o: any): string {
  if (typeof o.taskClass === 'string' && o.taskClass.trim() !== '') return o.taskClass;
  let valid = '';
  try {
    valid = ` Valid: ${Object.keys(new ReadinessEngine({ repoRoot: REPO_ROOT }).templates).join(', ')}.`;
  } catch { /* the registry is unreadable; the missing argument is still the thing to report */ }
  usageError(o.cmd, `--task-class is required — the contract is per class, so guessing one would grade the wrong task.${valid}`, o.json);
  process.exit(2);
}

/** The task id the caller named, or exit 2. Same reasoning as requireTaskClass. */
function requireTaskId(o: any): string {
  if (typeof o.taskId === 'string' && o.taskId.trim() !== '') return o.taskId;
  usageError(o.cmd, '--task-id is required — evidence and claims belong to one task, so guessing an id would report on a different one.', o.json);
  process.exit(2);
}

/**
 * The single-item spelling of an evidence write, assembled from exactly the flags the caller gave.
 *
 * Absent flags stay absent. Filling a gap here with 'unknown'/'general' would move the omission out
 * of the caller's error message and into the stored record, where it reads as a measurement.
 */
function evidenceItemFromFlags(o: any): any {
  const item: any = {};
  if (o.kind !== undefined) item.kind = o.kind;
  if (o.provenance !== undefined) item.provenance = o.provenance;
  if (o.locator !== undefined) item.locator = o.locator;
  if (o.content !== undefined) item.content = o.content;
  if (o.establishes !== undefined) item.establishes = o.establishes;
  if (o.need !== undefined) item.need = o.need;
  if (o.result !== undefined) item.result = o.result;
  if (o.absence !== undefined) item.absence = o.absence;
  // Both halves of an observation travel together; a lone half must reach the write boundary as
  // the partial object it is, so the refusal names the missing field instead of dropping the pair.
  if (o.observedCommand !== undefined || o.observedExit !== undefined) {
    item.observation = {};
    if (o.observedCommand !== undefined) item.observation.command = o.observedCommand;
    if (o.observedExit !== undefined) item.observation.exitCode = o.observedExit;
  }
  const source: any = {};
  if (o.provider !== undefined) source.provider = o.provider;
  if (o.capability !== undefined) source.capability = o.capability;
  if (Object.keys(source).length > 0) item.source = source;
  return item;
}

/** Verbs that read or write per-task records, and so accept `--slug` (IC-002). Their records, and
 * `orchestrate`'s run and `context-emit`'s delivery, live in `taskStateRoot` (115 IC-004). */
const TASK_STORE_VERBS = new Set(['evidence', 'claim', 'readiness', 'context-pack', 'research-request', 'outcome', 'retrieval-plan', 'retrieve']);

/** The checkout a call runs in: `context-emit`'s `--cwd`, else the positional project root. */
function callerRoot(o: any): string {
  return o.cmd === 'context-emit' && typeof o.cwd === 'string' && o.cwd !== '' ? path.resolve(o.cwd) : evidenceRoot(o);
}

/** The store conflicts a sweep found, one line each (IC-006). */
function conflictText(o: any, sweep: any): string {
  const lines = sweep.conflicts.map((c: any) => (c.reason === 'link' ? `  ${c.worktree} -> ${c.main}: a link on the way, nothing is moved through it`
    : c.reason === 'same-file' ? `  ${c.worktree} and ${c.main} are one file` : `  ${c.worktree} differs from ${c.main}`));
  return `doflow ${o.cmd}: store-conflict: ${sweep.conflicts.length} record(s) in this worktree could not be moved to the main checkout; `
    + `files already moved stay moved. Keep one copy of each pair and remove the other, then re-run.\n${lines.join('\n')}`;
}

/**
 * Forward one parsed invocation to its runtime verb's implementation, or exit 1 naming an unknown
 * command. Argument shaping stays here (requireTaskClass/requireTaskId/evidenceItemFromFlags
 * validate parsed CLI arguments, which is the CLI's job, not a library's); everything else belongs
 * to the engine module each case names.
 */
function dispatchRuntimeCommandInner(o: any, moment: any): any {
  // IC-005: no caller names a decider. orchestrate takes no --by, and the channel `policy` (decided
  // by autopilot) is refused on every verb, before any state is read or written.
  if (o.cmd === 'orchestrate' && o.by !== undefined) {
    return usageError('orchestrate', '--by is not accepted; the runtime derives the gate decider', o.json);
  }
  if (isReservedChannel(o.channel)) {
    return usageError(o.cmd, CHANNEL_RESERVED, o.json);
  }
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
  // `retrieve` is a task-store verb only as bound code retrieval (--scope code with --task-id or --slug):
  // guidance retrieval and unbound code retrieval record nothing in a feature store, so they keep the
  // pre-079 dispatch (no checkout listing, no feature resolver, no store note).
  const storeVerb = (verbs: Set<string>) => verbs.has(o.cmd) && (o.cmd !== 'retrieve' || (o.scope === 'code' && Boolean(o.taskId || o.slug)));
  const recordVerb = storeVerb(TASK_STORE_VERBS) || o.cmd === 'orchestrate' || o.cmd === 'context-emit';
  const caller = callerRoot(o);
  // `evidence` always lists: its attempt lookup reuses the main checkout from this one listing.
  const checkouts = recordVerb && !o.global && (o.cmd === 'evidence' || mayBeLinked(caller))
    ? listCheckouts({ cwd: caller }) : null;
  // 115 IC-004: a linked, non-sandbox worktree keeps every per-task record in the main checkout.
  const { root: storeRoot, redirected } = recordVerb ? taskStateRoot(o, checkouts) : { root: evidenceRoot(o), redirected: false };
  const attemptRoot = checkouts?.ok && !checkouts.sandbox ? (checkouts.main || checkouts.current || null) : null;
  // Use the same root resolver as the handler: task redirection, the nearest run ledger,
  // and lifecycle's shared main-worktree store are deliberately different scopes.
  try {
    if (['trace', 'stats', 'discover'].includes(o.cmd)) {
      moment.projectRoot = path.dirname(resolveRunsLocation({ start: traceViewRoot(o), global: o.global }).configDir);
    } else if (['followup', 'lifecycle', 'goal', 'task-attempt', 'worker', 'dispatch'].includes(o.cmd)) {
      moment.projectRoot = lifecycleProjectRoot(evidenceRoot(o));
    } else if (o.cmd === 'plan-check' || o.cmd === 'slot') {
      moment.projectRoot = process.cwd(); // the first positional of plan-check is a file, never a project root
    } else if (o.cmd === 'verify') {
      moment.projectRoot = verifyStateRoot({ start: evidenceRoot(o) }).projectRoot; // the store verify writes, never a cwd fragment
    } else {
      moment.projectRoot = storeRoot;
    }
  } catch { /* a failed upkeep lookup must not change the verb's answer */ }
  // 115 C-1: one record slug per call, `--slug`, else the feature of the checkout the verb runs in,
  // used by every store the call touches (task-scope.ts). It is looked up on first use, so a
  // `context-emit` event that compiles no pack spawns no resolver. Reset on every dispatch, so one
  // invocation's slug can never carry into the next in-process call. `retrieve` is a task-store verb
  // only as bound code retrieval (--scope code with --task-id or --slug).
  let slugMemo: string | null | undefined;
  const recordSlug = (): string | null => {
    if (slugMemo === undefined) {
      try { slugMemo = o.slug || callerFeatureSlug({ projectRoot: caller, taskId: o.taskId }) || null; } catch { slugMemo = null; }
    }
    return slugMemo as string | null;
  };
  setRecordSlug(recordVerb ? recordSlug : undefined);
  const storeSlug = recordVerb && o.cmd !== 'context-emit' ? recordSlug() : undefined;
  if (redirected && o.cmd !== 'context-emit') {
    console.error(`doflow ${o.cmd}: note: records are kept in the main checkout ${storeRoot}`);
  }
  // A well-formed slug that names no feature folder still names the records' namespace, but the
  // caller typed it expecting a feature, so say so once, on stderr only.
  if (storeVerb(TASK_STORE_VERBS) && typeof o.slug === 'string' && o.slug !== ''
    && slugNamesNoFeature({ projectRoots: redirected ? [caller, storeRoot] : [caller], slug: o.slug })) {
    console.error(`doflow ${o.cmd}: note: --slug '${o.slug}' names no feature folder; its records are kept under that slug`);
  }
  // 115 IC-006: every record left in the worktree's own store moves to the main checkout first, in one
  // locked sweep; a record held in both with different bytes refuses the call before the verb runs.
  // 092 IC-001: the orchestrate reads (list, status) write nothing, so they never sweep: they read the
  // main checkout's store and see a record still left in this worktree as another checkout's
  // (`orchestrationRuns`, `findRunFile`). The next write verb from here sweeps it as before.
  const orchestrateRead = o.cmd === 'orchestrate' && (o.action === 'list' || o.action === 'status');
  if (redirected && !orchestrateRead) {
    const sweep = sweepWorktreeRecords({ mainRoot: storeRoot, worktreeRoot: checkouts.current, recordSlug });
    if (!sweep.ok) {
      if (o.json) console.log(JSON.stringify(sweep, null, 2));
      else console.error(conflictText(o, sweep));
      return finishRuntime(2);
    }
  }
  switch (o.cmd) {
    // REPO_ROOT locates the capability registry; projectRoot is the tree whose index freshness
    // and build/test commands are being reported on, which follows the usual scope rules.
    case 'capabilities': return handleCapabilitiesCommand({ json: o.json, check: o.check, repoRoot: REPO_ROOT });
    case 'enforcement': return handleEnforcementCommand(o);
    case 'doctor': return handleDoctorCommand({ json: o.json, repoRoot: REPO_ROOT, projectRoot: evidenceRoot(o), adapters: buildAdapterRegistry() });
    // REPO_ROOT locates the registry (templates ship with the package); stateRoot locates the
    // caller's evidence, which follows the same scope rules as every other command: -g means
    // $HOME, otherwise the positional project root (default cwd).
    // `o.taskClass || 'feature'` and `o.taskId || 'default'` used to sit here. Both re-created
    // the identity defect readiness.ts fails closed on: omitting either argument produced a
    // confident verdict about a task or a contract the caller never named. Required now, and the
    // valid class set is named in the refusal.
    // The task-profile arguments are the caller's own statements and are forwarded only when
    // given. They exist because without them no readiness template can ever reach READY —
    // every one of the five has at least one requirement satisfied from the profile rather
    // than from evidence, so the gate had one reachable answer for every task. Forwarding is
    // all this does: the handler names them back under `callerAsserted` so a stated input is
    // never mistaken for a measured one.
    case 'readiness': return handleReadinessCommand({ taskClass: requireTaskClass(o), taskId: requireTaskId(o), verificationPlan: o.verificationPlan, scopeClear: o.scope, invariants: o.invariants, userDecisionPending: o.userDecisionPending, mode: o.mode, slug: storeSlug, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot, sourceRoot: evidenceRoot(o) });
    case 'evidence': return handleEvidenceCommand({ taskId: requireTaskId(o), action: o.action, item: evidenceItemFromFlags(o), batchPath: o.batchPath, evidenceId: o.evidenceId, replacedBy: o.replacedBy, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot, slug: storeSlug, sourceRoot: evidenceRoot(o), attemptRoot });
    // Run-ledger views. They resolve their own ledger the way the dispatcher does (nearest
    // `.doflow` walking up, or the global one) rather than assuming cwd is the project root, so
    // a view invoked from a subdirectory reads the runs that were actually recorded.
    // Exit codes follow design §4.2 and are set by the handler itself: 0 = answered, 1 = a
    // finding the caller must act on.
    case 'trace': return handleTraceViewCommand(o);
    case 'stats': return handleStatsCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    case 'indicators': return handleIndicatorsCommand({ json: o.json, projectRoot: evidenceRoot(o) });
    case 'discover': return handleDiscoverCommand({ json: o.json, days: o.days, global: o.global, projectRoot: evidenceRoot(o) });
    // Deliberately NOT evidenceRoot(o): this is the one verb that reads both scopes in one
    // invocation (IC-001), so the project root is always the positional (default cwd) and never
    // $HOME, and `-g` is forwarded to be refused by the handler rather than silently narrowing a
    // report whose whole purpose is to be cross-scope. The global scope's own root is derived from
    // the process home directory inside the lifecycle view (design R7) and is not an argument.
    case 'inventory': return handleInventoryCommand({ json: o.json, global: o.global, targets: o.targets, repoRoot: REPO_ROOT, projectRoot: path.resolve(o.positional[0] || '.') });
    case 'storage': return handleStorageCommand({ action: o.actionGiven ? o.action : 'report', json: o.json, global: o.global, projectRoot: evidenceRoot(o) });
    case 'config': return handleConfigCommand({ json: o.json, global: o.global, showOrigin: o.showOrigin, positional: o.positional, layer: o.layer, preparedRun: o.preparedRun, repoRoot: REPO_ROOT });
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
    case 'classify': return handleClassifyCommand({ taskClass: o.taskClass, rationale: o.rationale, proposedBy: o.proposedBy, callingSkill: o.callingSkill, request: o.request, requestFile: o.requestFile, taskId: o.taskId, projectRoot: evidenceRoot(o), json: o.json });
    case 'workflow': return handleWorkflowCommand({ taskClass: o.taskClass, json: o.json });
    case 'orchestrate': return handleOrchestrateCommand({ action: o.action, taskId: o.taskId, taskClass: o.taskClass, stage: o.stage, gate: o.gate, node: o.node, decision: o.decision, policy: o.policy, note: o.note, reason: o.reason, forced: o.forced, verificationPlan: o.verificationPlan, scope: o.scope, invariants: o.invariants, result: o.result, mcpOutcome: o.mcpOutcome, callingSkill: o.callingSkill, slug: o.slug, recordSlug: storeSlug, dryRun: o.dryRun, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot, sourceRoot: evidenceRoot(o), buildAdapters: buildAdapterRegistry });
    case 'research-request': return handleResearchRequestCommand({ slug: storeSlug, action: o.action === 'status' ? 'list' : o.action, taskId: requireTaskId(o), stageId: o.stageId, question: o.question, reason: o.reason, blocking: o.blocking === undefined ? undefined : o.blocking === 'true' ? true : o.blocking === 'false' ? false : o.blocking, requestId: o.requestId, outcome: o.researchOutcome, claimId: o.claimId, evidenceIds: o.evidenceIds, gap: o.gap, json: o.json, projectRoot: storeRoot, sourceRoot: evidenceRoot(o) });
    // The store is shared by every linked worktree of the clone (lifecycle's main-worktree root); the
    // feature is `--slug`, else the branch's, resolved the way decision and scaffold resolve it.
    case 'task-attempt': return handleTaskAttemptCommand({ action: o.actionGiven ? o.action : undefined, slug: o.slug, task: o.task, owner: o.owner, mode: o.mode, token: o.token, result: o.result, evidenceId: o.evidenceId, reason: o.reason, ownerOverride: o.ownerOverride, epoch: o.epoch, reserveTokens: o.reserveTokens, execWorktree: o.execWorktree, tokens: o.tokens, tokensBasis: o.tokensBasis, budgetAttempts: o.budgetAttempts, budgetTokens: o.budgetTokens, by: o.by, ack: o.ack, adoptUnowned: Boolean(o.adoptUnowned), json: o.json, cwd: evidenceRoot(o), resolveSlug: (cwd: string) => featureSlugFor({ projectRoot: cwd }) });
    // 081 IC-026: the worker adapter reads and writes the same main-worktree store as task-attempt.
    case 'worker': return handleWorkerCommand({ action: o.actionGiven ? o.action : undefined, slug: o.slug, harness: o.harness, need: o.need, modelCheck: o.modelCheck, budgetTokens: o.budgetTokens, task: o.task, token: o.token, promptFile: o.promptFile, timeoutSeconds: o.timeoutSeconds, wait: Boolean(o.wait), edit: Boolean(o.edit), childOf: o.childOf, request: o.request, execWorktree: o.execWorktree, workerRun: o.workerRun, checks: o.checks, out: o.out, by: o.by, reason: o.reason, json: o.json, env: process.env, cwd: evidenceRoot(o), resolveSlug: (cwd: string) => featureSlugFor({ projectRoot: cwd }) });
    // 082 IC-001, IC-038: the dispatch loop shares the main-worktree store root with task-attempt.
    // `--status` is parsed under `attemptStatus` (retrieval-plan's key), so it is renamed here.
    case 'dispatch': return handleDispatchCommand({ action: o.actionGiven ? o.action : undefined, slug: o.slug, by: o.by, reason: o.reason, concurrency: o.concurrency, mode: o.mode, billingCap: o.billingCap, verifyArgv: o.verifyArgv, verifySeconds: o.verifySeconds, attemptSeconds: o.attemptSeconds, reserveTokens: o.reserveTokens, budgetAttempts: o.budgetAttempts, budgetTokens: o.budgetTokens, spawnGrant: o.spawnGrant, harness: o.harness, need: o.need, maxSeconds: o.maxSeconds, dispatch: o.dispatch, status: o.attemptStatus, summary: o.summary, blocker: o.blocker, tokens: o.tokens, tokensBasis: o.tokensBasis, promptFile: o.promptFile, requestId: o.requestId, task: o.task, ack: o.ack, fallback: o.fallback, ladder: o.ladder, json: o.json, env: process.env, cwd: evidenceRoot(o), resolveSlug: (cwd: string) => featureSlugFor({ projectRoot: cwd }) });
    // Code scope keeps two roots: the search root is --root or cwd (the invoking checkout), the state root is
    // the feature store above. Guidance gets no stateRoot, exactly as before 079, so it resolves from cwd.
    case 'retrieve': return handleRetrieveCommand({ query: o.query, top: o.top, json: o.json, scope: o.scope,
      profile: o.profile, root: o.root, indexAction: o.indexAction, modelPath: o.modelPath,
      taskId: o.taskId, need: o.need, slug: storeSlug, stateRoot: o.scope === 'code' ? storeRoot : undefined, repoRoot: REPO_ROOT });
    case 'brief-tools': return handleBriefToolsCommand({ owner: o.owner, tier: o.tier, harness: o.harness, slug: o.slug, headingLevel: o.headingLevel, tasks: o.tasks, json: o.json, repoRoot: REPO_ROOT, projectRoot: storeRoot, buildAdapters: buildAdapterRegistry });
    case 'advise': return handleAdviseCommand({ action: o.action, actionGiven: o.actionGiven, kind: o.kind, server: o.server, state: o.state, stateFile: o.stateFile, staticAnswer: o.staticAnswer, questionsFile: o.questionsFile, taskId: o.taskId, pickId: o.pickId, actual: o.actual, model: o.model, endpoint: o.endpoint, off: o.off, project: o.project, force: o.force, global: o.global, json: o.json, projectRoot: evidenceRoot(o) });
    case 'model-role': return handleModelRoleCommand({ role: o.role, exclude: o.exclude, excludeFamilies: o.excludeFamily, json: o.json, repoRoot: REPO_ROOT });
    case 'route': return handleRouteCommand({ intent: o.intent, query: o.query, check: o.check, json: o.json, projectRoot: evidenceRoot(o) });
    case 'claim': return handleClaimCommand({ slug: storeSlug, taskId: requireTaskId(o), action: o.action, statement: o.statement, claimId: o.claimId, evidenceId: o.evidenceId, replacedBy: o.replacedBy, relation: o.relation, role: o.role, json: o.json, stateRoot: storeRoot });
    case 'context-pack': return handleContextPackCommand({ taskId: requireTaskId(o), taskClass: o.taskClass, objective: o.objective, json: o.json, stateRoot: storeRoot, sourceRoot: evidenceRoot(o), slug: storeSlug, mandatoryFile: o.mandatoryFile, harness: o.harness, maxBytes: o.maxBytes, bare: o.bare, noRecord: o.noRecord, reason: o.reason, since: o.since, expand: o.expand });
    // 078 IC-005 and IC-013: identity is the process environment's alone, never a flag.
    case 'context-emit': return handleContextEmitCommand({ event: o.event, cwd: o.cwd, session: o.session, harness: o.harness, nudge: o.nudge, maxBytes: o.maxBytes, taskId: o.taskId || undefined, slug: o.slug || undefined, stateRoot: redirected ? storeRoot : undefined, peek: o.peek, json: o.json });
    case 'context-grant': return handleContextGrantCommand({ summary: o.summary, toRun: o.toRun, toLineage: o.toLineage, fromWorktree: o.fromWorktree, fromRun: o.fromRun, fromLineage: o.fromLineage, maxBytes: o.maxBytes, json: o.json });
    case 'retrieval-plan': return handleRetrievalPlanCommand({ slug: storeSlug, taskId: requireTaskId(o), action: o.action, need: o.need, stage: o.stage, provider: o.provider, attemptStatus: o.attemptStatus, reason: o.reason, note: o.note, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot, sourceRoot: evidenceRoot(o) });
    case 'outcome': return handleOutcomeCommand({ slug: storeSlug, taskId: requireTaskId(o), action: o.action, state: o.state, taskClass: o.taskClass, stage: o.stage, readiness: o.readiness, verification: o.verification, json: o.json, repoRoot: REPO_ROOT, stateRoot: storeRoot });
    case 'verify': return handleVerifyCommand({ slug: o.slug, taskId: requireTaskId(o), action: o.action, risk: o.risk, planPath: o.planPath, scope: o.scope, verificationInput: o.verificationInput, verificationPhase: o.verificationPhase, baselineRef: o.baselineRef, json: o.json, projectRoot: evidenceRoot(o) });
    case 'leak-scan': return handleLeakScanCommand({ paths: o.paths, exclude: o.exclude, json: o.json, repoRoot: evidenceRoot(o) });
    case 'recover': return handleRecoverCommand({ errorMessage: o.errorMessage, failedChecks: o.failedChecks, iteration: o.iteration, agent: o.agent, json: o.json });
    case 'roadmap': return handleRoadmapVerbCommand(o);
    case 'plan-check': return handlePlanCheckCommand({ positional: o.positional, extraFlags: o.extraFlags, json: o.json, cwd: process.cwd() });
    // One --path only: a second occurrence reaches the handler as a list, which it refuses as usage.
    case 'review': return handleReviewCommand({ action: o.actionGiven ? o.action : undefined, slug: o.slug, path: o.paths?.length === 1 ? o.paths[0] : o.paths, base: o.base, preset: o.preset, json: o.json, cwd: process.cwd(), env: process.env });
    case 'protocol': return handleProtocolCommand({ action: o.actionGiven ? o.action : undefined, kind: o.kind, taskClass: o.taskClass, risk: o.risk, preset: o.preset, positional: o.positional, json: o.json, cwd: process.cwd() });
    case 'primary': return handlePrimaryCommand({ action: o.actionGiven ? o.action : undefined, json: o.json, flags: o.flagsGiven, env: process.env, cwd: process.cwd() });
    case 'slot': return handleSlotCommand({ action: o.actionGiven ? o.action : undefined, name: o.name, label: o.label, timeout: o.timeout, noWait: Boolean(o.noWait), command: o.slotCommand, by: o.by, reason: o.reason, positional: o.positional, extraFlags: o.extraFlags, json: o.json, env: process.env, cwd: process.cwd() });
    default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
  }
}

/** Await the verb without changing its return value, output or exit code; usage exits never return. */
async function dispatchRuntimeCommand(o: any): Promise<any> {
  const moment: any = {};
  const result = await dispatchRuntimeCommandInner(o, moment);
  if (!NO_UPKEEP.has(o.cmd)) upkeepAfterVerb({ projectRoot: moment.projectRoot });
  return result;
}

function handleEnforcementCommand(o: any): number {
  const fail = (error: string, detail: string): number => {
    if (o.json) console.log(JSON.stringify({ error, detail }));
    else console.error(`doflow enforcement: ${detail}`);
    process.exitCode = 2;
    return 2;
  };
  if (typeof o.harness !== 'string' || !o.harness || typeof o.policy !== 'string' || !o.policy || (o.profile !== undefined && typeof o.profile !== 'string')) return fail('usage', 'requires --harness <id> --policy <id> [--profile <id>]');
  try {
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    const answer = enforcementFor(registry.coverage, { harness: o.harness, policy: o.policy, ...(o.profile ? { profile: o.profile } : {}) });
    if (o.json) console.log(JSON.stringify(answer));
    else {
      console.log(`${answer.harness} ${answer.policy}: ${answer.enforced ? 'enforced' : 'not enforced'} (${answer.class}, ${answer.verification})`);
      for (const item of answer.doesNotCover) console.log(`does not cover: ${item}`);
      for (const item of answer.prerequisites) console.log(`prerequisite: ${item}`);
    }
    process.exitCode = answer.enforced ? 0 : 1;
    return process.exitCode;
  } catch (error: any) {
    if (error instanceof UnknownEnforcementTarget) return fail(error.code, error.message);
    return fail('usage', error.message);
  }
}

module.exports = { dispatchRuntimeCommand };
