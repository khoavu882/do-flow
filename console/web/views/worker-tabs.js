// The worker tabs of the Session screen (feature 150, IC-018; FR-006, FR-008, FR-015, FR-016, FR-017, FR-019). One selected
// worker run shows its head facts, then one tab list of Log, Transcript, Result and Process and one tab panel. Every string
// from the Console reaches the page as a text node (149 NFR-004): log text is appended to a `pre` as text nodes and is never a
// live region, so streamed text is never announced (the Fleet panel's rule, transcript.js). The tab list owns its arrow keys
// (Left, Right, Home and End move and select, automatic activation); no document listener and no shortcut entry is added
// (NFR-006). Nothing runs on a timer here: the log streams poll only through log-store.js, and the transcript is read once.
//
// `mountWorkerTabs(container, options)` mounts the tabs into `container` and returns `{ el, update(patch), destroy() }`.
//   options: { apiGet, store, slug, run, tab?, onTab?, clock?, platform? }
//     apiGet    the shell's same-origin GET: the body, or a thrown `{ status, code, network }`
//     store     the page's one live store (store.js), handed to each log stream (log-store.js)
//     slug      the feature slug of the run store
//     run       the run's row of `GET /api/worker-runs/<slug>` (IC-011 `worker-runs`, or the older-core fallback row)
//     tab       'log' | 'transcript' | 'result' | 'process' (default 'log'), the tab the hash names
//     onTab     called with the tab id when the person selects a tab, so the caller can write the hash (IC-015)
//     clock     handed to the log streams (log-store.js's `{ now, setTimeout, clearTimeout }`)
//     platform  the host platform when the caller knows it; 'win32' makes liveness read unknown with the Windows sentence
//   update(patch), each key optional:
//     run       a new row: another run id starts over (log streams closed, members dropped); the same id redraws the head
//     tab       selects a tab without calling onTab (the hash moved)
//     worker    the `worker` member of `worker:<runId>` as `{ status, body }` (equal to `GET .../status`), for Process
//     result    the `result` member of `worker:<runId>` as `{ status, body }` (equal to `GET .../result`), for Result
//     stale     true while the view's connector is stale: the panel carries `data-stale="true"`
//   The Result and Process tabs read their GET once, the first time they are shown for a run with no member held; a member
//   given by `update` replaces what is held. The Transcript tab reads `GET .../transcript` once the first time it is shown for
//   a run, never again unless the person presses Try again after a failure. The Log tab opens one log stream per stream while
//   it is shown and closes both when another tab is selected.
// The panel's `data-state` names its state: loading, ready, empty, error or not-in-core.

import { h, mount, icon } from '../dom.js';
import { isKey } from '../keys.js';
import { classify, renderError, renderLoading, ERROR_COPY, clockTime, skel, button } from '../states.js';
import { createLogStream } from '../log-store.js';
import { workerChip } from '../derive/chain.js';
import { reasonBanner, renderEventList } from './transcript.js';
import { CORE_RANGE } from '../routes.js';

/** The tabs in IC-018's order (requirement A2). */
const TABS = Object.freeze([['log', 'Log'], ['transcript', 'Transcript'], ['result', 'Result'], ['process', 'Process']]);
const TAB_IDS = Object.freeze(TABS.map(([id]) => id));
const RUN_ID = /^w-[0-9a-f]{12}$/;
const STREAMS = Object.freeze([['out', 'stdout'], ['err', 'stderr']]);

/** The Fleet panel's sentence (console/web/views/transcript.js), said by the Log and Transcript tabs. */
const MASKED_SENTENCE = 'Text is masked, best effort: DoFlow’s redactor can miss a secret that has no known shape.';

/** IC-018's per-stream notes, keyed by log-store.js `notices`. */
/** @type {Readonly<Record<string, string>>} */
const LOG_NOTES = Object.freeze({
  earlier: 'Earlier text exists and is not shown.',
  paused: 'Following paused.',
  reset: 'The log file was replaced; showing its newest page.',
  withheld: 'A line too long to show after masking was left out.',
  capped: 'Log capped: the worker wrote more than 4 MiB and later output was not kept.',
  waiting: "Waiting for the worker's first output.",
  none: 'This run recorded no output on this stream.',
  gone: 'This log was pruned by retention.',
});
const LOG_EMPTY = 'No output on this stream yet.';

/** IC-018's older-core copy (FR-019). */
const OLDER_CORE = Object.freeze({
  log: 'This DoFlow core does not provide worker logs.',
  transcript: 'This DoFlow core does not provide transcripts.',
  result: 'This DoFlow core does not provide worker results.',
  process: 'This DoFlow core does not provide worker process status.',
});

/** One sentence per `resultOfRun` withheld code (src/runtime/worker/supervisor.ts:269; `CLOSED_SETS.withheldCodes`). */
/** @type {Readonly<Record<string, string>>} */
const WITHHELD_SENTENCES = Object.freeze({
  'not-exited': 'The worker did not exit on its own: it timed out, was cancelled or never started.',
  'outside-write': 'The edit run changed the caller’s checkout, outside its own worktree.',
  'branch-moved': 'The attempt branch moved off its recorded branch or base.',
  'isolation-unverifiable': 'DoFlow could not verify that the edit run stayed inside its worktree.',
  'read-only-violation': 'The read-only run changed the checkout.',
  'read-only-unverifiable': 'DoFlow could not verify that the read-only run left the checkout unchanged.',
  'report-denied': 'The worker’s report says a permission was denied.',
  'report-quota': 'The worker stopped at a usage quota.',
  'report-failure': 'The worker’s report says it failed.',
  'report-unparsed': 'DoFlow could not read a report in the worker’s output.',
  'group-survived': 'Processes of the worker’s group were still running after it exited.',
});

/** `reportStatus` (src/runtime/worker/parsers/common.ts:16). */
/** @type {Readonly<Record<string, string>>} */
const REPORT_WORDS = Object.freeze({ success: 'success', failure: 'failure', denied: 'denied', unparsed: 'not parsed' });
/** The read-only and isolation check statuses (src/runtime/worker/worktree-check.ts:52). */
/** @type {Readonly<Record<string, string>>} */
const CHECK_WORDS = Object.freeze({ clean: 'clean', violated: 'violated', unverifiable: 'could not be verified' });
/** `isolation.reason` (isolationOf, src/runtime/worker/supervisor.ts:241). */
/** @type {Readonly<Record<string, string>>} */
const ISOLATION_REASONS = Object.freeze({
  'outside-write': 'the caller’s checkout changed',
  'branch-moved': 'the attempt branch moved',
  'isolation-unverifiable': 'a snapshot or a git read failed',
});
/** `end.state`. */
/** @type {Readonly<Record<string, string>>} */
const END_WORDS = Object.freeze({ exited: 'exited', 'timed-out': 'timed out', cancelled: 'cancelled' });

/** The worker status states and reasons (statusView, src/runtime/worker/command.ts:428). */
/** @type {Readonly<Record<string, string>>} */
const STATE_WORDS = Object.freeze({ starting: 'Starting', running: 'Running', unknown: 'Unknown', exited: 'Exited', 'timed-out': 'Timed out', cancelled: 'Cancelled' });
/** @type {Readonly<Record<string, string>>} */
const REASON_SENTENCES = Object.freeze({
  'supervisor-lost': 'The supervisor process is gone, so DoFlow did not see the run finish.',
  'liveness-unknown': 'DoFlow could not check whether the run’s processes are alive.',
  'process-lost': 'Neither the supervisor nor the worker process is running.',
});
const SUPERVISOR_LOST = 'Supervisor lost: the worker process is seen, its supervisor is not.';
const WIN32_SENTENCE = 'Liveness is unknown on Windows: DoFlow cannot check processes there.';
/** `process.groupAlive` (src/runtime/worker/supervisor.ts:495); absent (null) where no group was read, such as on win32. */
const GROUP_WORDS = Object.freeze({
  true: 'the process group was still running after the exit',
  false: 'the process group was gone',
  unknown: 'unknown',
  null: 'unknown: the process group was not read',
});
/** `process.leftover` and `cleanup` statuses (process-tree.ts escalate, cancel.ts). */
/** @type {Readonly<Record<string, string>>} */
const LEFTOVER_WORDS = Object.freeze({ verified: 'verified: no process was left', survivors: 'survivors: processes were left', unknown: 'unknown' });

/** The 12 px face of each badge token (the Sessions view's table). */
/** @type {Readonly<Record<string, string>>} */
const TOKEN_FACE = Object.freeze({ running: 'running', done: 'check', failed: 'failed', unknown: 'unknown', rejected: 'rejected', skipped: 'skipped', pending: 'pending', awaiting: 'awaiting', stale: 'stale' });

const NOT_YET = 'not recorded yet';

let mounts = 0;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object';

/** A failed `apiGet` as `{ status, code, network }`. @param {any} error */
const failureOf = (error) => ({
  status: error && typeof error.status === 'number' ? error.status : null,
  code: error && typeof error.code === 'string' ? error.code : null,
  network: Boolean(error && error.network === true),
});

/** A member `{ status, body }` as held: `{ ok: true, body }` or `{ ok: false, error }`; null for none. @param {any} entry */
function memberOf(entry) {
  if (!isObject(entry) || typeof entry.status !== 'number') return null;
  if (entry.status === 200) return { ok: true, body: entry.body };
  const code = isObject(entry.body) && isObject(entry.body.error) && typeof entry.body.error.code === 'string' ? entry.body.error.code : null;
  return { ok: false, error: { status: entry.status, code, network: false } };
}

/** A time as a `time` element in local HH:MM:SS, or `missing`. @param {any} iso @param {string} missing */
function timeOr(iso, missing) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? h('time', { datetime: iso }, clockTime(ms)) : missing;
}

/** One term and value of a facts list. @param {string} term @param {any} value */
const fact = (term, value) => h('div', { class: 'facts__row' }, [h('dt', {}, term), h('dd', {}, value)]);

/** The loading state of a tab. @param {string} noun */
const loading = (noun) => renderLoading({ noun, showSkeleton: true, skeleton: () => h('div', {}, [skel('skel--meta'), skel('skel--meta')]) });

/**
 * The error state (the 149 error copy keys): 404 `unknown-run` reads as the run-not-found copy, a key without copy (a full-page
 * row) as core-error. A retryable row gets Try again, pressed by the person; nothing retries on a timer.
 * @param {any} failure @param {string} noun @param {() => void} retry
 */
function errorBox(failure, noun, retry) {
  let info = classify(failure);
  if (failure && failure.status === 404 && failure.code === 'unknown-run') info = { ...info, key: 'run-not-found' };
  if (!Object.hasOwn(ERROR_COPY, info.key)) info = { ...info, key: 'core-error' };
  const panel = renderError({ info: { ...info, auto: false }, noun, range: CORE_RANGE, onRetry: retry, onReload: () => globalThis.location.reload() });
  if (info.auto) {
    const again = button('secondary', 'Try again', retry, 'refresh');
    const actions = panel.querySelector('.state-panel__actions');
    if (actions) actions.prepend(again);
    else panel.insertBefore(h('div', { class: 'state-panel__actions' }, again), panel.querySelector('.code-chip'));
  }
  return panel;
}

/**
 * One stream's region of the Log tab: notes, state and a `pre` of text nodes, fed by a log stream's state.
 * @param {string} stream @param {string} label @param {() => any} logStream
 */
function streamPane(stream, label, logStream) {
  const earlier = h('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => void logStream().loadEarlier() } }, 'Load earlier');
  const jump = h('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => void logStream().jumpToNewest() } }, 'Jump to newest');
  const notes = h('div', {});
  const stateBox = h('div', {});
  const pre = h('pre', { class: 'logpane__text', tabindex: '0', hidden: true });
  const el = h('section', { class: 'logpane', 'aria-label': label, dataset: { stream, state: 'loading' } }, [h('h3', {}, label), notes, stateBox, pre]);
  /** What the `pre` shows: the inode and first offset of the held text, the pieces drawn and the last one's offset. */
  const shown = { ino: /** @type {string | null} */ (null), from: -1, count: 0, lastAt: -1 };
  let noteKey = '';
  let boxKey = '';

  /** @param {any} state */
  function renderText(state) {
    const pieces = state.pieces;
    const same = state.ino !== null && state.ino === shown.ino && state.from === shown.from && pieces.length >= shown.count
      && (shown.count === 0 || pieces[shown.count - 1].at === shown.lastAt);
    const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 48 || !(pre.scrollHeight > 0);
    // Simplification: a held text that moved its start (the hold bound trimmed it, or Load earlier) is drawn again whole.
    if (!same) {
      pre.replaceChildren();
      shown.count = 0;
    }
    for (let i = shown.count; i < pieces.length; i += 1) {
      const joined = i > 0 && pieces[i - 1].cut !== true ? '\n' : '';
      pre.append(document.createTextNode(joined + pieces[i].text));
    }
    shown.ino = state.ino;
    shown.from = state.from;
    shown.count = pieces.length;
    shown.lastAt = pieces.length > 0 ? pieces[pieces.length - 1].at : -1;
    if (pieces.length > 0) pre.removeAttribute('hidden');
    else pre.setAttribute('hidden', '');
    if (near && state.following) pre.scrollTop = pre.scrollHeight;
  }

  return {
    el,
    /** @param {any} state @returns {string} this stream's state: loading, ready, empty, error or not-in-core */
    render(state) {
      const mode = state.mode;
      let kind;
      if (mode === 'idle' || mode === 'loading') kind = 'loading';
      else if (mode === 'failed' || mode === 'not-found') kind = 'error';
      else if (mode === 'not-in-core') kind = 'not-in-core';
      else kind = state.pieces.length > 0 ? 'ready' : 'empty';
      el.dataset.state = kind;
      const box = kind === 'error' ? `error:${state.error ? `${state.error.status}:${state.error.code}` : ''}` : kind;
      if (box !== boxKey) {
        boxKey = box;
        if (kind === 'loading') mount(stateBox, loading(label));
        else if (kind === 'error') mount(stateBox, errorBox(state.error ?? { status: null, code: null, network: true }, `the ${label} log`, () => void logStream().open()));
        else mount(stateBox, []);
      }
      const notices = kind === 'loading' || kind === 'error' || kind === 'not-in-core' ? [] : [...state.notices];
      if (kind === 'empty' && notices.length === 0) notices.push('empty');
      const key = notices.join(' ');
      if (key !== noteKey) {
        noteKey = key;
        mount(notes, notices.map((notice) => {
          if (notice === 'empty') return h('p', { class: 'logpane__note' }, LOG_EMPTY);
          const extra = notice === 'earlier' ? earlier : notice === 'paused' ? jump : null;
          return h('p', { class: 'logpane__note', dataset: { notice } }, [LOG_NOTES[notice], extra ? ' ' : null, extra]);
        }));
      }
      if (kind === 'ready' || kind === 'empty') renderText(state);
      else pre.setAttribute('hidden', '');
      return kind;
    },
  };
}

/**
 * Mounts the worker tabs of one run into `container` (see the header for the options and the patch).
 * @param {any} container
 * @param {{ apiGet: (path: string) => Promise<any>, store: any, slug: string, run: any, tab?: string, onTab?: (tab: string) => void, clock?: any, platform?: string | null }} options
 */
function mountWorkerTabs(container, options) {
  const { apiGet, store, slug, clock } = options ?? {};
  if (!container || typeof apiGet !== 'function' || !isObject(store) || typeof slug !== 'string' || slug === '' || !isObject(options.run) || !RUN_ID.test(options.run.runId)) {
    throw new TypeError('mountWorkerTabs(container, { apiGet, store, slug, run, tab, onTab, clock, platform })');
  }
  const onTab = typeof options.onTab === 'function' ? options.onTab : () => {};
  const platform = typeof options.platform === 'string' ? options.platform : null;
  mounts += 1;
  const idBase = `wtabs-${mounts}`;

  let run = options.run;
  let selected = TAB_IDS.includes(String(options.tab)) ? String(options.tab) : 'log';
  let destroyed = false;
  /** @type {{ worker: any, result: any }} held members: null, `{ loading: true }`, `{ ok: true, body }` or `{ ok: false, error }` */
  let members = { worker: null, result: null };
  /** @type {Map<string, any>} the transcript read of each run shown here */
  const transcripts = new Map();
  /** @type {any} the open Log tab: its streams, panes, unsubscribes, states and content */
  let log = null;

  const base = () => `/api/worker-runs/${encodeURIComponent(slug)}/${encodeURIComponent(run.runId)}`;

  const head = h('div', {});
  const tabs = TABS.map(([id, word]) => h('button', {
    type: 'button', role: 'tab', class: 'wtabs__tab', id: `${idBase}-${id}`, 'aria-controls': `${idBase}-panel`, 'aria-selected': 'false', tabindex: '-1', dataset: { tab: id },
  }, word));
  const tablist = h('div', { role: 'tablist', 'aria-label': 'Worker run' }, tabs);
  const panel = h('div', { role: 'tabpanel', tabindex: '0', id: `${idBase}-panel`, class: 'wtabs__panel', dataset: { state: 'loading' } });
  const root = h('div', { class: 'wtabs' }, [head, tablist, panel]);
  mount(container, root);

  // ---- the head ----

  function renderHead() {
    const worker = members.worker && members.worker.ok && isObject(members.worker.body) ? members.worker.body : null;
    const chip = workerChip(run, worker ? worker.state : null);
    const ended = run.phase === 'ended' || (run.phase === null && typeof run.endState === 'string');
    mount(head, [
      h('p', {}, [
        typeof run.harness === 'string' ? h('span', { class: 'tag tag--mono' }, run.harness) : h('span', { class: 'tag' }, 'harness not recorded'),
        ' ',
        h('span', { class: 'badge', dataset: { state: chip.token } }, [icon(TOKEN_FACE[chip.token] ?? 'unknown', 12), chip.word]),
      ]),
      h('dl', { class: 'facts' }, [
        fact('Task', [String(run.task), `, token ${run.token}`]),
        typeof run.childOf === 'string' ? fact('Granted by', run.childOf) : null,
        fact('Started', timeOr(run.startedAt ?? (worker ? worker.startedAt : null), NOT_YET)),
        fact('Ended', timeOr(run.endedAt ?? (worker ? worker.endedAt : null), ended ? 'not recorded' : NOT_YET)),
      ]),
    ]);
  }

  // ---- the panel ----

  /** @param {string} state @param {any} children */
  function show(state, children) {
    panel.dataset.state = state;
    mount(panel, children);
  }

  // Log

  function openLog() {
    const mine = {
      streams: /** @type {any[]} */ ([]),
      panes: /** @type {any[]} */ ([]),
      offs: /** @type {Array<() => void>} */ ([]),
      kinds: ['loading', 'loading'],
      older: false,
      el: h('div', {}),
    };
    log = mine;
    STREAMS.forEach(([stream, label], i) => {
      mine.streams.push(createLogStream({ apiGet, store, clock, slug, runId: run.runId, stream: /** @type {'out' | 'err'} */ (stream) }));
      mine.panes.push(streamPane(stream, label, () => mine.streams[i]));
    });
    mount(mine.el, [h('p', { class: 'logpane__note' }, MASKED_SENTENCE), mine.panes[0].el, mine.panes[1].el]);
    mine.streams.forEach((logStream, i) => {
      mine.offs.push(logStream.onChange((/** @type {any} */ state) => {
        if (log !== mine) return;
        mine.kinds[i] = mine.panes[i].render(state);
        refreshLog();
      }));
    });
    for (const logStream of mine.streams) void logStream.open();
  }

  function closeLog() {
    if (log === null) return;
    for (const off of log.offs) off();
    for (const logStream of log.streams) logStream.close();
    log = null;
  }

  function refreshLog() {
    if (log === null || selected !== 'log') return;
    const kinds = log.kinds;
    const older = kinds.includes('not-in-core');
    if (older !== log.older) {
      log.older = older;
      mount(log.el, older ? h('p', { class: 'logpane__note' }, OLDER_CORE.log) : [h('p', { class: 'logpane__note' }, MASKED_SENTENCE), log.panes[0].el, log.panes[1].el]);
    }
    const state = older ? 'not-in-core' : kinds.includes('loading') ? 'loading' : kinds.includes('error') ? 'error' : kinds.includes('ready') ? 'ready' : 'empty';
    panel.dataset.state = state;
    if (panel.children.length !== 1 || panel.children[0] !== log.el) mount(panel, log.el);
  }

  // Transcript

  function readTranscript() {
    const runId = run.runId;
    transcripts.set(runId, { loading: true });
    apiGet(`${base()}/transcript`).then(
      (body) => ({ ok: true, body }),
      (error) => ({ ok: false, error: failureOf(error) }),
    ).then((answer) => {
      if (destroyed || !transcripts.has(runId)) return;
      transcripts.set(runId, answer);
      if (selected === 'transcript' && run.runId === runId) renderPanel();
    });
  }

  function renderTranscript() {
    if (!transcripts.has(run.runId)) readTranscript();
    const held = transcripts.get(run.runId);
    if (held.loading) return show('loading', loading('the transcript'));
    if (!held.ok) {
      if (held.error.status === 404 && (held.error.code === 'agent-not-in-project' || held.error.code === 'project-not-found')) return show('empty', h('p', {}, 'The core did not include this worker run in its read.'));
      if (held.error.status === 501) return show('not-in-core', h('p', {}, OLDER_CORE.transcript));
      return show('error', errorBox(held.error, 'the transcript', () => {
        readTranscript();
        renderPanel();
      }));
    }
    const body = isObject(held.body) ? held.body : {};
    const events = Array.isArray(body.events) ? body.events : [];
    const reason = isObject(body.transcript) && typeof body.transcript.reason === 'string' ? body.transcript.reason : null;
    const eventsOnly = isObject(body.reader) && body.reader.status === 'events-only';
    const name = typeof body.harness === 'string' ? body.harness : typeof run.harness === 'string' ? run.harness : 'this harness';
    const banner = reasonBanner(reason, name, eventsOnly);
    const list = events.length > 0 ? renderEventList(events, { node: null, nodeOf: () => null, select: () => {} }) : null;
    const empty = list === null && banner === null ? h('p', {}, 'No reply or tool call is recorded for this worker run yet.') : null;
    return show(list === null ? 'empty' : 'ready', [banner, empty, list, h('p', { class: 'logpane__note' }, MASKED_SENTENCE)]);
  }

  // Result and Process: the member, or one GET the first time the tab is shown for the run

  /** @param {'worker' | 'result'} name @param {boolean} [force] */
  function ensureMember(name, force = false) {
    if (!force && members[name] !== null) return;
    const held = { loading: true };
    const mine = members;
    mine[name] = held;
    apiGet(`${base()}/${name === 'worker' ? 'status' : 'result'}`).then(
      (body) => ({ ok: true, body }),
      (error) => ({ ok: false, error: failureOf(error) }),
    ).then((answer) => {
      if (destroyed || members !== mine || mine[name] !== held) return;
      mine[name] = answer;
      if (name === 'worker') renderHead();
      if (selected === (name === 'worker' ? 'process' : 'result')) renderPanel();
    });
  }

  /** @param {'worker' | 'result'} name */
  function retryMember(name) {
    members[name] = null;
    renderPanel();
  }

  function renderResult() {
    ensureMember('result');
    const held = members.result;
    if (held.loading) return show('loading', loading('the result'));
    if (!held.ok) {
      if (held.error.status === 501) return show('not-in-core', h('p', {}, OLDER_CORE.result));
      return show('error', errorBox(held.error, 'the result', () => retryMember('result')));
    }
    const body = isObject(held.body) ? held.body : {};
    const ended = body.phase === 'ended';
    const withheld = Array.isArray(body.withheld) ? body.withheld : [];
    const verdict = !ended ? `Result: ${NOT_YET}` : body.resultOffered === true ? 'Result offered' : 'Result withheld';
    const face = !ended ? 'pending' : body.resultOffered === true ? 'check' : 'failed';
    const edit = isObject(body.isolation) || run.edit === true;
    /** The value of a field the end decides: "not recorded yet" before the end, then its words or `after`. @param {any} words @param {string} after */
    const endField = (words, after) => (!ended ? NOT_YET : words !== null && words !== undefined ? words : after);
    let check = null;
    if (edit && isObject(body.isolation)) {
      const reason = typeof body.isolation.reason === 'string' ? ISOLATION_REASONS[body.isolation.reason] : null;
      check = `${CHECK_WORDS[body.isolation.status] ?? body.isolation.status}${reason ? `: ${reason}` : ''}`;
    } else if (!edit && typeof body.readOnly === 'string') check = CHECK_WORDS[body.readOnly] ?? body.readOnly;
    const quota = isObject(body.quota) ? `signal ${body.quota.signal}, basis ${body.quota.basis}` : null;
    return show('ready', [
      h('p', {}, [icon(face, 16), ' ', h('strong', {}, verdict)]),
      ended && withheld.length > 0 ? h('ul', {}, withheld.map((/** @type {string} */ code) => h('li', { dataset: { code } }, WITHHELD_SENTENCES[code] ?? `Withheld: ${code}.`))) : null,
      h('dl', { class: 'facts' }, [
        fact('Ended', endField(ended && typeof body.endState === 'string' ? [`${END_WORDS[body.endState] ?? body.endState}`, body.endedAt ? [' at ', timeOr(body.endedAt, '')] : null] : null, 'not recorded')),
        fact('Report', endField(typeof body.reportStatus === 'string' ? REPORT_WORDS[body.reportStatus] ?? body.reportStatus : null, 'none recorded')),
        fact(edit ? 'Isolation check' : 'Read-only check', endField(check, 'not recorded')),
        fact('Quota stop', endField(quota, 'none')),
      ]),
    ]);
  }

  function renderProcess() {
    ensureMember('worker');
    const held = members.worker;
    if (held.loading) return show('loading', loading('the process status'));
    if (!held.ok) {
      if (held.error.status === 501) return show('not-in-core', h('p', {}, OLDER_CORE.process));
      return show('error', errorBox(held.error, 'the process status', () => retryMember('worker')));
    }
    if (!isObject(held.body)) return show('empty', h('p', {}, 'The core holds no status for this worker run.'));
    // Built field by field from IC-011's widened worker status: no pid, group number or process start exists in it.
    const body = held.body;
    const proc = isObject(body.process) ? body.process : null;
    const ended = ['exited', 'timed-out', 'cancelled'].includes(body.state) || run.phase === 'ended';
    let liveness = null;
    if (platform === 'win32' || proc?.leftover?.reason === 'win32' || body.reason === 'liveness-unknown') liveness = 'unknown';
    else if (body.state === 'running' || body.state === 'starting') liveness = 'process seen';
    else if (body.reason === 'supervisor-lost' || body.reason === 'process-lost') liveness = 'process not seen';
    let exit = ended ? 'not recorded' : NOT_YET;
    if (proc && proc.kind === 'exited') {
      const parts = [proc.code !== null ? `exit code ${proc.code}` : null, proc.signal !== null ? `signal ${proc.signal}` : null].filter(Boolean);
      exit = parts.length > 0 ? parts.join(', ') : 'exited, no code or signal recorded';
    } else if (proc && proc.kind === 'not-started') exit = `not started: ${proc.reason ?? 'no reason recorded'}`;
    const exited = proc !== null && proc.kind === 'exited';
    const group = exited ? GROUP_WORDS[/** @type {'true'} */ (String(proc.groupAlive))] ?? GROUP_WORDS.null : null;
    const leftover = exited ? (isObject(proc.leftover) ? `${LEFTOVER_WORDS[proc.leftover.status] ?? proc.leftover.status}${proc.leftover.reason ? ` (${proc.leftover.reason})` : ''}` : 'not recorded') : null;
    const cleanup = isObject(body.cleanup) ? `${LEFTOVER_WORDS[body.cleanup.status] ?? body.cleanup.status}${body.cleanup.reason ? ` (${body.cleanup.reason})` : ''}` : 'none recorded';
    const overdue = body.overdue === true ? 'yes, past the deadline' : body.overdue === false ? 'no' : null;
    return show('ready', [
      h('p', {}, h('strong', {}, STATE_WORDS[body.state] ?? body.state)),
      typeof body.reason === 'string' && REASON_SENTENCES[body.reason] ? h('p', {}, REASON_SENTENCES[body.reason]) : null,
      body.supervisorLost === true ? h('p', {}, SUPERVISOR_LOST) : null,
      platform === 'win32' || proc?.leftover?.reason === 'win32' ? h('p', {}, WIN32_SENTENCE) : null,
      h('dl', { class: 'facts' }, [
        liveness !== null ? fact('Liveness', liveness) : null,
        fact('Started', timeOr(body.startedAt, NOT_YET)),
        fact('Deadline', timeOr(body.deadline, 'none recorded')),
        overdue !== null ? fact('Overdue', overdue) : null,
        fact('Exit', exit),
        group !== null ? fact('Process group', group) : null,
        leftover !== null ? fact('Leftover', leftover) : null,
        fact('Cancel cleanup', cleanup),
      ]),
    ]);
  }

  function renderPanel() {
    if (destroyed) return;
    panel.setAttribute('aria-labelledby', `${idBase}-${selected}`);
    if (selected !== 'log') closeLog();
    if (selected === 'log') {
      if (log === null) openLog();
      else refreshLog();
    } else if (selected === 'transcript') renderTranscript();
    else if (selected === 'result') renderResult();
    else renderProcess();
  }

  /** @param {string} tab */
  function select(tab) {
    if (!TAB_IDS.includes(tab)) return;
    const changed = tab !== selected;
    selected = tab;
    tabs.forEach((button, i) => {
      const on = TAB_IDS[i] === tab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.setAttribute('tabindex', on ? '0' : '-1');
    });
    if (changed) renderPanel();
  }

  /** The person selected `tab`: select it, focus it and report it for the hash. @param {string} tab */
  function choose(tab) {
    const changed = tab !== selected;
    select(tab);
    tabs[TAB_IDS.indexOf(tab)].focus();
    if (changed) onTab(tab);
  }

  tablist.addEventListener('keydown', (/** @type {any} */ event) => {
    if (!isKey(event, 'move')) return;
    const at = TAB_IDS.indexOf(selected);
    const last = TAB_IDS.length - 1;
    /** @type {Record<string, number>} */
    const moves = { ArrowLeft: at === 0 ? last : at - 1, ArrowRight: at === last ? 0 : at + 1, Home: 0, End: last };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(TAB_IDS[next]);
  });
  tabs.forEach((button, i) => button.addEventListener('click', () => choose(TAB_IDS[i])));

  renderHead();
  tabs.forEach((button, i) => {
    button.setAttribute('aria-selected', TAB_IDS[i] === selected ? 'true' : 'false');
    button.setAttribute('tabindex', TAB_IDS[i] === selected ? '0' : '-1');
  });
  renderPanel();

  return {
    el: root,
    /** @param {{ run?: any, tab?: string, worker?: any, result?: any, stale?: boolean }} patch */
    update(patch) {
      if (destroyed || !isObject(patch)) return;
      if (isObject(patch.run) && RUN_ID.test(patch.run.runId)) {
        const other = patch.run.runId !== run.runId;
        const phaseChanged = patch.run.phase !== run.phase || patch.run.endState !== run.endState;
        run = patch.run;
        if (other) {
          closeLog();
          members = { worker: null, result: null };
        }
        renderHead();
        if (other) renderPanel();
        else if (selected === 'result' && (phaseChanged || !members.result?.body?.endedAt)) {
          ensureMember('result', true);
        } else if (selected === 'process' && (phaseChanged || !['exited', 'timed-out', 'cancelled'].includes(members.worker?.body?.state))) {
          ensureMember('worker', true);
        }
      }
      if (Object.hasOwn(patch, 'worker')) {
        const held = memberOf(patch.worker);
        if (held !== null) {
          members.worker = held;
          renderHead();
          if (selected === 'process') renderPanel();
        }
      }
      if (Object.hasOwn(patch, 'result')) {
        const held = memberOf(patch.result);
        if (held !== null) {
          members.result = held;
          if (selected === 'result') renderPanel();
        }
      }
      if (typeof patch.tab === 'string') select(patch.tab);
      if (Object.hasOwn(patch, 'stale')) {
        if (patch.stale === true) panel.dataset.stale = 'true';
        else delete panel.dataset.stale;
      }
    },
    /** Closes the log streams and removes the tabs; answers that arrive later are dropped. */
    destroy() {
      if (destroyed) return;
      closeLog();
      destroyed = true;
      root.remove();
    },
  };
}

export { mountWorkerTabs, TABS, LOG_NOTES, OLDER_CORE, WITHHELD_SENTENCES, MASKED_SENTENCE, WIN32_SENTENCE };
