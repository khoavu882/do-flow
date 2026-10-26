// The task graph view (E.3; design.md section 7 V4): an SVG-edged board of task cards in lanes by owner and columns by
// dependency layer from 768 px, a lane list below it, and a side panel with the selected task's attempts. Elements are
// built with `h`, `icon` and `mount` only; every string from the API reaches the page as text, and the only style the
// code writes is `setProperty('--g-...')` (IC-007). What must survive the body re-mount of a poll (the selected task,
// the card that holds the tab stop, which control opened it) lives in `local.graph`.

import { h, icon, mount, SVG_NS } from '../dom.js';
import { sinceStamp, formatDuration } from '../derive/rail.js';
import {
  GEOMETRY, mergeTasks, attemptsByTask, layoutGraph, placeBoard, edgePath, moveFocus, stateFace, STATE_FACE, reasonWords, unresolvedWords, attemptList,
} from '../derive/graph.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
const budgetWords = (/** @type {any} */ task) => (task.budget ? `${task.budget.used} of ${task.budget.limit} attempts` : 'attempts not known');
const layerWords = (/** @type {any} */ card) => (card.unresolved ? 'No layer' : `Layer ${card.layer + 1}`);
const ownerWords = (/** @type {any} */ card) => (card.ownerSource === 'attempt' ? `${card.owner} (running an attempt)` : card.ownerSource === 'declared' ? `${card.owner} (planned owner)` : 'unassigned');

/** @param {string} name @param {Record<string, string | number>} attrs */
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** @param {any} params */
const runHref = (params) => `#/run/${params.slug}/${params.taskId}`;

/** A short note in place of the board: why there is nothing to draw. @param {any} params @param {string} title @param {string} sentence */
function emptyGraph(params, title, sentence) {
  return h('section', { class: 'graph graph--empty', 'aria-labelledby': 'graph-empty-title' }, [
    h('h2', { class: 'graph__emptytitle', id: 'graph-empty-title' }, title),
    h('p', { class: 'graph__emptytext' }, sentence),
    h('a', { class: 'graph__back', href: runHref(params) }, [h('span', { 'aria-hidden': 'true' }, '← '), 'Back to the run']),
  ]);
}

/** The words of the summary line: tasks, lanes and the task states that occur. @param {any[]} tasks @param {any} layout */
function summaryWords(tasks, layout) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const task of tasks) {
    const word = stateFace(task.state).word.toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const order = [...Object.values(STATE_FACE).map((face) => face.word.toLowerCase()), 'unknown'];
  const parts = [...new Set(order)].filter((word) => counts.has(word)).map((word) => `${counts.get(word)} ${word}`);
  return [plural(tasks.length, 'task', 'tasks'), plural(layout.lanes.length, 'lane', 'lanes'), ...parts].join(' · ');
}

/**
 * The selected task's details: what it is, why it is in that state, who owns it, what it waits for and its attempts.
 * @param {any} task @param {any} card @param {number} nowMs
 */
function detailBody(task, card, nowMs) {
  const face = stateFace(task.state);
  const why = reasonWords(task.reason);
  const unresolved = card.unresolved ? unresolvedWords(card.why) : null;
  const facts = [
    ['Phase', task.phase ?? 'not recorded'],
    ['Lane', ownerWords(card)],
    card.ownerSource === 'attempt' && task.owner && task.owner !== card.owner ? ['Planned owner', task.owner] : null,
    ['Attempts', budgetWords(task)],
    ['Position', layerWords(card)],
    ['Waits for', card.deps.length === 0 ? 'nothing' : h('span', { class: 'mono' }, card.deps.join(', '))],
    card.missing.length > 0 ? ['Not in the plan', h('span', { class: 'mono' }, card.missing.join(', '))] : null,
  ].filter(Boolean);
  const attempts = attemptList(task.attempts);
  return [
    h('span', { class: 'badge', dataset: { state: face.token } }, [icon(face.face, 12), face.word]),
    why ? h('p', { class: 'gdetail__why' }, why) : null,
    unresolved ? h('p', { class: 'gdetail__why' }, [icon('info', 16), unresolved]) : null,
    h('dl', { class: 'gdetail__facts' }, facts.flatMap((fact) => { const [term, value] = /** @type {any} */ (fact); return [h('dt', {}, term), h('dd', {}, value)]; })),
    h('h3', { class: 'gdetail__attempts' }, 'Attempts'),
    attempts.length === 0
      ? h('p', { class: 'gdetail__none' }, 'No attempt has been made yet.')
      : h('ol', { class: 'gattempts' }, attempts.map((attempt) => {
        const start = attempt.startedAt === null ? null : sinceStamp(Date.parse(attempt.startedAt), nowMs);
        const end = attempt.endedAt === null ? null : sinceStamp(Date.parse(attempt.endedAt), nowMs);
        const took = formatDuration(attempt.durationMs);
        const when = start === null ? 'start not recorded'
          : end === null ? `since ${start}` : `${start} to ${end}${took === null ? '' : ` (${took})`}`;
        return h('li', { class: 'gattempt', dataset: { state: attempt.state } }, [
          h('span', { class: 'gattempt__no' }, `Attempt ${attempt.no}`),
          h('span', { class: 'gattempt__owner' }, `${attempt.owner ?? 'unknown owner'} · ${attempt.mode ?? 'unknown mode'}`),
          h('span', { class: 'gattempt__state' }, attempt.result === null ? attempt.state : `${attempt.state}, ${attempt.result}`),
          h('span', { class: 'gattempt__when' }, when),
        ]);
      })),
  ];
}

/**
 * The task graph body: summary, board, lane list and panel.
 * @param {any} data `{ run, timeline, tasks, workflow, tasksReason? }`
 * @param {{ slug: string, taskId: string }} params
 * @param {any} local the view instance's own memory
 */
function renderGraph(data, params, local) {
  const nowMs = Date.now();
  const memory = local.graph ?? (local.graph = { selected: null, focus: null, trigger: 'card' });
  const body = data.tasks === undefined ? null : data.tasks;
  if (body === null) {
    return data.tasksReason === 'legacy-plan'
      ? emptyGraph(params, 'No task graph', 'This run’s plan is in an older format, so its task graph cannot be shown.')
      : emptyGraph(params, 'No task graph', 'This run has no task plan, so there is no task graph to show.');
  }
  const tasks = mergeTasks(body);
  if (tasks === null) return emptyGraph(params, 'No task graph', 'The task plan could not be read just now. This view tries again on every update.');
  if (tasks.length === 0) return emptyGraph(params, 'No tasks', 'The plan lists no tasks, so there is nothing to draw.');

  const layout = layoutGraph(tasks, attemptsByTask(tasks));
  const placed = placeBoard(layout);
  /** @type {Map<string, number>} */
  const at = new Map(layout.cards.map((card, i) => [card.id, i]));
  if (memory.selected !== null && !at.has(memory.selected)) memory.selected = null;
  if (memory.focus !== null && !at.has(memory.focus)) memory.focus = null;
  const stop = memory.selected ?? memory.focus ?? layout.cards[0].id;
  const g = GEOMETRY;

  // ---- the board (from 768 px) ----
  const board = h('div', { class: 'graph__board', role: 'group', 'aria-label': `Task board: ${plural(tasks.length, 'task', 'tasks')} in ${plural(layout.lanes.length, 'lane', 'lanes')}, laid out by dependency` });
  const vars = { 'g-w': placed.width, 'g-h': placed.height, 'g-card-w': g.cardW, 'g-card-h': g.cardH, 'g-head-h': g.headH, 'g-label-w': g.labelW };
  for (const [name, value] of Object.entries(vars)) board.style.setProperty(`--${name}`, String(value));

  layout.lanes.forEach((lane, i) => {
    const band = h('div', { class: 'graph__band', 'aria-hidden': 'true' }, [h('span', { class: 'graph__lanelabel' }, [h('span', { class: 'graph__lanename' }, lane.label), h('span', { class: 'graph__lanecount' }, plural(lane.count, 'task', 'tasks'))])]);
    band.style.setProperty('--g-y', String(placed.lanes[i].y));
    band.style.setProperty('--g-bh', String(placed.lanes[i].h));
    board.append(band);
  });
  for (let column = 0; column < layout.layers; column += 1) {
    const last = layout.unresolved.length > 0 && column === layout.layers - 1;
    const head = h('span', { class: 'graph__layerhead', 'aria-hidden': 'true', dataset: { unresolved: last ? 'true' : null } }, last ? 'Unresolved' : `Layer ${column + 1}`);
    head.style.setProperty('--g-x', String(g.labelW + g.padX + column * (g.cardW + g.gapX)));
    board.append(head);
  }

  const edgeLayer = svgEl('svg', { class: 'graph__edges', width: placed.width, height: placed.height, viewBox: `0 0 ${placed.width} ${placed.height}`, 'aria-hidden': 'true', focusable: 'false' });
  const edgeEls = layout.edges.map((edge) => {
    const path = svgEl('path', { class: 'graph__edge', d: edgePath(placed.boxes[/** @type {number} */ (at.get(edge.from))], placed.boxes[/** @type {number} */ (at.get(edge.to))], edge.straight) });
    edgeLayer.append(path);
    return { el: path, from: edge.from, to: edge.to };
  });
  board.append(edgeLayer);

  /** @type {Map<string, any>} */
  const taskOf = new Map(tasks.map((task) => [task.id, task]));
  const cardEls = new Map();
  layout.cards.forEach((card, i) => {
    const task = taskOf.get(card.id);
    const face = stateFace(task.state);
    const label = `${card.id}, ${face.word}, ${budgetWords(task)}, lane ${card.owner}, ${card.unresolved ? 'no layer' : layerWords(card).toLowerCase()}, waits for ${card.deps.length === 0 ? 'nothing' : card.deps.join(', ')}`;
    const el = h('button', {
      type: 'button',
      class: 'gcard',
      tabindex: card.id === stop ? '0' : '-1',
      'aria-controls': 'graph-panel',
      'aria-expanded': 'false',
      'aria-label': label,
      dataset: { card: card.id, state: face.token, unresolved: card.unresolved ? 'true' : null, focusKey: `card:${card.id}` },
    }, [
      h('span', { class: 'gcard__top' }, [h('span', { class: 'gcard__id mono' }, card.id), h('span', { class: 'gcard__state' }, [icon(face.face, 12), face.word])]),
      h('span', { class: 'gcard__line' }, budgetWords(task)),
      card.unresolved ? h('span', { class: 'gcard__line gcard__line--why' }, 'No layer') : null,
    ]);
    el.style.setProperty('--g-x', String(placed.boxes[i].x));
    el.style.setProperty('--g-y', String(placed.boxes[i].y));
    el.addEventListener('click', () => { memory.trigger = 'card'; memory.focus = card.id; select(memory.selected === card.id ? null : card.id); });
    el.addEventListener('focus', () => { memory.focus = card.id; });
    cardEls.set(card.id, el);
    board.append(el);
  });

  // ---- the panel beside the board, and the lane list (below 768 px) ----
  const panel = h('aside', { class: 'graph__panel', id: 'graph-panel', 'aria-labelledby': 'graph-panel-title', hidden: true });
  const rowEls = new Map();
  const rowSlots = new Map();
  const lanesList = h('div', { class: 'graph__lanes' }, layout.lanes.map((lane) => {
    const cards = layout.cards.filter((card) => card.lane === lane.index).sort((a, b) => a.layer - b.layer || a.order - b.order);
    return h('section', { class: 'glane', 'aria-labelledby': `glane-${lane.index}` }, [
      h('h2', { class: 'glane__name', id: `glane-${lane.index}` }, [lane.label, h('span', { class: 'glane__count' }, plural(lane.count, 'task', 'tasks'))]),
      h('ol', { class: 'glane__list' }, cards.map((card) => {
        const task = taskOf.get(card.id);
        const face = stateFace(task.state);
        const button = h('button', { type: 'button', class: 'grow__btn', 'aria-expanded': 'false', dataset: { row: card.id, focusKey: `row:${card.id}` } }, [
          h('span', { class: 'grow__top' }, [
            h('span', { class: 'mono grow__id' }, card.id),
            h('span', { class: 'badge', dataset: { state: face.token } }, [icon(face.face, 12), face.word]),
            h('span', { class: 'grow__layer' }, layerWords(card)),
          ]),
          h('span', { class: 'grow__line' }, `${card.deps.length === 0 ? 'Waits for nothing' : `Waits for ${card.deps.join(', ')}`} · ${budgetWords(task)}`),
        ]);
        button.addEventListener('click', () => { memory.trigger = 'row'; select(memory.selected === card.id ? null : card.id); });
        const slot = h('div', { class: 'grow__panel', hidden: true });
        rowEls.set(card.id, button);
        rowSlots.set(card.id, slot);
        return h('li', { class: 'grow' }, [button, slot]);
      })),
    ]);
  }));

  const top = h('div', { class: 'graph__top' }, [
    h('a', { class: 'graph__back', href: runHref(params) }, [h('span', { 'aria-hidden': 'true' }, '← '), 'Back to the run']),
    h('p', { class: 'graph__summary' }, summaryWords(tasks, layout)),
    layout.unresolved.length > 0
      ? h('p', { class: 'graph__unresolved' }, [icon('info', 16), `${plural(layout.unresolved.length, 'task has', 'tasks have')} no place in the layers because of a dependency cycle or a dependency outside the plan. ${layout.unresolved.length === 1 ? 'It is' : 'They are'} in the last column.`])
      : null,
  ]);
  const root = h('section', { class: 'graph', 'aria-label': 'Task graph', dataset: { open: 'false' } }, [
    top,
    h('div', { class: 'graph__layout' }, [h('div', { class: 'graph__main' }, [h('div', { class: 'graph__scroll' }, board), lanesList]), panel]),
  ]);

  /** The board panel's content: the title, the close control and the details. @param {string} id */
  const panelContent = (id) => {
    const card = layout.cards[/** @type {number} */ (at.get(id))];
    return [
      h('div', { class: 'graph__panelhead' }, [
        h('h2', { class: 'graph__paneltitle mono', id: 'graph-panel-title' }, id),
        h('button', { type: 'button', class: 'btn btn--ghost graph__close', 'aria-label': `Close the details of ${id}`, dataset: { focusKey: 'panel-close' }, on: { click: () => { memory.trigger = 'card'; select(null, true); } } }, icon('close', 16)),
      ]),
      detailBody(taskOf.get(id), card, nowMs),
    ];
  };

  /** Applies `memory.selected` to every part of the view in place. */
  const apply = () => {
    const id = memory.selected;
    root.dataset.open = id === null ? 'false' : 'true';
    for (const [key, el] of cardEls) {
      el.setAttribute('aria-expanded', key === id ? 'true' : 'false');
      if (key === id) el.dataset.selected = 'true';
      else el.removeAttribute('data-selected');
    }
    for (const [key, el] of rowEls) el.setAttribute('aria-expanded', key === id ? 'true' : 'false');
    for (const edge of edgeEls) {
      if (id !== null && (edge.from === id || edge.to === id)) edge.el.setAttribute('data-active', 'true');
      else edge.el.removeAttribute('data-active');
    }
    if (id === null) {
      panel.setAttribute('hidden', '');
      mount(panel, []);
    } else {
      panel.removeAttribute('hidden');
      mount(panel, panelContent(id));
    }
    for (const [key, slot] of rowSlots) {
      if (key === id) {
        slot.removeAttribute('hidden');
        mount(slot, detailBody(taskOf.get(key), layout.cards[/** @type {number} */ (at.get(key))], nowMs));
      } else {
        slot.setAttribute('hidden', '');
        mount(slot, []);
      }
    }
  };

  /** Opens `id`, or closes the panel on null; `refocus` returns the focus to the control that opened the task being closed. @param {string | null} id @param {boolean} [refocus] */
  function select(id, refocus = false) {
    const previous = memory.selected;
    memory.selected = id;
    apply();
    if (refocus && previous !== null) {
      const target = (memory.trigger === 'row' ? rowEls : cardEls).get(previous);
      if (target) target.focus({ preventScroll: true });
    }
  }

  board.addEventListener('keydown', (/** @type {any} */ event) => {
    const owner = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-card]') : null;
    if (!owner) return;
    const to = moveFocus(layout, owner.dataset.card, event.key);
    if (to === null) return;
    event.preventDefault();
    const next = cardEls.get(to);
    owner.setAttribute('tabindex', '-1');
    next.setAttribute('tabindex', '0');
    memory.focus = to;
    next.focus();
  });
  root.addEventListener('keydown', (/** @type {any} */ event) => {
    if (event.key !== 'Escape' || memory.selected === null) return;
    event.preventDefault();
    // The focus goes back to the opener only when it was inside the panel; on a card or a row it stays where it is.
    const target = event.target;
    const inPanel = Boolean(target) && (panel.contains(target) || (typeof target.closest === 'function' && target.closest('.grow__panel') !== null));
    select(null, inPanel);
  });

  apply();
  return root;
}

export { renderGraph };
