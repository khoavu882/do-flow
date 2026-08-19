'use strict';

/**
 * The task's terminal record (feature 011, plan task B.2, design component C2; FR-011).
 *
 * A task that ends leaves nothing behind today. Readiness answered at some point, verification
 * answered at some point, evidence accumulated — and then the run stopped, and the next worker
 * opening the same task finds four states scattered across three stores and no statement of how it
 * ended. This module writes that statement: **one closed-vocabulary terminal state, with the basis
 * it rests on recorded beside it**, so "this finished" and "this stopped" are never the same
 * record.
 *
 * It mirrors `readiness.js`'s four-state shape and reuses `verification`'s meaning of
 * `INCONCLUSIVE` — a verdict over zero evidence is not a pass — and it owns no verdict of its own:
 *
 *   - It **never re-evaluates readiness and never re-runs verification.** Re-running verification
 *     would execute the project's checks as a side effect of filing a record, and re-evaluating
 *     readiness here would grade the task under a profile this verb invented rather than the one
 *     the stage actually acted on. Both verdicts therefore arrive as the caller's own statement of
 *     what its run saw, validated against the vocabulary each owning module exports, and are
 *     labelled in the record as stated rather than measured (the `callerAsserted` precedent
 *     `readiness`'s own verb already sets). A basis nobody stated reads `NOT_RECORDED` — never a
 *     pass, never an empty string, never absent.
 *   - It **does not decide when a task ends.** The workflow's terminal stage decides that (design
 *     A1), so the writer is learned from `workflow-engine`'s `terminalStage` for the declared
 *     class. A caller naming a non-terminal `--stage` is refused with the stage that is terminal.
 *   - The two things it *does* measure it measures itself, at the write: how many records the
 *     evidence ledger holds for this task, and which declared retrieval needs the run never
 *     reached (read from `retrieval-plan`'s own record, by its own path function).
 *
 * `recordedAt` is stamped here and is never accepted from the caller, exactly as the evidence
 * ledger stamps freshness at the write — a timestamp a caller supplies is a claim about when
 * something happened, not a record of it.
 *
 * No state here is a number, a percentage or a confidence (NFR-001). `basis.evidenceCount` is the
 * only integer the record carries and it is a **count of records**: how many things were filed, not
 * how good they were. Score-shaped inputs are refused by name at this boundary through the same
 * one definition `bin/doflow.js` and `retrieval-plan.js` use.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EvidenceLedger, assertSafeTaskId } = require('./evidence-ledger');
// The two verdict vocabularies, imported from the modules that own them rather than respelled
// here. A second copy would let this file accept a readiness state readiness itself has retired.
const { READINESS_STATES } = require('./readiness');
const { VERIFICATION_STATUSES } = require('./verification');
const { WorkflowEngine } = require('./workflow-engine');
// Read, not re-derived: the retrieval plan's location is `retrieval-plan.js`'s to define, and the
// unreached items this record carries forward are the ones that record already holds.
const { planPath, UNREACHED } = require('./retrieval-plan');
// One definition of the score refusal, applied at a further boundary. See the note on
// EVIDENCE_SCORE_FIELDS in cli.js: a terminal state that carried a confidence would be exactly the
// number NFR-001 exists to keep out of the one record the next worker reads first.
const { assertNoScoreFields } = require('./cli');
const { finishRuntime, usageError } = require('./cli-result');

// ── the closed terminal vocabulary (design §4) ───────────────────────────────────────────────

/** The work was done and rests on something. Unavailable over an empty ledger — see `record`. */
const COMPLETED = 'COMPLETED';
/** The work stopped against an obstacle it could not pass. It is not finished and not abandoned. */
const BLOCKED = 'BLOCKED';
/** The work was deliberately dropped. A decision, and distinct from having been stopped. */
const ABANDONED = 'ABANDONED';
/**
 * Verification's meaning, unchanged: a verdict over zero evidence is not a pass. This is what a
 * task ending with nothing recorded is, and the reason `COMPLETED` cannot describe it.
 */
const INCONCLUSIVE = 'INCONCLUSIVE';

const OUTCOME_STATES = Object.freeze([COMPLETED, BLOCKED, ABANDONED, INCONCLUSIVE]);

/**
 * What a basis field says when nobody stated it.
 *
 * Deliberately a token and not `null`: an absent readiness state and a readiness state of `READY`
 * must not be able to read the same way to anything scanning these records, and an empty field
 * invites the reader to supply the missing half themselves.
 */
const NOT_RECORDED = 'NOT_RECORDED';

// ── the record ────────────────────────────────────────────────────────────────────────────────

/**
 * Where a task's outcome lives, under the invoking project's state root.
 *
 * The task id is validated by the evidence ledger's own rule, unchanged: it becomes a filename, so
 * it must never be able to name a path.
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {string}
 */
function outcomePath(projectRoot, taskId) {
  return path.join(projectRoot, '.doflow', 'state', 'outcome', `${assertSafeTaskId(taskId)}.json`);
}

/**
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {Object|null} the record, or null when no outcome was recorded
 */
function readOutcome(projectRoot, taskId) {
  const file = outcomePath(projectRoot, taskId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`the outcome record at '${file}' is not readable: ${error.message}`);
  }
}

/**
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {Object} record
 * @returns {string} the file written
 */
function writeOutcome(projectRoot, taskId, record) {
  const file = outcomePath(projectRoot, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

// ── the basis, half measured and half stated ─────────────────────────────────────────────────

/**
 * How many records the ledger holds for this task.
 *
 * A count of records and nothing more (NFR-001). It does not weigh them, does not judge whether
 * they are the right ones — that is readiness's job, and readiness already did it — and it is the
 * one number this whole record contains.
 *
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {number}
 */
function countEvidence(projectRoot, taskId) {
  const ledger = new EvidenceLedger({ repoRoot: projectRoot });
  ledger.load(taskId);
  return ledger.queryEvidence({ taskId }).length;
}

/**
 * Declared items no run reached, carried forward from retrieval and from verification.
 *
 * Every entry names its source, because the two halves are not the same kind of gap: a retrieval
 * need that was declared and never asked is a lookup that did not happen, while an unstated or
 * inconclusive verification verdict is a check that did not establish anything. Collapsing them
 * into one unlabelled list would leave a reader unable to tell which one they are looking at.
 *
 * The retrieval half is read from the plan record — its own `UNREACHED` result, computed by the
 * module that owns that vocabulary, not recomputed here.
 *
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {string} verification the stated verification verdict, or NOT_RECORDED
 * @returns {Array<string>}
 */
function unreachedItems(projectRoot, taskId, verification) {
  const items = [];
  const file = planPath(projectRoot, taskId);
  if (fs.existsSync(file)) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`the retrieval plan at '${file}' is not readable: ${error.message}`);
    }
    for (const need of plan.needs || []) {
      if (need.result === UNREACHED) items.push(`retrieval:${need.intent}`);
    }
  }
  if (verification === NOT_RECORDED) {
    items.push('verification:NOT_RECORDED — no verification verdict was stated for this task');
  } else if (verification === 'INCONCLUSIVE') {
    items.push('verification:INCONCLUSIVE — the contract reached a verdict over zero evidence');
  }
  return items;
}

/**
 * Validates one caller-stated basis verdict against the vocabulary its owning module exports.
 *
 * An omitted verdict is `NOT_RECORDED`. An unrecognised one is refused with the valid set rather
 * than stored: a basis field holding a token nothing else in the runtime uses would look like a
 * verdict while meaning nothing.
 *
 * @param {string|undefined} value
 * @param {Iterable<string>} vocabulary
 * @param {string} flag the flag name, for the refusal
 * @returns {{value: string, stated: boolean}}
 */
function statedVerdict(value, vocabulary, flag) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: NOT_RECORDED, stated: false };
  }
  const token = String(value).trim();
  const valid = [...vocabulary];
  if (!valid.includes(token)) {
    throw new Error(`unknown ${flag} '${token}'. Valid: ${valid.join(', ')}, or omit the flag to record ${NOT_RECORDED}`);
  }
  return { value: token, stated: true };
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────

/**
 * `--action record` — write the terminal state with its basis.
 *
 * One consistency rule is enforced here and it is the one design §4 states: **`COMPLETED` is not
 * available over an empty ledger.** A task whose evidence ledger holds nothing has no basis for
 * "the work was done and rests on something", and `INCONCLUSIVE` is the state that describes it —
 * the same rule `verify` applies to a contract with no checks. It is a refusal rather than a silent
 * downgrade, because rewriting the caller's word would hide the thing worth knowing.
 *
 * A record replaces any previous one for the task: the record is keyed by task id and stamps one
 * `recordedAt`, so a second write is a second terminal statement, not an amendment to the first.
 *
 * @returns {number} exit code
 */
function recordOutcome({ projectRoot, packageRoot, taskId, taskClass, stage, state, readiness, verification, json }) {
  if (state === undefined || state === null || String(state).trim() === '') {
    return usageError('outcome',
      `--action record needs --state <state>. Valid: ${OUTCOME_STATES.join(', ')}`, json);
  }
  const proposed = String(state).trim();
  if (!OUTCOME_STATES.includes(proposed)) {
    return usageError('outcome',
      `unknown --state '${proposed}'. Valid: ${OUTCOME_STATES.join(', ')}`, json);
  }

  // The terminal stage is learned, never decided here (design A1). That is why the class is
  // required on a write: without it there is no workflow to ask which stage is the last one, and
  // guessing would put this module in charge of when a task ends.
  if (typeof taskClass !== 'string' || taskClass.trim() === '') {
    return usageError('outcome',
      '--task-class is required to record an outcome: the workflow\'s terminal stage is what writes '
      + 'one (design A1), and the class is what names that stage. Run `doflow workflow --task-class <c>` '
      + 'to see it', json);
  }
  let workflow;
  try {
    workflow = new WorkflowEngine({ repoRoot: packageRoot }).resolveWorkflow(taskClass);
  } catch (error) {
    return usageError('outcome', error.message, json);
  }
  const terminalStage = workflow.terminalStage;
  if (stage !== undefined && stage !== null && String(stage).trim() !== '' && String(stage).trim() !== terminalStage.id) {
    return usageError('outcome',
      `stage '${String(stage).trim()}' is not the terminal stage of task class '${taskClass}' — `
      + `'${terminalStage.id}' is (${workflow.stageIds.join(' -> ')}). The outcome is written by the `
      + 'stage the workflow ends on, so a record from an earlier stage would state a task had ended '
      + 'while stages remained', json);
  }

  let basisReadiness;
  let basisVerification;
  try {
    basisReadiness = statedVerdict(readiness, READINESS_STATES, '--readiness');
    basisVerification = statedVerdict(verification, VERIFICATION_STATUSES, '--verification');
  } catch (error) {
    return usageError('outcome', error.message, json);
  }

  let evidenceCount;
  let unreached;
  try {
    evidenceCount = countEvidence(projectRoot, taskId);
    unreached = unreachedItems(projectRoot, taskId, basisVerification.value);
  } catch (error) {
    return usageError('outcome', error.message, json);
  }

  if (proposed === COMPLETED && evidenceCount === 0) {
    return usageError('outcome',
      `'${COMPLETED}' is not available for task '${taskId}': its evidence ledger holds no records, so `
      + `there is nothing the completion rests on. ${INCONCLUSIVE} is the state that describes a verdict `
      + 'over zero evidence. Record the evidence with `doflow evidence --action add`, or record '
      + `--state ${INCONCLUSIVE}`, json);
  }

  const statedByCaller = [
    ...(basisReadiness.stated ? ['readiness'] : []),
    ...(basisVerification.stated ? ['verification'] : []),
  ];

  const record = {
    version: 1,
    taskId,
    state: proposed,
    // Stamped here, never accepted from the caller: a caller-supplied timestamp is a claim about
    // when a task ended, and this record's whole value is that it was written when it happened.
    recordedAt: new Date().toISOString(),
    taskClass,
    writtenByStage: terminalStage.id,
    basis: {
      readiness: basisReadiness.value,
      verification: basisVerification.value,
      evidenceCount,
      unreached,
    },
    // Which half of the basis rests on someone saying so. A record that mixes measured and stated
    // inputs must say which is which, or the next reader treats both as measurements.
    statedByCaller,
  };
  const file = writeOutcome(projectRoot, taskId, record);

  if (json) {
    console.log(JSON.stringify({ action: 'record', ...record, stateFile: file }, null, 2));
    return finishRuntime(0);
  }
  printOutcome(record, file, 'recorded');
  return finishRuntime(0);
}

/**
 * `--action show` — emit the recorded outcome.
 *
 * Exits 1 when none exists, and that is the *only* thing exit 1 means here. A recorded `BLOCKED`
 * exits 0, because the record answered: overloading the code with "the task did not complete"
 * would make "no outcome was ever recorded" and "the outcome was recorded and it was not a
 * completion" indistinguishable to every caller, which is the collapse this feature exists to undo.
 *
 * @returns {number} exit code
 */
function showOutcome({ projectRoot, taskId, json }) {
  let record;
  try {
    record = readOutcome(projectRoot, taskId);
  } catch (error) {
    return usageError('outcome', error.message, json);
  }
  if (!record) {
    const file = outcomePath(projectRoot, taskId);
    if (json) {
      console.log(JSON.stringify({
        action: 'show', taskId, state: null, stateFile: file,
        summary: `no outcome is recorded for task '${taskId}'`,
      }, null, 2));
    } else {
      console.log(`\nDoFlow Task Outcome [Task: ${taskId}]:`);
      console.log('═'.repeat(78));
      console.log(`No outcome is recorded for this task (looked in ${file}).`);
      console.log('An unrecorded outcome is not a completed task and not a failed one — it is a task');
      console.log('whose end nobody stated. The terminal stage records it with --action record.');
      console.log('═'.repeat(78) + '\n');
    }
    return finishRuntime(1);
  }

  if (json) {
    console.log(JSON.stringify({ action: 'show', ...record, stateFile: outcomePath(projectRoot, taskId) }, null, 2));
    return finishRuntime(0);
  }
  printOutcome(record, outcomePath(projectRoot, taskId), 'recorded at');
  return finishRuntime(0);
}

/** The one text rendering both actions print, so a shown record reads exactly as the written one. */
function printOutcome(record, file, verb) {
  const basis = record.basis || {};
  console.log(`\nDoFlow Task Outcome [Task: ${record.taskId}] — ${record.state}:`);
  console.log('═'.repeat(78));
  console.log(`Task class:    ${record.taskClass || 'not stated'}`);
  console.log(`Written by:    ${record.writtenByStage || 'not stated'} (the workflow's terminal stage)`);
  console.log(`Recorded at:   ${record.recordedAt}`);
  console.log('─'.repeat(78));
  console.log('Basis:');
  console.log(`  Readiness      ${basis.readiness}`);
  console.log(`  Verification   ${basis.verification}`);
  console.log(`  Evidence       ${basis.evidenceCount} record(s) — a count of records, not a score`);
  const stated = record.statedByCaller || [];
  if (stated.length > 0) {
    // Named, not hidden, exactly as the readiness verb names its own caller-asserted inputs.
    console.log(`  Caller-stated: ${stated.join(', ')} (stated by the run that recorded this, not measured here)`);
  }
  // NFR-004: what nothing reached is stated as prominently as what was decided.
  const unreached = basis.unreached || [];
  if (unreached.length > 0) {
    console.log('─'.repeat(78));
    console.log('Declared and never reached:');
    for (const item of unreached) console.log(`  ${item}`);
  }
  console.log('─'.repeat(78));
  console.log(`Outcome ${verb} ${file}`);
  console.log('═'.repeat(78) + '\n');
}

// ── the verb ──────────────────────────────────────────────────────────────────────────────────

/**
 * Handles `doflow outcome` — record a task's terminal state with its basis, or show the one
 * already recorded.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'record'|'show'|'status'} [options.action='show']
 * @param {string} [options.state] the terminal state, on `record`
 * @param {string} [options.taskClass] the workflow whose terminal stage is writing, on `record`
 * @param {string} [options.stage] the writing stage, refused when it is not the terminal one
 * @param {string} [options.readiness] the readiness state the run saw
 * @param {string} [options.verification] the verification verdict the run saw
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot] the DoFlow package root, holding the workflow registry
 * @param {string} [options.stateRoot] the project the task belongs to, holding its state
 * @returns {number} exit code
 */
function handleOutcomeCommand(options = {}) {
  const {
    taskId, action = 'show', state, taskClass, stage, readiness, verification,
    json = false, repoRoot, stateRoot,
  } = options;

  // NFR-001, at the boundary where a caller's input first becomes a record. `bin/doflow.js` already
  // refuses every score-shaped flag name on the command line; this is the same rule applied to the
  // option object, so a second input surface cannot arrive later without inheriting the refusal.
  try {
    assertNoScoreFields(options, '');
  } catch (error) {
    return usageError('outcome', error.message, json);
  }

  // `'status'` is the CLI's shared `--action` default, owned by `tools`. Every read-action verb
  // accepts it as an alias for its own default rather than reporting a usage error on an argument
  // the caller never typed — `verify`, `claim` and `retrieval-plan` already do exactly this.
  const resolvedAction = action === 'status' ? 'show' : action;
  if (resolvedAction !== 'record' && resolvedAction !== 'show') {
    return usageError('outcome', `unknown --action '${action}'. Valid: record, show (default)`, json);
  }

  // The project the task belongs to owns the state; the package root owns the workflow registry,
  // and is a different directory in every install.
  const projectRoot = stateRoot || process.cwd();
  const packageRoot = repoRoot || path.resolve(__dirname, '..', '..');

  try {
    assertSafeTaskId(taskId);
  } catch (error) {
    return usageError('outcome', error.message, json);
  }

  if (resolvedAction === 'record') {
    return recordOutcome({
      projectRoot, packageRoot, taskId, taskClass, stage, state, readiness, verification, json,
    });
  }
  return showOutcome({ projectRoot, taskId, json });
}

module.exports = {
  handleOutcomeCommand,
  outcomePath,
  OUTCOME_STATES,
  COMPLETED,
  BLOCKED,
  ABANDONED,
  INCONCLUSIVE,
  NOT_RECORDED,
};
