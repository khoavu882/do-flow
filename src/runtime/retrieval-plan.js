'use strict';

/**
 * Declared retrieval, and the report over it (feature 011, plan task B.1, design component C1;
 * FR-010, FR-013, FR-014, FR-015).
 *
 * The distinction this module exists to make: **"the provider found nothing" and "the provider was
 * never asked" are not the same answer**, and neither of them is "the provider answered but its
 * index could not be located". Collapsing any pair of those is how a stage concludes there are no
 * dependents when what actually happened is that no graph exists. So retrieval is declared before
 * it runs, and every declared item is reported afterwards — including the ones the run never
 * reached, which are reported as unreached rather than omitted.
 *
 * It mirrors `verification-contract-runner.js`'s declare-then-report split, and owns nothing else:
 * it performs no retrieval, chooses no provider (it asks `capability-router` for each need), and
 * does not decide whether an unreached item matters — that judgement belongs to the stage that
 * declared it.
 *
 * **Freshness qualifies an answer; it never routes one.** FR-009 freezes routing, so a provider's
 * index state is recorded against the need and reported, and is not consulted when resolving which
 * provider a need goes to. `probeFreshness` is reused unchanged rather than reimplemented — this
 * module owns the qualification, `health.js` owns the measurement.
 *
 * Two shape decisions are load-bearing and are enforced structurally rather than by convention:
 *
 *   1. **One probe per distinct provider, at declare time** (design R8, plan D2). `probeFreshness`
 *      walks the project tree to `SCAN_FILE_LIMIT` (4000 files), so probing per *need* would pay
 *      one full scan per need for answers that are identical per provider. A plan of six needs
 *      across two providers pays two scans, not six.
 *   2. **Freshness is stored once per provider and referenced, never copied onto a need** (plan
 *      D7). `needs[]` carries a provider id and nothing about that provider's index; a reader
 *      dereferences `providers{}`. The record is therefore structurally unable to represent two
 *      needs resolving to the same provider while disagreeing about its index.
 *
 * No state here is a number, a percentage or a confidence (NFR-001). The only integers this module
 * emits are counts of records.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CapabilityRouter } = require('./capability-router');
const { EvidenceLedger, assertSafeTaskId } = require('./evidence-ledger');
const { probeFreshness } = require('./health');
// One definition of the score refusal, applied at a second boundary. See the note on
// EVIDENCE_SCORE_FIELDS in cli.js: relevance is a property of a search, not of a fact, and a plan
// that recorded one would hand the next worker a confidence dressed as a measurement.
const { assertNoScoreFields } = require('./cli');
const { finishRuntime, usageError } = require('./cli-result');
const { REPO_ROOT } = require('../helper/repo-root');

// ── the closed result vocabulary (design §4) ─────────────────────────────────────────────────

/** The provider was asked and answered with something; the ledger holds what it yielded. */
const RETRIEVED = 'RETRIEVED';
/** The provider was asked and answered with nothing — a negative finding, from a locatable index. */
const EMPTY = 'EMPTY';
/** The provider was never asked. The state this component exists to keep separate from EMPTY. */
const UNREACHED = 'UNREACHED';
/** It answered, but its index could not be located, so the answer carries no weight. */
const UNVERIFIED = 'UNVERIFIED';

const RESULTS = Object.freeze([RETRIEVED, EMPTY, UNREACHED, UNVERIFIED]);

// ── the freshness vocabulary, reused rather than reinvented (plan D1) ────────────────────────
//
// FRESH / STALE / UNKNOWN come from `probeFreshness` and are not respelled here. NOT_APPLICABLE is
// the runtime's existing word for "the alternative was not available, so nothing was missed"
// (trace-views.js) and covers a provider with no index concept at all — ripgrep and git read the
// working tree and history directly, so their answers are current by construction.
const NOT_APPLICABLE = 'NOT_APPLICABLE';
const FRESHNESS_STATES = Object.freeze(['FRESH', 'STALE', 'UNKNOWN', NOT_APPLICABLE]);

/**
 * Design §4's mapping table, as data. It maps only the *empty* answer: a provider that returned
 * something is RETRIEVED whatever the age of its index, because the thing it returned is a
 * locator a reader can check.
 *
 * `STALE` deliberately does not produce `UNVERIFIED` (design R10). A stale index answered from
 * real data and its limitation is known and stated; an unlocatable index answered from nothing.
 * Collapsing the two would repeat, one level down, exactly the empty-versus-unreached conflation
 * this module exists to prevent — so staleness travels as a marker beside `EMPTY`, and the
 * provider's `refresh` command travels with it so the remedy is one step away.
 */
const EMPTY_ANSWER_BY_FRESHNESS = Object.freeze({
  UNKNOWN: UNVERIFIED,
  STALE: EMPTY,
  FRESH: EMPTY,
  [NOT_APPLICABLE]: EMPTY,
});

/**
 * What an empty answer becomes, given the freshness of the index behind it.
 * @param {string} freshnessState one of FRESHNESS_STATES
 * @returns {string} one of RESULTS
 */
function resultForEmptyAnswer(freshnessState) {
  const mapped = EMPTY_ANSWER_BY_FRESHNESS[freshnessState];
  if (!mapped) {
    // Fail closed rather than pick a default: an unrecognised freshness token means the record was
    // written by something this table does not describe, and calling that a negative finding would
    // be a verdict over an unread state.
    return UNVERIFIED;
  }
  return mapped;
}

// ── the record ────────────────────────────────────────────────────────────────────────────────

/**
 * Where a task's plan lives, under the invoking project's state root.
 *
 * The task id is validated by the evidence ledger's own rule, unchanged: it becomes a filename, so
 * it must never be able to name a path.
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {string}
 */
function planPath(projectRoot, taskId) {
  return path.join(projectRoot, '.doflow', 'state', 'retrieval', `${assertSafeTaskId(taskId)}.json`);
}

/**
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {Object|null} the record, or null when no plan was declared
 */
function readPlan(projectRoot, taskId) {
  const file = planPath(projectRoot, taskId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`the retrieval plan at '${file}' is not readable: ${error.message}`);
  }
}

/**
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {Object} record
 * @returns {string} the file written
 */
function writePlan(projectRoot, taskId, record) {
  const file = planPath(projectRoot, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * One provider's index freshness, in the shape the record stores it.
 *
 * Called once per distinct provider per plan and never per need — that bound is the whole of R8's
 * mitigation, and it is why this function is called from a loop over a provider set rather than
 * from the loop over needs.
 *
 * @param {string} providerId
 * @param {string} projectRoot the project whose source the index is compared against
 * @returns {{state: string, artifact: string|null, refresh: string|null, label: string|null, reason: string|null}}
 */
function freshnessEntry(providerId, projectRoot) {
  const probe = probeFreshness(providerId, { root: projectRoot });
  if (!probe) {
    // `probeFreshness` returns null for a provider it has no artifact layout for. Design R9 records
    // the accepted cost: a future index-backed provider missing from PROVIDER_ARTIFACTS reads as
    // NOT_APPLICABLE and so as fully trustworthy. Stated here rather than silently defaulted.
    return {
      state: NOT_APPLICABLE,
      artifact: null,
      refresh: null,
      label: null,
      reason: 'this provider keeps no index DoFlow knows how to locate — a live filesystem or history '
        + 'scan is current by construction, so there is nothing whose age could be measured',
    };
  }
  return {
    state: probe.state,
    artifact: probe.artifact,
    // Carried through from PROVIDER_ARTIFACTS so the report can state the remedy, not only the
    // problem: an index that cannot be verified is actionable, and the action is one command.
    refresh: probe.refresh || null,
    label: probe.label || null,
    reason: probe.reason || null,
  };
}

/**
 * The freshness state a need's answer is qualified by, read from the plan's provider cache.
 *
 * Always a dereference, never a stored copy (plan D7).
 * @param {Object} record
 * @param {Object} need
 * @returns {string} one of FRESHNESS_STATES
 */
function freshnessOf(record, need) {
  if (!need.provider) return NOT_APPLICABLE;
  const entry = record.providers && record.providers[need.provider];
  return entry && entry.state ? entry.state : NOT_APPLICABLE;
}

/**
 * The ledger items a need produced: anything recorded for this task whose source names the
 * provider the need resolved to, or the capability it resolved through.
 *
 * Both are checked because the evidence boundary requires `source.provider` and
 * `source.capability` on every item but constrains neither to a registry id — a stage that
 * recorded `grep` under `code.exact-search` still linked its find to the need that asked for it.
 *
 * @param {Object} need
 * @param {Array<Object>} items
 * @returns {Array<string>} evidence ids
 */
function evidenceIdsFor(need, items) {
  return items
    .filter((item) => {
      const source = item.source || {};
      if (need.provider && source.provider === need.provider) return true;
      return Boolean(need.capability) && source.capability === need.capability;
    })
    .map((item) => item.id);
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────

/**
 * `--action declare` — record the needs and the provider each resolves to, before retrieval runs.
 *
 * Exits 0 even when a need resolves to nothing. A need no provider can answer is recorded as
 * declared-unresolvable (`provider: null`) rather than dropped, and it surfaces as UNREACHED at
 * report time, which is where the exit-1 contract lives. Failing the declare would stop the stage
 * before it retrieves the needs that *are* resolvable.
 *
 * A declare replaces any previous plan for the task: design §5 keys the record by task id and
 * stamps one `stage` and one `declaredAt` on it, so a second stage declaring a plan is declaring
 * its own, not appending to somebody else's.
 *
 * @returns {number} exit code
 */
function declarePlan({ router, projectRoot, taskId, stage, intents, json }) {
  const needs = [];
  for (const intent of intents) {
    let resolution;
    try {
      resolution = router.resolveIntent(intent);
    } catch (error) {
      // A misspelled intent is a caller error, not an unresolvable need. Recording it as
      // declared-unresolvable would file a typo as a machine limitation and hide it until report.
      return usageError('retrieval-plan',
        `${error.message}. Declared intents: ${Object.keys(router.routes).sort().join(', ')}`, json);
    }
    needs.push({
      intent,
      // Stored because it is what the evidence ledger records under `source.capability`, so the
      // report can link a need to the ids it yielded without re-resolving the route.
      capability: resolution.capability,
      provider: resolution.selectedProvider ? resolution.selectedProvider.id : null,
      result: UNREACHED,
      evidenceIds: [],
    });
  }

  // R8, in one loop: the probe set is the set of DISTINCT providers, so cost is bounded by
  // provider count and not by need count. Six needs across two providers pay two scans.
  const providers = {};
  for (const need of needs) {
    if (!need.provider || providers[need.provider]) continue;
    providers[need.provider] = freshnessEntry(need.provider, projectRoot);
  }

  const record = {
    version: 1,
    taskId,
    stage: stage || null,
    declaredAt: new Date().toISOString(),
    providers,
    needs,
  };
  const file = writePlan(projectRoot, taskId, record);

  const unresolvable = needs.filter((need) => !need.provider).map((need) => need.intent);
  if (json) {
    console.log(JSON.stringify({ action: 'declare', ...record, stateFile: file, unresolvable }, null, 2));
    return finishRuntime(0);
  }

  console.log(`\nDoFlow Retrieval Plan declared [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  console.log(`Stage: ${record.stage || 'not stated'}`);
  console.log('─'.repeat(78));
  console.log('Intent'.padEnd(26) + 'Provider'.padEnd(22) + 'Index');
  for (const need of needs) {
    console.log(
      need.intent.padEnd(26)
      + (need.provider || 'none — unresolvable').padEnd(22)
      + freshnessOf(record, need),
    );
  }
  printProviderIndexes(record);
  if (unresolvable.length > 0) {
    console.log('─'.repeat(78));
    console.log(`Declared but unresolvable on this machine: ${unresolvable.join(', ')}`);
    console.log('  No provider can answer these; they are recorded, not dropped, and will report as UNREACHED.');
  }
  console.log('─'.repeat(78));
  console.log(`Declared ${needs.length} need(s) to ${file}`);
  console.log('═'.repeat(78) + '\n');
  return finishRuntime(0);
}

/**
 * `--action report` — emit every declared item with what it returned.
 *
 * How an item earns each result:
 *   - **RETRIEVED** — the ledger holds evidence for this task from the need's provider or
 *     capability. What it yielded is linked by id.
 *   - **EMPTY** / **UNVERIFIED** — the caller named the intent in `--need`, stating it was asked,
 *     and the ledger holds nothing from it. Which of the two it becomes is design §4's table.
 *   - **UNREACHED** — everything else. A need nothing recorded and nobody said was asked was not
 *     asked, and the report will not upgrade that to a negative finding on its own.
 *
 * That is why `--need` is meaningful on report and not only on declare: only the caller knows
 * whether a lookup ran and came back empty. Guessing would be the empty-versus-unreached
 * conflation this whole module exists to prevent, committed by the reporter.
 *
 * Exits 1 when any declared item is UNREACHED or UNVERIFIED. Every declared need is required — the
 * record carries no optionality, and inventing one here would be an escape hatch from the exit
 * code rather than a fact about the plan.
 *
 * @returns {number} exit code
 */
function reportPlan({ projectRoot, taskId, reached, json }) {
  let record;
  try {
    record = readPlan(projectRoot, taskId);
  } catch (error) {
    return usageError('retrieval-plan', error.message, json);
  }
  if (!record) {
    return usageError('retrieval-plan',
      `no retrieval plan is declared for task '${taskId}' (looked in ${planPath(projectRoot, taskId)}). `
      + 'Declare one with --action declare --need <intent> before the retrieval runs; a report over no '
      + 'plan would state that nothing was missed, which is not something an absent plan can establish', json);
  }

  const declared = new Set(record.needs.map((need) => need.intent));
  const undeclared = [...reached].filter((intent) => !declared.has(intent)).sort();
  if (undeclared.length > 0) {
    return usageError('retrieval-plan',
      `these intents are reported as reached but were never declared: ${undeclared.join(', ')}. `
      + `Declared: ${[...declared].sort().join(', ')}`, json);
  }

  const ledger = new EvidenceLedger({ repoRoot: projectRoot });
  try {
    ledger.load(taskId);
  } catch (error) {
    return usageError('retrieval-plan', error.message, json);
  }
  const items = ledger.queryEvidence({ taskId });

  for (const need of record.needs) {
    need.evidenceIds = evidenceIdsFor(need, items);
    if (need.evidenceIds.length > 0) need.result = RETRIEVED;
    else if (reached.has(need.intent)) need.result = resultForEmptyAnswer(freshnessOf(record, need));
    else need.result = UNREACHED;
  }

  record.reportedAt = new Date().toISOString();
  const file = writePlan(projectRoot, taskId, record);

  // Derived views, computed at emit and never stored on a need — a need holds a provider id and
  // nothing about that provider's index (plan D7).
  const byResult = (result) => record.needs.filter((need) => need.result === result).map((need) => need.intent);
  const stale = record.needs.filter((need) => freshnessOf(record, need) === 'STALE').map((need) => need.intent);
  const unreached = byResult(UNREACHED);
  const unverified = byResult(UNVERIFIED);
  const incomplete = unreached.length > 0 || unverified.length > 0;

  if (json) {
    console.log(JSON.stringify({
      action: 'report',
      ...record,
      stateFile: file,
      summary: {
        declared: record.needs.length,
        retrieved: byResult(RETRIEVED).length,
        empty: byResult(EMPTY).length,
        unreached: unreached.length,
        unverified: unverified.length,
      },
      unreached,
      unverified,
      stale,
    }, null, 2));
    return finishRuntime(incomplete ? 1 : 0);
  }

  console.log(`\nDoFlow Retrieval Report [Task: ${taskId}]:`);
  console.log('═'.repeat(78));
  console.log(`Stage: ${record.stage || 'not stated'}   Declared: ${record.declaredAt}`);
  console.log('─'.repeat(78));
  console.log('Intent'.padEnd(26) + 'Provider'.padEnd(22) + 'Index'.padEnd(16) + 'Result');
  for (const need of record.needs) {
    const freshness = freshnessOf(record, need);
    console.log(
      need.intent.padEnd(26)
      + (need.provider || 'none').padEnd(22)
      + freshness.padEnd(16)
      + need.result + (freshness === 'STALE' ? ' (stale index)' : ''),
    );
  }
  printProviderIndexes(record);
  console.log('─'.repeat(78));
  // NFR-004: the skip is stated as prominently as the failure, on its own line and named.
  if (unreached.length > 0) {
    console.log(`UNREACHED — declared and never asked: ${unreached.join(', ')}`);
  }
  if (unverified.length > 0) {
    console.log(`UNVERIFIED — answered with nothing from an index that could not be located: ${unverified.join(', ')}`);
    console.log('  This is not a negative finding. Rebuild the index above, or record what you found by other means.');
  }
  if (!incomplete) console.log('Every declared need was reached and its answer is grounded.');
  console.log(`Reported ${record.needs.length} declared need(s) to ${file}`);
  console.log('═'.repeat(78) + '\n');
  return finishRuntime(incomplete ? 1 : 0);
}

/** The provider index block both actions print: state, what was located, and the remedy. */
function printProviderIndexes(record) {
  const entries = Object.entries(record.providers || {});
  if (entries.length === 0) return;
  console.log('─'.repeat(78));
  console.log('Provider indexes (probed once each, at declare time):');
  for (const [providerId, entry] of entries) {
    console.log(`  ${providerId} — ${entry.state}${entry.label ? ` (${entry.label})` : ''}`);
    if (entry.artifact) console.log(`      at ${entry.artifact}`);
    if (entry.reason) console.log(`      ${entry.reason}`);
    if (entry.refresh && entry.state !== 'FRESH') console.log(`      Refresh: ${entry.refresh}`);
  }
}

// ── the verb ──────────────────────────────────────────────────────────────────────────────────

/** `--need a,b --need c` and `--need a --need b` are the same list. */
function parseIntents(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  const out = [];
  for (const entry of list) {
    for (const token of String(entry).split(',')) {
      const trimmed = token.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Handles `doflow retrieval-plan` — declare the information needs a stage intends to resolve, and
 * report every declared item afterwards.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'declare'|'report'|'status'} [options.action='report']
 * @param {Array<string>|string} [options.need] intents, comma-separated or repeated
 * @param {string} [options.stage] the stage id declaring the plan
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot] the DoFlow package root, holding the capability registries
 * @param {string} [options.stateRoot] the project the task belongs to; its state and its index
 * @returns {number} exit code
 */
function handleRetrievalPlanCommand(options = {}) {
  const { taskId, action = 'report', need, stage, json = false, repoRoot, stateRoot } = options;

  // NFR-001, at the boundary where a caller's input first becomes a record. `bin/doflow.js` already
  // refuses every score-shaped flag name on the command line; this is the same rule applied to the
  // option object, so a second input surface cannot arrive later without inheriting the refusal.
  try {
    assertNoScoreFields(options, '');
  } catch (error) {
    return usageError('retrieval-plan', error.message, json);
  }

  // `'status'` is the CLI's shared `--action` default, owned by `tools`. Every read-action verb
  // accepts it as an alias for its own default rather than reporting a usage error on an argument
  // the caller never typed — `verify` and `claim` already do exactly this.
  const resolvedAction = action === 'status' ? 'report' : action;
  if (resolvedAction !== 'declare' && resolvedAction !== 'report') {
    return usageError('retrieval-plan', `unknown --action '${action}'. Valid: declare, report (default)`, json);
  }

  // The project the task belongs to owns both the state and the index whose age is being measured.
  // The package root owns the capability registries, and is a different directory in every install.
  const projectRoot = stateRoot || process.cwd();
  const packageRoot = repoRoot || REPO_ROOT;

  try {
    assertSafeTaskId(taskId);
  } catch (error) {
    return usageError('retrieval-plan', error.message, json);
  }

  const intents = parseIntents(need);

  if (resolvedAction === 'declare') {
    if (intents.length === 0) {
      return usageError('retrieval-plan',
        '--action declare needs at least one --need <intent>: a plan that declares nothing cannot '
        + 'later report that anything went unreached, which is the only thing it is for', json);
    }
    if (stage !== undefined && stage !== null && String(stage).trim() === '') {
      return usageError('retrieval-plan', '--stage requires a value', json);
    }
    let router;
    try {
      router = new CapabilityRouter({ repoRoot: packageRoot });
    } catch (error) {
      return usageError('retrieval-plan', error.message, json);
    }
    return declarePlan({ router, projectRoot, taskId, stage, intents, json });
  }

  return reportPlan({ projectRoot, taskId, reached: new Set(intents), json });
}

module.exports = {
  handleRetrievalPlanCommand,
  resultForEmptyAnswer,
  freshnessEntry,
  planPath,
  RESULTS,
  RETRIEVED,
  EMPTY,
  UNREACHED,
  UNVERIFIED,
  NOT_APPLICABLE,
  FRESHNESS_STATES,
  EMPTY_ANSWER_BY_FRESHNESS,
};
