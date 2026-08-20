'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CapabilityRouter } = require('./capability-router');
const { EvidenceLedger, VALID_EVIDENCE_KINDS, VALID_PROVENANCE } = require('./evidence-ledger');
const { resolveLocator, describeResolution } = require('./locator-resolve');
const { ClaimsManager } = require('./claims');
const { ReadinessEngine } = require('./readiness');
const { loadRegistry } = require('../registry');

/**
 * Handles `doflow capabilities` command execution.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {boolean} [options.check=false]
 * @param {string} [options.repoRoot]
 */
function handleCapabilitiesCommand({ json = false, check = false, repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
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

// ── uniform report contract, handler side ─────────────────────────────────────────────────────
//
// Both helpers mirror `bin/doflow.js`'s `finishRuntime` and `usageError` exactly. They are
// duplicated rather than imported because `bin/doflow.js` is an executable script, not a module;
// the alternative is a new shared file for six lines. If the contract there changes, it changes
// here — design §4.2 is the single definition, not either copy.

/** Sets the process exit code and returns it, for the `case 'x': return handleXCommand(...)` form. */
function finish(code) {
  process.exitCode = code;
  return code;
}

/** Reports an argument the verb cannot proceed without: exit 2, in the caller's requested shape. */
function usageError(verb, message, json) {
  if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: 'usage', summary: message }, null, 2));
  else console.error(`doflow ${verb}: ${message}`);
  return finish(2);
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
 */
function handleReadinessCommand({
  taskClass = 'feature', taskId = 'default', json = false, repoRoot, stateRoot,
  verificationPlan, scopeClear, invariants, userDecisionPending = false,
} = {}) {
  // Two different roots, previously conflated into one. `root` locates the *registry* (the
  // readiness templates ship inside the DoFlow package). `state` locates the invoking project's
  // evidence, which belongs to the caller's repo — not to wherever DoFlow happens to be installed.
  // Sharing one root put every project's per-task evidence inside the DoFlow install directory,
  // which under an npm install is node_modules/ — shared across all projects and often read-only.
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const state = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: state });
  try {
    ledger.load(taskId);
  } catch (error) {
    return usageError('readiness', error.message, json);
  }

  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: state });
  claims.load(taskId);

  const engine = new ReadinessEngine({ repoRoot: root, projectRoot: state });
  // Only what the caller actually told us. An absent key must stay absent rather than become a
  // falsy default, because the engine reads presence, not truth.
  const profile = { taskId, taskClass };
  if (typeof verificationPlan === 'string' && verificationPlan.trim() !== '') profile.verificationPlan = verificationPlan;
  if (typeof scopeClear === 'string' && scopeClear.trim() !== '') profile.scopeClear = scopeClear;
  if (typeof invariants === 'string' && invariants.trim() !== '') profile.invariants = invariants;
  if (userDecisionPending) profile.userDecisionPending = true;
  const callerAsserted = Object.keys(profile).filter((k) => k !== 'taskId' && k !== 'taskClass');

  const report = engine.evaluateReadiness(profile, ledger, claims);

  if (json) {
    console.log(JSON.stringify({ ...report, callerAsserted }, null, 2));
    return finish(0);
  }

  console.log(`\nDoFlow Task Readiness Evaluation [${report.taskClass.toUpperCase()}]:`);
  console.log('═'.repeat(70));
  console.log(`Task ID:       ${report.taskId}`);
  console.log(`Template:      ${report.templateName}`);
  console.log(`Overall State: ${report.state === 'READY' ? '✓ READY' : report.state === 'NEEDS_EVIDENCE' ? '▲ NEEDS EVIDENCE' : '✗ ' + report.state}`);
  console.log(`Summary:       ${report.summary}`);
  if (callerAsserted.length > 0) {
    // Named, not hidden: these requirements were satisfied because the caller said so, and a
    // verdict that mixes measured and stated inputs must say which is which.
    console.log(`Caller-stated: ${callerAsserted.join(', ')} (asserted on the command line, not established by evidence)`);
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
  return finish(0);
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

/** Every field an evidence item may carry here. Anything else is refused, never dropped. */
const EVIDENCE_ITEM_FIELDS = ['kind', 'provenance', 'source', 'locator', 'content', 'taskId'];
const EVIDENCE_SOURCE_FIELDS = ['provider', 'capability'];
const EVIDENCE_LOCATOR_FIELDS = ['file', 'line', 'symbol', 'uri'];

/** Kinds that are by definition not a direct read of the repository. FR-007's second sentence. */
const NON_REPOSITORY_KINDS = new Set(['generated-analysis', 'user-statement']);

/** Fields a caller might plausibly send that this boundary refuses by name, with the reason.
 *  A named refusal beats the generic unknown-field error: each of these would otherwise be
 *  silently discarded by `addEvidence`, and a silent discard reads as a successful write. */
const EVIDENCE_REFUSED_FIELDS = new Map([
  ['id', 'evidence ids are minted by the ledger — a caller-chosen id can overwrite an unrelated record'],
  ['freshness', 'freshness is measured here from the working tree at write time, never asserted by the writer'],
  ['supports', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['contradicts', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['stage', 'the evidence record has no stage field — the batch *is* the stage boundary, so a stage name recorded here would be dropped'],
]);

/** The names a retrieval score arrives under, in camelCase (`--relevance-score` normalises here).
 *  Exported because `bin/doflow.js` refuses the same names on the command line, and because
 *  `retrieval-plan.js` and `outcome.js` refuse them on the option object a declared plan and a
 *  terminal record are built from: one definition, three input surfaces (argv, a `--batch` JSON
 *  file, and a verb's own options), each with exactly one enforcement point. A second copy of
 *  this list is how one of them drifts. */
const EVIDENCE_SCORE_FIELDS = new Set([
  'confidence', 'score', 'relevance', 'relevanceScore', 'similarity',
  'certainty', 'probability', 'rank', 'distance', 'weight',
]);

/** The one refusal message for a score offered as a property of a fact. */
function scoreFieldRefusal(name) {
  return `'${name}' is a retrieval score and this boundary records none (FR-007). Relevance is a `
    + 'property of a search, not of a fact: stored beside the fact it is read as confidence by the '
    + 'next worker, which is the specific interpretation the requirement forbids. Record the '
    + 'locator and the content instead — a reader who can see where a fact came from does not need '
    + 'to be told how sure to be.';
}

/** Refuses a score-shaped key anywhere in an item, including nested under source or locator. */
function assertNoScoreFields(value, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (EVIDENCE_SCORE_FIELDS.has(key)) throw new Error(scoreFieldRefusal(dotted));
    assertNoScoreFields(inner, dotted);
  }
}

/**
 * Normalises a locator given either as an object or as a `file[:line]` / URI string.
 * @param {Object|string} raw
 * @returns {Object}
 */
function parseLocator(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') throw new Error('locator is empty');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { uri: text };
    const withLine = text.match(/^(.+):(\d+)$/);
    if (withLine) return { file: withLine[1], line: Number(withLine[2]) };
    return { file: text };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error("locator must be an object, or a 'path/to/file[:line]' or URI string");
  }
  const locator = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EVIDENCE_LOCATOR_FIELDS.includes(key)) {
      throw new Error(`unknown locator field '${key}'. Accepted: ${EVIDENCE_LOCATOR_FIELDS.join(', ')}`);
    }
    locator[key] = value;
  }
  if (locator.line !== undefined && (!Number.isInteger(locator.line) || locator.line < 1)) {
    throw new Error(`locator.line must be a positive integer, got '${locator.line}'`);
  }
  for (const key of ['file', 'symbol', 'uri']) {
    if (locator[key] !== undefined && (typeof locator[key] !== 'string' || locator[key].trim() === '')) {
      throw new Error(`locator.${key} must be a non-empty string`);
    }
  }
  if (!locator.file && !locator.uri) throw new Error('a locator needs at least a file or a uri');
  return locator;
}

/**
 * Validates one raw evidence item and returns the record fields the ledger will store.
 *
 * Throws on anything it cannot account for. Every rule here traces to FR-007 or to the
 * vacuous-record family: a record with no statement and no locator asserts nothing, and storing it
 * inflates the evidence count that the readiness gate then reads.
 *
 * @param {Object} raw
 * @param {string} taskId the task the batch is being written to
 * @param {string} [repoRoot] root a relative locator resolves against; defaults to cwd
 * @returns {{kind:string, provenance:string, source:Object, locator:Object, content:(string|null)}}
 */
function validateEvidenceItem(raw, taskId, repoRoot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an evidence item must be a JSON object');
  assertNoScoreFields(raw, '');

  for (const key of Object.keys(raw)) {
    if (EVIDENCE_REFUSED_FIELDS.has(key)) throw new Error(`'${key}' is not accepted here: ${EVIDENCE_REFUSED_FIELDS.get(key)}`);
    if (!EVIDENCE_ITEM_FIELDS.includes(key)) {
      throw new Error(`unknown evidence field '${key}'. Accepted: ${EVIDENCE_ITEM_FIELDS.join(', ')}`);
    }
  }

  if (raw.taskId !== undefined && raw.taskId !== taskId) {
    throw new Error(`item names task '${raw.taskId}' but this write targets '${taskId}' — one write, one task`);
  }

  const kinds = [...VALID_EVIDENCE_KINDS].sort().join(', ');
  if (typeof raw.kind !== 'string' || raw.kind.trim() === '') throw new Error(`kind is required. Valid: ${kinds}`);
  if (!VALID_EVIDENCE_KINDS.has(raw.kind)) throw new Error(`unknown evidence kind '${raw.kind}'. Valid: ${kinds}`);

  const provenances = [...VALID_PROVENANCE].sort().join(', ');
  if (typeof raw.provenance !== 'string' || raw.provenance.trim() === '') {
    throw new Error('provenance is required and has no default here — defaulting it would file model '
      + `analysis as repository fact, the one distinction FR-007 makes binding. Valid: ${provenances}`);
  }
  if (!VALID_PROVENANCE.has(raw.provenance)) throw new Error(`unknown provenance '${raw.provenance}'. Valid: ${provenances}`);
  if (NON_REPOSITORY_KINDS.has(raw.kind) && raw.provenance === 'extracted') {
    throw new Error(`kind '${raw.kind}' cannot carry provenance 'extracted': it is not a read of the `
      + "repository, and labelling it as one is exactly how model analysis stops being distinguishable "
      + "from fact. Use 'inferred' (derived by analysis) or 'asserted' (stated by a person).");
  }

  if (raw.source === undefined) {
    throw new Error('source is required: which provider answered, under which capability. '
      + "It has no default — 'unknown/general' is a plausible-looking answer to a question nobody asked.");
  }
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) {
    throw new Error('source must be an object with provider and capability');
  }
  for (const key of Object.keys(raw.source)) {
    if (!EVIDENCE_SOURCE_FIELDS.includes(key)) {
      throw new Error(`unknown source field '${key}'. Accepted: ${EVIDENCE_SOURCE_FIELDS.join(', ')}`);
    }
  }
  for (const key of EVIDENCE_SOURCE_FIELDS) {
    if (typeof raw.source[key] !== 'string' || raw.source[key].trim() === '') {
      throw new Error(`source.${key} is required and must be a non-empty string`);
    }
  }

  const locator = raw.locator === undefined ? null : parseLocator(raw.locator);
  if (raw.provenance === 'extracted' && !locator) {
    throw new Error("provenance 'extracted' requires a locator — a fact read from the repository "
      + 'must name where it was read, or the next worker cannot check it and cannot tell when it goes stale');
  }

  // A locator that parses is not a locator that resolves (FR-004). Shape validation alone let an
  // item naming line 799 of a 28-line file be recorded as support and counted by the readiness
  // gate. The refusal names what the file actually offers, so the writer can correct it here rather
  // than discover it at the gate.
  if (raw.provenance === 'extracted' && locator) {
    const resolution = resolveLocator({ locator, repoRoot });
    if (!resolution.resolved) {
      throw new Error(`the locator does not resolve: ${describeResolution(locator, resolution)}. `
        + "An 'extracted' item asserts a read of the repository, so a locator that points at nothing "
        + 'records a fact nobody can check');
    }
  }

  if (raw.content !== undefined && typeof raw.content !== 'string') throw new Error('content must be a string');
  const content = typeof raw.content === 'string' && raw.content.trim() !== '' ? raw.content : null;
  if (raw.provenance !== 'extracted' && !content) {
    throw new Error(`provenance '${raw.provenance}' requires content — an inferred or asserted item `
      + 'is the statement itself, so a record without one records nothing while still counting as evidence');
  }

  return {
    kind: raw.kind,
    provenance: raw.provenance,
    source: { provider: raw.source.provider, capability: raw.source.capability },
    locator: locator || {},
    content,
  };
}

/** HEAD of the tree the evidence was observed in, or null outside a repo. Measured, not asserted. */
function headCommit(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Freshness, measured at the write boundary.
 *
 * `FreshnessValidator` invalidates by diffing a recorded commit against the working tree, so the
 * commit is what makes an evidence record expirable at all; a record written without one can never
 * be shown to have gone stale. Both fields are null when they cannot be established — an
 * unmeasurable commit is recorded as unmeasured, not as a value that happens to parse.
 *
 * @param {string} root project root the locator is relative to
 * @param {Object} locator
 * @param {string|null} gitCommit resolved once per invocation
 * @returns {Object}
 */
function measureFreshness(root, locator, gitCommit) {
  let fileHash = null;
  if (locator && locator.file) {
    try {
      const abs = path.resolve(root, locator.file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        fileHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
      }
    } catch {
      fileHash = null;
    }
  }
  return { gitCommit, fileHash, observedAt: new Date().toISOString(), status: 'FRESH' };
}

/**
 * Reads a stage's evidence batch: a JSON array, or `{ "evidence": [...] }`.
 * @param {string} batchPath a file path, or `-` for stdin
 * @returns {Array<Object>}
 */
function readEvidenceBatch(batchPath) {
  let text;
  try {
    text = batchPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(batchPath), 'utf8');
  } catch (error) {
    throw new Error(`cannot read the batch at '${batchPath}': ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`the batch at '${batchPath}' is not valid JSON: ${error.message}`);
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) {
      if (key === 'evidence') continue;
      const named = EVIDENCE_REFUSED_FIELDS.has(key) ? ` — ${EVIDENCE_REFUSED_FIELDS.get(key)}` : '';
      throw new Error(`unknown batch field '${key}'${named}. A batch is a JSON array of items, `
        + "or an object whose only key is 'evidence'");
    }
    if (!Array.isArray(data.evidence)) throw new Error("the batch field 'evidence' must be an array");
    return data.evidence;
  }
  throw new Error('a batch must be a JSON array of evidence items, or an object with an `evidence` array');
}

/**
 * The `--action add` arm: validate the whole batch, then write it.
 * @returns {number} exit code
 */
function addEvidence({ ledger, root, taskId, item, batchPath, json }) {
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
    raws = batchPath ? readEvidenceBatch(batchPath) : [item];
  } catch (error) {
    return usageError('evidence', error.message, json);
  }
  if (raws.length === 0) {
    return usageError('evidence', 'the batch holds no evidence items — a stage that established nothing '
      + 'should record nothing, and an empty write reported as success is the vacuous-PASS defect in another costume', json);
  }

  // The whole batch is validated before any of it is written. A half-written stage batch is worse
  // than a rejected one: the half that landed looks complete to every later reader.
  const validated = [];
  for (const [index, raw] of raws.entries()) {
    try {
      validated.push(validateEvidenceItem(raw, taskId, root));
    } catch (error) {
      const where = raws.length > 1 ? `batch item ${index + 1} of ${raws.length}: ` : '';
      return usageError('evidence', `${where}${error.message}`, json);
    }
  }

  const gitCommit = headCommit(root);
  const written = [];
  let stateFile;
  try {
    for (const record of validated) {
      const id = ledger.addEvidence({
        ...record,
        taskId,
        freshness: measureFreshness(root, record.locator, gitCommit),
      });
      written.push(ledger.getEvidence(id));
    }
    stateFile = ledger.save(taskId);
  } catch (error) {
    return usageError('evidence', error.message, json);
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
  console.log(`Commit at observation: ${gitCommit || 'not a git worktree — freshness cannot expire by diff'}`);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

/** One-line rendering of a locator for the table views. */
function locatorText(locator) {
  if (!locator) return '';
  if (locator.file) return locator.line ? `${locator.file}:${locator.line}` : locator.file;
  return locator.uri || locator.symbol || '';
}

/**
 * Handles `doflow evidence` — record a stage's evidence batch, or query what is recorded.
 *
 * @param {Object} options
 * @param {string} [options.taskId='default']
 * @param {'list'|'status'|'add'} [options.action='list']
 * @param {Object} [options.item] single-item write, assembled from flags by bin/doflow.js
 * @param {string} [options.batchPath] `add`: a JSON batch file, or `-` for stdin
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @param {string} [options.stateRoot]
 * @returns {number} exit code
 */
function handleEvidenceCommand({ taskId = 'default', action = 'list', item = null, batchPath = null, json = false, repoRoot, stateRoot } = {}) {
  // See handleReadinessCommand: evidence is the caller's project state, not DoFlow package state.
  const root = stateRoot || repoRoot || process.cwd();
  const isQuery = action === 'list' || action === 'status';
  if (!isQuery && action !== 'add') {
    return usageError('evidence', `unknown --action '${action}'. Valid: list, add`, json);
  }
  // A write argument on a read action is the defect this verb was reported for: it used to accept
  // append-shaped flags, ignore them, and print the (unchanged) ledger as if the write had landed.
  if (isQuery && ((item && Object.keys(item).length > 0) || batchPath)) {
    return usageError('evidence', 'these are write arguments and this action only reads — re-run with --action add', json);
  }

  const ledger = new EvidenceLedger({ repoRoot: root });
  try {
    ledger.load(taskId);
  } catch (error) {
    return usageError('evidence', error.message, json);
  }

  if (action === 'add') return addEvidence({ ledger, root, taskId, item, batchPath, json });

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

module.exports = {
  handleCapabilitiesCommand,
  handleReadinessCommand,
  handleEvidenceCommand,
  // Exported for bin/doflow.js, which refuses the same names as command-line flags, and for the
  // tests that pin the write boundary.
  EVIDENCE_SCORE_FIELDS,
  scoreFieldRefusal,
  // The recursive refusal itself, not just the name set — `retrieval-plan.js` applies it to the
  // option object a plan is built from and `outcome.js` to the one a terminal record is, so every
  // boundary rejects the same shapes by the same rule rather than by implementations that agree
  // today.
  assertNoScoreFields,
  validateEvidenceItem,
};
