// The response-stream panel of the Fleet view (V.10; design ui/V8.md 7b.5 "The response-stream panel", 7b.9, 7b.10).
// It shows what an agent's records state and nothing more: replies, tool calls with their result metadata, usage, dividers,
// and DoFlow's own `record` events. Every string from the Console reaches the page as a text node (IC-007); the redactor's
// three markers become chips; thinking, prompts and tool-result text never arrive (IC-022). The list is patched, never
// re-mounted: a batch appends rows, the oldest are removed above 500 events, and the reading position is kept. The list is
// not a live region: streamed text is never announced. The panel keeps its events only in the DOM and in a bounded array;
// no storage API is used (IC-025, IC-026). The stream panel says that its text is masked, best effort, because the redactor
// is a best-effort one (gate-a Q5 A).

import { h, mount, icon, announce } from '../dom.js';
import {
  MAX_EVENTS, appendEvents, secondsStamp, splitMasked, usageLine, resultBits, recordWords, nodeTitle, titleIsLabel, kindWord,
} from '../derive/fleet.js';

const CLAMP_REPLY_LINES = 12;
const CLAMP_ARGS_LINES = 4;
/** A rough line count of a text, for deciding whether it needs "Show all" (the browser clamps by lines; the count only decides the button). @param {string} text @param {number} width */
const roughLines = (text, width) => text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);

const FILTERS = Object.freeze([['all', 'All'], ['replies', 'Replies'], ['tools', 'Tools']]);
/** Which row groups each filter shows (usage only under All). */
/** @type {Readonly<Record<string, readonly string[]>>} */
const SHOWS = Object.freeze({ all: ['reply', 'tool', 'usage', 'divider', 'record'], replies: ['reply', 'divider', 'record'], tools: ['tool', 'divider', 'record'] });
/** @type {Readonly<Record<string, string>>} */
const GROUP = Object.freeze({ reply: 'reply', 'tool-call': 'tool', 'tool-result': 'tool', usage: 'usage', 'model-change': 'divider', 'subagent-start': 'divider', 'turn-end': 'divider', record: 'record' });

/** The text of a field with the redactor's markers as chips. @param {any} text @param {boolean} onCard */
function maskedNodes(text, onCard) {
  return splitMasked(text).map((part) => (part.mask
    ? h('span', { class: `masked${onCard ? ' masked--card' : ''}` }, [icon('masked', 12), part.mask])
    : part.text));
}

/** The 12 px glyph of a `record` event by its type. @param {any} record */
function recordGlyph(record) {
  const result = record && typeof record.result === 'string' ? record.result.toLowerCase() : '';
  if (!record || record.type === 'hook-record' || record.type === 'attempt-claim' || record.type === 'worker-run-start') return h('span', { class: 'ev__dot ev__dot--ring', 'aria-hidden': 'true' });
  const failed = /fail|error|abandon|cancel/.test(result);
  return h('span', { class: `ev__dot ${failed ? 'ev__dot--failed' : 'ev__dot--done'}`, 'aria-hidden': 'true' });
}

/**
 * The panel of one project fleet. `hooks`: `nodeOf(agentKey)` the tree node or null, `select(agentKey)` selects an agent,
 * `back()` leaves a gone agent, `close()` closes the 768 sheet.
 * @param {any} hooks
 */
function createPanel(hooks) {
  const state = {
    node: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    /** One entry per row in the DOM: its element, how many events it stands for, and its tool call key. */
    rows: /** @type {Array<{ li: any, n: number, callKey: string | null, group: string }>} */ ([]),
    byCall: /** @type {Map<string, { li: any, name: string }>} */ (new Map()),
    follow: true,
    unseen: 0,
    filter: 'all',
    answered: false,
    reader: /** @type {any} */ (null),
    transcript: /** @type {any} */ (null),
    warnings: /** @type {string[]} */ ([]),
    masked: 0,
    other: 0,
    unparsable: 0,
    dropped: 0,
    missing: /** @type {string | null} */ (null),
    tickError: /** @type {string | null} */ (null),
    connecting: true,
    skeleton: false,
    skeletonTimer: /** @type {any} */ (null),
    resetSeen: false,
    /** Rows enter with a short fade once the first batch is in; the first paint and a long catch-up are still. */
    animateRows: false,
  };

  const title = h('h2', { class: 'fpanel__title', id: 'fpanel-title', tabindex: '-1' }, 'Transcript');
  const tags = h('span', { class: 'fpanel__tags' });
  const meta = h('p', { class: 'fpanel__meta' });
  const maskedCount = h('span', { class: 'fpanel__masked', hidden: true });
  const follow = h('button', { type: 'button', class: 'btn btn--secondary fpanel__follow', 'aria-pressed': 'true', dataset: { focusKey: 'panel-follow' } }, [icon('check', 16), 'Follow']);
  const filterGroup = h('div', { class: 'fpanel__filter', role: 'radiogroup', 'aria-label': 'Show' }, FILTERS.map(([id, word]) => h('button', {
    type: 'button', role: 'radio', class: 'chip', 'aria-checked': id === 'all' ? 'true' : 'false', tabindex: id === 'all' ? '0' : '-1', dataset: { filter: id, focusKey: `panel-filter-${id}` },
  }, word)));
  const close = h('button', { type: 'button', class: 'btn btn--ghost fpanel__close', dataset: { focusKey: 'panel-close' } }, [icon('close', 16), h('span', { class: 'vh' }, 'Close transcript')]);
  const head = h('div', { class: 'fpanel__head' }, [
    h('div', { class: 'fpanel__titleline' }, [title, tags, close]),
    meta,
    h('div', { class: 'fpanel__controls' }, [follow, filterGroup, maskedCount]),
  ]);
  const notice = h('div', { class: 'fpanel__notice' });
  const list = h('ol', { class: 'stream' });
  const stateBox = h('div', { class: 'fpanel__state' });
  const scroll = h('div', { class: 'fpanel__scroll', tabindex: '0' }, [notice, stateBox, list]);
  const pill = h('button', { type: 'button', class: 'fpanel__new', hidden: true, dataset: { focusKey: 'panel-new' } }, [icon('arrow-down', 16), h('span', { class: 'fpanel__new-text' })]);
  const foot = h('p', { class: 'fpanel__foot' });
  const root = h('aside', { class: 'fpanel', 'aria-labelledby': 'fpanel-title', dataset: { empty: 'true' } }, [head, h('div', { class: 'fpanel__body' }, [scroll, pill]), foot]);

  // ---- helpers -------------------------------------------------------------------------------------

  const atEnd = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48 || !(scroll.scrollHeight > 0);

  function scrollToEnd() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  /** @param {boolean} on */
  function setFollow(on) {
    state.follow = on;
    follow.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      state.unseen = 0;
      pill.setAttribute('hidden', '');
    }
  }

  function updatePill() {
    if (state.follow || state.unseen === 0) {
      pill.setAttribute('hidden', '');
      return;
    }
    mount(pill.querySelector('.fpanel__new-text'), `${state.unseen} new ${state.unseen === 1 ? 'event' : 'events'}`);
    pill.removeAttribute('hidden');
  }

  function applyFilter() {
    const shows = SHOWS[state.filter];
    for (const row of state.rows) {
      if (shows.includes(row.group)) row.li.removeAttribute('hidden');
      else row.li.setAttribute('hidden', '');
    }
    for (const radio of filterGroup.querySelectorAll('.chip')) {
      const on = radio.dataset.filter === state.filter;
      radio.setAttribute('aria-checked', on ? 'true' : 'false');
      radio.setAttribute('tabindex', on ? '0' : '-1');
    }
  }

  /** The harness name and reader of the current node, for the banners. */
  const harnessName = () => (state.node && state.node.harness ? state.node.harness : 'this harness');

  /** @param {string} kind @param {string} face @param {string} strong @param {string} rest */
  function banner(kind, face, strong, rest) {
    return h('div', { class: 'fbanner', dataset: { kind } }, [icon(face, 16), h('p', {}, [h('strong', {}, strong), ` ${rest}`])]);
  }

  /** The banners above the events and the state of an empty body (7b.5 "Panel states"). */
  function renderStates() {
    const banners = [];
    const reason = state.node && state.node.transcript ? state.node.transcript.reason : null;
    const events = state.reader ? state.reader.status === 'events-only' : false;
    const name = harnessName();
    const gone = state.missing === 'agent-not-in-project' || state.missing === 'session-not-in-project';
    if (gone) {
      // The body says it: no banner.
    } else if ((state.transcript && state.transcript.reason === 'not-found') || reason === 'not-found') {
      banners.push(banner('not-found', 'failed', 'Transcript not found.', 'The harness may have moved or deleted it. DoFlow’s own records are listed below.'));
    } else if ((state.transcript && state.transcript.reason === 'not-linked') || reason === 'not-linked') {
      banners.push(banner('not-linked', 'info', 'Transcript not linked.', `DoFlow could not match this session to a ${name} transcript file. Its own records are listed below.`));
    } else if (events || (state.transcript && state.transcript.reason === 'no-reader') || reason === 'no-reader') {
      banners.push(banner('no-reader', 'info', `No transcript reader for ${name}.`, 'DoFlow’s own records for this agent are listed below. Reply text and tool calls are not available for this harness yet.'));
    }
    if (state.warnings.includes('format-unrecognized')) {
      banners.push(banner('format', 'stale', `This ${name} transcript has records this reader does not recognise.`, 'Showing the ones it could read.'));
    }
    mount(notice, banners);

    /** @type {any} */
    let box = null;
    if (gone) {
      box = h('div', { class: 'fpanel__empty' }, [h('p', {}, 'This agent is no longer in this project’s records.'), h('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => hooks.back() } }, 'Back to agents')]);
    } else if (state.node === null) {
      box = h('p', { class: 'fpanel__empty' }, 'Select an agent in the tree to follow its replies and tool calls.');
    } else if (state.skeleton && state.rows.length === 0) {
      box = h('div', { class: 'fpanel__skeleton', 'aria-hidden': 'true' }, [h('div', { class: 'skel skel--ev' }), h('div', { class: 'skel skel--ev skel--ev-tall' }), h('div', { class: 'skel skel--ev' })]);
    } else if (state.answered && state.rows.length === 0) {
      box = h('p', { class: 'fpanel__empty' }, 'No reply or tool call is recorded for this agent yet.');
    }
    mount(stateBox, box);
    root.dataset.empty = state.node === null ? 'true' : 'false';
    const controls = root.querySelector('.fpanel__controls');
    if (controls) {
      if (state.node === null || gone) controls.setAttribute('hidden', '');
      else controls.removeAttribute('hidden');
    }
  }

  function renderHead() {
    const node = state.node;
    if (node === null) {
      mount(title, 'Transcript');
      mount(tags, []);
      mount(meta, []);
      mount(foot, []);
      return;
    }
    mount(title, nodeTitle(node));
    mount(tags, [
      node.harness ? h('span', { class: 'tag tag--mono' }, node.harness) : null,
      titleIsLabel(node) || node.kind !== 'main-session' ? h('span', { class: 'tag' }, kindWord(node)) : null,
    ]);
    const reader = state.reader && state.reader.id ? `reader ${state.reader.id}` : state.reader ? 'no reader' : node.transcript && node.transcript.reader ? `reader ${node.transcript.reader}` : 'no reader';
    mount(meta, [
      node.model ? h('span', { class: 'mono' }, node.model) : h('span', {}, 'model not recorded'),
      h('span', { class: 'fpanel__sep', 'aria-hidden': 'true' }, '·'),
      h('span', { class: 'mono' }, reader),
      state.events.length > 0 ? [h('span', { class: 'fpanel__sep', 'aria-hidden': 'true' }, '·'), h('span', {}, ['last event ', h('span', { class: 'mono' }, secondsStamp(state.events[state.events.length - 1].at) ?? 'untimed')])] : null,
    ]);
    if (state.masked > 0) {
      mount(maskedCount, [icon('masked', 12), `${state.masked} ${state.masked === 1 ? 'value' : 'values'} masked`]);
      maskedCount.removeAttribute('hidden');
    } else maskedCount.setAttribute('hidden', '');
    mount(foot, `Not shown: ${state.other} other ${state.other === 1 ? 'record' : 'records'} (prompts, thinking, attachments, system). ${state.unparsable} unreadable. Text is masked, best effort: DoFlow’s redactor can miss a secret that has no known shape.`);
  }

  // ---- rows ----------------------------------------------------------------------------------------

  /** @param {any} event */
  function timeCell(event) {
    const stamp = secondsStamp(event.at);
    return stamp === null ? h('span', { class: 'ev__at' }, 'untimed') : h('time', { class: 'ev__at', datetime: event.at }, stamp);
  }

  /** The clamped text of a reply or of tool arguments with its "Show all" button. @param {any} event @param {string} field @param {string} tagName @param {number} lines @param {number} width @param {boolean} onCard */
  function clamped(event, field, tagName, lines, width, onCard) {
    const text = String(event[field] ?? '');
    const body = h(tagName, { class: tagName === 'pre' ? 'ev__args' : 'ev__text' }, maskedNodes(text, onCard));
    const long = roughLines(text, width) > lines;
    const nodes = [body];
    if (long) {
      body.classList.add('is-clamped');
      const note = event.cut ? h('span', { class: 'ev__cut', hidden: true }, field === 'args' ? 'cut at 512 B by DoFlow' : 'cut at 4 KiB by DoFlow') : null;
      const toggle = h('button', { type: 'button', class: 'btn btn--ghost ev__more', 'aria-expanded': 'false' }, 'Show all');
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        mount(toggle, open ? 'Show less' : 'Show all');
        if (open) body.classList.remove('is-clamped');
        else body.classList.add('is-clamped');
        if (note) {
          if (open) note.removeAttribute('hidden');
          else note.setAttribute('hidden', '');
        }
      });
      nodes.push(toggle, note);
    } else if (event.cut) nodes.push(h('span', { class: 'ev__cut' }, field === 'args' ? 'cut at 512 B by DoFlow' : 'cut at 4 KiB by DoFlow'));
    return nodes;
  }

  /** The result status of a tool card (or of an orphan result), as nodes. @param {any} result */
  function resultNodes(result) {
    if (result === null) return h('span', { class: 'ev__noresult' }, 'no result recorded yet');
    const tool = result.tool ?? {};
    const bits = resultBits(tool);
    const tail = bits.length ? ` · ${bits.join(' · ')}` : '';
    if (tool.status === 'ok') return h('span', { class: 'ev__status ev__status--ok' }, [icon('check', 12), `ok${tail}`]);
    if (tool.status === 'error') return h('span', { class: 'ev__status ev__status--error' }, [icon('failed', 12), `error${tail}`]);
    return h('span', { class: 'ev__status' }, `result recorded${tail}`);
  }

  /** @param {any} event @returns {{ li: any, group: string, callKey: string | null, name: string }} */
  function buildRow(event) {
    const group = GROUP[event.kind] ?? 'record';
    const li = h('li', { class: 'ev', dataset: { kind: event.kind, group } });
    let callKey = null;
    let name = '';
    if (group === 'divider') {
      const words = event.kind === 'model-change' ? `Model changed to ${event.model ?? 'another model'}` : '';
      let content;
      if (event.kind === 'subagent-start') {
        const label = event.text && String(event.text) !== '' ? String(event.text) : 'a subagent';
        const target = event.agentKey && hooks.nodeOf(event.agentKey);
        content = target ? ['Started subagent ', h('button', { type: 'button', class: 'btn btn--ghost ev__link', on: { click: () => hooks.select(event.agentKey) } }, label)] : `Started subagent ${label}`;
      } else content = words === '' ? '' : words;
      li.classList.add('ev--divider');
      li.append(timeCell(event), h('div', { class: 'ev__divider' }, [h('span', { class: 'ev__rule' }), content === '' ? null : h('span', { class: 'ev__divtext' }, content), h('span', { class: 'ev__rule' })]));
    } else if (event.kind === 'reply') {
      li.append(timeCell(event), h('div', { class: 'ev__body' }, [
        h('p', { class: 'ev__eyebrow' }, ['Reply', event.model && (!state.node || event.model !== state.node.model) ? h('span', { class: 'ev__model mono' }, event.model) : null]),
        ...clamped(event, 'text', 'p', CLAMP_REPLY_LINES, 80, false),
      ]));
    } else if (event.kind === 'tool-call') {
      callKey = event.tool ? event.tool.callKey : null;
      name = event.tool ? event.tool.name : 'tool';
      const status = h('span', { class: 'ev__result' }, resultNodes(null));
      li.append(timeCell(event), h('div', { class: 'ev__body' }, h('div', { class: 'ev__tool' }, [
        h('div', { class: 'ev__toolhead' }, [icon('tool', 16), h('span', { class: 'ev__toolname mono' }, name), status]),
        event.args ? clamped(event, 'args', 'pre', CLAMP_ARGS_LINES, 60, true) : null,
      ])));
    } else if (event.kind === 'tool-result') {
      const label = event.tool ? event.tool.name : 'a tool';
      li.append(timeCell(event), h('div', { class: 'ev__body ev__orphan' }, [`Result of ${label} · `, resultNodes(event)]));
    } else if (event.kind === 'usage') {
      li.append(timeCell(event), h('p', { class: 'ev__usage' }, usageLine(event.tokens)));
    } else {
      // A `record` event: DoFlow's own record for this agent.
      li.append(timeCell(event), h('p', { class: 'ev__record' }, [recordGlyph(event.record), recordWords(event.record)]));
    }
    return { li, group, callKey, name };
  }

  /** Adds the rows of one batch to the list, attaching tool results to the calls the panel already shows. @param {any[]} batch */
  function addRows(batch) {
    for (const event of batch) {
      if (event.kind === 'tool-result' && event.tool && state.byCall.has(event.tool.callKey)) {
        const target = /** @type {{ li: any }} */ (state.byCall.get(event.tool.callKey));
        const slot = target.li.querySelector('.ev__result');
        if (slot) mount(slot, resultNodes(event));
        const row = state.rows.find((entry) => entry.li === target.li);
        if (row) row.n += 1;
        continue;
      }
      const built = buildRow(event);
      if (state.animateRows && batch.length <= 50) built.li.classList.add('ev--enter');
      list.append(built.li);
      state.rows.push({ li: built.li, n: 1, callKey: built.callKey, group: built.group });
      if (built.callKey !== null) state.byCall.set(built.callKey, { li: built.li, name: built.name });
    }
  }

  /** Removes the oldest rows until no more than the bound is represented; keeps the reading position when not following. @param {number} dropped */
  function trimRows(dropped) {
    if (dropped <= 0) return;
    let removed = 0;
    let height = 0;
    while (state.rows.length > 0 && removed < dropped) {
      const row = /** @type {any} */ (state.rows.shift());
      removed += row.n;
      height += Number(row.li.offsetHeight) || 0;
      if (row.callKey !== null) state.byCall.delete(row.callKey);
      row.li.remove();
    }
    state.dropped += removed;
    if (!state.follow && height > 0) scroll.scrollTop = Math.max(0, scroll.scrollTop - height);
    renderBoundNote();
  }

  function renderBoundNote() {
    let first = list.querySelector('.ev--bound');
    if (state.dropped === 0) {
      if (first) first.remove();
      return;
    }
    if (!first) {
      first = h('li', { class: 'ev--bound' }, `Earlier events are not kept in this view (${MAX_EVENTS} shown).`);
      list.prepend(first);
    }
  }

  // ---- the surface -----------------------------------------------------------------------------------

  follow.addEventListener('click', () => {
    setFollow(!state.follow);
    if (state.follow) scrollToEnd();
  });
  pill.addEventListener('click', () => {
    setFollow(true);
    scrollToEnd();
  });
  scroll.addEventListener('scroll', () => {
    const near = atEnd();
    if (near && !state.follow) setFollow(true);
    else if (!near && state.follow) setFollow(false);
    updatePill();
  });
  close.addEventListener('click', () => hooks.close());
  for (const radio of filterGroup.querySelectorAll('.chip')) {
    radio.addEventListener('click', () => {
      state.filter = radio.dataset.filter;
      applyFilter();
    });
    radio.addEventListener('keydown', (/** @type {any} */ event) => {
      const radios = Array.from(filterGroup.querySelectorAll('.chip'));
      const at = radios.indexOf(radio);
      /** @type {Record<string, number>} */
      const steps = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      const move = steps[event.key];
      if (move === undefined) return;
      event.preventDefault();
      const next = radios[(at + move + radios.length) % radios.length];
      next.focus();
      state.filter = next.dataset.filter;
      applyFilter();
    });
  }

  renderStates();

  return {
    el: root,
    titleEl: title,
    scrollEl: scroll,
    listEl: list,
    state,
    /** Shows a node (or none). A different agent starts the list over. @param {any} node */
    setAgent(node) {
      const same = node !== null && state.node !== null && node.agentKey === state.node.agentKey;
      const wasMissing = state.missing;
      state.node = node;
      if (node === null) state.missing = null;
      if (!same) {
        for (const row of state.rows) row.li.remove();
        state.rows = [];
        state.byCall.clear();
        state.events = [];
        state.answered = false;
        state.reader = null;
        state.transcript = null;
        state.warnings = [];
        state.masked = 0;
        state.other = 0;
        state.unparsable = 0;
        state.dropped = 0;
        state.missing = null;
        state.resetSeen = false;
        state.animateRows = false;
        state.unseen = 0;
        setFollow(true);
        renderBoundNote();
        if (state.skeletonTimer !== null) globalThis.clearTimeout(state.skeletonTimer);
        state.skeleton = false;
        if (node !== null) {
          state.skeletonTimer = globalThis.setTimeout(() => {
            state.skeletonTimer = null;
            state.skeleton = true;
            renderStates();
          }, 300);
        }
      } else state.missing = wasMissing;
      renderHead();
      renderStates();
    },
    /** A page of the transcript (IC-022), from the stream or from the poll. @param {any} body @param {{ resumed: boolean }} meta */
    receive(body, meta) {
      if (state.node === null || !body || typeof body !== 'object') return;
      if (body.agent !== undefined && body.agent !== state.node.agentKey) return;
      if (state.skeletonTimer !== null) globalThis.clearTimeout(state.skeletonTimer);
      state.skeletonTimer = null;
      state.skeleton = false;
      state.answered = true;
      state.reader = body.reader ?? state.reader;
      state.transcript = body.transcript ?? state.transcript;
      state.warnings = Array.isArray(body.warnings) ? body.warnings : [];
      state.masked += Number(body.masked) || 0;
      state.other += Number(body.otherRecords) || 0;
      state.unparsable += Number(body.unparsable) || 0;
      const wasEnd = state.follow;
      const events = Array.isArray(body.events) ? body.events : [];
      if (body.reset) {
        // The file was rewritten: what is held is no longer its past.
        for (const row of state.rows) row.li.remove();
        state.rows = [];
        state.byCall.clear();
        state.events = [];
        state.dropped = 0;
        renderBoundNote();
        list.append(h('li', { class: 'ev ev--divider', dataset: { kind: 'reset', group: 'divider' } }, [h('span', { class: 'ev__at' }), h('div', { class: 'ev__divider' }, [h('span', { class: 'ev__rule' }), h('span', { class: 'ev__divtext' }, 'The transcript was rewritten. Showing its last 64 records.'), h('span', { class: 'ev__rule' })])]));
        state.resetSeen = true;
        announce('The transcript was rewritten; showing its last 64 records.');
      }
      const next = appendEvents(state.events, events, { dedupe: Boolean(meta && meta.resumed), reset: false });
      state.events = next.events;
      // A resumed batch can hold events the panel already has; only the new ones are drawn.
      addRows(next.fresh);
      state.animateRows = true;
      trimRows(next.dropped);
      applyFilter();
      renderHead();
      renderStates();
      if (next.added > 0) {
        if (state.follow && wasEnd) scrollToEnd();
        else {
          state.unseen += next.added;
          updatePill();
        }
      }
    },
    /** A server error code for this stream: the missing states come from here. @param {string | null} code */
    setMissing(code) {
      state.missing = code === 'agent-not-in-project' || code === 'session-not-in-project' ? code : null;
      renderStates();
    },
    destroy() {
      if (state.skeletonTimer !== null) globalThis.clearTimeout(state.skeletonTimer);
      state.skeletonTimer = null;
    },
    /** The panel's own redraw of head and banners (the selected node changed). */
    refresh() {
      renderHead();
      renderStates();
    },
    setFollow,
    /** Where the focus goes when the panel opens. */
    focusTitle() {
      title.focus({ preventScroll: true });
    },
  };
}

export { createPanel, maskedNodes, GROUP, SHOWS, CLAMP_REPLY_LINES, CLAMP_ARGS_LINES };
