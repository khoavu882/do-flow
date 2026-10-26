// The runs home (E.1 note section 6): summary tiles that filter, the three sections (Needs you, Running, Finished),
// the run rows with their compact rails, change memory and announcements. `derive/rail.js` holds the logic that
// needs no DOM; this module builds the element trees and owns the filter for the life of the tab.

import { h, icon, mount, announce } from '../dom.js';
import { reltime, clockTime, skel } from '../states.js';
import {
  deriveRail, programLength, runKey, groupRuns, countRuns, describeRun, updatedText, stepText, changedNodes, runToken,
  awaitingGateOf, waitStamp, waitText, describeGate, tileFacts, stepPart, stepFraction, progressOf, stepNumber,
} from '../derive/rail.js';
import { railCompact, railFallback } from './rail.js';

/** How many finished runs the list shows before "Show all". */
const FINISHED_CAP = 10;
/** A workflows fetch is retried at most this often (E.1 section 3). */
const WORKFLOWS_RETRY_MS = 60_000;

/** The filter and the Finished expansion: they survive route changes and reset on reload (not stored). */
const page = { filter: /** @type {string | null} */ (null), expanded: false };

/** For tests: a fresh module state, as after a reload. */
function resetHome() {
  page.filter = null;
  page.expanded = false;
}

/** @type {Record<string, { label: string, face: string, token: string, sentence: string, empty: string, emptyFace: string }>} */
const SECTIONS = {
  needs: { label: 'Needs you', face: 'awaiting', token: 'awaiting', sentence: 'Showing only runs that need you.', empty: 'Nothing is waiting for you.', emptyFace: 'check' },
  running: { label: 'Running', face: 'running', token: 'running', sentence: 'Showing only running runs.', empty: 'Nothing is running right now.', emptyFace: 'pending' },
  finished: { label: 'Finished', face: 'check', token: 'done', sentence: 'Showing only finished runs.', empty: 'No run has finished yet.', emptyFace: 'pending' },
};
const SECTION_ORDER = ['needs', 'running', 'finished'];

// ---- data (E.1 section 3) ----------------------------------------------------------------------------

/**
 * Fetches the registry workflows into `local.workflows`, best effort: a failure keeps what is there and never rejects.
 * @param {any} local
 * @param {(path: string) => Promise<any>} apiGet
 */
async function fetchWorkflows(local, apiGet) {
  local.workflowsAt = Date.now();
  try {
    const body = await apiGet('/api/workflows');
    if (body && Array.isArray(body.workflows)) {
      local.workflows = new Map(body.workflows.filter((/** @type {any} */ item) => item && typeof item.taskClass === 'string').map((/** @type {any} */ item) => [item.taskClass, item]));
    }
  } catch {
    // The rows of a class without a workflow say "workflow unavailable"; the view stays loaded.
  }
}

/** Whether a later poll should read the workflows again: a row has none, or its step count no longer fits. */
function needsWorkflows(/** @type {any} */ local, /** @type {any[]} */ runs) {
  if (Date.now() - local.workflowsAt < WORKFLOWS_RETRY_MS) return false;
  return runs.some((run) => {
    const workflow = local.workflows.get(run.taskClass);
    return !workflow || programLength(workflow) !== (run.progress && run.progress.total);
  });
}

/**
 * The home's read: the runs (required, failures propagate to the shell) and the workflows (best effort, kept in the
 * view instance). The first load waits for both; later polls refresh the workflows in the background.
 * @param {any} local the view instance's own memory
 * @param {(path: string) => Promise<any>} apiGet
 */
async function loadHome(local, apiGet) {
  if (!(local.workflows instanceof Map)) local.workflows = new Map();
  const first = local.workflowsAt === undefined;
  const pending = first ? fetchWorkflows(local, apiGet) : null;
  const body = await apiGet('/api/runs');
  if (pending) await pending;
  else if (needsWorkflows(local, body.runs)) void fetchWorkflows(local, apiGet);
  return { runs: body.runs, unreadableCount: body.unreadableCount, workflows: local.workflows };
}

/**
 * What decides a re-mount: the runs, the unreadable count, which classes have a workflow, and which runs are stale
 * (age alone can flip that). Not the workflow bodies: re-reading the same registry must not re-mount the body.
 * @param {any} data
 */
function homeKey(data) {
  const now = Date.now();
  const classes = data.workflows instanceof Map ? [...data.workflows.keys()].sort() : [];
  const stale = data.runs.filter((/** @type {any} */ run) => runToken(run, now) === 'stale').map(runKey);
  return `${JSON.stringify({ runs: data.runs, unreadableCount: data.unreadableCount })}|${classes.join(',')}|${stale.join(',')}`;
}

// ---- change memory and announcements (E.1 sections 8.1, 8.2) -------------------------------------------------

/**
 * Compares this poll with the previous one of the same view instance: which glyphs changed, and which runs just began
 * waiting. The first poll marks and announces nothing.
 * @param {any} data
 * @param {any} local
 * @param {number} now
 * @returns {Map<string, Set<number>>}
 */
function ingest(data, local, now) {
  /** @type {Map<string, Set<number>>} */
  const changed = new Map();
  const memory = local.memory instanceof Map ? local.memory : new Map();
  const nextMemory = new Map();
  for (const run of data.runs) {
    const workflow = data.workflows instanceof Map ? data.workflows.get(run.taskClass) : null;
    const model = workflow ? deriveRail(workflow, run, null, now) : null;
    if (!model || model.degraded) continue;
    const states = model.nodes.map((/** @type {any} */ node) => node.state);
    nextMemory.set(runKey(run), states);
    const marks = changedNodes(memory.get(runKey(run)), states);
    if (marks.size > 0) changed.set(runKey(run), marks);
  }
  local.memory = nextMemory;

  const waiting = data.runs.filter((/** @type {any} */ run) => run.state === 'AWAITING_GATE');
  const before = local.awaiting;
  local.awaiting = new Set(waiting.map(runKey));
  if (before instanceof Set) {
    const fresh = waiting.filter((/** @type {any} */ run) => !before.has(runKey(run)));
    if (fresh.length === 1) {
      const run = fresh[0];
      const gate = (run.awaitingGate && run.awaitingGate.gateId) || (run.current && run.current.id);
      announce(`${run.featureSlug === null ? run.taskId : `${run.featureSlug} / ${run.taskId}`} is waiting for you${gate ? ` at ${gate}` : ''}.`);
    } else if (fresh.length > 1) announce(`${fresh.length} runs are waiting for you.`);
  }
  return changed;
}

// ---- pieces ----------------------------------------------------------------------------------------------

const tag = (/** @type {string} */ text) => h('span', { class: 'tag' }, text);

/** The step text with the node id set in mono. @param {any} run */
function stepNodes(run) {
  const text = stepText(run);
  const split = text.split(' · ');
  if (split.length === 2) return [split[0], ' · ', h('span', { class: 'mono' }, split[1])];
  const stopped = /^Stopped at (.+)$/.exec(text);
  return stopped ? ['Stopped at ', h('span', { class: 'mono' }, stopped[1])] : text;
}

/** The step part of the meta (CD-B5): the current id in mono, "all steps done", or "stopped at <id>". @param {any} run */
function stepPartNodes(run) {
  const part = stepPart(run);
  // R3-8: below 768 a rejected row reads "at gate-a" (its badge says the rest); the whole words show from 768.
  const lead = part.lead === 'stopped at ' ? [h('span', { class: 'run-row__wide' }, 'stopped '), 'at '] : part.lead;
  return [lead, part.id === null ? null : h('span', { class: 'mono' }, part.id)];
}

/** What a rewritten description (row or card) was built from, kept off the element for the tick. */
const described = new WeakMap();

/** The slug and the muted task id of a run, as the title of a row or a card. @param {any} run */
function titleParts(run) {
  return [h('span', { class: 'run-row__slug' }, run.featureSlug), h('span', { class: 'run-row__task' }, ` / ${run.taskId}`)];
}

/** The row's own context: its workflow, its rail model and the degrade reason. @param {any} run @param {any} context */
function railOf(run, context) {
  const { now, local } = context;
  const workflow = local.workflows.get(run.taskClass) ?? null;
  const model = workflow ? deriveRail(workflow, run, null, now) : null;
  const drawn = model !== null && model.degraded === null;
  return {
    workflow, model, drawn,
    reason: model ? (model.degraded === 'workflow-unavailable' ? null : model.degraded) : null,
    degraded: drawn ? null : model ? (model.degraded === 'workflow-unavailable' ? 'unavailable' : model.degraded) : 'unavailable',
    workflowName: run.workflowName || (workflow && workflow.name) || run.taskClass,
  };
}

/**
 * A run row of Running and Finished (E.1 6.4). The badge shows only exceptions (CD-B3).
 * @param {any} run
 * @param {number} index
 * @param {any} context
 */
function runRow(run, index, context) {
  const { now, badge, changed } = context;
  const { model, drawn, reason, degraded, workflowName } = railOf(run, context);
  const token = runToken(run, now);
  const slug = run.featureSlug;
  const openable = typeof slug === 'string';
  const key = runKey(run);
  const id = `rd-${index}`;

  const title = openable
    ? h('a', {
      class: 'run-row__link', href: `#/run/${slug}/${run.taskId}`, 'aria-describedby': id, title: `${slug} / ${run.taskId}`,
      dataset: { focusKey: `run:${key}` },
    }, titleParts(run))
    : h('span', { class: 'run-row__id', title: run.taskId }, run.taskId);
  const at = Date.parse(run.updatedAt);
  const options = { workflowName, nowMs: now, degraded };
  // An openable row's link carries the description (aria-describedby reads hidden content), so reading mode does not say it twice.
  const description = h('span', { class: 'vh run-row__desc', id, hidden: openable, dataset: { ts: Number.isFinite(at) ? at : null } });
  described.set(description, { kind: 'row', run, options });
  description.textContent = describeRun(run, { ...options, timeText: updatedText(run, now, { clock: clockTime }) });
  const { done, total } = progressOf(run);
  // R3-8: a Finished row's badge shares the phone line, so the fraction (which the rail already shows) is left out.
  const fraction = run.state === 'COMPLETED' || run.state === 'REJECTED' ? null : stepFraction(run);
  const part = stepPart(run);
  const exception = run.state !== 'RUNNING' || token === 'stale';

  return h('li', { class: 'run-row', dataset: { state: token, openable: openable ? 'true' : 'false' } }, [
    h('div', { class: 'run-row__title' }, [title, run.origin === 'other' ? tag('Other checkout') : null, openable ? null : tag('No feature folder')]),
    h('div', { class: 'run-row__rail' }, model && drawn ? railCompact(model, { changed: changed.get(key) ?? new Set() }) : railFallback(run, reason, now)),
    h('div', { class: 'run-row__step', 'aria-hidden': 'true' }, done === null || total === null ? null : [
      h('span', { class: 'run-row__step-n' }, String(stepNumber(run))), h('span', { class: 'run-row__step-of' }, ` / ${total}`),
    ]),
    h('div', { class: 'run-row__state' }, exception ? badge(run, now) : null),
    h('p', { class: 'run-row__meta' }, [
      h('span', { class: 'run-row__wf' }, part.lead === '' && part.id === null ? workflowName : `${workflowName} · `),
      h('span', { class: 'run-row__sp' }, stepPartNodes(run)),
      h('span', { class: 'run-row__st' }, stepNodes(run)),
      fraction === null ? null : h('span', { class: 'run-row__frac' }, ` · ${fraction}`),
    ]),
    h('p', { class: 'run-row__time' }, Number.isFinite(at) ? [h('span', { class: 'run-row__upd' }, 'Updated '), reltime(run.updatedAt, now)] : 'Update time unknown'),
    description,
  ]);
}

/**
 * A gate card of Needs you (E.1 6.4a): the decision that waits, how long, and the run it belongs to.
 * @param {any} run
 * @param {number} index
 * @param {any} context
 */
function gateCard(run, index, context) {
  const { now, changed } = context;
  const { workflow, model, drawn, reason, workflowName } = railOf(run, context);
  const gate = awaitingGateOf(workflow, run);
  const named = Boolean(gate && gate.name);
  const kind = gate && gate.kind ? gate.kind : null;
  const slug = run.featureSlug;
  const openable = typeof slug === 'string';
  const id = `gd-${index}`;
  const wait = waitText(run, now);
  const { done, total } = progressOf(run);
  const waitDur = h('span', { class: 'gate-card__wait-dur', dataset: { unknown: wait === null ? 'true' : null } }, wait === null ? 'time unknown' : wait);
  const waitWord = wait === null ? null : h('span', { class: 'gate-card__wait-word' }, 'waiting');
  const description = h('span', { class: 'vh gate-card__desc', id, hidden: openable });
  const options = { gate, named, workflowName, nowMs: now };
  described.set(description, { kind: 'card', run, options, waitDur, waitWord });
  description.textContent = describeGate(run, options);
  const glyph = `gate-${kind === 'clarification' ? 'clarification' : 'approval'}-12`;

  return h('li', { class: 'gate-card', dataset: { kind: kind ?? '', openable: openable ? 'true' : 'false' } }, [
    h('div', { class: 'gate-card__head', 'aria-hidden': 'true' }, [
      h('span', { class: 'gate-card__glyph' }, icon(glyph, 16)),
      h('span', { class: 'gate-card__kind' }, kind === 'clarification' ? 'Clarification gate' : kind === 'approval' ? 'Approval gate' : 'Gate'),
      h('span', { class: 'gate-card__wait' }, [waitWord, waitDur]),
    ]),
    h('div', { class: 'gate-card__body' }, [
      h('h3', { class: 'gate-card__name' }, named ? gate?.name : h('span', { class: 'mono' }, gate && gate.id ? gate.id : 'gate')),
      named && gate?.prompt ? h('p', { class: 'gate-card__prompt' }, gate.prompt) : null,
      h('div', { class: 'gate-card__run' }, [
        h('p', { class: 'gate-card__id' }, [
          openable ? titleParts(run) : h('span', { class: 'run-row__id' }, run.taskId),
          run.origin === 'other' ? tag('Other checkout') : null, openable ? null : tag('No feature folder'),
        ]),
        model && drawn ? railCompact(model, { large: true, changed: changed.get(runKey(run)) ?? new Set() }) : railFallback(run, reason, now),
        h('p', { class: 'gate-card__meta' }, done === null || total === null ? workflowName : `${workflowName} · step ${stepNumber(run)} of ${total}`),
      ]),
      openable
        ? h('a', {
          class: 'gate-card__link', href: `#/run/${slug}/${run.taskId}`, 'aria-label': `Open the run to decide: ${slug} / ${run.taskId}`,
          'aria-describedby': id, dataset: { focusKey: `run:${runKey(run)}` },
        }, ['Open the run to decide', h('span', { 'aria-hidden': 'true' }, ' →')])
        : h('p', { class: 'gate-card__note' }, 'Decide in a terminal. This run has no feature folder, so it cannot be opened here.'),
      description,
    ]),
  ]);
}

/**
 * The tick: rewrites row and card descriptions and card waits when their text changed, and the tile facts.
 * @param {any} root the page's main element
 * @param {number} nowMs
 * @param {any} [local]
 */
function tickHome(root, nowMs, local) {
  const stale = Boolean(root.dataset) && root.dataset.stale === 'true';
  for (const el of [...root.querySelectorAll('.run-row__desc'), ...root.querySelectorAll('.gate-card__desc')]) {
    const source = described.get(el);
    if (!source) continue;
    if (source.kind === 'row') {
      const text = describeRun(source.run, { ...source.options, nowMs, timeText: updatedText(source.run, nowMs, { stale, clock: clockTime }) });
      if (el.textContent !== text) el.textContent = text;
    } else {
      const text = describeGate(source.run, { ...source.options, nowMs, stale });
      if (el.textContent !== text) el.textContent = text;
      const wait = waitStamp(source.run, nowMs, stale);
      if (wait !== null && source.waitDur.textContent !== wait) source.waitDur.textContent = wait;
      const word = stale ? 'since' : 'waiting';
      if (source.waitWord && source.waitWord.textContent !== word) source.waitWord.textContent = word;
    }
  }
  if (local && Array.isArray(local.homeRuns)) {
    const facts = tileFacts(local.homeRuns, nowMs, { stale });
    for (const el of root.querySelectorAll('.tile')) {
      const fact = facts[String(el.dataset.focusKey).replace('tile:', '')];
      if (!fact) continue;
      const long = el.querySelector('.tile__sub-long');
      const short = el.querySelector('.tile__sub-text');
      if (long && long.textContent !== fact.long) long.textContent = fact.long;
      if (short && short.textContent !== fact.short) short.textContent = fact.short;
      const prefix = el.querySelector('.tile__sub-prefix');
      if (prefix && prefix.textContent !== fact.prefix) prefix.textContent = fact.prefix;
    }
  }
}

/** @param {string} id @param {any[]} runs @param {any} context */
function section(id, runs, context) {
  const spec = SECTIONS[id];
  const capped = id === 'finished' && !page.expanded && runs.length > FINISHED_CAP;
  const shown = capped ? runs.slice(0, FINISHED_CAP) : runs;
  let index = context.rowIndex;
  const rows = shown.map((run) => (id === 'needs' ? gateCard(run, index++, context) : runRow(run, index++, context)));
  context.rowIndex = index;
  return h('section', { class: 'run-section', dataset: { section: id }, 'aria-labelledby': `sec-${id}` }, [
    h('h2', { class: 'run-section__title', id: `sec-${id}` }, [spec.label, h('span', { class: 'run-section__count' }, String(runs.length))]),
    runs.length === 0
      ? h('p', { class: 'run-section__empty' }, [icon(spec.emptyFace, 16), spec.empty])
      : h('ul', { class: id === 'needs' ? 'gate-cards' : 'run-list' }, rows),
    id === 'finished' && runs.length > FINISHED_CAP
      ? h('button', {
        type: 'button', class: 'btn btn--ghost run-section__more', 'aria-expanded': page.expanded ? 'true' : 'false', dataset: { focusKey: 'finished-more' },
        on: { click: () => { page.expanded = !page.expanded; context.rerender('finished-more'); } },
      }, page.expanded ? 'Show fewer' : `Show all ${runs.length} finished runs`)
      : null,
  ]);
}

/** @param {string} id @param {number} count @param {{ long: string, short: string, prefix: string }} fact @param {any} context */
function tile(id, count, fact, context) {
  const spec = SECTIONS[id];
  const pressed = page.filter === id;
  return h('button', {
    type: 'button',
    class: 'tile',
    'aria-pressed': pressed ? 'true' : 'false',
    dataset: { state: spec.token, attention: id === 'needs' && count > 0 ? 'true' : null, focusKey: `tile:${id}` },
    on: { click: () => { page.filter = pressed ? null : id; context.rerender(`tile:${id}`); } },
  }, [
    h('span', { class: 'tile__label' }, [icon(spec.face, 12), spec.label]),
    h('span', { class: 'tile__count' }, [String(count), pressed ? h('span', { class: 'tile__check' }, icon('check', 16)) : null]),
    h('span', { class: 'vh' }, count === 1 ? ' run' : ' runs'),
    h('span', { class: 'tile__sub' }, [
      h('span', { class: 'tile__sub-long' }, fact.long),
      h('span', { class: 'tile__sub-short' }, [h('span', { class: 'vh tile__sub-prefix' }, fact.prefix), h('span', { class: 'tile__sub-text' }, fact.short)]),
    ]),
  ]);
}

/** @param {any} data @param {any} context */
function homeContent(data, context) {
  const groups = groupRuns(data.runs);
  const counts = countRuns(data.runs);
  const facts = tileFacts(data.runs, context.now);
  const filter = page.filter;
  const unreadable = data.unreadableCount;
  return [
    h('div', { class: 'summary', role: 'group', 'aria-label': 'Filter runs by state' }, SECTION_ORDER.map((id) => tile(id, counts[/** @type {'needs'} */ (id)], facts[id], context))),
    filter
      ? h('div', { class: 'filter-status' }, [
        h('span', {}, SECTIONS[filter].sentence),
        h('button', { type: 'button', class: 'btn btn--ghost', dataset: { focusKey: 'filter-clear' }, on: { click: () => { page.filter = null; context.rerender(`tile:${filter}`); } } }, 'Show all runs'),
      ])
      : null,
    SECTION_ORDER.filter((id) => !filter || filter === id).map((id) => section(id, groups[id], context)),
    unreadable > 0
      ? h('p', { class: 'view-note view-note--unreadable' }, [icon('unknown', 16), `${unreadable} ${unreadable === 1 ? 'run' : 'runs'} could not be read.`])
      : null,
  ];
}

/**
 * The loaded home. A tile or a "Show ..." button rebuilds the content in place and keeps focus by its key.
 * @param {any} data `{ runs, unreadableCount, workflows }` from `loadHome`
 * @param {{ badge: (run: any, nowMs: number) => any, local: any }} context
 */
function renderHome(data, { badge, local }) {
  const root = h('div', { class: 'home' });
  const now = Date.now();
  if (!(local.workflows instanceof Map)) local.workflows = data.workflows instanceof Map ? data.workflows : new Map();
  local.homeRuns = data.runs;
  let changed = ingest({ ...data, workflows: local.workflows }, local, now);
  /** @type {any} */
  const context = { now, local, badge, rowIndex: 0, changed };
  const build = () => {
    context.rowIndex = 0;
    context.changed = changed;
    context.now = Date.now();
    mount(root, homeContent(data, context));
    changed = new Map(); // a rebuild for a filter must not replay the change marks
  };
  context.rerender = (/** @type {string} */ focusKey) => {
    build();
    const target = root.querySelector(`[data-focus-key="${focusKey}"]`);
    if (target) target.focus({ preventScroll: true });
  };
  build();
  return root;
}

/** The loading placeholder (E.1 section 6.6): the strip, a section title and a list block. */
function skeletonHome() {
  return h('div', { class: 'skeleton skeleton--home' }, [
    h('div', { class: 'summary' }, [skel('skel--tile'), skel('skel--tile'), skel('skel--tile')]),
    skel('skel--title'),
    skel('skel--list'),
  ]);
}

export { loadHome, renderHome, skeletonHome, homeKey, tickHome, resetHome, FINISHED_CAP, WORKFLOWS_RETRY_MS };
