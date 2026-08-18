'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseYamlFile } = require('./capability-router');

/**
 * Resolves a task class to the ordered stages that run for it.
 *
 * The engine holds no knowledge of any particular class. Everything it answers — which stages run,
 * which of them mutate source, which readiness template gates them — is read from
 * `core/registry/workflows.yaml`, so adding a class is a registry edit and not a code change.
 */

/** Fields every stage must declare as a non-empty string. `readinessTemplate` and `optional` are
 * checked separately, because for those two an *absent* key is the dangerous case: reading a
 * missing `readinessTemplate` as "ungated" is how a gate disappears without anyone noticing. */
const STAGE_STRING_FIELDS = ['id', 'skill', 'kind', 'purpose'];
const GATE_STRING_FIELDS = ['id', 'name', 'afterStage', 'kind', 'trigger', 'prompt'];

const READINESS_REGISTRY_FILE = 'readiness-templates.yaml';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Accepts the several shapes a caller may already hold readiness templates in: the parsed
 * registry document, its `templates` map, a Set, or a plain list of names. */
function normalizeTemplateNames(input) {
  if (Array.isArray(input)) return new Set(input);
  if (input instanceof Set) return new Set(input);
  if (isPlainObject(input)) {
    const map = isPlainObject(input.templates) ? input.templates : input;
    return new Set(Object.keys(map));
  }
  throw new TypeError(
    'readinessTemplates must be an array, a Set, an object keyed by template name, '
    + 'or false to disable the cross-check',
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

class WorkflowEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {string} [options.registryPath]
   * @param {Object} [options.workflows] Pre-parsed registry document, bypassing the filesystem.
   * @param {Object|Array<string>|Set<string>|false} [options.readinessTemplates] Template names to
   *   cross-check stage gates against, or `false` to skip the cross-check. When omitted, names are
   *   read from `readiness-templates.yaml` beside the workflow registry — but only if the workflow
   *   registry itself came from disk, so an injected document never forces a filesystem read.
   * @param {Object} [options.fsImpl]
   */
  constructor(options = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
    this.registryPath = options.registryPath
      || path.join(this.repoRoot, 'core', 'registry', 'workflows.yaml');

    const injected = Boolean(options.workflows);
    const document = options.workflows || this.loadRegistry();

    if (options.readinessTemplates === false || options.readinessTemplates === null) {
      this.knownReadinessTemplates = null;
    } else if (options.readinessTemplates !== undefined) {
      this.knownReadinessTemplates = normalizeTemplateNames(options.readinessTemplates);
    } else {
      // A stage naming a template that does not exist would gate on nothing while looking gated —
      // the same shape of defect as a verification check with no command reporting PASS. Catch it
      // at load rather than at the gate.
      this.knownReadinessTemplates = injected ? null : this.loadReadinessTemplateNames();
    }

    const problems = WorkflowEngine.validateRegistry(document, {
      readinessTemplates: this.knownReadinessTemplates,
    });
    if (problems.length > 0) {
      throw new Error(
        `Invalid workflow registry '${this.registryPath}':\n  - ${problems.join('\n  - ')}`,
      );
    }

    this.version = document.version;
    this.stageKinds = document.stageKinds;
    this.classes = document.classes;
    this.resolvedCache = new Map();
  }

  loadRegistry() {
    return parseYamlFile(this.registryPath, this.fsImpl);
  }

  /** @returns {Set<string>} template names declared in the sibling readiness registry. */
  loadReadinessTemplateNames() {
    const templatePath = path.join(path.dirname(this.registryPath), READINESS_REGISTRY_FILE);
    const document = parseYamlFile(templatePath, this.fsImpl);
    if (!isPlainObject(document.templates) || Object.keys(document.templates).length === 0) {
      throw new Error(`Readiness registry '${templatePath}' declares no templates`);
    }
    return new Set(Object.keys(document.templates));
  }

  /**
   * Structural validation of a registry document. Returns every problem found rather than the
   * first, so a guard can report the whole picture in one run.
   * @param {Object} document
   * @param {Object} [options]
   * @param {Set<string>|null} [options.readinessTemplates]
   * @returns {Array<string>}
   */
  static validateRegistry(document, options = {}) {
    const problems = [];
    if (!isPlainObject(document)) {
      return ['registry document is not an object'];
    }
    if (!isPlainObject(document.stageKinds) || Object.keys(document.stageKinds).length === 0) {
      problems.push('`stageKinds` must be a non-empty object');
    }
    if (!isPlainObject(document.classes) || Object.keys(document.classes).length === 0) {
      problems.push('`classes` must be a non-empty object');
    }
    if (problems.length > 0) return problems;

    // A class must never be resolvable by default. If the registry ever grows a default-class key,
    // fail here rather than let it silently absorb every unclassified task.
    if ('defaultClass' in document) {
      problems.push('`defaultClass` is not permitted: an unrecognized class is rejected, never coerced');
    }

    const knownTemplates = options.readinessTemplates || null;
    const kindIds = new Set(Object.keys(document.stageKinds));

    for (const [kindId, kind] of Object.entries(document.stageKinds)) {
      if (!isPlainObject(kind)) {
        problems.push(`stageKind '${kindId}' must be an object`);
        continue;
      }
      if (typeof kind.mutatesSource !== 'boolean') {
        problems.push(`stageKind '${kindId}' must declare a boolean \`mutatesSource\``);
      }
      if (!isNonEmptyString(kind.description)) {
        problems.push(`stageKind '${kindId}' must declare a non-empty \`description\``);
      }
    }

    for (const [classId, definition] of Object.entries(document.classes)) {
      if (!isPlainObject(definition)) {
        problems.push(`class '${classId}' must be an object`);
        continue;
      }
      for (const field of ['name', 'description', 'readinessNote']) {
        if (!isNonEmptyString(definition[field])) {
          problems.push(`class '${classId}' must declare a non-empty \`${field}\``);
        }
      }
      if (definition.handoff !== undefined && !isNonEmptyString(definition.handoff)) {
        problems.push(`class '${classId}' declares a \`handoff\` that is not a non-empty string`);
      }
      if (!Array.isArray(definition.stages) || definition.stages.length === 0) {
        problems.push(`class '${classId}' must declare a non-empty \`stages\` array`);
        continue;
      }

      const stageIds = new Set();
      let hasRequiredStage = false;

      definition.stages.forEach((stage, index) => {
        const where = `class '${classId}' stage #${index + 1}`;
        if (!isPlainObject(stage)) {
          problems.push(`${where} must be an object`);
          return;
        }
        for (const field of STAGE_STRING_FIELDS) {
          if (!isNonEmptyString(stage[field])) {
            problems.push(`${where} must declare a non-empty \`${field}\``);
          }
        }
        if (isNonEmptyString(stage.id)) {
          if (stageIds.has(stage.id)) {
            problems.push(`class '${classId}' declares duplicate stage id '${stage.id}'`);
          }
          stageIds.add(stage.id);
        }
        if (isNonEmptyString(stage.kind) && !kindIds.has(stage.kind)) {
          problems.push(`${where} names undeclared stage kind '${stage.kind}'`);
        }
        if (typeof stage.optional !== 'boolean') {
          problems.push(`${where} must declare a boolean \`optional\` explicitly`);
        } else if (!stage.optional) {
          hasRequiredStage = true;
        }
        if (!Object.prototype.hasOwnProperty.call(stage, 'readinessTemplate')) {
          problems.push(`${where} must declare \`readinessTemplate\` explicitly (null when ungated)`);
        } else if (stage.readinessTemplate !== null) {
          if (!isNonEmptyString(stage.readinessTemplate)) {
            problems.push(`${where} \`readinessTemplate\` must be null or a template name`);
          } else if (knownTemplates && !knownTemplates.has(stage.readinessTemplate)) {
            problems.push(
              `${where} references readiness template '${stage.readinessTemplate}', which does not exist`,
            );
          }
        }
        // An edit that no readiness contract gates is the failure mode FR-008 exists to prevent,
        // so the registry cannot express one.
        const kind = isNonEmptyString(stage.kind) ? document.stageKinds[stage.kind] : null;
        if (kind && kind.mutatesSource === true && stage.readinessTemplate === null) {
          problems.push(`${where} mutates source but declares no readiness template`);
        }
      });

      if (!hasRequiredStage) {
        problems.push(
          `class '${classId}' has no required stage; a workflow of only optional stages runs nothing`,
        );
      }

      const gates = definition.gates;
      if (!Array.isArray(gates)) {
        problems.push(`class '${classId}' must declare a \`gates\` array (empty when it has none)`);
        continue;
      }
      const gateIds = new Set();
      gates.forEach((gate, index) => {
        const where = `class '${classId}' gate #${index + 1}`;
        if (!isPlainObject(gate)) {
          problems.push(`${where} must be an object`);
          return;
        }
        for (const field of GATE_STRING_FIELDS) {
          if (!isNonEmptyString(gate[field])) {
            problems.push(`${where} must declare a non-empty \`${field}\``);
          }
        }
        if (isNonEmptyString(gate.id)) {
          if (gateIds.has(gate.id)) {
            problems.push(`class '${classId}' declares duplicate gate id '${gate.id}'`);
          }
          gateIds.add(gate.id);
        }
        if (isNonEmptyString(gate.afterStage) && !stageIds.has(gate.afterStage)) {
          problems.push(`${where} attaches to unknown stage '${gate.afterStage}'`);
        }
      });
    }

    return problems;
  }

  /** @returns {Array<string>} declared class ids, in declaration order. */
  listClasses() {
    return Object.keys(this.classes);
  }

  /**
   * @param {*} taskClass
   * @returns {boolean} true only for an exactly-matching declared class id.
   */
  hasClass(taskClass) {
    return typeof taskClass === 'string'
      && Object.prototype.hasOwnProperty.call(this.classes, taskClass);
  }

  /** @param {string} kind @returns {boolean} */
  isImplementationKind(kind) {
    const declared = this.stageKinds[kind];
    if (!declared) {
      throw new Error(
        `Unknown stage kind '${kind}'. Declared: ${Object.keys(this.stageKinds).join(', ')}`,
      );
    }
    return declared.mutatesSource === true;
  }

  /**
   * Summaries of every class, for presenting the choice before one is proposed.
   * @returns {Array<Object>}
   */
  listClassOptions() {
    return this.listClasses().map((taskClass) => {
      const workflow = this.resolveWorkflow(taskClass);
      return {
        taskClass,
        name: workflow.name,
        description: workflow.description,
        stageCount: workflow.stages.length,
        hasImplementationStage: workflow.hasImplementationStage,
        requiresImplementationReadiness: workflow.requiresImplementationReadiness,
      };
    });
  }

  /**
   * Resolves a task class to its full workflow.
   *
   * Throws on a missing or unrecognized class. There is no fallback class: resolving an unknown
   * input to `feature` would produce a confident answer about the wrong workflow.
   * @param {string} taskClass
   * @returns {Object} frozen ResolvedWorkflow
   */
  resolveWorkflow(taskClass) {
    if (!isNonEmptyString(taskClass)) {
      throw new Error(
        `A task class is required to resolve a workflow (received ${JSON.stringify(taskClass)}). `
        + `Valid classes: ${this.listClasses().join(', ')}`,
      );
    }
    if (!this.hasClass(taskClass)) {
      throw new Error(
        `Unknown task class '${taskClass}'. Valid classes: ${this.listClasses().join(', ')}`,
      );
    }
    if (this.resolvedCache.has(taskClass)) {
      return this.resolvedCache.get(taskClass);
    }

    const definition = this.classes[taskClass];
    const gates = definition.gates.map((gate) => ({ ...gate }));

    const stages = definition.stages.map((stage, index) => ({
      ...stage,
      index,
      mutatesSource: this.isImplementationKind(stage.kind),
      kindDescription: this.stageKinds[stage.kind].description,
      gatesAfter: gates.filter((gate) => gate.afterStage === stage.id),
    }));

    const implementationStages = stages.filter((stage) => stage.mutatesSource);
    const readinessTemplates = [
      ...new Set(stages.map((stage) => stage.readinessTemplate).filter(Boolean)),
    ];

    const workflow = deepFreeze({
      taskClass,
      version: this.version,
      name: definition.name,
      description: definition.description,
      handoff: definition.handoff || null,
      readinessNote: definition.readinessNote,
      stages,
      stageIds: stages.map((stage) => stage.id),
      requiredStageIds: stages.filter((stage) => !stage.optional).map((stage) => stage.id),
      optionalStageIds: stages.filter((stage) => stage.optional).map((stage) => stage.id),
      gates,
      gateIds: gates.map((gate) => gate.id),
      implementationStageIds: implementationStages.map((stage) => stage.id),
      hasImplementationStage: implementationStages.length > 0,
      requiresImplementationReadiness: readinessTemplates.length > 0,
      readinessTemplates,
      terminalStage: stages[stages.length - 1],
    });

    this.resolvedCache.set(taskClass, workflow);
    return workflow;
  }

  /**
   * @param {string} taskClass
   * @param {string} stageId
   * @returns {Object} the resolved stage
   */
  describeStage(taskClass, stageId) {
    const workflow = this.resolveWorkflow(taskClass);
    const stage = workflow.stages.find((candidate) => candidate.id === stageId);
    if (!stage) {
      throw new Error(
        `Unknown stage '${stageId}' for task class '${taskClass}'. `
        + `Stages: ${workflow.stageIds.join(' -> ')}`,
      );
    }
    return stage;
  }

  /**
   * The next stage to run, given the stages already completed.
   *
   * An unrecognized completed-stage id throws: a caller that mistypes a stage id must not be told
   * the workflow starts over from the beginning.
   * @param {string} taskClass
   * @param {Array<string>} [completedStageIds]
   * @returns {Object|null} the next stage, or null when the workflow is exhausted
   */
  nextStage(taskClass, completedStageIds = []) {
    const workflow = this.resolveWorkflow(taskClass);
    if (!Array.isArray(completedStageIds)) {
      throw new TypeError('completedStageIds must be an array of stage ids');
    }
    const known = new Set(workflow.stageIds);
    for (const completed of completedStageIds) {
      if (!known.has(completed)) {
        throw new Error(
          `Unknown completed stage '${completed}' for task class '${taskClass}'. `
          + `Stages: ${workflow.stageIds.join(' -> ')}`,
        );
      }
    }
    const done = new Set(completedStageIds);
    return workflow.stages.find((stage) => !done.has(stage.id)) || null;
  }

  /**
   * @param {string} taskClass
   * @param {string} stageId
   * @returns {Array<Object>} gates that fire after the named stage
   */
  gatesAfter(taskClass, stageId) {
    return this.describeStage(taskClass, stageId).gatesAfter;
  }
}

module.exports = {
  WorkflowEngine,
};
