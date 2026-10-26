// The Workflows view (F.2; design.md section 7 V6): per workflow class a heading, the diagram as one `<img>` with a text
// alternative, and the same steps as an ordered list. A class whose diagram is missing, or whose image fires `error`, shows a
// short note in the image's place and never a broken image; the list is always there. Elements are built with `h`, `icon` and
// `mount` only; every string from the API reaches the page as text, and no style is written (IC-007). What must survive the
// body re-mount of a poll (which images failed) lives in `local.workflows`.

import { h, icon, mount } from '../dom.js';
import { workflowsOf, stepsOf, altText, diagramPath, gateWord } from '../derive/workflows.js';

const FALLBACK_WORDS = 'Diagram not available. The steps are listed here in order.';

/** The note that stands in for a diagram. */
const fallbackNote = () => h('p', { class: 'wf__fallback' }, FALLBACK_WORDS);

/** One step of the list: its number, shape and word for a gate, the optional mark, and a stage's skill and purpose. @param {any} step */
function stepItem(step) {
  const gate = step.type === 'gate';
  return h('li', { class: `wf__step wf__step--${step.type}` }, [
    h('span', { class: 'wf__line' }, [
      gate ? icon(step.kind === 'clarification' ? 'gate-clarification-12' : 'gate-approval-12', 12) : null,
      h('span', { class: 'wf__id' }, step.label),
      gate ? h('span', { class: 'wf__tag' }, gateWord(step.kind)) : null,
      step.optional ? h('span', { class: 'wf__tag' }, 'optional') : null,
    ]),
    step.detail === '' ? null : h('span', { class: 'wf__detail' }, step.detail),
  ]);
}

/**
 * The image area of one class: the scrolling figure with the diagram, or the note when there is no diagram to ask for or it
 * already failed. The `error` listener swaps the figure for the note and remembers the class.
 * @param {any} workflow @param {Set<string>} failed
 */
function mediaFor(workflow, failed) {
  const media = h('div', { class: 'wf__media' });
  const path = diagramPath(workflow.taskClass);
  if (path === null || failed.has(workflow.taskClass)) return mount(media, fallbackNote());
  const img = h('img', {
    class: 'wf__img', src: path, alt: altText(workflow), loading: 'lazy', decoding: 'async',
    on: {
      error: () => {
        failed.add(workflow.taskClass);
        mount(media, fallbackNote());
      },
    },
  });
  // The diagram is wider than most columns: the figure scrolls inside itself, and takes the keyboard so it can be scrolled.
  return mount(media, h('figure', { class: 'wf__figure', tabindex: '0', 'aria-label': `${workflow.name || workflow.taskClass} diagram, scrolls sideways` }, img));
}

/** @param {any} workflow @param {number} index @param {Set<string>} failed */
function workflowSection(workflow, index, failed) {
  const titleId = `wf-title-${index}`;
  return h('section', { class: 'wf', 'aria-labelledby': titleId, dataset: { class: workflow.taskClass } }, [
    h('h2', { class: 'wf__title', id: titleId }, [workflow.name || workflow.taskClass, ' ', h('span', { class: 'wf__class mono' }, workflow.taskClass)]),
    h('div', { class: 'wf__body' }, [
      mediaFor(workflow, failed),
      h('ol', { class: 'wf__steps', 'aria-label': `${workflow.name || workflow.taskClass} steps in order` }, stepsOf(workflow).map(stepItem)),
    ]),
  ]);
}

/**
 * The view body.
 * @param {any} data the `GET /api/workflows` body
 * @param {any} params
 * @param {any} local the view instance's memory
 */
function renderWorkflows(data, params, local) {
  const memory = local.workflows ?? (local.workflows = { failed: new Set() });
  return h('div', { class: 'wf-list' }, workflowsOf(data).map((workflow, index) => workflowSection(workflow, index, memory.failed)));
}

export { renderWorkflows };
