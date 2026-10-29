// The live run view (E.2 note): the full rail of E.1, the current-activity slot and the timeline on one shared time
// axis. Elements are built with `h`, `icon` and `mount` only; every string from the API reaches the page as text, and
// the only style the code writes is `setProperty('--tl-...')` (IC-007). What must survive the body re-mount of a poll
// (change memory, the view toggle, the list expansion, the track width) lives in `local.run`.

import { h, icon, mount, announce } from '../dom.js';
import { commandBlock, clockTime, reltime } from '../states.js';
import { renderRunRail, tickRunRail, releaseRail, toneOf } from './rail.js';
import { runToken, formatDuration, liveDuration, clockHM, sinceStamp, stateWord } from '../derive/rail.js';
import { deriveActivity, clauseWords, attemptChanges, finishedCounts } from '../derive/activity.js';
import { deriveTimeline, axisDomain, tickMarks, mergeMarkers, position, rowCopy } from '../derive/timeline.js';
import { withReplay, isReplaying, releaseReplay } from './replay.js';

/** A change mark lasts one poll interval (reduced motion shows it as an outline), or until its animation ends. */
const CHANGED_MS = 3000;
/** The list shows this many events until the person asks for all of them. */
const LIST_LIMIT = 20;
/** The fixed columns of the chart (name, duration) and the gaps between the three, in px: app.css has the same figures. */
const CHART_SIDE_PX = 156 + 96 + 2 * 12;
/** The track width assumed until the chart has been measured. */
const DEFAULT_TRACK_PX = 600;

/** Clears `data-changed` when the animation ends or one poll interval later, whichever is first. @param {any} el */
function expire(el) {
  const clear = () => el.removeAttribute('data-changed');
  el.addEventListener('animationend', clear);
  globalThis.setTimeout(clear, CHANGED_MS);
}

/** Writes the geometry of an element on the track: fractions of the axis, set as custom properties only. @param {any} el @param {number | null} start @param {number} end */
function placeSpan(el, start, end) {
  if (start !== null) el.style.setProperty('--tl-start', String(start));
  el.style.setProperty('--tl-end', String(end));
}

/** @param {any} el @param {number} at */
function placeAt(el, at) {
  el.style.setProperty('--tl-at', String(at));
}

/** Local time of an ISO string for display: `HH:MM` today, `D Mon HH:MM` otherwise; null when unusable. @param {any} iso @param {number} nowMs */
function stampOf(iso, nowMs) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? sinceStamp(ms, nowMs) : null;
}

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
const gateWord = (/** @type {any} */ kind) => (kind === 'clarification' ? 'Clarification gate' : 'Approval gate');

// ---- the activity slot ----------------------------------------------------------------------------------------

/**
 * @param {any} model `deriveActivity`'s result
 * @param {{ nowMs: number, params: any, live: any[], changed: Set<string>, flash: boolean, row: any, tasksReason: any, startIso: string | null, rail: any }} ctx
 */
function buildSlot(model, ctx) {
  if (model.kind === 'gate') return gateSlot(model, ctx);
  if (model.kind === 'finished') return finishedSlot(model, ctx);
  return stageSlot(model, ctx);
}

/** @param {any} ctx */
function graphHref(ctx) {
  return `#/run/${ctx.params.slug}/${ctx.params.taskId}/tasks`;
}

/** The "Open the task graph" link: text, with the arrow hidden from assistive technology. @param {any} ctx @param {string} focusKey */
function graphLink(ctx, focusKey) {
  return h('a', { class: 'attempts__link', href: graphHref(ctx), dataset: { focusKey } }, ['Open the task graph', h('span', { 'aria-hidden': 'true' }, ' →')]);
}

/** A text node element that the 1 s tick keeps current: `text(nowMs, stale)` gives its words. @param {any} ctx @param {string} cls @param {(nowMs: number, stale: boolean) => string} text @param {string} [tag] */
function liveText(ctx, cls, text, tag = 'span') {
  const el = h(tag, { class: cls }, text(ctx.nowMs, false));
  ctx.live.push({ el, text });
  return el;
}

/** "13:43 (39 min), when gate-a was approved": the duration drops on stale data and the clause is the record's. @param {any} model @param {any} ctx */
function sinceLine(model, ctx) {
  if (!model.timelineAvailable) return 'not available';
  if (model.since === null) return 'not recorded';
  const sinceMs = Date.parse(model.since);
  const clause = model.sinceEvent ? `, when ${clauseWords(model.sinceEvent)}` : '';
  const stamp = sinceStamp(sinceMs, ctx.nowMs);
  return [stamp, liveText(ctx, 'activity__since', (now, stale) => (stale ? '' : ` (${liveDuration(Math.max(0, now - sinceMs))})`)), clause];
}

/** The "Last event" value: the words, the time and a relative time the shell keeps current. @param {any} model @param {any} ctx */
function lastEventLine(model, ctx) {
  if (!model.timelineAvailable) return 'not available';
  const last = model.lastEvent;
  const stamp = stampOf(last.at, ctx.nowMs);
  return stamp === null ? [`${last.words} · time not recorded`] : [`${last.words} · ${stamp} (`, reltime(last.at, ctx.nowMs), ')'];
}

/** @param {any} model @param {any} ctx */
function stageSlot(model, ctx) {
  const node = model.node;
  const staleRun = runToken(ctx.row, ctx.nowMs) === 'stale';
  const missing = node === null || node.missing === true;
  const where = node && node.index !== null && node.count !== null ? ` · stage ${node.index} of ${node.count}` : '';
  const eyebrow = `${staleRun ? 'Running, silent for over a day' : 'Now running'}${where}`;
  const facts = [];
  if (!missing) {
    facts.push(['Skill', h('span', { class: 'mono' }, node.skill ?? 'unknown')]);
    facts.push(['Agent', h('span', { class: 'mono' }, node.agent ?? 'unknown')]);
  }
  facts.push(['Running since', sinceLine(model, ctx)]);
  if (model.lastEvent && model.lastEvent.action === 'annotate') facts.push(['Last event', lastEventLine(model, ctx)]);
  else if (!model.timelineAvailable) facts.push(['Last event', 'not available']);

  const main = h('div', { class: 'activity__main' }, [
    h('h2', { class: 'activity__eyebrow', id: 'activity-title' }, eyebrow),
    node ? h('p', { class: 'activity__id' }, node.id) : null,
    !missing && node.purpose ? h('p', { class: 'activity__purpose' }, node.purpose) : null,
    missing ? h('p', { class: 'activity__missing' }, model.workflowUnavailable ? 'The workflow could not be read, so its details are not shown.' : 'This step is not in the current workflow, so its details are not shown.') : null,
    h('dl', { class: 'activity__facts' }, facts.flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])),
    staleRun && model.since !== null
      ? h('p', { class: 'activity__stale' }, [icon('stale', 16), `No event since ${stampOf(model.since, ctx.nowMs)}. The run may have stopped without recording it.`]) : null,
    missing ? null : h('p', { class: 'activity__foot' }, 'Skill and agent are what the workflow declares for this stage.'),
  ]);
  return { el: h('section', { class: `activity activity--stage${staleRun ? ' activity--stale' : ''}`, 'aria-labelledby': 'activity-title', dataset: { changed: ctx.flash ? 'true' : null } }, [h('div', { class: 'activity__grid' }, [main, attemptsAside(model, ctx)])]) };
}

/** The side column: the run's active task attempts, or why there are none. @param {any} model @param {any} ctx */
function attemptsAside(model, ctx) {
  const running = model.running;
  const count = running === null ? 0 : running.shown.length + running.more;
  const head = [h('h3', { id: 'attempts-title' }, 'Task attempts')];
  if (running !== null) head.push(h('span', { class: 'activity__count' }, `${count} active`));
  const body = [];
  if (running === null) {
    body.push(h('p', { class: 'attempts__empty' }, ctx.tasksReason === 'legacy-plan'
      ? 'This run’s plan is in an older format, so its task attempts cannot be shown.' : 'This run has no task plan, so there are no task attempts to show.'));
  } else {
    if (count === 0) body.push(h('p', { class: 'attempts__empty' }, 'No task attempt is active.'));
    else {
      body.push(h('ol', { class: 'attempts', 'aria-labelledby': 'attempts-title' }, running.shown.map((/** @type {any} */ attempt) => {
        const at = stampOf(attempt.startedAt, ctx.nowMs);
        const li = h('li', { class: 'attempt', dataset: { changed: ctx.changed.has(`${attempt.taskId}#${attempt.attemptNo}`) ? 'true' : null } }, [
          h('span', { class: 'mono attempt__task' }, attempt.taskId),
          h('span', { class: 'attempt__owner' }, attempt.owner ?? 'unknown owner'),
          h('span', { class: 'attempt__meta' }, [attempt.mode ?? 'unknown mode', ` · attempt ${attempt.attemptNo}`, at === null ? ' · start not recorded' : ` · since ${at}`]),
        ]);
        if (li.getAttribute('data-changed') === 'true') expire(li);
        return li;
      })));
      if (running.more > 0) body.push(h('p', { class: 'attempts__more' }, `+${running.more} more active`));
    }
    body.push(graphLink(ctx, 'attempts-graph'));
  }
  return h('aside', { class: 'activity__side', 'aria-labelledby': 'attempts-title' }, [h('div', { class: 'activity__sidehead' }, head), body]);
}

/** One line under a gate or a finished run: how many attempts are still active, with the graph link (E.2 Q5). @param {any} model @param {any} ctx */
function tasksLine(model, ctx) {
  const running = model.running;
  const count = running === null ? 0 : running.shown.length + running.more;
  if (count === 0) return null;
  return h('p', { class: 'activity__tasks' }, [`${plural(count, 'task attempt is', 'task attempts are')} still active. `, graphLink(ctx, 'slot-graph')]);
}

/** @param {any} model @param {any} ctx */
function gateSlot(model, ctx) {
  const node = model.node;
  const kind = node ? node.kind : null;
  const sinceMs = model.since === null ? Number.NaN : Date.parse(model.since);
  const wait = !model.timelineAvailable ? () => 'not available'
    : model.since === null ? () => 'wait not recorded'
      : (/** @type {number} */ now, /** @type {boolean} */ stale) => (stale ? `waiting since ${sinceStamp(sinceMs, now)}` : `waiting ${liveDuration(Math.max(0, now - sinceMs))}`);
  const missing = node === null || node.missing === true;
  const command = model.command;
  const approve = command ? commandBlock(command.approve, 'the approve command') : null;
  const reject = command ? commandBlock(command.reject, 'the reject command') : null;
  if (approve) approve.querySelector('button').dataset.focusKey = 'copy:approve';
  if (reject) reject.querySelector('button').dataset.focusKey = 'copy:reject';
  const body = h('div', { class: 'activity__body' }, [
    node ? h('p', { class: 'activity__name' }, missing || !node.name ? node.id : node.name) : null,
    node && node.prompt ? h('p', { class: 'activity__prompt' }, node.prompt) : null,
    node ? h('p', { class: 'activity__idline' }, [h('span', { class: 'mono' }, node.id), node.after ? [' · after ', h('span', { class: 'mono' }, node.after)] : null]) : null,
    missing && node ? h('p', { class: 'activity__missing' }, model.workflowUnavailable ? 'The workflow could not be read, so its details are not shown.' : 'This step is not in the current workflow, so its details are not shown.') : null,
    model.journalGateDiffers ? h('p', { class: 'activity__journal' }, [icon('info', 16), 'When this gate opened, the run recorded different wording. This is the current workflow’s.']) : null,
    command ? [
      h('p', { class: 'activity__lead' }, 'Decide in a terminal in this project:'),
      h('div', { class: 'activity__cmds' }, [
        h('div', { class: 'activity__cmd' }, [h('p', { class: 'activity__cmdlabel' }, 'To approve'), approve]),
        h('div', { class: 'activity__cmd' }, [h('p', { class: 'activity__cmdlabel' }, 'To reject'), reject]),
      ]),
    ] : null,
    h('p', { class: 'activity__note' }, 'The Console only reads. Deciding stays in the terminal.'),
    model.origin === 'other' ? h('p', { class: 'activity__other' }, [icon('info', 16), 'This run belongs to another checkout of this project. Run the command there.']) : null,
    tasksLine(model, ctx),
  ]);
  const head = h('div', { class: 'activity__head' }, [
    icon(kind === 'clarification' ? 'gate-clarification-12' : 'gate-approval-12', 16),
    h('h2', { class: 'activity__gate', id: 'activity-title' }, [gateWord(kind), h('span', { class: 'vh' }, ', waiting for you')]),
    liveText(ctx, 'activity__wait', wait),
  ]);
  return { el: h('section', { class: 'activity activity--gate', 'aria-labelledby': 'activity-title', dataset: { changed: ctx.flash ? 'true' : null } }, [head, body]) };
}

/** @param {any} model @param {any} ctx */
function finishedSlot(model, ctx) {
  const done = ctx.row.state === 'COMPLETED';
  const facts = model.lastEvent ? [h('dt', {}, 'Last event'), h('dd', {}, lastEventLine(model, ctx))] : !model.timelineAvailable ? [h('dt', {}, 'Last event'), h('dd', {}, 'not available')] : [];
  let summary;
  if (done) {
    const took = formatDuration(model.waitedMs);
    const from = stampOf(ctx.startIso, ctx.nowMs);
    const to = stampOf(model.since, ctx.nowMs);
    summary = took === null || from === null || to === null ? 'Finished; the end time is not recorded.' : `Took ${took}, from ${from} to ${to}.`;
  } else {
    const at = stampOf(model.since, ctx.nowMs);
    const waited = formatDuration(model.waitedMs);
    summary = at === null ? 'The time of the rejection is not recorded. The run stopped at this gate.' : `Rejected at ${at}${waited === null ? '' : `, after waiting ${waited}`}. The run stopped at this gate.`;
  }
  const counts = done && ctx.rail && ctx.rail.degraded === null ? finishedCounts(ctx.rail.nodes) : null;
  const node = model.node;
  return {
    el: h('section', { class: `activity activity--${done ? 'done' : 'rejected'}`, 'aria-labelledby': 'activity-title', dataset: { changed: ctx.flash ? 'true' : null } }, [
      h('h2', { class: 'activity__eyebrow', id: 'activity-title' }, done ? 'Completed' : 'Rejected'),
      done ? h('p', { class: 'activity__title' }, 'Run completed') : h('p', { class: 'activity__title' }, ['Rejected at ', h('span', { class: 'mono' }, node ? node.id : 'a gate')]),
      !done && node && !node.missing && node.name ? h('p', { class: 'activity__name' }, node.name) : null,
      h('p', { class: 'activity__summary' }, summary),
      counts ? h('p', { class: 'activity__counts' }, counts) : null,
      facts.length > 0 ? h('dl', { class: 'activity__facts' }, facts) : null,
      tasksLine(model, ctx),
    ]),
  };
}

// ---- the timeline ---------------------------------------------------------------------------------------------

/** The list view (E.2 section 9.4): newest first, 20 until asked. @param {any} tl @param {any} memory @param {number} nowMs @param {number} fresh how many items are new since the previous poll */
function listItems(tl, memory, nowMs, fresh) {
  const shown = memory.tlAll ? tl.list : tl.list.slice(0, LIST_LIMIT);
  return shown.map((/** @type {any} */ item, /** @type {number} */ index) => {
    const at = stampOf(item.at, nowMs);
    const duration = formatDuration(item.durationMs);
    const li = h('li', { class: 'tl-item', dataset: { tone: item.tone, changed: index < fresh ? 'true' : null } }, [
      h('time', { class: 'mono tl-item__time' }, at === null ? 'time not recorded' : at),
      h('span', { class: 'tl-item__words' }, item.words),
      h('span', { class: 'mono tl-item__dur' }, duration === null ? '' : duration),
    ]);
    if (index < fresh) expire(li);
    return li;
  });
}

/**
 * The chart (E.2 section 9.2). Returns the element and what the tick keeps current.
 * @param {any} tl
 * @param {{ nowMs: number, trackPx: number, stale: boolean, staleRun: boolean, lastGood: number }} ctx
 */
function buildChart(tl, ctx) {
  const axis = axisDomain(tl.domain, ctx.nowMs, ctx.trackPx);
  const live = tl.domain.live;
  const marks = tickMarks(axis);
  const merged = mergeMarkers(tl.markers, axis, ctx.trackPx);
  /** @type {any[]} */
  const durs = [];
  /** @type {any[]} */
  const liveBars = [];

  const axisTrack = h('div', { class: 'tl__axistrack' }, marks.map((mark, index) => {
    const label = h('span', { class: 'tl__ticklabel', dataset: { edge: index === 0 ? 'first' : index === marks.length - 1 ? 'last' : null } }, mark.label);
    placeAt(label, mark.fraction);
    return label;
  }));
  const ticks = h('div', { class: 'tl__ticks' }, marks.map((mark) => {
    const line = h('span', { class: 'tl__tick' });
    placeAt(line, mark.fraction);
    return line;
  }));
  for (const marker of merged.filter((m) => m.nodeId === null || !tl.rows.some((/** @type {any} */ r) => r.node.id === m.nodeId))) {
    const el = h('span', { class: 'tl__mark' });
    placeAt(el, position(axis, marker.atMs));
    axisTrack.append(el);
  }

  let nowLine = null;
  let nowLabel = null;
  if (live) {
    nowLine = h('span', { class: 'tl__now' });
    placeAt(nowLine, position(axis, ctx.stale ? ctx.lastGood : ctx.nowMs));
    nowLabel = h('span', { class: 'tl__nowlabel' }, ctx.stale ? `data as of ${clockTime(ctx.lastGood)}` : `now ${clockHM(ctx.nowMs)}`);
    placeAt(nowLabel, position(axis, ctx.stale ? ctx.lastGood : ctx.nowMs));
    axisTrack.append(nowLabel);
  }

  const copyOf = (/** @type {any} */ entry, /** @type {number} */ now, /** @type {boolean} */ stale) => rowCopy(entry, { nowMs: now, stale, staleRun: ctx.staleRun });
  const accessible = h('ol', { class: 'vh' });
  const rows = tl.rows.map((/** @type {any} */ entry) => {
    const { node, segments } = entry;
    const tone = toneOf(node);
    const track = h('div', { class: 'tl__track' });
    for (const segment of segments) {
      if (segment.kind === 'skip') {
        const ring = h('span', { class: 'tl__ring', dataset: { kind: 'skip' } });
        placeAt(ring, position(axis, segment.toMs));
        track.append(ring);
        continue;
      }
      const isLive = segment.kind === 'live';
      const bar = h('span', {
        class: 'tl__bar',
        dataset: {
          kind: segment.kind,
          tone: segment.kind === 'wait' ? (node.state === 'rejected' ? 'rejected' : 'awaiting') : isLive ? (node.state === 'awaiting' ? 'awaiting' : node.state === 'stale' ? 'stale' : 'running') : tone,
          gate: node.type === 'gate' ? 'true' : null,
          imported: node.synthetic === true ? 'true' : null,
          forced: node.forced === true && segment.kind === 'wait' ? 'true' : null,
        },
      });
      placeSpan(bar, position(axis, segment.fromMs), position(axis, segment.toMs));
      track.append(bar);
      if (isLive) liveBars.push({ el: bar, fromMs: segment.fromMs });
    }
    for (const marker of merged.filter((m) => m.nodeId === node.id)) {
      const mark = h('span', { class: 'tl__mark' });
      placeAt(mark, position(axis, marker.atMs));
      track.append(mark);
    }
    const copy = copyOf(entry, ctx.nowMs, ctx.stale);
    const dur = h('span', { class: 'tl__dur' }, copy.dur);
    const notes = tl.markers.filter((/** @type {any} */ m) => m.nodeId === node.id).map((/** @type {any} */ m) => ` Note added at ${clockHM(m.atMs)}.`).join('');
    const li = h('li', {}, `${copy.copy}${notes}`);
    accessible.append(li);
    const hasLive = segments.some((/** @type {any} */ s) => s.kind === 'live');
    if (hasLive) durs.push({ entry, dur, li, notes });
    return h('div', { class: 'tl__row', dataset: { type: node.type, state: node.state, tone } }, [
      h('span', { class: 'tl__name' }, [node.type === 'gate' ? icon(node.kind === 'clarification' ? 'gate-clarification-12' : 'gate-approval-12', 12) : null, h('span', { class: 'mono tl__id' }, node.id), h('span', { class: 'tl__state' }, stateWord(node))]),
      track,
      dur,
    ]);
  });

  const el = h('div', { class: 'tl', 'aria-hidden': 'true' }, [
    h('div', { class: 'tl__axis' }, [h('span'), axisTrack, h('span')]),
    h('div', { class: 'tl__overlay' }, [ticks, nowLine]),
    rows,
  ]);
  return { el, accessible, axis, live: { bars: liveBars, nowLine, nowLabel, durs, copyOf } };
}

/**
 * The timeline card, and what the tick and the resize observer need from it.
 * @param {any} tl `deriveTimeline`'s result
 * @param {any} memory `local.run`
 * @param {{ nowMs: number, row: any, fresh: number }} ctx
 */
function timelineCard(tl, memory, ctx) {
  const { nowMs, row } = ctx;
  const staleRun = runToken(row, nowMs) === 'stale';
  const started = tl.available ? sinceStamp(tl.domain.startMs, nowMs) : null;
  const count = tl.list.length;
  const head = [
    h('h2', { id: 'timeline-title' }, 'Timeline'),
    tl.available ? h('p', { class: 'timeline__meta' }, `${started === null ? 'start not recorded' : `started ${started}`} · ${plural(count, 'event', 'events')}`) : null,
  ];
  const card = h('section', { class: 'timeline', 'aria-labelledby': 'timeline-title', dataset: { view: 'list' } });
  if (!tl.available) {
    mount(card, [h('div', { class: 'timeline__head' }, head), h('p', { class: 'timeline__note' }, [icon('info', 16), 'The run’s event record could not be read just now. The stages above come from its status. This view tries again on every update.'])]);
    return { el: card, tl: null };
  }
  if (count === 0) {
    mount(card, [h('div', { class: 'timeline__head' }, head), h('p', { class: 'timeline__note' }, 'No events recorded yet.')]);
    return { el: card, tl: null };
  }

  const degraded = tl.degraded !== null;
  const showChart = !degraded;
  /** @type {any} */
  const state = { tl, chart: null, observer: null, staleRun };
  const host = h('div', { class: 'timeline__chart' });
  const listHost = h('ol', { class: 'tl-list' }, listItems(tl, memory, nowMs, ctx.fresh));
  const more = count > LIST_LIMIT
    ? h('button', { type: 'button', class: 'btn btn--ghost timeline__more', dataset: { focusKey: 'tl-more' } }, memory.tlAll ? `Show the newest ${LIST_LIMIT}` : `Show all ${count} events`) : null;
  if (more) {
    more.addEventListener('click', () => {
      memory.tlAll = !memory.tlAll;
      mount(listHost, listItems(tl, memory, Date.now(), 0));
      more.textContent = memory.tlAll ? `Show the newest ${LIST_LIMIT}` : `Show all ${count} events`;
    });
  }
  const toggle = showChart ? h('button', { type: 'button', class: 'btn btn--ghost timeline__view', dataset: { focusKey: 'tl-view' } }, memory.tlView === 'list' ? 'Show as chart' : 'Show as list') : null;
  card.dataset.view = showChart && memory.tlView !== 'list' ? 'chart' : 'list';
  if (toggle) {
    toggle.addEventListener('click', () => {
      memory.tlView = memory.tlView === 'list' ? 'chart' : 'list';
      card.dataset.view = memory.tlView === 'list' ? 'list' : 'chart';
      toggle.textContent = memory.tlView === 'list' ? 'Show as chart' : 'Show as list';
    });
  }

  const draw = (/** @type {number} */ now, /** @type {boolean} */ stale) => {
    const built = buildChart(tl, { nowMs: now, trackPx: memory.trackPx ?? DEFAULT_TRACK_PX, stale, staleRun, lastGood: memory.lastGood ?? now });
    state.chart = built;
    state.pinnedAt = undefined;
    mount(host, [built.el, built.accessible]);
  };
  if (showChart) draw(nowMs, false);
  state.draw = draw;
  if (showChart && typeof globalThis.ResizeObserver === 'function') {
    state.observer = new globalThis.ResizeObserver(() => {
      const width = host.clientWidth - CHART_SIDE_PX;
      if (!(width > 0) || Math.abs(width - (memory.trackPx ?? 0)) < 1) return;
      memory.trackPx = width;
      draw(memory.stale === true ? memory.lastGood : Date.now(), memory.stale === true);
    });
    state.observer.observe(host);
  }

  const foot = [
    showChart && tl.untimed > 0 ? h('p', { class: 'timeline__foot timeline__foot--chart' }, `${plural(tl.untimed, 'event has', 'events have')} no recorded time and ${tl.untimed === 1 ? 'is' : 'are'} not on the axis.`) : null,
    tl.other > 0 ? h('p', { class: 'timeline__foot' }, `${plural(tl.other, 'other event', 'other events')} in the record ${tl.other === 1 ? 'is' : 'are'} not shown.`) : null,
  ];
  mount(card, [
    h('div', { class: 'timeline__head' }, [head, toggle]),
    degraded ? h('p', { class: 'timeline__listnote' }, 'Shown as a list because this run’s workflow does not match the current one.') : null,
    showChart ? host : null,
    h('div', { class: 'timeline__list' }, [listHost, more]),
    foot,
  ]);
  return { el: card, tl: state };
}

// ---- the view ---------------------------------------------------------------------------------------------------

/**
 * The run route body: the rail section of E.1 and the activity slot, followed by replay controls beside the timeline.
 * A scrubbed body is drawn by `renderRunBody` like a live one.
 * @param {any} data `{ run, timeline, tasks, workflow }`
 * @param {{ slug: string, taskId: string }} params
 * @param {any} local the view instance's own memory
 */
function renderRun(data, params, local) {
  return withReplay(data, local, (view) => renderRunBody(view, params, local), { place: 'before-timeline' });
}

/**
 * The live body of the run view, or the body at one replayed event (same shape).
 * @param {any} data `{ run, timeline, tasks, workflow }`
 * @param {{ slug: string, taskId: string }} params
 * @param {any} local the view instance's own memory
 */
function renderRunBody(data, params, local) {
  const nowMs = Date.now();
  const row = data.run;
  const before = local.railPrev;
  const railSection = renderRunRail(data, params, local);
  const after = local.railPrev;
  const stepUnchanged = Boolean(before) && before.state === after.state && before.key === after.key;

  disconnectTimeline(local);
  const memory = local.run ?? (local.run = {});
  const first = memory.slotKey === undefined;
  const timeline = data.timeline === undefined ? null : data.timeline;
  const tasks = data.tasks === undefined ? null : data.tasks;
  const model = deriveActivity(row, data.workflow, timeline, tasks, nowMs);
  const tl = deriveTimeline(data.workflow, row, timeline, nowMs);

  const key = `${model.kind}:${model.node ? `${model.node.type}:${model.node.id}` : ''}`;
  const flash = !first && memory.slotKey !== key;
  memory.slotKey = key;

  const changes = attemptChanges(memory.attempts ?? null, tasks);
  const changed = new Set(first ? [] : changes.changes.filter((change) => change.started).map((change) => change.key));
  memory.attempts = changes.map;
  if (!first && stepUnchanged && changes.sentence) announce(changes.sentence);

  const fresh = memory.events === undefined ? 0 : Math.max(0, tl.list.length - memory.events);
  memory.events = tl.list.length;

  /** @type {any[]} */
  const liveTexts = [];
  const startIso = timeline && typeof timeline.startedAt === 'string' ? timeline.startedAt : row.startedAt ?? null;
  const slot = buildSlot(model, { nowMs, params, live: liveTexts, changed, flash, row, tasksReason: data.tasksReason, startIso, rail: tl.rail });
  if (flash) expire(slot.el);
  const card = timelineCard(tl, memory, { nowMs, row, fresh });

  memory.tl = card.tl;
  memory.live = liveTexts;
  memory.lastGood = nowMs;
  memory.finished = model.kind === 'finished';
  return [railSection, slot.el, card.el];
}

/** Disconnects the timeline's resize observer, if any. @param {any} local */
function disconnectTimeline(local) {
  const memory = local && local.run;
  if (memory && memory.tl && memory.tl.observer) memory.tl.observer.disconnect();
  if (memory && memory.tl) memory.tl.observer = null;
}

/** The teardown of the view: the rail's observer and the timeline's. @param {any} local */
function releaseRun(local) {
  disconnectTimeline(local);
  releaseRail(local);
  releaseReplay(local);
}

/**
 * The 1 s tick: the rail first, then the slot's durations and the timeline's live parts. On stale data no figure
 * grows: durations read as stamps and the now line stays where it was at the last good poll.
 * @param {any} root the `main` element
 * @param {number} nowMs
 * @param {any} local
 */
function tickRun(root, nowMs, local) {
  // A replayed moment does not move: nothing on the page ticks until the person is back to live.
  if (isReplaying(local)) return;
  tickRunRail(root, nowMs, local);
  const memory = local && local.run;
  if (!memory) return;
  const stale = Boolean(root && root.dataset && root.dataset.stale === 'true');
  memory.stale = stale;
  for (const item of memory.live ?? []) {
    const text = item.text(nowMs, stale);
    if (item.el.textContent !== text) item.el.textContent = text;
  }
  const state = memory.tl;
  if (!state || !state.chart) return;
  const { chart } = state;
  if (!stale) memory.lastGood = nowMs;
  if (!stale && chart.axis.live && nowMs > chart.axis.endMs) {
    state.draw(nowMs, false);
    return;
  }
  const px = memory.trackPx ?? DEFAULT_TRACK_PX;
  const moved = (/** @type {number} */ at) => Math.abs(at - (state.pinnedAt ?? Number.NaN)) * px >= 1 || state.pinnedAt === undefined;
  if (!stale && chart.live.nowLine) {
    const at = position(chart.axis, nowMs);
    if (moved(at)) {
      state.pinnedAt = at;
      placeAt(chart.live.nowLine, at);
      if (chart.live.nowLabel) {
        placeAt(chart.live.nowLabel, at);
        chart.live.nowLabel.textContent = `now ${clockHM(nowMs)}`;
      }
      for (const bar of chart.live.bars) placeSpan(bar.el, null, at);
    }
  } else if (stale && chart.live.nowLabel) {
    const label = `data as of ${clockTime(memory.lastGood)}`;
    if (chart.live.nowLabel.textContent !== label) chart.live.nowLabel.textContent = label;
  }
  for (const item of chart.live.durs) {
    const copy = chart.live.copyOf(item.entry, stale ? memory.lastGood : nowMs, stale);
    if (item.dur.textContent !== copy.dur) item.dur.textContent = copy.dur;
    const words = `${copy.copy}${item.notes}`;
    if (item.li.textContent !== words) item.li.textContent = words;
  }
}

export { renderRun, tickRun, releaseRun };
