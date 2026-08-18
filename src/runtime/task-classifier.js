'use strict';

const { WorkflowEngine } = require('./workflow-engine');

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
});

/** Keys a caller plausibly reaches for instead of `taskClass`. Naming them back in the rejection
 * message is the whole fix for the `taskProfile.taskId` / `id` defect family: a near-miss key is
 * reported as a near-miss, never read as if it were the right one and never ignored into a
 * default. */
const NEAR_MISS_KEYS = ['class', 'taskType', 'type', 'proposedClass', 'workflow', 'workflowClass'];

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
    return { taskClass: null, rationale: null, proposedBy: null, nearMissKeys: [] };
  }
  if (typeof proposal === 'string') {
    return { taskClass: proposal, rationale: null, proposedBy: null, nearMissKeys: [] };
  }
  if (!isPlainObject(proposal)) {
    throw new TypeError(
      `A task-class proposal must be a string or an object, received ${typeof proposal}`,
    );
  }
  const hasKey = Object.prototype.hasOwnProperty.call(proposal, 'taskClass');
  return {
    taskClass: hasKey ? proposal.taskClass : null,
    rationale: typeof proposal.rationale === 'string' ? proposal.rationale : null,
    // Not defaulted to 'model': attributing a proposal to an actor we did not observe would put a
    // fabricated fact into the trace.
    proposedBy: typeof proposal.proposedBy === 'string' ? proposal.proposedBy : null,
    signals: Array.isArray(proposal.signals) ? proposal.signals.slice() : [],
    nearMissKeys: hasKey
      ? []
      : NEAR_MISS_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(proposal, key)),
  };
}

/**
 * Classes a rejected proposal plausibly meant. Suggestion only — nothing acts on it, so a wrong
 * suggestion costs the user a second look rather than the wrong workflow.
 */
function suggestClasses(proposed, validClasses) {
  if (typeof proposed !== 'string' || proposed.trim() === '') return [];
  const needle = proposed.trim().toLowerCase();
  return validClasses.filter((candidate) => {
    const other = candidate.toLowerCase();
    return other === needle || other.includes(needle) || needle.includes(other);
  });
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
   * @param {string|Object|null} proposal Either a class id or `{ taskClass, rationale, proposedBy, signals }`.
   * @param {Object} [context] Free-form trace context (task id, request summary) echoed on the decision.
   * @returns {Object} decision — `outcome` is ACCEPTED with a `workflow`, or REJECTED with
   *   `reason`, `validClasses` and a null `workflow`. Never coerced to a default class.
   */
  classify(proposal, context = {}) {
    const validClasses = this.listClasses();
    const parsed = readProposal(proposal);
    const base = {
      proposedClass: parsed.taskClass,
      proposedBy: parsed.proposedBy,
      rationale: parsed.rationale,
      signals: parsed.signals || [],
      validClasses,
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
      const suggestions = suggestClasses(parsed.taskClass, validClasses);
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

    const workflow = this.engine.resolveWorkflow(parsed.taskClass);
    return {
      ...base,
      outcome: CLASSIFICATION_OUTCOMES.ACCEPTED,
      taskClass: parsed.taskClass,
      workflow,
      reason: null,
      suggestions: [],
      message: `Task class '${parsed.taskClass}' selects the ${workflow.name} workflow: `
        + `${workflow.stageIds.join(' → ')}.`,
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

module.exports = {
  TaskClassifier,
  CLASSIFICATION_OUTCOMES,
  REJECTION_REASONS,
};
