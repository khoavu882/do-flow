'use strict';

const path = require('node:path');
const { WorkflowEngine, CALLER_ROLES } = require('./workflow-engine');
const { finishRuntime } = require('./cli-result');
const { REPO_ROOT } = require('../helper/repo-root');


/**
 * Validates a task class proposed by the model against the classes the registry declares.
 *
 * The split is deliberate (design C11): the model proposes, the runtime validates. The classifier
 * contains no heuristics of its own — it never reads the request text and never guesses. Its only
 * job is to turn a proposal into either a resolved workflow or an explicit rejection carrying the
 * valid set, and to record which of those happened so the decision is traceable.
 */

const CLASSIFICATION_OUTCOMES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
});

const REJECTION_REASONS = Object.freeze({
  /** No class was proposed at all, or one was proposed under the wrong key. */
  MISSING_CLASS: 'missing-class',
  /** A class was proposed but is not declared in workflows.yaml. */
  UNKNOWN_CLASS: 'unknown-class',
  /** The class exists, but no stage of it names the calling skill. */
  CALLER_NOT_A_STAGE: 'caller-not-a-stage',
  /** The calling skill is not in the registry's caller list, so fit is unanswerable. */
  UNKNOWN_CALLER: 'unknown-calling-skill',
  /** The calling skill is declared to run outside class routing entirely. */
  CALLER_OUTSIDE_WORKFLOWS: 'caller-outside-workflows',
});

/**
 * What the fit check concluded, reported on every decision.
 *
 * `NOT_EVALUATED` is the load-bearing one. A gate that cannot judge and says nothing is
 * indistinguishable from a gate that judged and passed — the failure shape this whole check exists
 * to remove — so an unjudgeable fit is named as unjudged in both the field and the message rather
 * than folded into the ACCEPTED that membership earned.
 */
const FIT_STATES = Object.freeze({
  HOSTED: 'HOSTED',
  NOT_HOSTED: 'NOT_HOSTED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

/** Reasons for the fit states that are not rejections. A rejection's `fit.reason` is the same
 * string as `decision.reason`, so a reader never reconciles two names for one fact. */
const FIT_REASONS = Object.freeze({
  CLASS_NOT_RESOLVED: 'class-not-resolved',
  NO_CALLER: 'no-calling-skill-supplied',
  CALLER_KEY_NEAR_MISS: 'caller-key-near-miss',
  CALLER_IS_ROUTER: 'caller-is-a-router',
});

/** Keys a caller plausibly reaches for instead of `taskClass`. Naming them back in the rejection
 * message is the whole fix for the `taskProfile.taskId` / `id` defect family: a near-miss key is
 * reported as a near-miss, never read as if it were the right one and never ignored into a
 * default. */
const NEAR_MISS_KEYS = ['class', 'taskType', 'type', 'proposedClass', 'workflow', 'workflowClass'];

/** The same treatment for the caller's identity: a proposal that names its caller under one of
 * these has said who is asking, and reading it as "nobody asked" would turn a near miss into a
 * silent skip of the fit check. */
const CALLER_NEAR_MISS_KEYS = ['caller', 'callerSkill', 'skill', 'skillId', 'invokedBy', 'calledBy'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a proposal into its parts without normalizing the class itself.
 *
 * Case and whitespace are preserved on purpose: `'Feature '` is a rejection with a suggestion, not
 * a silent match. Trimming here would be a small coercion that hides a real formatting bug in the
 * caller's output.
 */
function readProposal(proposal) {
  if (proposal === null || proposal === undefined) {
    return {
      taskClass: null, rationale: null, proposedBy: null, callingSkill: null,
      nearMissKeys: [], nearMissCallerKeys: [],
    };
  }
  if (typeof proposal === 'string') {
    return {
      taskClass: proposal, rationale: null, proposedBy: null, callingSkill: null,
      nearMissKeys: [], nearMissCallerKeys: [],
    };
  }
  if (!isPlainObject(proposal)) {
    throw new TypeError(
      `A task-class proposal must be a string or an object, received ${typeof proposal}`,
    );
  }
  const hasKey = Object.prototype.hasOwnProperty.call(proposal, 'taskClass');
  const callingSkill = typeof proposal.callingSkill === 'string' && proposal.callingSkill.trim() !== ''
    ? proposal.callingSkill
    : null;
  return {
    taskClass: hasKey ? proposal.taskClass : null,
    callingSkill,
    rationale: typeof proposal.rationale === 'string' ? proposal.rationale : null,
    // Not defaulted to 'model': attributing a proposal to an actor we did not observe would put a
    // fabricated fact into the trace.
    proposedBy: typeof proposal.proposedBy === 'string' ? proposal.proposedBy : null,
    signals: Array.isArray(proposal.signals) ? proposal.signals.slice() : [],
    nearMissKeys: hasKey
      ? []
      : NEAR_MISS_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(proposal, key)),
    nearMissCallerKeys: callingSkill
      ? []
      : CALLER_NEAR_MISS_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(proposal, key)),
  };
}

/**
 * Candidates a rejected id plausibly meant — a class id against the class list, or a caller id
 * against the caller list. Suggestion only: nothing acts on it, so a wrong suggestion costs the
 * user a second look rather than the wrong workflow.
 *
 * Matching is substring in both directions, so a short id matches generously — `do` would match
 * every `do-*` skill. That is acceptable for a hint nobody acts on; it is why the messages present
 * the result as "Did you mean" rather than as a shortlist.
 */
function suggestFrom(proposed, candidates) {
  if (typeof proposed !== 'string' || proposed.trim() === '') return [];
  const needle = proposed.trim().toLowerCase();
  return candidates.filter((candidate) => {
    const other = candidate.toLowerCase();
    return other === needle || other.includes(needle) || needle.includes(other);
  });
}

/**
 * Judges whether the proposed class has a stage the calling skill can occupy.
 *
 * Structural only: it asks whether some stage of the class names this skill, and consults the
 * registry's declared caller roles for the two cases where stage membership is the wrong question.
 * It never reads the request. When it cannot judge — no caller named, or a caller the registry does
 * not declare — it says so rather than passing.
 *
 * @param {WorkflowEngine} engine
 * @param {string} taskClass a class already known to exist
 * @param {string|null} callingSkill
 * @param {Array<string>} nearMissCallerKeys
 * @returns {{state: string, reason: string|null, callingSkill: string|null, callerRole: string|null,
 *   hostedStageIds: Array<string>, hostingClasses: Array<{taskClass: string, stageIds: Array<string>}>,
 *   callerSuggestions: Array<string>}} frozen
 */
function judgeFit(engine, taskClass, callingSkill, nearMissCallerKeys) {
  const unevaluated = (reason, extra = {}) => Object.freeze({
    state: FIT_STATES.NOT_EVALUATED,
    reason,
    callingSkill,
    callerRole: null,
    hostedStageIds: [],
    hostingClasses: [],
    callerSuggestions: [],
    ...extra,
  });

  if (callingSkill === null) {
    return nearMissCallerKeys.length > 0
      ? unevaluated(FIT_REASONS.CALLER_KEY_NEAR_MISS)
      : unevaluated(FIT_REASONS.NO_CALLER);
  }

  // A caller id the registry does not declare is a rejection, never a NOT_EVALUATED pass: reading
  // `do-diagnos` as "no caller supplied" would let a one-character typo switch the gate off, which
  // is the silently-passing shape this check exists to remove.
  if (!engine.hasCaller(callingSkill)) {
    return unevaluated(REJECTION_REASONS.UNKNOWN_CALLER, {
      callerSuggestions: suggestFrom(callingSkill, engine.listCallers()),
    });
  }

  const callerRole = engine.callerRole(callingSkill);
  // Derived from the stage lists rather than declared, so it cannot drift from them. On HOSTED it
  // includes the accepted class: it is the caller's complete map, not a list of alternatives.
  const hostingClasses = engine.classesHosting(callingSkill);
  const decided = (state, reason, hostedStageIds = []) => Object.freeze({
    state, reason, callingSkill, callerRole, hostedStageIds, hostingClasses, callerSuggestions: [],
  });

  if (callerRole === CALLER_ROLES.ROUTER) {
    return decided(FIT_STATES.NOT_APPLICABLE, FIT_REASONS.CALLER_IS_ROUTER);
  }
  if (callerRole === CALLER_ROLES.STANDALONE) {
    return decided(FIT_STATES.NOT_HOSTED, REJECTION_REASONS.CALLER_OUTSIDE_WORKFLOWS);
  }

  const hostedStageIds = engine.stagesHosting(taskClass, callingSkill);
  return hostedStageIds.length > 0
    ? decided(FIT_STATES.HOSTED, null, hostedStageIds)
    : decided(FIT_STATES.NOT_HOSTED, REJECTION_REASONS.CALLER_NOT_A_STAGE);
}

/** `bug (root-cause), refactor (architecture-mapping)` — the caller's hosting map, as prose. */
function renderHostingClasses(hostingClasses) {
  return hostingClasses
    .map(({ taskClass, stageIds }) => `${taskClass} (${stageIds.join(', ')})`)
    .join(', ');
}

/**
 * The sentence appended to an ACCEPTED decision's message. Always present, including — especially —
 * when fit was not evaluated: an operator must be able to read the blind spot off the message
 * without inspecting the JSON.
 */
function describeAcceptedFit(fit, nearMissCallerKeys) {
  if (fit.state === FIT_STATES.HOSTED) {
    return ` It hosts '${fit.callingSkill}' at stage(s): ${fit.hostedStageIds.join(', ')}.`;
  }
  if (fit.state === FIT_STATES.NOT_APPLICABLE) {
    return ` Fit is not applicable: '${fit.callingSkill}' is declared a router, so it occupies no `
      + 'stage. The skill this work is handed to must classify under its own identity.';
  }
  if (fit.reason === FIT_REASONS.CALLER_KEY_NEAR_MISS) {
    return ' Fit was NOT evaluated: the proposal carries '
      + `${nearMissCallerKeys.map((key) => `'${key}'`).join(', ')}; the calling skill must be given `
      + 'as `callingSkill`. Membership is all this decision establishes.';
  }
  return ' Fit was NOT evaluated: no calling skill was named, so this decision establishes that the '
    + 'class exists and nothing about whether its workflow can host the caller. Pass '
    + '--calling-skill <skill-id> to have fit checked.';
}

/**
 * The message for a rejection the fit check produced. Each one names the remedy: a rejection nobody
 * can act on is a stop rather than a fix.
 */
function describeFitRejection(fit, taskClass, workflow, engine) {
  if (fit.reason === REJECTION_REASONS.UNKNOWN_CALLER) {
    const hint = fit.callerSuggestions.length > 0
      ? ` Did you mean: ${fit.callerSuggestions.join(', ')}?`
      : '';
    return `Calling skill '${fit.callingSkill}' is not declared in the workflow registry's caller `
      + 'list, so fit could not be judged and the proposal is refused rather than accepted on a '
      + `membership check alone. Declared callers: ${engine.listCallers().join(', ')}.${hint}`;
  }
  if (fit.reason === REJECTION_REASONS.CALLER_OUTSIDE_WORKFLOWS) {
    return `'${fit.callingSkill}' runs outside class routing — no workflow declares a stage for it `
      + `— so no task class can host it. ${engine.callerReason(fit.callingSkill)} Do not propose a `
      + 'class for this work.';
  }
  const head = `Task class '${taskClass}' is declared, but its workflow has no stage for `
    + `'${fit.callingSkill}'`;
  if (fit.hostingClasses.length === 0) {
    return `${head}, and no declared class names it at any stage. That is a registry defect, not a `
      + 'proposal you can fix: report it rather than choosing another class.';
  }
  return `${head}: ${taskClass} runs ${workflow.stageIds.join(' → ')} `
    + `(skills: ${workflow.stageSkills.join(', ')}). Classes with a stage for `
    + `'${fit.callingSkill}': ${renderHostingClasses(fit.hostingClasses)}. Propose one of those, or `
    + `hand this work to the skill '${taskClass}' names for the stage you meant.`;
}

class TaskClassifier {
  /**
   * @param {Object} [options]
   * @param {WorkflowEngine} [options.engine] Pre-built engine; otherwise one is built from `options`.
   * @param {Function} [options.now] Clock returning an ISO timestamp, for deterministic tests.
   */
  constructor(options = {}) {
    this.engine = options.engine || new WorkflowEngine(options);
    this.now = options.now || (() => new Date().toISOString());
  }

  /** @returns {Array<string>} */
  listClasses() {
    return this.engine.listClasses();
  }

  /** @returns {Array<Object>} class summaries, for presenting the choice to a model or a user. */
  listClassOptions() {
    return this.engine.listClassOptions();
  }

  /**
   * Validates a proposed class and resolves its workflow.
   *
   * @param {string|Object|null} proposal Either a class id or
   *   `{ taskClass, rationale, proposedBy, signals, callingSkill }`.
   * @param {Object} [context] Free-form trace context (task id, request summary) echoed on the decision.
   * @returns {Object} decision — `outcome` is ACCEPTED with a `workflow`, or REJECTED with
   *   `reason`, `validClasses` and a null `workflow`. Never coerced to a default class. Every
   *   decision carries `fit`, which reports whether the class's workflow has a stage the calling
   *   skill can occupy — including `NOT_EVALUATED` when no caller was named, since an unchecked fit
   *   must never read as a checked one.
   */
  classify(proposal, context = {}) {
    const validClasses = this.listClasses();
    const parsed = readProposal(proposal);
    const base = {
      proposedClass: parsed.taskClass,
      proposedBy: parsed.proposedBy,
      callingSkill: parsed.callingSkill,
      rationale: parsed.rationale,
      signals: parsed.signals || [],
      validClasses,
      // Not merged into `suggestions`: skills present that array to the user as "choose one of
      // these classes", and a skill id in it would be offered as a task class.
      callerSuggestions: [],
      // Fit against a class that does not resolve is not a question that has an answer, so the two
      // rejections below inherit this rather than claiming anything about the caller.
      fit: Object.freeze({
        state: FIT_STATES.NOT_EVALUATED,
        reason: FIT_REASONS.CLASS_NOT_RESOLVED,
        callingSkill: parsed.callingSkill,
        callerRole: null,
        hostedStageIds: [],
        hostingClasses: [],
        callerSuggestions: [],
      }),
      context: isPlainObject(context) ? { ...context } : {},
      decidedAt: this.now(),
    };

    if (typeof parsed.taskClass !== 'string' || parsed.taskClass.trim() === '') {
      const nearMiss = parsed.nearMissKeys.length > 0
        ? ` The proposal carries ${parsed.nearMissKeys.map((k) => `'${k}'`).join(', ')}; `
          + 'the class must be given as `taskClass`.'
        : '';
      return {
        ...base,
        outcome: CLASSIFICATION_OUTCOMES.REJECTED,
        taskClass: null,
        workflow: null,
        reason: REJECTION_REASONS.MISSING_CLASS,
        suggestions: [],
        message: `No task class was proposed, so no workflow can be selected.${nearMiss} `
          + `Propose one of: ${validClasses.join(', ')}.`,
      };
    }

    if (!this.engine.hasClass(parsed.taskClass)) {
      const suggestions = suggestFrom(parsed.taskClass, validClasses);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      return {
        ...base,
        outcome: CLASSIFICATION_OUTCOMES.REJECTED,
        taskClass: null,
        workflow: null,
        reason: REJECTION_REASONS.UNKNOWN_CLASS,
        suggestions,
        message: `Proposed task class '${parsed.taskClass}' is not declared in the workflow `
          + `registry. Valid classes: ${validClasses.join(', ')}.${hint}`,
      };
    }

    const fit = judgeFit(
      this.engine, parsed.taskClass, parsed.callingSkill, parsed.nearMissCallerKeys,
    );
    const workflow = this.engine.resolveWorkflow(parsed.taskClass);

    // A class that exists but has no stage for the caller is still a rejection: accepting it would
    // put the caller's work under a workflow with nowhere to record it, which is the defect the fit
    // check was added for. An unknown caller rejects too — see judgeFit.
    if (fit.state === FIT_STATES.NOT_HOSTED || fit.reason === REJECTION_REASONS.UNKNOWN_CALLER) {
      return {
        ...base,
        outcome: CLASSIFICATION_OUTCOMES.REJECTED,
        taskClass: null,
        workflow: null,
        reason: fit.reason,
        suggestions: [],
        callerSuggestions: fit.callerSuggestions,
        fit,
        message: describeFitRejection(fit, parsed.taskClass, workflow, this.engine),
      };
    }

    return {
      ...base,
      outcome: CLASSIFICATION_OUTCOMES.ACCEPTED,
      taskClass: parsed.taskClass,
      workflow,
      reason: null,
      suggestions: [],
      fit,
      message: `Task class '${parsed.taskClass}' selects the ${workflow.name} workflow: `
        + `${workflow.stageIds.join(' → ')}.`
        + describeAcceptedFit(fit, parsed.nearMissCallerKeys),
    };
  }

  /**
   * Same validation, but a rejection throws instead of returning.
   *
   * For call sites that cannot meaningfully continue without a workflow — the alternative there is
   * an ignored `outcome` field and a downstream null dereference far from the real cause.
   * @param {string|Object} proposal
   * @param {Object} [context]
   * @returns {Object} the resolved workflow
   */
  resolve(proposal, context = {}) {
    const decision = this.classify(proposal, context);
    if (decision.outcome !== CLASSIFICATION_OUTCOMES.ACCEPTED) {
      throw new Error(decision.message);
    }
    return decision.workflow;
  }
}

/**
 * Handles `doflow classify` — validate a proposed task class against the workflow registry.
 *
 * Prints the classifier's decision object verbatim: `outcome`, `taskClass`, `message`,
 * `validClasses`, `suggestions`, `fit`, `workflow`. A REJECTED decision keeps `taskClass: null` and
 * exits non-zero; it is never coerced to `feature`, which is the whole reason this verb exists
 * rather than callers reading a class out of a string themselves.
 *
 * @param {Object} options
 * @param {string|null} options.taskClass the proposed class
 * @param {string} [options.rationale]
 * @param {string} [options.proposedBy]
 * @param {string} [options.callingSkill] the skill asking, against which fit is judged
 * @param {boolean} [options.json=false]
 * @returns {number} exit code
 */
function handleClassifyCommand({ taskClass, rationale, proposedBy, callingSkill, json = false } = {}) {
  const classifier = new TaskClassifier({ repoRoot: REPO_ROOT });
  const decision = classifier.classify({ taskClass, rationale, proposedBy, callingSkill });

  if (json) console.log(JSON.stringify(decision, null, 2));
  else {
    console.log(`\nDoFlow Task Classification [${decision.outcome}]:`);
    console.log('═'.repeat(78));
    console.log(decision.message);
    // Printed unconditionally, including when it says NOT_EVALUATED: an operator has to be able to
    // see that fit was never checked without reading --json.
    console.log(`Fit: ${decision.fit.state}${decision.fit.reason ? ` (${decision.fit.reason})` : ''}`);
    if (decision.fit.state === 'NOT_HOSTED' && decision.fit.hostingClasses.length > 0) {
      console.log(`Classes that host ${decision.fit.callingSkill}: `
        + decision.fit.hostingClasses.map((h) => `${h.taskClass} (${h.stageIds.join(', ')})`).join(', '));
    }
    if (decision.workflow) {
      console.log('─'.repeat(78));
      console.log(`Workflow: ${decision.workflow.name} (${decision.workflow.stageIds.length} stage(s))`);
      console.log(`Stages:   ${decision.workflow.stageIds.join(' → ')}`);
      console.log(`Implementation stages: ${decision.workflow.hasImplementationStage ? decision.workflow.implementationStageIds.join(', ') : 'none'}`);
    } else {
      console.log(`Valid classes: ${decision.validClasses.join(', ')}`);
    }
    console.log('═'.repeat(78) + '\n');
  }

  if (decision.outcome === CLASSIFICATION_OUTCOMES.ACCEPTED) return finishRuntime(0);
  // No class supplied is the CLI's caller failing to say what to classify; a class supplied and
  // rejected is the classifier having done its job and found something the caller must fix.
  return finishRuntime(decision.reason === REJECTION_REASONS.MISSING_CLASS ? 2 : 1);
}

module.exports = {
  TaskClassifier,
  CLASSIFICATION_OUTCOMES,
  REJECTION_REASONS,
  FIT_STATES,
  FIT_REASONS,
  handleClassifyCommand,
};
