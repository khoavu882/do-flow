// The Sessions view (E.7; design.md section 7a V7): who is working where, what each holds, and where work collides.
// One row per checkout with its lanes, holds and last record; conflicts C1 to C4 lead in a pinned bar; a footer says what
// the view cannot see. Elements are built with `h`, `icon` and `mount` only; every string from the API reaches the page as
// text, and the only style the code writes is none (IC-007). What must survive the body re-mount of a poll (the filter,
// the open rows, the selected lane, the element that holds the tab stop, which conflicts were seen) lives in `local.sessions`.
// No main session has a heartbeat, so nothing here says a session is active, online or idle: it says what was recorded.

import { isKey } from '../keys.js';
import { h, icon, mount, announce } from '../dom.js';
import { clockTime, reltime, commandBlock } from '../states.js';
import {
  deriveSessions, conflictWords, noteWords, limitWords, laneName, rowName, filterRows, newConflicts, moveFocus, commandFor,
} from '../derive/sessions.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The local `HH:MM` of a time, for the accessible names (they cannot refresh, so they carry no "ago"). @param {number} ms */
const localClock = (ms) => clockTime(ms).slice(0, 5);

/** A lane or conflict state token as its icon. */
/** @type {Readonly<Record<string, string>>} */
const TOKEN_FACE = Object.freeze({ running: 'running', stale: 'stale', unknown: 'unknown', done: 'check', failed: 'failed', awaiting: 'awaiting' });
/** The badge token of each conflict kind (Overlap awaits a decision, a stale claim and a dead holder are stale, outside DoFlow is only recorded). */
/** @type {Readonly<Record<string, string>>} */
const CONFLICT_TOKEN = Object.freeze({ C1: 'awaiting', C2: 'stale', C3: 'stale', C4: 'unknown' });

/** The three blind spots of design 7a, one sentence each. */
const BLIND_SPOTS = Object.freeze([
  'A session in a tool with no installed or trusted DoFlow hooks, and that runs no DoFlow command, leaves nothing here.',
  'A plain git commit or merge from any tool leaves nothing either; the outside-DoFlow marker only compares a commit time with the last DoFlow record, so it says nothing about who committed.',
  'A hook session whose payload carries no model writes no model record, so it can be missing or show only a start.',
]);

const FILTERS = Object.freeze([['conflicts', 'Conflicts'], ['records', 'With records'], ['all', 'All']]);

/** The default for a disclosure on a phone: closed below 768 px, open above. */
function narrow() {
  try {
    return Boolean(globalThis.matchMedia && globalThis.matchMedia('(max-width: 767px)').matches);
  } catch {
    return false;
  }
}

// ---- small pieces -------------------------------------------------------------------------------------

/** @param {string} token @param {string} word */
const stateMark = (token, word) => h('span', { class: 'slane__state', dataset: { state: token } }, [icon(TOKEN_FACE[token] ?? 'unknown', 12), word]);

/** A time in a line: relative while fresh, absolute when the view is stale (states.js). @param {any} iso @param {number} nowMs */
const at = (iso, nowMs) => (Number.isFinite(Date.parse(iso)) ? reltime(iso, nowMs) : 'not recorded');

/** Words for the lane's state, from the core's own check or the lack of one. @param {any} lane */
function stateWord(lane) {
  const text = lane.liveness;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The lines under a lane's title. @param {any} lane @param {number} nowMs */
function laneLines(lane, nowMs) {
  if (lane.kind === 'hook' || lane.kind === 'launched') {
    const who = [lane.harness ?? 'harness not recorded', lane.model === null ? null : `model ${lane.model}`].filter(Boolean).join(' · ');
    return [
      lane.kind === 'launched' ? `Run ${lane.unit.run}, lineage ${lane.unit.lineage}, ${who}` : who,
      ['started ', at(lane.startedAt, nowMs)],
      ['last hook record ', at(lane.lastRecordAt, nowMs)],
    ];
  }
  if (lane.kind === 'run') {
    const claims = lane.attempts.map((/** @type {any} */ a) => a.task).join(', ');
    return [`${plural(lane.attempts.length, 'claim')}: ${claims}`, ['claimed ', at(lane.startedAt, nowMs)]];
  }
  if (lane.kind === 'worker') {
    return [lane.harness ?? 'harness not recorded', lane.worker.endedAt === null ? ['started ', at(lane.startedAt, nowMs)] : ['ended ', at(lane.worker.endedAt, nowMs)]];
  }
  return [lane.lock.label ?? 'no label', ['since ', at(lane.startedAt, nowMs)], lane.lock.waiters > 0 ? plural(lane.lock.waiters, 'waiter') : null];
}

/** The titles of the lane kinds, with the harness where there is one. @param {any} lane */
function laneTitle(lane) {
  if (lane.kind === 'run') return lane.run === null ? 'DoFlow run' : `DoFlow run ${lane.run}/${lane.lineage ?? '-'}`;
  if (lane.kind === 'worker') return 'Worker';
  if (lane.kind === 'launched') return 'Launched unit';
  return lane.title;
}

// ---- the panel of one lane ----------------------------------------------------------------------------

/** @param {any} lane @param {any} row @param {number} nowMs */
function laneFacts(lane, row, nowMs) {
  /** @type {Array<[string, any]>} */
  const facts = [['Kind', laneTitle(lane)], ['Checkout', row.kind === 'unplaced' ? 'held from another directory' : row.label]];
  if (lane.kind === 'hook' || lane.kind === 'launched') {
    facts.push(['Harness', lane.harness ?? 'not recorded'], ['Model', lane.model ?? 'not recorded'], ['Started', at(lane.startedAt, nowMs)]);
    facts.push(['Model first seen', at(lane.modelFirstSeenAt, nowMs)], ['Last hook record', at(lane.lastRecordAt, nowMs)]);
    facts.push(['What this shows', 'Times when records were written. A main session has no heartbeat.']);
  } else if (lane.kind === 'run') {
    facts.push(['Run', lane.run === null ? 'not recorded' : `${lane.run} / ${lane.lineage ?? 'not recorded'}`]);
    if (lane.runIds.length > 0) facts.push(['Orchestration runs', lane.runIds.join(', ')]);
    for (const a of lane.attempts) facts.push([`Claim ${a.task}`, [`${a.slug}, ${a.owner ?? 'unknown owner'} (${a.mode ?? 'unknown mode'}), `, at(a.startedAt, nowMs)]]);
    for (const unit of lane.launched) facts.push(['Launched unit', [`attempt ${unit.attempt}, last hook record `, at(unit.lastHookRecordAt, nowMs)]]);
  } else if (lane.kind === 'worker') {
    facts.push(['Harness', lane.harness ?? 'not recorded'], ['Process', lane.liveness], ['State', lane.worker.state]);
    if (lane.worker.reason !== null) facts.push(['Reason', lane.worker.reason]);
    facts.push(['Started', at(lane.startedAt, nowMs)]);
    if (lane.worker.endedAt !== null) facts.push(['Ended', at(lane.worker.endedAt, nowMs)]);
    facts.push(['Serves', `${lane.worker.task}, claim ${lane.worker.token}, ${lane.worker.slug}`]);
  } else {
    facts.push(['Label', lane.lock.label ?? 'none'], ['Process', lane.liveness], ['Held since', at(lane.startedAt, nowMs)], ['Waiting', String(lane.lock.waiters)]);
  }
  return facts;
}

/** The panel content: title, close, facts and the command that shows more, as text. @param {any} lane @param {any} row @param {number} nowMs @param {(() => void) | null} onClose @param {string | null} titleId */
function panelContent(lane, row, nowMs, onClose, titleId) {
  const command = commandFor(lane);
  return [
    h('div', { class: 'spanel__head' }, [
      h('h2', { class: 'spanel__title', id: titleId }, laneTitle(lane)),
      onClose ? h('button', { type: 'button', class: 'btn btn--ghost spanel__close', 'aria-label': `Close the details of ${laneTitle(lane)}`, dataset: { focusKey: 'panel-close' }, on: { click: onClose } }, icon('close', 16)) : null,
    ]),
    stateMark(lane.token, stateWord(lane)),
    h('dl', { class: 'spanel__facts' }, laneFacts(lane, row, nowMs).flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])),
    command ? h('p', { class: 'spanel__more' }, 'To see more, run:') : null,
    command ? commandBlock(command, 'command') : null,
  ];
}

// ---- rows ---------------------------------------------------------------------------------------------

/** A hold of a row: a line with its text and when it began. @param {any} hold @param {number} nowMs */
function holdItem(hold, nowMs) {
  return h('li', { class: 'shold', dataset: { kind: hold.kind } }, [hold.text, hold.since ? [' · since ', at(hold.since, nowMs)] : null]);
}

/** @param {any} conflict @param {any} words */
function conflictBadge(conflict, words) {
  const token = CONFLICT_TOKEN[conflict.code];
  return h('span', { class: 'badge', dataset: { state: token } }, [icon(TOKEN_FACE[token], 12), words.label]);
}

/**
 * The whole view. `data` is the `GET /api/sessions` body.
 * @param {any} data
 * @param {any} params
 * @param {any} local the view instance's own memory
 */
function renderSessions(data, params, local) {
  const nowMs = Date.now();
  const memory = local.sessions ?? (local.sessions = { filter: 'all', open: new Map(), selected: null, focusKey: null, seen: null, hadConflicts: new Set(), barOpen: !narrow() });
  const result = deriveSessions(data, nowMs);

  // The conflicts that are new since the previous read are announced once and flash once; the first read does neither.
  const fresh = newConflicts(memory.seen, result.conflicts);
  const freshRows = new Set(fresh.flatMap((c) => c.rowKeys));
  const clearedRows = new Set(memory.seen === null ? [] : [...memory.hadConflicts].filter((key) => !result.rows.some((row) => row.key === key && row.conflicts.length > 0)));
  memory.seen = new Set(result.conflicts.map((c) => c.id));
  memory.hadConflicts = new Set(result.rows.filter((row) => row.conflicts.length > 0).map((row) => row.key));
  if (fresh.length === 1) announce(conflictWords(fresh[0], localClock).announce);
  else if (fresh.length > 1) announce(`${fresh.length} new conflicts: ${fresh.map((c) => c.subject).join(', ')}`);

  /** @type {(row: any) => any[]} */
  const lanesIn = (row) => row.lanes.flatMap((/** @type {any} */ lane) => [lane, ...lane.children]);
  const laneOf = (/** @type {string | null} */ key) => {
    if (key === null) return null;
    for (const row of result.rows) for (const lane of lanesIn(row)) if (lane.key === key) return { lane, row };
    return null;
  };
  if (memory.selected !== null && laneOf(memory.selected) === null) memory.selected = null;
  const isOpen = (/** @type {any} */ row) => (memory.open.has(row.key) ? memory.open.get(row.key) : !narrow());

  const root = h('section', { class: 'sessions', 'aria-label': 'Sessions' });
  const rowsHost = h('div', { class: 'sessions__rows' });
  const panel = h('aside', { class: 'spanel', id: 'sessions-panel', 'aria-labelledby': 'sessions-panel-title', hidden: true });

  // ---- top: summary, notes, conflict bar, filter ----
  const summary = h('p', { class: 'sessions__summary' }, [
    plural(result.summary.checkouts, 'checkout'), ' · ', plural(result.summary.lanes, 'lane'), ' · ', plural(result.summary.holds, 'hold'), ' · ', plural(result.summary.conflicts, 'conflict'),
  ]);
  const notes = result.notes.map((note) => h('p', { class: 'snote', role: 'note' }, [icon('info', 16), noteWords(note)]));
  const absent = result.storeAbsent
    ? h('p', { class: 'snote', role: 'note' }, [icon('info', 16), 'Hook records are off on this machine: no config home. Checkouts, claims and locks still show.'])
    : null;

  /** Moves focus to a row's head, opening it first when it is filtered out of sight. @param {string} rowKey */
  const jumpTo = (rowKey) => {
    if (memory.filter !== 'all' && !filterRows(result.rows, memory.filter).some((row) => row.key === rowKey)) { memory.filter = 'all'; drawChips(); }
    memory.focusKey = `row:${rowKey}`;
    draw();
    const target = rowsHost.querySelector(`[data-focus-key="row:${rowKey}"]`);
    if (target) /** @type {any} */ (target).focus();
  };

  /** @type {any} */
  let bar = null;
  if (result.conflicts.length > 0) {
    const toggle = h('button', { type: 'button', class: 'btn btn--ghost sbar__toggle', 'aria-expanded': String(memory.barOpen), 'aria-controls': 'sbar-list', dataset: { focusKey: 'bar-toggle' } }, plural(result.conflicts.length, 'conflict'));
    const items = result.conflicts.map((c) => {
      const words = conflictWords(c, localClock);
      const first = result.rows.find((row) => c.rowKeys.includes(row.key));
      return h('li', { class: 'sbar__item', dataset: { code: c.code } }, [
        conflictBadge(c, words),
        h('span', { class: 'sbar__text' }, [h('strong', { class: 'sbar__subject' }, c.subject), ' ', words.text]),
        first ? h('button', { type: 'button', class: 'sbar__jump', 'aria-label': `Go to the row of ${c.subject}`, on: { click: () => jumpTo(first.key) }, dataset: { focusKey: `jump:${c.id}` } }, 'Go to row') : null,
      ]);
    });
    bar = h('section', { class: 'sbar', 'aria-labelledby': 'sbar-title', dataset: { open: String(memory.barOpen) } }, [
      h('div', { class: 'sbar__head' }, [h('h2', { class: 'sbar__title', id: 'sbar-title' }, [icon('awaiting', 16), plural(result.conflicts.length, 'conflict')]), toggle]),
      h('ul', { class: 'sbar__list', id: 'sbar-list' }, items),
    ]);
    toggle.addEventListener('click', () => {
      memory.barOpen = !memory.barOpen;
      toggle.setAttribute('aria-expanded', String(memory.barOpen));
      bar.dataset.open = String(memory.barOpen);
    });
  }

  const chips = h('div', { class: 'sfilter', role: 'radiogroup', 'aria-label': 'Show checkouts' });
  const chipEls = FILTERS.map(([id, text]) => h('button', {
    type: 'button', role: 'radio', class: 'sfilter__opt', dataset: { filter: id, focusKey: `chip:${id}` },
    on: { click: () => { memory.filter = id; drawChips(); draw(); } },
  }, text));
  function drawChips() {
    for (const el of chipEls) {
      const on = el.dataset.filter === memory.filter;
      el.setAttribute('aria-checked', on ? 'true' : 'false');
      el.setAttribute('tabindex', on ? '0' : '-1');
    }
  }
  chips.append(...chipEls);
  chips.addEventListener('keydown', (/** @type {any} */ event) => {
    const steps = /** @type {Record<string, number>} */ ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 });
    const at0 = chipEls.findIndex((el) => el === event.target);
    if (at0 < 0 || steps[event.key] === undefined) return;
    event.preventDefault();
    const next = chipEls[(at0 + steps[event.key] + chipEls.length) % chipEls.length];
    next.focus();
    memory.filter = next.dataset.filter;
    drawChips();
    draw();
    next.focus();
  });
  drawChips();

  const legend = h('p', { class: 'sessions__legend' }, [
    h('span', { class: 'slane__mark', dataset: { mark: 'checked' }, 'aria-hidden': 'true' }), ' a process was checked · ',
    h('span', { class: 'slane__mark', dataset: { mark: 'recorded' }, 'aria-hidden': 'true' }), ' recorded only. A main session has no heartbeat, so its times are when a record was written.',
  ]);

  // ---- rows ----
  /** The tab stop: the element in `memory.focusKey` when it is on the page, else the first row head. @param {string[]} keys */
  const stopKey = (keys) => (memory.focusKey !== null && keys.includes(memory.focusKey) ? memory.focusKey : keys[0]);

  function draw() {
    const shown = filterRows(result.rows, memory.filter);
    const keys = shown.flatMap((row) => [`row:${row.key}`, ...(isOpen(row) ? lanesIn(row).map((/** @type {any} */ lane) => `lane:${lane.key}`) : [])]);
    const stop = stopKey(keys);
    const slotOf = laneOf(memory.selected);
    const items = shown.map((row) => {
      const open = isOpen(row);
      const rowKey = `row:${row.key}`;
      const conflictWordsOf = row.conflicts.map((/** @type {any} */ c) => ({ c, words: conflictWords(c, localClock) }));
      const head = h('button', {
        type: 'button', class: 'srow__head', 'aria-expanded': String(open), 'aria-label': rowName(row, localClock), tabindex: stop === rowKey ? '0' : '-1',
        dataset: { focusKey: rowKey, rowKey: row.key },
      }, [
        h('span', { class: 'srow__name' }, row.label),
        row.current ? h('span', { class: 'srow__tag' }, 'this checkout') : null,
        row.role ? h('span', { class: 'srow__role' }, row.role) : null,
        row.head7 ? h('span', { class: 'srow__head7 mono' }, row.head7) : null,
        row.headCommittedAt ? h('span', { class: 'srow__commit' }, ['commit ', at(row.headCommittedAt, nowMs)]) : null,
        row.conflicts.length > 0 ? h('span', { class: 'badge', dataset: { state: 'awaiting' } }, [icon('awaiting', 12), row.conflicts.length === 1 ? 'Conflict' : `${row.conflicts.length} conflicts`]) : null,
        h('span', { class: 'srow__counts' }, `${plural(row.counts.lanes, 'lane')}, ${plural(row.counts.holds, 'hold')}`),
      ]);
      head.addEventListener('click', () => { memory.focusKey = rowKey; memory.open.set(row.key, !isOpen(row)); draw(); focusKey(rowKey); });
      head.addEventListener('focus', () => { memory.focusKey = rowKey; });

      const laneItem = (/** @type {any} */ lane, /** @type {boolean} */ nested) => {
        const key = `lane:${lane.key}`;
        const button = h('button', {
          type: 'button', class: 'slane', 'aria-label': laneName(lane, row, localClock), 'aria-expanded': String(memory.selected === lane.key), 'aria-controls': 'sessions-panel',
          tabindex: stop === key ? '0' : '-1', dataset: { focusKey: key, laneKey: lane.key, state: lane.token, kind: lane.kind, selected: memory.selected === lane.key ? 'true' : null, nested: nested ? 'true' : null },
        }, [
          h('span', { class: 'slane__mark', dataset: { mark: lane.mark }, 'aria-hidden': 'true' }),
          h('span', { class: 'slane__main' }, [
            h('span', { class: 'slane__top' }, [h('span', { class: 'slane__title' }, laneTitle(lane)), stateMark(lane.token, stateWord(lane))]),
            ...laneLines(lane, nowMs).filter(Boolean).map((line) => h('span', { class: 'slane__line' }, line)),
          ]),
        ]);
        button.addEventListener('click', () => { memory.focusKey = key; select(memory.selected === lane.key ? null : lane.key); focusKey(key); });
        button.addEventListener('focus', () => { memory.focusKey = key; });
        return h('li', { class: 'slane-item' }, [button, lane.children.length > 0 ? h('ul', { class: 'slane-children' }, lane.children.map((/** @type {any} */ child) => laneItem(child, true))) : null]);
      };

      const slot = h('div', { class: 'srow__panel', 'aria-label': 'Lane details', role: 'region', hidden: !(slotOf && slotOf.row === row) });
      if (slotOf && slotOf.row === row) mount(slot, panelContent(slotOf.lane, row, nowMs, () => select(null, true), null));

      const body = h('div', { class: 'srow__body', hidden: !open }, [
        h('div', { class: 'srow__lanes' }, [
          h('h3', { class: 'srow__colhead' }, 'Lanes'),
          row.lanes.length === 0
            ? h('p', { class: 'srow__none' }, row.kind === 'unplaced' ? 'Nothing here.' : 'No session record from this checkout.')
            : h('ul', { class: 'srow__lanelist' }, row.lanes.map((/** @type {any} */ lane) => laneItem(lane, false))),
        ]),
        h('div', { class: 'srow__holds' }, [
          h('h3', { class: 'srow__colhead' }, 'Holds'),
          row.holds.length === 0 ? h('p', { class: 'srow__none' }, 'Holds nothing.') : h('ul', { class: 'srow__holdlist' }, row.holds.map((/** @type {any} */ hold) => holdItem(hold, nowMs))),
        ]),
        h('div', { class: 'srow__last' }, [h('h3', { class: 'srow__colhead' }, 'Last record'), row.lastRecordAt ? at(row.lastRecordAt, nowMs) : h('span', { class: 'srow__none' }, 'none')]),
        conflictWordsOf.length > 0
          ? h('ul', { class: 'srow__conflicts' }, conflictWordsOf.map((/** @type {any} */ { c, words }) => h('li', { class: 'srow__conflict', dataset: { code: c.code } }, [conflictBadge(c, words), ' ', words.text])))
          : null,
      ]);
      return h('li', {
        class: 'srow',
        dataset: { group: row.group, conflict: row.conflicts.length > 0 ? 'true' : 'false', fresh: freshRows.has(row.key) ? 'true' : null, cleared: clearedRows.has(row.key) ? 'true' : null, kind: row.kind },
      }, [h('h2', { class: 'srow__title' }, head), body, slot]);
    });
    mount(rowsHost, [
      h('div', { class: 'srows__heads', 'aria-hidden': 'true' }, ['Checkout', 'Lanes', 'Holds', 'Last record'].map((text) => h('span', {}, text))),
      items.length === 0 ? h('p', { class: 'srows__empty' }, memory.filter === 'conflicts' ? 'No checkout has a conflict.' : 'No checkout has a record.') : h('ol', { class: 'srows' }, items),
    ]);
    applyPanel();
  }

  /** @param {string} key */
  function focusKey(key) {
    const el = rowsHost.querySelector(`[data-focus-key="${key}"]`);
    if (el) /** @type {any} */ (el).focus({ preventScroll: true });
  }

  function applyPanel() {
    const found = laneOf(memory.selected);
    root.dataset.open = found ? 'true' : 'false';
    if (!found) {
      panel.setAttribute('hidden', '');
      mount(panel, []);
    } else {
      panel.removeAttribute('hidden');
      mount(panel, panelContent(found.lane, found.row, nowMs, () => select(null, true), 'sessions-panel-title'));
    }
  }

  /** Opens `key`, or closes the panel on null; `refocus` returns the focus to the lane that opened it. @param {string | null} key @param {boolean} [refocus] */
  function select(key, refocus = false) {
    const previous = memory.selected;
    memory.selected = key;
    draw();
    if (refocus && previous !== null) focusKey(`lane:${previous}`);
  }

  rowsHost.addEventListener('keydown', (/** @type {any} */ event) => {
    const owner = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-focus-key]') : null;
    if (!owner || !(owner.dataset.focusKey.startsWith('row:') || owner.dataset.focusKey.startsWith('lane:'))) return;
    const shown = filterRows(result.rows, memory.filter);
    const layout = shown.map((row) => ({ lanes: isOpen(row) ? lanesIn(row).length : 0 }));
    const where = owner.dataset.focusKey.startsWith('row:')
      ? { row: shown.findIndex((row) => `row:${row.key}` === owner.dataset.focusKey), lane: null }
      : shown.reduce((found, row, index) => {
        const lane = lanesIn(row).findIndex((/** @type {any} */ l) => `lane:${l.key}` === owner.dataset.focusKey);
        return lane >= 0 ? { row: index, lane } : found;
      }, /** @type {any} */ (null));
    if (!where || where.row < 0) return;
    const to = moveFocus(layout, where, event.key);
    if (to === null) return;
    event.preventDefault();
    const row = shown[to.row];
    const key = to.lane === null ? `row:${row.key}` : `lane:${lanesIn(row)[to.lane].key}`;
    owner.setAttribute('tabindex', '-1');
    const next = rowsHost.querySelector(`[data-focus-key="${key}"]`);
    if (!next) return;
    next.setAttribute('tabindex', '0');
    memory.focusKey = key;
    /** @type {any} */ (next).focus();
  });
  root.addEventListener('keydown', (/** @type {any} */ event) => {
    if (!isKey(event, 'close') || memory.selected === null) return;
    event.preventDefault();
    const target = event.target;
    // The focus goes back to the lane only when it was inside a panel; on a lane it stays where it is.
    const inPanel = Boolean(target) && typeof target.closest === 'function' && target.closest('.spanel, .srow__panel') !== null;
    select(null, inPanel);
  });

  // ---- the footer: what was checked, what cannot be seen ----
  const footer = h('footer', { class: 'sfoot' }, [
    h('section', { class: 'sfoot__box', 'aria-labelledby': 'sfoot-checked' }, [
      h('h2', { class: 'sfoot__title', id: 'sfoot-checked' }, 'Checked this poll'),
      h('ul', { class: 'sfoot__list' }, limitWords(result.limits).map((line) => h('li', {}, line))),
    ]),
    h('section', { class: 'sfoot__box sfoot__box--blind', 'aria-labelledby': 'sfoot-blind' }, [
      h('h2', { class: 'sfoot__title', id: 'sfoot-blind' }, 'What this view cannot see'),
      h('ul', { class: 'sfoot__list' }, BLIND_SPOTS.map((line) => h('li', {}, line))),
    ]),
  ]);

  // ---- assemble ----
  if (result.empty) {
    return h('section', { class: 'sessions sessions--empty', 'aria-label': 'Sessions' }, [
      ...notes,
      absent,
      h('div', { class: 'empty' }, [
        icon('empty-rail', 96),
        h('h2', { class: 'empty__title' }, 'Only this checkout, and DoFlow has no session record here yet'),
        h('p', { class: 'empty__sentence' }, 'A session shows up here once DoFlow records it in one of two ways:'),
        h('ul', { class: 'empty__ways' }, [
          h('li', {}, 'Installed hooks: your coding tool’s DoFlow hooks write a record when a session starts.'),
          h('li', {}, 'DoFlow commands: a task claim, a worker or a lock taken through a doflow command.'),
        ]),
      ]),
      footer,
    ]);
  }
  draw();
  drawChips();
  const top = [h('div', { class: 'sessions__top' }, [summary, chips, legend]), ...notes, absent, bar];
  const layout = h('div', { class: 'sessions__layout' }, [rowsHost, panel]);
  mount(root, [...top, layout, footer]);
  return root;
}

export { renderSessions };
