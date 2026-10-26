'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CapabilityRouter } = require('./capability-router.ts');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { ClaimsManager } = require('./claims.ts');
const { measureTreeState } = require('./source-version.ts');
const { fileRootFor } = require('./freshness.ts');
const { toEvidence, parseLocator, validateEvidenceItem, EVIDENCE_REFUSED_FIELDS } = require('./candidate.ts');
const { sourceModeLookup } = require('./retrieval-plan.ts');
const { evaluateTaskReadiness } = require('./readiness.ts');
const { writeReadinessRecord, readReadinessRecord } = require('./readiness-record.ts');
const { resolveTaskScope } = require('./task-scope.ts');
const { parseDeclaredScope } = require('./verification/scope-bound.ts');
const { loadRegistry } = require('../registry/index.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');
// One definition of the exit and usage helpers (design §4.2); `finish` is the local spelling of `finishRuntime`.
const { finishRuntime: finish, usageError } = require('./cli-result.ts');

/**
 * Handles `doflow capabilities` command execution.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {boolean} [options.check=false]
 * @param {string} [options.repoRoot]
 */
function handleCapabilitiesCommand({ json = false, check = false, repoRoot }: any = {}) {
  const root = repoRoot || REPO_ROOT;
  const router = new CapabilityRouter({ repoRoot: root });
  const report = router.getAllCapabilitiesHealth(check);

  if (json) {
    console.log(JSON.stringify({ capabilities: report }, null, 2));
    return;
  }

  console.log('\nDoFlow Abstract Capabilities & Resolved Providers:');
  console.log('═'.repeat(78));
  console.log(
    'Capability'.padEnd(26) +
    'Active Provider'.padEnd(22) +
    'Status'.padEnd(14) +
    'Description'
  );
  console.log('─'.repeat(78));

  for (const item of report) {
    const statusFormatted =
      item.status === 'HEALTHY' ? '✓ HEALTHY' :
      item.status === 'FALLBACK' ? '▲ FALLBACK' :
      '✗ UNAVAIL';

    console.log(
      item.capability.padEnd(26) +
      item.activeProvider.padEnd(22) +
      statusFormatted.padEnd(14) +
      item.description
    );
  }
  console.log('═'.repeat(78));
  console.log(`Mode: ${check ? 'Deep Smoke Check' : 'Fast Presence Check'} · Total Capabilities: ${report.length}\n`);
}

/**
 * Fills `profile` with the caller-stated inputs the task's last readiness record for this template
 * holds and this call did not pass. Returns the profile keys it filled.
 * @returns {Array<string>}
 */
function carriedInputs({ profile, taskClass, taskId, slug, state }: any): string[] {
  const keyOf: any = { verificationPlan: 'verificationPlan', scope: 'scopeClear', invariants: 'invariants' };
  let prior: any = null;
  try {
    const scope = resolveTaskScope({ projectRoot: state, taskId, slug });
    const read = readReadinessRecord({ stateRoot: state, taskId, slug: scope.slug || slug || null });
    if (read.status === 'found' && read.record && read.record.taskClass === taskClass) prior = read.record;
  } catch {
    return [];
  }
  const filled: string[] = [];
  for (const [inputKey, profileKey] of Object.entries(keyOf)) {
    const value = prior && prior.inputs && prior.inputs[inputKey];
    if (profile[profileKey as string] === undefined && typeof value === 'string' && value.trim() !== '') {
      profile[profileKey as string] = value;
      filled.push(profileKey as string);
    }
  }
  return filled;
}

/**
 * Handles `doflow readiness` command execution.
 *
 * The four profile inputs below are the caller's own statements, not measurements, and they are
 * passed through only when the caller actually made them. This verb previously asserted
 * `verificationPlan: 'npm test'` and `scopeClear: true` unconditionally, which auto-satisfied the
 * verification and scope requirement families for every task regardless of project state — the
 * gate reported checkmarks it had not measured. Restoring them as *flags* keeps `READY` reachable
 * without reinstating that defect: nothing here invents a value, and every value the caller did
 * supply is named back in the output under `callerAsserted`, so a reader can tell which part of a
 * verdict rests on evidence and which part rests on someone saying so.
 *
 * @param {Object} options
 * @param {string} [options.taskClass='feature']
 * @param {string} [options.taskId='default']
 * @param {string} [options.verificationPlan] satisfies the verification requirement family
 * @param {string} [options.scopeClear] satisfies the scope requirement family
 * @param {string} [options.invariants] satisfies `invariants_captured`
 * @param {boolean} [options.userDecisionPending=false] forces NEEDS_USER_DECISION
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @param {string} [options.stateRoot]
 * @param {Date} [options.now] the evaluation clock the record is stamped with
 * @param {string|null} [options.slug] `--slug`: the feature the record belongs to
 * @returns {number} exit code: 0 once the evaluation is recorded, whatever its state
 */
function handleReadinessCommand({
  taskClass = 'feature', taskId = 'default', json = false, repoRoot, stateRoot, sourceRoot,
  verificationPlan, scopeClear, invariants, userDecisionPending = false, mode = 'workflow', now, slug = null,
}: any = {}) {
  // Two different roots, previously conflated into one. `root` locates the *registry* (the
  // readiness templates ship inside the DoFlow package). `state` locates the invoking project's
  // evidence, which belongs to the caller's repo — not to wherever DoFlow happens to be installed.
  // Sharing one root put every project's per-task evidence inside the DoFlow install directory,
  // which under an npm install is node_modules/ — shared across all projects and often read-only.
  const root = repoRoot || REPO_ROOT;
  const state = stateRoot || process.cwd();
  // Only what the caller actually told us. An absent key must stay absent rather than become a
  // falsy default, because the engine reads presence, not truth.
  const profile: any = { taskId, taskClass };
  if (typeof verificationPlan === 'string' && verificationPlan.trim() !== '') profile.verificationPlan = verificationPlan;
  if (typeof scopeClear === 'string' && scopeClear.trim() !== '') profile.scopeClear = scopeClear;
  if (typeof invariants === 'string' && invariants.trim() !== '') profile.invariants = invariants;
  if (userDecisionPending) profile.userDecisionPending = true;
  // An input not passed this call is the one the task's last evaluation for this template stated, so
  // a bare re-check after evidence changes does not discard the scope and plan a READY verdict rested
  // on. Passing an input replaces it. Ceiling: an input can be replaced but not dropped, and
  // `--user-decision-pending` is never carried.
  const carried = carriedInputs({ profile, taskClass, taskId, slug, state });
  const callerAsserted = Object.keys(profile).filter((k) => k !== 'taskId' && k !== 'taskClass');

  let report;
  try {
    report = evaluateTaskReadiness({ taskProfile: profile, repoRoot: root, projectRoot: state, treeRoot: sourceRoot || state, sourceRoot: sourceRoot || state, mode });
  } catch (error: any) {
    return usageError('readiness', error.message, json, error);
  }

  // The evaluation is recorded so the handoff, `verify` and the edit hook can later ask whether
  // this task was READY before its work began. A scope that parses as a path list is also the
  // declared scope `verify` bounds a change by; any other wording stays a statement only.
  const inputs: any = {};
  if (profile.verificationPlan) inputs.verificationPlan = profile.verificationPlan;
  if (profile.scopeClear) inputs.scope = profile.scopeClear;
  if (profile.invariants) inputs.invariants = profile.invariants;
  if (profile.userDecisionPending) inputs.userDecisionPending = true;
  const declared = inputs.scope ? parseDeclaredScope(inputs.scope) : null;
  const declaredScope = declared && !declared.reason ? declared.paths : null;
  let recorded: any;
  try {
    const { file, replacedUnreadable } = writeReadinessRecord({ stateRoot: state, taskId, slug, report, inputs, declaredScope, mode, now: now || new Date() });
    recorded = { file, written: true, ...(replacedUnreadable ? { replacedUnreadable } : {}) };
  } catch (error: any) {
    recorded = { file: null, written: false, error: error.message };
  }
  const exitCode = recorded.written ? 0 : 1;
  const reportNotRecorded = () => {
    if (!recorded.written) console.error(`[ERROR] readiness: the evaluation was not recorded: ${recorded.error}`);
  };

  if (json) {
    console.log(JSON.stringify({ ...report, callerAsserted, carriedFromLastRecord: carried, record: recorded, declaredScope }, null, 2));
    reportNotRecorded();
    return finish(exitCode);
  }

  console.log(`\nDoFlow Task Readiness Evaluation [${report.taskClass.toUpperCase()}]:`);
  console.log('═'.repeat(70));
  console.log(`Task ID:       ${report.taskId}`);
  console.log(`Template:      ${report.templateName}`);
  console.log(`Overall State: ${report.state === 'READY' ? '✓ READY' : report.state === 'NEEDS_EVIDENCE' ? '▲ NEEDS EVIDENCE' : '✗ ' + report.state}`);
  console.log(`Stage Entry:   ${report.stageEntry.decision} (${report.executionMode} mode) — ${report.stageEntry.reason}`);
  console.log(`Summary:       ${report.summary}`);
  if (recorded.written) console.log(`Recorded:      ${path.relative(state, recorded.file)}`);
  if (recorded.replacedUnreadable) {
    console.log(`Replaced:      the previous record could not be read; its bytes are kept in ${path.relative(state, recorded.replacedUnreadable)}`);
  }
  if (declared) {
    console.log(declaredScope
      ? `Declared scope: ${declaredScope.join(', ')}`
      : 'Scope:         stated as text, not a path list; verify does not bound a change by it');
  }
  if (callerAsserted.length > 0) {
    // Named, not hidden: these requirements were satisfied because the caller said so, and a
    // verdict that mixes measured and stated inputs must say which is which.
    console.log(`Caller-stated: ${callerAsserted.join(', ')} (asserted on the command line, not established by evidence)`);
    if (carried.length > 0) console.log(`Carried:       ${carried.join(', ')} (stated by the last evaluation of this task; pass the flag to replace it)`);
  }
  console.log('─'.repeat(70));
  console.log('Requirements Breakdown:');

  for (const req of report.requirements || []) {
    const mark = req.satisfied ? '✓ Satisfied' : req.required ? '✗ MISSING' : '○ Optional';
    console.log(`  ${req.id.padEnd(26)} ${mark.padEnd(14)} ${req.description}`);
    if (!req.satisfied && req.recommendedAction) {
      console.log(`    └─ Recommended: [${req.recommendedAction.capability}] ${req.recommendedAction.action}`);
    }
  }
  console.log('═'.repeat(70) + '\n');
  reportNotRecorded();
  return finish(exitCode);
}

// ── the evidence write boundary (FR-007, plan task C.12) ──────────────────────────────────────
//
// `evidence` shipped as a read-only verb. `EvidenceLedger.addEvidence()`/`save()` existed and were
// tested, and nothing in the CLI called either — so every `evidenceKinds` requirement in every
// readiness template was unsatisfiable and the gate could only ever answer NEEDS_EVIDENCE. This
// section is the missing writer.
//
// It is almost entirely validation, deliberately. FR-007 makes two separations binding — model
// analysis stays distinguishable from repository fact, and retrieval relevance is never recorded
// as confidence — and a separation that is only documented is not enforced. Both are refused here,
// at the one point where an evidence record comes into existence.
//
// The refusals matter more than the writes. `addEvidence` builds an explicit record and ignores
// every key it does not recognise, so a field this boundary forwards blindly is a field the caller
// watches vanish while the command reports success. Nothing reaches the ledger unnamed.

const {
  EVIDENCE_SCORE_FIELDS,
  scoreFieldRefusal,
  assertNoScoreFields,
} = require('./evidence-fields.ts');



/**
 * Reads a stage's evidence batch: a JSON array, or `{ "evidence": [...] }`.
 * @param {string} batchPath a file path, or `-` for stdin
 * @param {string} taskId
 * @param {string} root
 * @param {string|null} [slug]
 * @returns {Array<Object>}
 */
function readEvidenceBatch(batchPath: any, taskId: any, root: any, slug: any = null) {
  let text;
  try {
    text = batchPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(batchPath), 'utf8');
  } catch (error: any) {
    throw new Error(`cannot read the batch at '${batchPath}': ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error: any) {
    throw new Error(`the batch at '${batchPath}' is not valid JSON: ${error.message}`);
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) {
      if (key === 'evidence') continue;
      const refusedVal = EVIDENCE_REFUSED_FIELDS.get(key);
      const reason = typeof refusedVal === 'function' ? refusedVal(taskId, root, slug) : refusedVal;
      const named = reason ? ` — ${reason.endsWith('.') ? reason.slice(0, -1) : reason}` : '';
      throw new Error(`unknown batch field '${key}'${named}. A batch is a JSON array of items, `
        + "or an object whose only key is 'evidence'");
    }
    if (!Array.isArray(data.evidence)) throw new Error("the batch field 'evidence' must be an array");
    return data.evidence;
  }
  throw new Error('a batch must be a JSON array of evidence items, or an object with an `evidence` array');
}

/**
 * Refuses an evidence item whose file locator names a directory, whatever its provenance: a locator
 * points into a file. An absence item has no locator, and a locator that does not parse is left to
 * `toEvidence`, which names what is wrong with it.
 * @throws {Error} naming the locator
 */
function refuseDirectoryLocator(raw: any, sourceRoot: string, root: string) {
  if (!raw || typeof raw !== 'object' || raw.absence || raw.locator === undefined) return;
  let locator;
  try {
    locator = parseLocator(raw.locator);
  } catch {
    return;
  }
  if (!locator.file) return;
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(path.resolve(fileRootFor(sourceRoot, root, locator), locator.file)).isDirectory();
  } catch { /* missing or unreadable: the resolver judges that */ }
  if (isDirectory) {
    throw new Error(`the locator '${locator.file}' is a directory, and a directory is not a valid locator; name a file (path[:line])`);
  }
}

/**
 * The `--action add` arm: validate the whole batch, then write it.
 * @returns {number} exit code
 */
function addEvidence({ ledger, root, sourceRoot = root, attemptRoot, taskId, item, batchPath, json, slug = null }: any) {
  const flagged = item && Object.keys(item).length > 0;
  if (flagged && batchPath) {
    return usageError('evidence', '--batch and the single-item flags are two spellings of the same write; use one', json);
  }
  if (!flagged && !batchPath) {
    return usageError('evidence', '--action add needs either --batch <file|-> or the single-item flags '
      + '(--kind, --provenance, --provider, --capability, --locator, --content)', json);
  }

  let raws;
  try {
    raws = batchPath ? readEvidenceBatch(batchPath, taskId, root, slug) : [item];
  } catch (error: any) {
    return usageError('evidence', error.message, json, error);
  }
  if (raws.length === 0) {
    return usageError('evidence', 'the batch holds no evidence items — a stage that established nothing '
      + 'should record nothing, and an empty write reported as success is the vacuous-PASS defect in another costume', json);
  }

  // The whole batch is validated before any of it is written. A half-written stage batch is worse
  // than a rejected one: the half that landed looks complete to every later reader.
  // The tree observed is the checkout the verb runs in (115 IC-007), one measurement for every item.
  const treeState = measureTreeState(sourceRoot);
  const providerFreshness = new Map();
  let sourceModeOf: any = null;
  const validated = [];
  for (const [index, raw] of raws.entries()) {
    try {
      if (raw && raw.absence && !sourceModeOf) {
        sourceModeOf = sourceModeLookup(new CapabilityRouter({ repoRoot: REPO_ROOT }).capabilities);
      }
      refuseDirectoryLocator(raw, sourceRoot, root);
      validated.push(toEvidence({ item: raw }, { taskId, root, treeState, probeRoot: sourceRoot, sourceRoot, attemptRoot, slug, providerFreshness, sourceModeOf }));
    } catch (error: any) {
      const where = raws.length > 1 ? `batch item ${index + 1} of ${raws.length}: ` : '';
      return usageError('evidence', `${where}${error.message}`, json, error);
    }
  }

  const written = [];
  let stateFile;
  try {
    for (const record of validated) {
      const id = ledger.addEvidence(record);
      written.push(ledger.getEvidence(id));
    }
    stateFile = ledger.save(taskId);
  } catch (error: any) {
    return usageError('evidence', error.message, json, error);
  }

  if (json) {
    console.log(JSON.stringify({ action: 'add', taskId, written: written.length, stateFile, evidence: written }, null, 2));
    return finish(0);
  }

  console.log(`\nDoFlow Evidence Recorded [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  console.log('ID'.padEnd(16) + 'Kind'.padEnd(20) + 'Provenance'.padEnd(12) + 'Locator');
  console.log('─'.repeat(78));
  for (const record of written) {
    console.log(
      record.id.padEnd(16) +
      record.kind.padEnd(20) +
      record.provenance.padEnd(12) +
      (locatorText(record.locator) || 'none')
    );
  }
  console.log('─'.repeat(78));
  console.log(`Wrote ${written.length} item(s) to ${stateFile}`);
  console.log(`Commit at observation: ${treeState.gitCommit || (treeState.prefix !== null ? 'not measured' : 'not a git worktree — freshness cannot expire by diff')}`);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

/** One-line rendering of a locator for the table views. */
function locatorText(locator: any) {
  if (!locator) return '';
  if (locator.file) return locator.line ? `${locator.file}:${locator.line}` : locator.file;
  return locator.uri || locator.symbol || '';
}

/**
 * The `--action supersede` arm: mark one already-recorded item superseded by another. Mirrors
 * `handleClaimCommand`'s `supersede` branch — validate, write, save, report the same shape.
 * @returns {number} exit code
 */
function supersedeEvidence({ ledger, taskId, evidenceId, replacedBy, json }: any) {
  if (!evidenceId || !replacedBy) {
    return usageError('evidence', '--evidence-id and --replaced-by are both required for --action supersede', json);
  }
  let status;
  try {
    status = ledger.supersedeEvidence(evidenceId, replacedBy);
  } catch (error: any) {
    return usageError('evidence', error.message, json, error);
  }
  const stateFile = ledger.save(taskId);
  const record = ledger.getEvidence(evidenceId);

  if (json) {
    console.log(JSON.stringify({ action: 'supersede', taskId, evidence: record, status, stateFile }, null, 2));
    return finish(0);
  }
  console.log(`\nDoFlow Evidence [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  console.log(`${record.id}  ${status} → ${record.supersededBy}`);
  console.log(`Wrote to ${stateFile}`);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

/**
 * The `--action retire --stale` arm: retire every active item the ledger classes stale right now,
 * judged the way readiness judges them (the tree the verb runs in). Items are retired without a
 * replacement and the reason is recorded on each; fresh items are not touched.
 * @returns {number} exit code
 */
function retireStaleEvidence({ ledger, root, sourceRoot, taskId, slug, stale, json }: any) {
  if (!stale) {
    return usageError('evidence', '--action retire retires every stale item and needs --stale; '
      + 'to retire one item, point it at its replacement with --action supersede', json);
  }
  // Staleness is derived, never stored by a read: classify on a separate copy so the ledger being
  // saved changes only the items retired here.
  const { FreshnessValidator } = require('./freshness.ts');
  const probe = new EvidenceLedger({ repoRoot: root, slug });
  let retired: any[];
  try {
    probe.load(taskId);
    new FreshnessValidator({ repoRoot: root, treeRoot: sourceRoot, sourceRoot }).validateLedgerFreshness(probe);
    const staleItems = probe.getAllEvidence().filter((item: any) => item.taskId === taskId
      && item.freshness?.status === 'STALE' && item.status !== 'superseded');
    for (const item of staleItems) {
      ledger.retireEvidence(item.id, `stale: ${item.freshness.staleReason || 'marked stale'}`);
    }
    retired = staleItems.map((item: any) => ledger.getEvidence(item.id));
    if (retired.length > 0) ledger.save(taskId);
  } catch (error: any) {
    return usageError('evidence', error.message, json, error);
  }
  const ids = retired.map((item: any) => item.id);
  if (json) {
    console.log(JSON.stringify({ action: 'retire', taskId, retired: ids.length, ids, evidence: retired }, null, 2));
    return finish(0);
  }
  console.log(ids.length === 0
    ? `Evidence [Task: ${taskId}]: no stale items to retire.`
    : `Evidence [Task: ${taskId}]: retired ${ids.length} stale item(s):\n${retired.map((item: any) => `  ${item.id}  ${item.retiredReason}`).join('\n')}`);
  return finish(0);
}

/**
 * Handles `doflow evidence` — record a stage's evidence batch, retire a stale item, or query
 * what is recorded.
 *
 * @param {Object} options
 * @param {string} [options.taskId='default']
 * @param {'list'|'status'|'add'|'supersede'|'retire'} [options.action='list']
 * @param {Object} [options.item] single-item write, assembled from flags by bin/doflow.js
 * @param {string} [options.batchPath] `add`: a JSON batch file, or `-` for stdin
 * @param {string} [options.evidenceId] `supersede`: the item to retire
 * @param {string} [options.replacedBy] `supersede`: the item that replaces it
 * @param {boolean} [options.stale] `retire`: retire every item the ledger classes stale
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @param {string} [options.stateRoot]
 * @returns {number} exit code
 */
function handleEvidenceCommand({ taskId = 'default', action = 'list', item = null, batchPath = null, evidenceId = null, replacedBy = null, stale = false, json = false, repoRoot, stateRoot, sourceRoot, attemptRoot, slug = null }: any = {}) {
  // See handleReadinessCommand: evidence is the caller's project state, not DoFlow package state.
  const root = stateRoot || repoRoot || process.cwd();
  const isQuery = action === 'list' || action === 'status';
  if (!isQuery && action !== 'add' && action !== 'supersede' && action !== 'retire') {
    return usageError('evidence', `unknown --action '${action}'. Valid: list, add, supersede, retire`, json);
  }
  // A write argument on a read action is the defect this verb was reported for: it used to accept
  // append-shaped flags, ignore them, and print the (unchanged) ledger as if the write had landed.
  if (isQuery && ((item && Object.keys(item).length > 0) || batchPath)) {
    return usageError('evidence', 'these are write arguments and this action only reads — re-run with --action add', json);
  }

  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  try {
    ledger.load(taskId);
  } catch (error: any) {
    return usageError('evidence', error.message, json, error);
  }

  if (action === 'add') return addEvidence({ ledger, root, sourceRoot: sourceRoot || root, attemptRoot, taskId, item, batchPath, json, slug });
  if (action === 'supersede') return supersedeEvidence({ ledger, taskId, evidenceId, replacedBy, json });
  if (action === 'retire') return retireStaleEvidence({ ledger, root, sourceRoot: sourceRoot || root, taskId, slug, stale, json });

  const items = ledger.queryEvidence({ taskId });

  if (json) {
    console.log(JSON.stringify({ taskId, evidenceCount: items.length, evidence: items }, null, 2));
    return finish(0);
  }

  console.log(`\nDoFlow Evidence Ledger [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  if (items.length === 0) {
    console.log('No evidence items recorded for this task.');
  } else {
    console.log('ID'.padEnd(16) + 'Kind'.padEnd(20) + 'Status'.padEnd(12) + 'File Locator');
    console.log('─'.repeat(78));
    for (const entry of items) {
      const loc = entry.locator?.file ? `${entry.locator.file}` : 'None';
      console.log(
        entry.id.padEnd(16) +
        entry.kind.padEnd(20) +
        entry.freshness.status.padEnd(12) +
        loc
      );
    }
  }
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

const EMIT_NUDGES = ['nudge', 'suppress', 'none'];
const EMIT_MAX_BYTES = /^[1-9][0-9]{0,9}$/;

/**
 * 078 IC-005: `doflow-run context-emit`, a thin wrapper over emitContext(). Identity is read from
 * the environment alone (IC-007); no flag sets it. Exits 0 emitted or silent, 2 usage (including a
 * launch without a launched identity, or an invalid identity value), 3 refused.
 */
function handleContextEmitCommand({ event, cwd, session, harness, nudge, maxBytes, taskId, slug, stateRoot, peek = false, json = false, env = process.env }: any = {}) {
  // Required on use: context-pack.ts loads the whole pack compiler, which no other verb here needs.
  const { emitContext } = require('./context-pack.ts');
  const { resolveIdentity } = require('./context/identity.ts');
  if (typeof cwd !== 'string' || cwd === '') return usageError('context-emit', '--cwd <dir> is required', json);
  const dir = path.resolve(cwd);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return usageError('context-emit', `--cwd '${cwd}' is not a directory`, json);
  if (nudge !== undefined && !EMIT_NUDGES.includes(nudge)) return usageError('context-emit', `--nudge must be one of ${EMIT_NUDGES.join(', ')}`, json);
  if (maxBytes !== undefined && !EMIT_MAX_BYTES.test(String(maxBytes))) return usageError('context-emit', '--max-bytes must be a positive integer', json);
  const sessionId = typeof session === 'string' ? session : '';
  const identity = resolveIdentity(env, { cwd: dir, sessionId });
  if (identity.diagnostics.includes('identity-invalid')) {
    return usageError('context-emit', 'DOFLOW_RUN_ID or DOFLOW_LINEAGE_ID holds an invalid value', json);
  }
  let result: any;
  try {
    result = emitContext({
      event, identity, cwd: dir, sessionId, env, peek: peek === true,
      ...(harness ? { harness } : {}),
      ...(nudge ? { nudge } : {}),
      ...(maxBytes !== undefined ? { maxBytes: Number(maxBytes) } : {}),
      ...(taskId ? { taskId } : {}),
      ...(slug ? { slug } : {}),
      ...(stateRoot ? { stateRoot } : {}),
    });
  } catch (error: any) {
    if (error?.code === 'USAGE_ERROR') return usageError('context-emit', error.message.replace(/^emitContext: /, ''), json);
    throw error;
  }
  if (json) {
    console.log(JSON.stringify({ v: 1, event, identity, decision: result.decision, text: result.text, pack: result.pack, committed: result.committed }));
  } else if (result.text !== null) {
    process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  }
  return finish(result.decision.reason === 'refused:mandatory-over-budget' ? 3 : 0);
}

/**
 * 078 IC-013: `doflow-run context-grant`, a thin wrapper over grantSummary(). The source scope
 * defaults to the caller's identity. Exits 0 created, 1 not found or already granted, 2 usage,
 * 3 over budget (refused before any write).
 */
function handleContextGrantCommand({ summary, toRun, toLineage, fromWorktree, fromRun, fromLineage, maxBytes, json = false, env = process.env }: any = {}) {
  const { grantSummary } = require('./context/summary-store.ts');
  let granted: any;
  try {
    granted = grantSummary({
      summary, toRun, toLineage, env,
      ...(fromWorktree ? { fromWorktree: path.resolve(fromWorktree) } : {}),
      ...(fromRun ? { fromRun } : {}),
      ...(fromLineage ? { fromLineage } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
  } catch (error: any) {
    if (error?.name !== 'SummaryStoreError') throw error;
    if (error.exitCode === 2) return usageError('context-grant', error.message, json);
    if (json) console.log(JSON.stringify({ v: 1, ok: false, error: error.code, summary: error.message }));
    else console.error(`doflow context-grant: ${error.message}`);
    return finish(error.exitCode);
  }
  if (json) console.log(JSON.stringify({ v: 1, ok: true, ...granted }));
  else console.log(`granted ${granted.summaryId} (${granted.bytes} B) -> ${granted.path}`);
  return finish(0);
}

module.exports = {
  handleCapabilitiesCommand,
  handleReadinessCommand,
  handleEvidenceCommand,
  handleContextEmitCommand,
  handleContextGrantCommand,
  // Exported for bin/doflow.js, which refuses the same names as command-line flags, and for the
  // tests that pin the write boundary.
  EVIDENCE_SCORE_FIELDS,
  scoreFieldRefusal,
  // The recursive refusal itself, not just the name set — `retrieval-plan.ts` applies it to the
  // option object a plan is built from and `outcome.ts` to the one a terminal record is, so every
  // boundary rejects the same shapes by the same rule rather than by implementations that agree
  // today.
  assertNoScoreFields,
  validateEvidenceItem,
};
