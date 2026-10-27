// The stage rail component (E.1 note sections 5, 7.2, 8 and 9): `railCompact` for the rows of the runs home, and
// the full rail of the run route with its keyboard walk, node detail, edge fades and change marks. Elements are built
// with `h`, `icon` and `mount` only; every string from the API reaches the page as text.

import { isKey } from '../keys.js';
import { h, icon, mount, announce } from '../dom.js';
import { clockTime } from '../states.js';
import {
  deriveRail, nodeName, stateWord, formatDuration, liveDuration, fallbackText, stepHead, stepNumber, degradedSentence, changedNodes, runToken, durationLine,
} from '../derive/rail.js';

/** The change mark lasts one poll interval (reduced motion shows it as a bar), or until its animation ends. */
const CHANGED_MS = 5000;
/** The edge a node keeps clear of when the scroller moves to show it: `--space-6`. */
const EDGE_PAD = 32;

const raf = (/** @type {() => void} */ fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 0));

/**
 * Clears `data-changed` when the animation ends or one poll interval later, whichever is first.
 * @param {any} el
 * @param {number} [ms]
 */
function expireChange(el, ms = CHANGED_MS) {
  const clear = () => el.removeAttribute('data-changed');
  el.addEventListener('animationend', clear);
  globalThis.setTimeout(clear, ms);
}

/** The gate glyph name for a node kind. @param {string} size @param {any} node */
const gateIcon = (node, size) => `gate-${node.kind === 'clarification' ? 'clarification' : 'approval'}-${size}`;

/** The look of a node: stage outcomes pick failed or unknown, everything else is its state. @param {any} node */
function toneOf(node) {
  if (node.type === 'stage' && node.state === 'done') return node.outcome === 'failed' ? 'failed' : node.outcome === 'unverified' ? 'unknown' : 'done';
  return node.state;
}

/** @type {Record<string, string>} */
const STAGE_FACE = { done: 'check', failed: 'failed', unknown: 'unknown', running: 'running', stale: 'stale', skipped: 'skipped', pending: 'pending', 'not-reached': 'pending' };

// ---- the compact rail (home rows) ---------------------------------------------------------------------

/**
 * A still glyph strip, not interactive and hidden from assistive technology: the row description carries its meaning.
 * @param {{ nodes: any[] }} model
 * @param {{ changed?: Set<number>, large?: boolean }} [options] `large`: the variant of the gate cards (CD-B1)
 */
function railCompact(model, { changed = new Set(), large = false } = {}) {
  return h('ol', { class: large ? 'rail rail--compact rail--lg' : 'rail rail--compact', 'aria-hidden': 'true' }, model.nodes.map((node, index) => {
    const glyph = h('li', {
      class: 'rail__glyph',
      dataset: { type: node.type, kind: node.kind, state: node.state, changed: changed.has(index) ? 'true' : null },
    }, node.type === 'gate' ? icon(gateIcon(node, '12'), large ? 16 : 12) : null);
    if (changed.has(index)) expireChange(glyph);
    return glyph;
  }));
}

/**
 * The one-line stand-in for a rail that cannot be drawn: a glyph for the current step, then why.
 * @param {any} row
 * @param {string | null} reason `shape-mismatch`, `cursor-mismatch` or null (no workflow)
 * @param {number} nowMs
 */
function railFallback(row, reason, nowMs) {
  const current = row.current && typeof row.current === 'object' ? row.current : null;
  const token = runToken(row, nowMs);
  const type = current ? current.type : 'stage';
  const state = !current ? 'done' : token === 'stale' ? 'stale' : row.state === 'AWAITING_GATE' ? 'awaiting' : row.state === 'REJECTED' ? 'rejected' : 'running';
  const glyph = h('span', { class: 'rail__glyph', dataset: { type, state, kind: current ? current.kind : null } }, type === 'gate' ? icon(gateIcon(current, '12'), 12) : null);
  return h('div', { class: 'rail-fallback' }, [glyph, h('span', { class: 'rail-fallback__text' }, fallbackText(row, reason))]);
}

// ---- the full rail (run route) ---------------------------------------------------------------------

/**
 * The registry entry of a node in the run's workflow, or null.
 * @param {any} workflow
 * @param {any} node
 */
function registryOf(workflow, node) {
  const stages = workflow && Array.isArray(workflow.stages) ? workflow.stages : [];
  if (node.type === 'stage') return stages.find((/** @type {any} */ stage) => stage.id === node.id) ?? null;
  for (const stage of stages) {
    const gate = (Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []).find((/** @type {any} */ item) => item.id === node.id);
    if (gate) return gate;
  }
  return null;
}

/** The detail row list of a node: `[term, value]` pairs, absent data left out. @param {any} node @param {any} entry */
function detailRows(node, entry) {
  /** @type {Array<[string, any]>} */
  const rows = [];
  const mono = (/** @type {any} */ value) => h('span', { class: 'mono' }, String(value));
  if (node.type === 'stage') {
    rows.push(['Kind', `${node.kind}${node.optional ? ', optional' : ''}`]);
    if (entry && entry.skill) rows.push(['Skill / Agent', [mono(entry.skill), ' / ', mono(entry.agent ?? 'unknown')]]);
    if (entry && entry.purpose) rows.push(['Purpose', entry.purpose]);
  } else {
    rows.push(['Kind', node.kind === 'clarification' ? 'Clarification gate' : 'Approval gate']);
    if (entry && entry.trigger) rows.push(['When asked', entry.trigger === 'always' ? 'Every run' : mono(entry.trigger)]);
    if (entry && entry.prompt) rows.push(['Asks', entry.prompt]);
  }
  /** @type {any} */
  let recorded;
  if (node.state === 'pending') recorded = 'Not yet';
  else if (node.state === 'not-reached') recorded = 'Never: the run was rejected';
  else if (node.state === 'running' || node.state === 'stale' || node.state === 'awaiting') recorded = 'Not yet';
  else if (node.at === null) recorded = 'Time not recorded';
  else {
    const duration = formatDuration(node.durationMs);
    recorded = [mono(clockTime(Date.parse(node.at))), duration === null ? null : ` · ${duration} after the previous event`];
  }
  rows.push(['Recorded', recorded]);
  if (node.type === 'gate') {
    if (node.state === 'done') rows.push(['Decision', node.forced ? 'Approved, forced' : 'Approved']);
    else if (node.state === 'rejected') rows.push(['Decision', 'Rejected']);
    else if (node.state === 'skipped') rows.push(['Decision', 'Skipped: its condition did not hold']);
  } else if (node.state === 'done' && node.outcome) {
    const word = node.outcome === 'failed' ? 'Failed' : node.outcome === 'unverified' ? 'Unverified' : 'Passed';
    rows.push(['Outcome', node.synthetic ? `${word}, imported` : word]);
  }
  return rows;
}

/**
 * The detail region of one node (E.1 section 9.4).
 * @param {any} node
 * @param {any} workflow
 * @param {{ onClose: () => void, onEscape?: () => void }} options
 */
function railDetail(node, workflow, { onClose, onEscape = onClose }) {
  const tone = toneOf(node);
  const close = h('button', { type: 'button', class: 'btn btn--ghost rail-detail__close', dataset: { focusKey: 'rail-detail-close' }, on: { click: onClose } }, [
    icon('close', 16), h('span', { class: 'vh' }, 'Close details'),
  ]);
  const keydown = (/** @type {any} */ event) => {
    if (!isKey(event, 'close')) return;
    event.preventDefault();
    onEscape();
  };
  return h('div', { class: 'rail-detail', id: 'rail-detail', role: 'region', 'aria-labelledby': 'rail-detail-title', on: { keydown } }, [
    h('div', { class: 'rail-detail__head' }, [
      h('h3', { class: 'rail-detail__title', id: 'rail-detail-title' }, node.id),
      h('span', { class: 'badge', dataset: { state: tone } }, [icon(node.type === 'gate' ? gateIcon(node, '12') : STAGE_FACE[tone] ?? 'pending', 12), stateWord(node)]),
      close,
    ]),
    h('dl', { class: 'rail-detail__body' }, detailRows(node, registryOf(workflow, node)).flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])),
  ]);
}

/**
 * One node of the full rail: an `li` holding the button that carries the accessible name.
 * @param {any} node
 * @param {number} index
 * @param {any} context
 */
function railItem(node, index, context) {
  const { count, nowMs, rovingIndex, openId, changed, keyOf, handlers } = context;
  const tone = toneOf(node);
  const open = openId === `${node.type}:${node.id}`;
  const stateLine = [stateWord(node)];
  const since = Date.parse(node.since);
  if ((node.state === 'running' || node.state === 'awaiting') && Number.isFinite(since)) stateLine.push(`for ${liveDuration(Math.max(0, nowMs - since))}`);
  else if (node.state === 'done' || node.state === 'rejected') {
    const duration = formatDuration(node.durationMs);
    if (duration !== null) stateLine.push(duration);
  }
  const stateText = h('span', { class: 'rail__state' }, stateLine.join(' · '));
  const line = durationLine(node, nowMs);
  const durEl = h('span', { class: 'rail__dur', 'aria-hidden': 'true', dataset: { tone: line.tone } }, line.text);
  const textBlock = h('span', { class: 'rail__text' }, [
    h('span', { class: 'rail__line' }, [h('span', { class: 'rail__id' }, node.id), node.type === 'stage' && node.synthetic ? h('span', { class: 'rail__tag' }, 'imported') : null]),
    stateText,
  ]);
  const button = h('button', {
    type: 'button',
    class: 'rail__node',
    'aria-label': context.nameOf ? context.nameOf(node, nowMs) : nodeName(node, index, count, nowMs),
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': 'rail-detail',
    tabindex: index === rovingIndex ? '0' : '-1',
    dataset: { focusKey: keyOf(index, node), selected: open ? 'true' : null },
    on: { click: () => handlers.toggle(index), keydown: (/** @type {any} */ event) => handlers.key(event, index), focus: () => handlers.rove(index) },
  }, [
    h('span', { class: 'rail__glyph' }, node.type === 'gate' ? icon(gateIcon(node, '24'), 24) : icon(STAGE_FACE[tone] ?? 'pending', 12)),
    node.type === 'gate'
      ? h('span', { class: 'rail__gate-label' }, [node.id, node.forced ? h('span', { class: 'rail__forced' }, 'forced') : null])
      : null,
    textBlock,
    durEl,
  ]);
  const item = h('li', {
    class: 'rail__item',
    dataset: {
      type: node.type, kind: node.kind, state: node.state, tone, forced: node.forced ? 'true' : null,
      changed: changed.has(index) ? 'true' : null,
    },
  }, button);
  if (changed.has(index)) expireChange(item, context.changedMs);
  return { item, button, stateText, textBlock, durEl };
}

/**
 * The degraded rail (E.1 section 9.5): the current node alone, then a track that says the rest is unknown.
 * @param {any} row
 * @param {number} nowMs
 * @returns {any}
 */
function degradedNode(row, nowMs) {
  const current = row.current && typeof row.current === 'object' ? row.current : null;
  if (!current) return null;
  const token = runToken(row, nowMs);
  const state = token === 'stale' ? 'stale' : row.state === 'AWAITING_GATE' ? 'awaiting' : row.state === 'REJECTED' ? 'rejected' : 'running';
  return {
    type: current.type === 'gate' ? 'gate' : 'stage', id: current.id, kind: current.kind, optional: false, state,
    outcome: null, synthetic: false, decision: null, forced: false, at: null, durationMs: null, since: null,
  };
}

const NOTES = Object.freeze({
  'shape-mismatch': 'This run started on a different workflow version, so only its current step is shown.',
  'cursor-mismatch': 'The run’s recorded position does not match its progress, so only its current step is shown.',
  'workflow-unavailable': 'This run’s workflow could not be read, so only its current step is shown.',
});

/**
 * The run route's rail section: the full rail, the degraded note and the open node's detail. State that must
 * survive the body re-mount of a poll (open node, scroll position, change memory) lives in `local`.
 * @param {any} data the run route body: `{ run, timeline, workflow }`
 * @param {{ slug: string, taskId: string }} params
 * @param {any} local the view instance's own memory
 */
function renderRunRail(data, params, local) {
  const nowMs = Date.now();
  const row = data.run;
  const model = deriveRail(data.workflow, row, data.timeline, nowMs);
  announceChange(row, local);
  const label = `Stages of ${params.slug} / ${params.taskId}`;

  const degraded = model.degraded !== null;
  /** @type {any[]} */
  const nodes = degraded ? [degradedNode(row, nowMs)].filter(Boolean) : model.nodes;
  const states = nodes.map((node) => node.state);
  const changed = degraded ? new Set() : changedNodes(local.railStates, states);
  local.railStates = degraded ? null : states;

  const cursorIndex = model.cursor >= 0 && model.cursor < nodes.length ? model.cursor : nodes.length - 1;
  const rovingId = nodes.findIndex((node) => `${node.type}:${node.id}` === local.rovingId);
  const rovingIndex = degraded ? 0 : rovingId >= 0 ? rovingId : Math.max(0, cursorIndex);
  const keyOf = (/** @type {number} */ index, /** @type {any} */ node) => `node:${index}:${node.id}`;

  const section = h('section', { class: 'run-rail', 'aria-label': 'Stages' });
  const detailSlot = h('div', { class: 'rail-detail-slot' });
  /** @type {any[]} */
  const built = [];

  const rove = (/** @type {number} */ index) => {
    const target = built[index];
    if (!target) return;
    for (const entry of built) entry.button.setAttribute('tabindex', entry === target ? '0' : '-1');
    local.rovingId = `${nodes[index].type}:${nodes[index].id}`;
  };
  const select = (/** @type {number} */ index, /** @type {boolean} */ focus) => {
    const target = built[index];
    if (!target) return;
    rove(index);
    if (focus) {
      target.button.focus({ preventScroll: true });
      ensureVisible(local.scroller, target.button);
    }
  };
  const paintOpen = () => {
    built.forEach((entry, index) => {
      const open = local.openId === `${nodes[index].type}:${nodes[index].id}`;
      entry.button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) entry.button.dataset.selected = 'true';
      else entry.button.removeAttribute('data-selected');
    });
    const node = nodes.find((candidate) => `${candidate.type}:${candidate.id}` === local.openId);
    mount(detailSlot, node ? railDetail(node, data.workflow, { onClose: () => close(true), onEscape: () => close(true) }) : null);
  };
  const close = (/** @type {boolean} */ focusNode) => {
    const id = local.openId;
    local.openId = null;
    paintOpen();
    const index = nodes.findIndex((node) => `${node.type}:${node.id}` === id);
    if (focusNode && index >= 0 && built[index]) built[index].button.focus({ preventScroll: true });
  };
  const handlers = {
    rove,
    toggle(/** @type {number} */ index) {
      const id = `${nodes[index].type}:${nodes[index].id}`;
      select(index, false);
      local.openId = local.openId === id ? null : id;
      paintOpen();
    },
    key(/** @type {any} */ event, /** @type {number} */ index) {
      const last = nodes.length - 1;
      /** @type {Record<string, number>} */
      const moves = { ArrowRight: Math.min(index + 1, last), ArrowDown: Math.min(index + 1, last), ArrowLeft: Math.max(index - 1, 0), ArrowUp: Math.max(index - 1, 0), Home: 0, End: last };
      if (isKey(event, 'close')) {
        if (local.openId !== null) {
          event.preventDefault();
          close(true);
        }
      } else if (moves[event.key] !== undefined) {
        event.preventDefault();
        select(moves[event.key], true);
      }
    },
  };

  // A degraded rail has one node: its position and total come from the run record, and the reason follows the name.
  const nameOf = degraded
    ? (/** @type {any} */ node, /** @type {number} */ at) => {
      const step = stepNumber(row);
      const total = row.progress && Number.isFinite(row.progress.total) ? row.progress.total : null;
      const named = step === null || total === null ? nodeName(node, 0, 1, at).replace(/^1 of 1\. /, '') : nodeName(node, step - 1, total, at);
      return `${named} ${degradedSentence(model.degraded) ?? ''}`.trim();
    }
    : null;
  const context = { count: nodes.length, nowMs, rovingIndex, openId: local.openId, changed, keyOf, handlers, changedMs: 3000, nameOf };
  const items = nodes.map((node, index) => {
    const entry = railItem(node, index, context);
    built.push(entry);
    return entry.item;
  });
  if (degraded) {
    items.push(h('li', { class: 'rail__item rail__item--unknown', dataset: { state: 'unknown' } }, h('span', { class: 'rail__unknown' }, stepHead(row))));
  }

  const list = h('ol', { class: 'rail rail--full', 'aria-label': label }, items);
  const scroller = h('div', { class: 'rail-scroll' }, list);
  const setFade = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scroller;
    if (![scrollLeft, scrollWidth, clientWidth].every(Number.isFinite)) return;
    const start = scrollLeft > 1;
    const end = scrollLeft + clientWidth < scrollWidth - 1;
    scroller.dataset.fade = [start ? 'start' : '', end ? 'end' : ''].filter(Boolean).join(' ');
  };
  scroller.addEventListener('scroll', () => {
    local.scrollLeft = scroller.scrollLeft;
    setFade();
  }, { passive: true });
  // R4-1: a window resize changes what overflows without a scroll event. The scroller is replaced on every re-mount, so
  // the previous observer is let go first, and the view's teardown lets the last one go.
  releaseRail(local);
  if (typeof globalThis.ResizeObserver === 'function') {
    local.resizeObserver = new globalThis.ResizeObserver(setFade);
    local.resizeObserver.observe(scroller);
  }
  raf(() => {
    if (Number.isFinite(local.scrollLeft)) scroller.scrollLeft = local.scrollLeft;
    else if (built[cursorIndex]) centerOn(scroller, built[cursorIndex].button);
    setFade();
  });
  local.scroller = scroller;
  local.live = nodes[cursorIndex] && (nodes[cursorIndex].state === 'running' || nodes[cursorIndex].state === 'awaiting')
    ? { entry: built[cursorIndex], node: nodes[cursorIndex], index: cursorIndex, count: nodes.length, nameOf }
    : null;

  mount(section, [scroller, degraded ? h('p', { class: 'rail-note' }, [icon('info', 16), /** @type {any} */ (NOTES)[/** @type {string} */ (model.degraded)]]) : null, detailSlot]);
  if (local.openId !== null) {
    if (nodes.some((node) => `${node.type}:${node.id}` === local.openId)) paintOpen();
    else local.openId = null;
  }
  return section;
}

/**
 * The button's left and right edge in the scroller's content coordinates, or null without a layout. Measured with
 * rects: `offsetLeft` is relative to the button's `li`, not to the scroller.
 * @param {any} scroller
 * @param {any} button
 */
function boxIn(scroller, button) {
  if (!scroller || !button || typeof button.getBoundingClientRect !== 'function' || typeof scroller.getBoundingClientRect !== 'function') return null;
  const at = button.getBoundingClientRect();
  const from = scroller.getBoundingClientRect();
  const left = at.left - from.left + scroller.scrollLeft;
  const values = [left, at.width, scroller.clientWidth, scroller.scrollLeft];
  return values.every(Number.isFinite) ? { left, right: left + at.width, width: at.width } : null;
}

/**
 * Scrolls so the button is in the middle of the scroller.
 * @param {any} scroller
 * @param {any} button
 */
function centerOn(scroller, button) {
  const box = boxIn(scroller, button);
  if (box) scroller.scrollLeft = Math.max(0, box.left + box.width / 2 - scroller.clientWidth / 2);
}

/** Disconnects the resize observer of the rail's scroller, if any. @param {any} local */
function releaseRail(local) {
  if (local && local.resizeObserver) local.resizeObserver.disconnect();
  if (local) local.resizeObserver = null;
}

/**
 * Keeps the cursor node visible with `EDGE_PAD` to spare; never scrolls the page.
 * @param {any} scroller
 * @param {any} button
 */
function ensureVisible(scroller, button) {
  const box = boxIn(scroller, button);
  if (!box) return;
  const { left, right } = box;
  if (left - EDGE_PAD < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - EDGE_PAD);
  else if (right + EDGE_PAD > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right + EDGE_PAD - scroller.clientWidth;
}

/**
 * The polite announcements of the run route (E.1 section 8.2): what moved since the previous poll of this view.
 * @param {any} row
 * @param {any} local
 */
function announceChange(row, local) {
  const current = row.current && typeof row.current === 'object' ? row.current : null;
  const now = { state: row.state, key: current ? `${current.type}:${current.id}` : null };
  const prev = local.railPrev;
  local.railPrev = now;
  if (!prev) return;
  if (now.state === 'COMPLETED' && prev.state !== 'COMPLETED') announce('Run completed.');
  else if (now.state === 'REJECTED' && prev.state !== 'REJECTED') announce(`Run rejected at ${current ? current.id : 'a gate'}.`);
  else if (current && now.key !== prev.key) announce(current.type === 'gate' ? `${current.id} is waiting for you.` : `${current.id} running.`);
}

/**
 * The 1 s tick: refreshes the running or waiting node's duration at minute granularity.
 * @param {any} _root
 * @param {number} nowMs
 * @param {any} local
 */
function tickRunRail(_root, nowMs, local) {
  const live = local && local.live;
  if (!live) return;
  const { entry, node, index, count } = live;
  const name = live.nameOf ? live.nameOf(node, nowMs) : nodeName(node, index, count, nowMs);
  if (entry.button.getAttribute('aria-label') !== name) entry.button.setAttribute('aria-label', name);
  const since = Date.parse(node.since);
  if (Number.isFinite(since)) {
    const text = `${stateWord(node)} · for ${liveDuration(Math.max(0, nowMs - since))}`;
    if (entry.stateText.textContent !== text) entry.stateText.textContent = text;
    const line = durationLine(node, nowMs);
    if (entry.durEl.textContent !== line.text) entry.durEl.textContent = line.text;
  }
}

export { railCompact, railFallback, renderRunRail, railDetail, tickRunRail, releaseRail, toneOf, registryOf, ensureVisible, centerOn, NOTES };
