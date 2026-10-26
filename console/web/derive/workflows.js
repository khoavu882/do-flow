// The Workflows view's derivations (F.2; design.md section 7 V6): the numbered steps of a workflow, the text alternative of
// its diagram and the diagram's same-origin path. No DOM and no fetch, so console/test/derive-workflows.test.ts runs them as
// plain functions. Every string stays a string: the view puts it on the page as text.

const isObject = (/** @type {any} */ value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A class id that may name `diagrams/<class>.svg`: the registry's own ids, lower case with hyphens. */
const CLASS_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The words of a gate kind. */
const GATE_WORDS = Object.freeze({ approval: 'approval gate', clarification: 'clarification gate' });

/** @param {any} kind */
const gateWord = (kind) => /** @type {Record<string, string>} */ (GATE_WORDS)[kind] ?? 'gate';

/**
 * The entries of a `GET /api/workflows` body that can be shown: an object with a string class and a stages array, in
 * the route's order. Anything else is dropped.
 * @param {any} body
 * @returns {any[]}
 */
function workflowsOf(body) {
  if (!isObject(body) || !Array.isArray(body.workflows)) return [];
  return body.workflows.filter((/** @type {any} */ entry) => isObject(entry) && typeof entry.taskClass === 'string' && Array.isArray(entry.stages));
}

/**
 * The program of a workflow as numbered steps: each stage, then the gates after it. `label` is the stage id or the gate
 * name; `detail` is a stage's "skill: purpose" (empty for a gate). Empty without a stages array.
 * @param {any} workflow
 * @returns {Array<{ n: number, type: 'stage' | 'gate', id: string, label: string, kind: string, optional: boolean, detail: string }>}
 */
function stepsOf(workflow) {
  if (!isObject(workflow) || !Array.isArray(workflow.stages)) return [];
  /** @type {any[]} */
  const steps = [];
  const text = (/** @type {any} */ value) => (typeof value === 'string' ? value : '');
  for (const stage of workflow.stages) {
    if (!isObject(stage)) continue;
    const detail = [text(stage.skill), text(stage.purpose)].filter(Boolean).join(': ');
    steps.push({ n: steps.length + 1, type: 'stage', id: text(stage.id), label: text(stage.id), kind: text(stage.kind), optional: stage.optional === true, detail });
    for (const gate of Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []) {
      if (!isObject(gate)) continue;
      steps.push({ n: steps.length + 1, type: 'gate', id: text(gate.id), label: text(gate.name) || text(gate.id), kind: text(gate.kind), optional: false, detail: '' });
    }
  }
  return steps;
}

/**
 * The text alternative of a workflow's diagram: its name and the steps in order, so a reader of the image gets the list.
 * @param {any} workflow
 */
function altText(workflow) {
  const name = isObject(workflow) && typeof workflow.name === 'string' && workflow.name !== '' ? workflow.name : isObject(workflow) && typeof workflow.taskClass === 'string' ? workflow.taskClass : 'Workflow';
  const steps = stepsOf(workflow).map((step) => (step.type === 'gate' ? `${gateWord(step.kind)} ${step.label}` : `${step.label}${step.optional ? ' (optional)' : ''}`));
  return steps.length === 0 ? `${name} workflow diagram. No stages are listed.` : `${name} workflow diagram. Steps in order: ${steps.join(', then ')}.`;
}

/**
 * The same-origin path of a class's diagram, or null when the id is not a plain registry id (the id comes from the API and
 * must never shape a path).
 * @param {any} taskClass
 */
function diagramPath(taskClass) {
  return typeof taskClass === 'string' && CLASS_PATTERN.test(taskClass) ? `/diagrams/${taskClass}.svg` : null;
}

export { workflowsOf, stepsOf, altText, diagramPath, gateWord };
