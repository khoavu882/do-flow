// The Layers views (feature 161, design §8; FR-009, FR-010, AC-5): the machine page (`#/layers`: what waits for you across the
// projects, one row per project, what the page cannot see) and one project's page (`#/layers/<pk>`: a lane per checkout with its
// orchestrator, runs, workers, subagents and briefs, the coverage table and the sources that did not read). The inspector
// holds one agent's transcript (`#/layers/<pk>/agent/<ak>`, the `transcript:` lane) or one file's text (`#/layers/<pk>/file/<fk>`,
// the `file:` lane through log-store.js).
//
// Every byte on these pages came from `/api/live` frames: this module makes no GET and runs no poll (D3). `connectLayers` is the
// stream-only connector behind the shell's poller interface (the shell's pill, pause control and stream states read it); the
// designed states (connecting, following, stream down, refused, unsupported, core-lacks-channel) are drawn by `paintStream`.
//
// The views are `live: true`: the shell mounts the body once (`render`) and every later frame reaches `update`, which rebuilds
// a section only when its derived text changed (so a frame of another section writes nothing) and hands the focus back to the
// element with the same `data-focus-key`. A gate that arrived since the previous frame carries `data-fresh="true"` for the one
// fade the stylesheet plays; the awaiting glyph of the first card is the view's only loop (`data-loop="on"`). Every string from
// the Console is a text node (IC-007); the words follow derive/layers.js: "recorded", "started", "process seen", never a word that claims an
// agent is up right now. No path, session id or label other than the record's own reaches the page; files are addressed by their key.

import { h, mount, icon, announce } from '../dom.js';
import { reltime, clockTime } from '../states.js';
import { createPanel } from './transcript.js';
import { createLogStream } from '../log-store.js';
import { showPanel, hidePanel } from '../shell.js';
import { isChannel } from '../live.js';
import { actionArea, actionButton, notAllowedLine } from './confirm.js';
import { tailPane, createSessionControls } from './start.js';
import { buildConfirmation } from '../derive/actions.js';
import {
  nodeTitle, titleIsLabel, kindWord, stamp, streamState, streamCopy, machineModel, projectModel, summarizedLine, COVERAGE_COLUMNS, coverageCell, projectLabel, startedWords,
} from '../derive/layers.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MASKED_SENTENCE = 'Text is masked, best effort: DoFlow’s redactor can miss a secret that has no known shape.';

/** The word of a section code the core or the Console gave. @param {string | null} code */
const unreadableWord = (code) => `unreadable (${code ?? 'unknown'})`;

/** The face of each stream state's mark. @type {Readonly<Record<string, { token: string, face: string }>>} */
const STREAM_MARK = Object.freeze({
  connecting: { token: 'pending', face: 'pending' },
  following: { token: 'done', face: 'check' },
  down: { token: 'stale', face: 'stale' },
  refused: { token: 'failed', face: 'failed' },
  unsupported: { token: 'unknown', face: 'unknown' },
  'core-lacks-channel': { token: 'failed', face: 'failed' },
  paused: { token: 'unknown', face: 'pause' },
});

/** The run state badge (design-system 4): shape, word and tint together. @type {Readonly<Record<string, { token: string, face: string, word: string }>>} */
const RUN_BADGES = Object.freeze({
  RUNNING: { token: 'running', face: 'running', word: 'Running' },
  AWAITING_GATE: { token: 'awaiting', face: 'awaiting', word: 'Waiting for you' },
  COMPLETED: { token: 'done', face: 'check', word: 'Completed' },
  REJECTED: { token: 'rejected', face: 'rejected', word: 'Rejected' },
  CLOSED: { token: 'closed', face: 'skipped', word: 'Closed' },
});

/** The name of each session log the page reads. @type {Readonly<Record<string, string>>} */
const LOG_WORD = Object.freeze({ audit: 'audit', denials: 'denial', attention: 'ask' });

/** @param {string} token @param {string} face @param {string} word */
const badge = (token, face, word) => h('span', { class: 'badge', dataset: { state: token } }, [icon(face, 12), word]);
/** @param {any} gate the words of `gateWords` */
const gateFace = (gate) => (gate.token === 'done' ? 'check' : gate.token === 'skipped' ? 'skipped' : gate.token);

/** Sets a text only when it differs. @param {any} el @param {string} value */
function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

/** Runs `fn`, then hands the focus back to the element with the same `data-focus-key` if it was lost. @param {any} root @param {() => void} fn */
function keepFocus(root, fn) {
  const focused = document.activeElement;
  const owner = /** @type {any} */ (focused && typeof focused.closest === 'function' && root.contains(focused) ? focused.closest('[data-focus-key]') : null);
  const key = owner && owner.dataset ? owner.dataset.focusKey : null;
  fn();
  if (key && !root.contains(document.activeElement)) {
    const again = root.querySelector(`[data-focus-key="${key}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

/** @param {any[]} list */
const withSep = (list) => list.filter(Boolean).flatMap((item, index) => (index === 0 ? [item] : [h('span', { class: 'view-head__sep', 'aria-hidden': 'true' }, '·'), item]));

// ---- the connector --------------------------------------------------------------------------------------------------------

/**
 * `spec.connect` of both Layers views: the page's live store only, no GET, no poll. The channels are `machine` and, on a project
 * page, `layers:<pk>`; their members' bodies, the channel errors and the transport are folded into one data object
 * `{ rev, machine, layers, stream, lastFrameAt }` that the shell paints (`rev` makes every change a new body). The first data goes
 * out at once, so the view draws its own `connecting` state; the poller interface the shell reads (`mode`, `isStale`, ...)
 * answers from the stream (the stream-down state is drawn by the view, not by the shell's stale banner).
 * @param {any} local @param {any} params @param {{ onData: (body: any) => void, store: () => any }} hooks
 */
function connectLayers(local, params, { onData, store: getStore }) {
  const store = getStore();
  local.store = store;
  /** @type {Array<{ channel: string, member: 'machine' | 'layers' }>} */
  const parts = params.project ? [{ channel: `layers:${params.project}`, member: 'layers' }, { channel: 'machine', member: 'machine' }] : [{ channel: 'machine', member: 'machine' }];
  /** @type {Record<string, any>} */
  const held = { machine: null, layers: null };
  /** @type {Map<string, string | null>} */
  const errors = new Map(parts.map((part) => [part.channel, null]));
  let transport = { state: 'none', code: /** @type {string | null} */ (null) };
  let rev = 0;
  let running = false;
  let paused = false;
  /** @type {number | null} */
  let frameAt = null;
  /** @type {Array<() => void>} */
  let offs = [];
  let token = 'connecting';

  const hasData = () => parts.every((part) => held[part.member] !== null);
  function emit() {
    if (!running) return;
    const stream = streamState({ transport, errors: [...errors.values()], hasData: hasData() });
    token = stream.token;
    rev += 1;
    onData({ rev, machine: held.machine, layers: held.layers, stream, lastFrameAt: frameAt });
  }

  /** @param {{ channel: string, member: string }} part @param {{ kind: string, state: any, code: string | null }} event */
  function onEvent(part, event) {
    if (!running || !event) return;
    if (event.kind === 'state') {
      const member = event.state && typeof event.state === 'object' ? event.state[part.member] : undefined;
      if (member && member.status === 200 && member.body && typeof member.body === 'object') {
        held[part.member] = member.body;
        errors.set(part.channel, null);
        frameAt = Date.now();
      } else {
        const code = member && member.body && member.body.error && typeof member.body.error.code === 'string' ? member.body.error.code : 'no-member';
        errors.set(part.channel, code);
      }
    } else if (event.kind === 'error') errors.set(part.channel, event.code ?? 'unknown');
    else if (event.kind === 'gone') errors.set(part.channel, 'gone');
    else return; // a `reset` keeps what is held; the snapshot that follows replaces it
    emit();
  }

  return {
    start() {
      if (running) return;
      running = true;
      transport = { state: store.status().transport, code: null };
      offs.push(store.onTransport((/** @type {any} */ event) => {
        transport = { state: event.state, code: typeof event.code === 'string' ? event.code : null };
        emit();
      }));
      // A page whose channel the grammar refuses cannot stream: nothing is subscribed and the state says so.
      for (const part of parts) {
        if (isChannel(part.channel)) offs.push(store.subscribe(part.channel, (/** @type {any} */ event) => onEvent(part, event)));
        else errors.set(part.channel, 'core-lacks-channel');
      }
      emit();
    },
    stop() {
      if (!running) return;
      running = false;
      for (const off of offs) off();
      offs = [];
      if (paused) store.resume();
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      store.pause();
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      store.resume();
    },
    refreshNow: () => false,
    isStale: () => false,
    get mode() { return token === 'following' ? 'live' : token === 'connecting' ? 'connecting' : 'down'; },
    get intervalMs() { return 0; },
    get running() { return running; },
    get paused() { return paused; },
    get inFlight() { return false; },
    get misses() { return 0; },
    get lastSuccessAt() { return frameAt; },
    get lastFailure() { return null; },
    get nextAt() { return null; },
  };
}

// ---- the stream state -----------------------------------------------------------------------------------------------------------

/**
 * Draws the stream state: a full state panel while the page holds no record, one line above the records it keeps once it holds
 * some (`down`, `paused`), nothing while following. @param {any} local @param {any} data
 */
function paintStream(local, data) {
  const { token, code } = data.stream;
  const key = `${token}|${code ?? ''}|${data.lastFrameAt ?? ''}`;
  local.root.dataset.stream = token;
  if (local.streamKey === key) return;
  local.streamKey = key;
  const copy = streamCopy(data.stream);
  const mark = STREAM_MARK[token] ?? STREAM_MARK.down;
  const held = local.hasModel === true;
  if (copy === null) {
    mount(local.streamBox, []);
    return;
  }
  const since = data.lastFrameAt === null ? null : `Last record at ${clockTime(data.lastFrameAt)}.`;
  if (!held) {
    mount(local.streamBox, h('section', { class: 'state-panel', dataset: { kind: `stream-${token}` } }, [
      h('div', { class: 'state-panel__head' }, [icon(mark.face, 20), h('h2', { class: 'state-panel__title' }, copy.title)]),
      h('p', { class: 'state-panel__sentence' }, copy.sentence),
      code ? h('p', { class: 'code-chip' }, code) : null,
    ]));
    return;
  }
  mount(local.streamBox, h('p', { class: 'layers-banner', dataset: { kind: `stream-${token}`, state: mark.token } }, [
    badge(mark.token, mark.face, copy.title), ' ', copy.sentence, since ? ` ${since}` : null, code ? h('span', { class: 'code-chip' }, code) : null,
  ]));
}

// ---- pieces --------------------------------------------------------------------------------------------------------------------

/** One section: a heading and a body that the update rebuilds. @param {string} id @param {string} title @param {any} slot */
function section(id, title, slot) {
  return h('section', { class: 'layers-section', dataset: { section: id }, 'aria-labelledby': `layers-${id}-title` }, [h('h2', { class: 'layers-section__title', id: `layers-${id}-title` }, title), slot]);
}

/** A note that a source did not read. @param {string} name @param {string | null} code */
const unreadableNote = (name, code) => h('p', { class: 'layers-unreadable', dataset: { state: 'failed' } }, [badge('failed', 'failed', 'unreadable'), ` ${name}: ${unreadableWord(code)}. Nothing is claimed about it.`]);

/**
 * The "Waiting for you" card of one awaiting gate. `where`: the project's label and link on the machine page; the run link only
 * when the gate is in the project the Console runs in (the run pages read that project).
 * 162: Approve and Reject open the confirmation when the page may act (`/api/actions`), else the card says what it said before.
 * `ctx.latest()` is the gate as the newest update holds it (null once it was decided), so "Review again" never reads a stale card.
 * @param {any} gate @param {{ projectKey: string, projectLabel: string | null, openRun: boolean, fresh: boolean, loop: boolean, label: string | null, latest: () => any }} ctx
 */
function gateCard(gate, ctx) {
  const at = gate.recordAt ?? gate.at ?? null;
  const name = typeof gate.name === 'string' && gate.name !== '' ? gate.name : null;
  const slug = typeof gate.slug === 'string' ? gate.slug : null;
  return h('li', { class: 'gate-card', dataset: { kind: 'gate', key: `${ctx.projectKey}/${gate.taskId}/${gate.gateId}`, fresh: ctx.fresh ? 'true' : null, openable: ctx.openRun && slug !== null ? 'true' : 'false' } }, [
    h('div', { class: 'gate-card__head', 'aria-hidden': 'true' }, [
      h('span', { class: 'gate-card__glyph', dataset: { loop: ctx.loop ? 'on' : null } }, icon('gate-approval-12', 16)),
      h('span', { class: 'gate-card__kind' }, 'Gate'),
      h('span', { class: 'gate-card__wait' }, at ? [h('span', { class: 'gate-card__wait-word' }, 'waiting since '), reltime(at, Date.now())] : null),
    ]),
    h('div', { class: 'gate-card__body' }, [
      h('h3', { class: 'gate-card__name' }, name ?? h('span', { class: 'mono' }, gate.gateId)),
      h('div', { class: 'gate-card__run' }, [
        h('p', { class: 'gate-card__id' }, [
          ctx.projectLabel !== null ? h('a', { class: 'layers-link', href: `#/layers/${ctx.projectKey}`, dataset: { focusKey: `project:${ctx.projectKey}` } }, ctx.projectLabel) : null,
          slug !== null ? h('span', { class: 'run-row__slug' }, slug) : null,
          gate.taskId === slug ? null : h('span', { class: 'run-row__id' }, gate.taskId),
        ]),
        h('p', { class: 'gate-card__meta' }, [badge('awaiting', 'awaiting', 'Waiting for you'), name !== null ? [' ', h('span', { class: 'mono' }, gate.gateId)] : null]),
      ]),
      ctx.openRun && slug !== null
        ? h('a', { class: 'gate-card__link', href: `#/run/${slug}/${gate.taskId}`, dataset: { focusKey: `gate:${gate.taskId}/${gate.gateId}` } }, ['Open the run to decide', h('span', { 'aria-hidden': 'true' }, ' →')])
        : null,
      actionArea(() => {
        const make = (/** @type {'approve' | 'reject'} */ decision) => () => gateSpec(ctx.latest(), ctx, decision);
        const approve = actionButton({ id: 'decide-gate', label: 'Approve', tone: 'approve', make: make('approve') });
        const reject = actionButton({ id: 'decide-gate', label: 'Reject', tone: 'danger', make: make('reject') });
        if (approve || reject) return h('div', { class: 'acts__row' }, [approve, reject]);
        return [notAllowedLine(['decide-gate']), ctx.openRun && slug !== null ? null : h('p', { class: 'gate-card__note' }, 'Decide in a terminal in that project. Deciding from this page needs the Console on this machine or a paired control device.')];
      }, 'acts acts--card'),
    ]),
  ]);
}

/**
 * The confirmation of a gate card, from the gate as the newest update holds it. Null when the gate is gone, or the page lacks what the
 * request carries (the run revision: an older core sends none).
 * @param {any} gate @param {{ projectKey: string, label: string | null }} ctx @param {'approve' | 'reject'} decision
 */
function gateSpec(gate, ctx, decision) {
  if (!gate) return null;
  return buildConfirmation('decide-gate', {
    projectKey: ctx.projectKey, project: ctx.label, slug: typeof gate.slug === 'string' ? gate.slug : null, taskId: gate.taskId,
    gate: { id: gate.gateId, name: gate.name }, decision, revision: gate.revision,
  });
}

/**
 * @param {any[]} gates @param {Set<string>} fresh @param {(gate: any) => { projectKey: string, projectLabel: string | null, openRun: boolean, label?: string | null }} where
 * @param {(key: string) => any} latest the gate of a card key as the newest update holds it
 */
function gateCards(gates, fresh, where, latest) {
  let loop = true;
  return h('ul', { class: 'gate-cards' }, gates.map((gate) => {
    const w = where(gate);
    const key = `${w.projectKey}/${gate.taskId}/${gate.gateId}`;
    const card = gateCard(gate, { ...w, label: w.label ?? w.projectLabel, fresh: fresh.has(key), loop, latest: () => latest(key) });
    loop = false;
    return card;
  }));
}

// ---- the machine page ----------------------------------------------------------------------------------------------------

/** @param {any} row @param {number} now */
function projectRow(row, now) {
  const counts = row.summarized
    ? withSep([
      row.runs.awaiting > 0 ? h('span', { class: 'lrow__wait' }, [badge('awaiting', 'awaiting', `${row.runs.awaiting} waiting for you`)]) : null,
      plural(row.runs.open, 'open run'), plural(row.workers.open, 'open worker run'), `${row.sessions.observed} ${row.sessions.observed === 1 ? 'session' : 'sessions'} recorded`,
    ])
    : [h('span', { class: 'lrow__none' }, 'Not summarized on this page')];
  return h('li', { class: 'lrow', dataset: { kind: 'project', key: row.projectKey, current: row.current ? 'true' : 'false' } }, [
    h('div', { class: 'lrow__name' }, [
      h('a', { class: 'lrow__link layers-link', href: `#/layers/${row.projectKey}`, dataset: { focusKey: `project:${row.projectKey}` } }, row.label),
      row.current ? h('span', { class: 'tag tag--accent' }, 'this project') : null,
      row.temp ? h('span', { class: 'tag' }, 'temp') : null,
      h('span', { class: 'lrow__co' }, plural(row.checkouts, 'checkout')),
    ]),
    h('div', { class: 'lrow__facts' }, counts),
    row.unreadable.length > 0
      ? h('div', { class: 'lrow__unread' }, [badge('failed', 'failed', 'unreadable'), ` ${row.unreadable.join(', ')}`])
      : null,
    h('div', { class: 'lrow__last' }, row.lastRecordAt ? ['last record ', reltime(row.lastRecordAt, now)] : h('span', { class: 'lrow__none' }, 'no record time')),
  ]);
}

/** The foot of the machine page. @param {any} model */
function machineFoot(model) {
  const f = model.foot;
  const line = summarizedLine(f);
  const ex = f.excluded;
  const excluded = ex ? [`${ex.missing} not found`, `${ex.temp} in a test scratch folder`, `${ex.notDoflow} without DoFlow state`, `${ex.unreadable} unreadable`] : [];
  return h('div', { class: 'layers-foot' }, [
    line ? h('p', { class: 'layers-foot__line' }, line) : null,
    excluded.length > 0 ? h('p', { class: 'layers-foot__line' }, `Not listed: ${excluded.join(', ')}.`) : null,
    f.truncated ? h('p', { class: 'layers-foot__line' }, 'The project list was cut at its bound.') : null,
    h('p', { class: 'layers-foot__line', dataset: { state: 'unknown' } }, [badge('unknown', 'unknown', 'not observed'), ` ${f.notObserved.replace(/^Not observed: /, '')}`]),
  ]);
}

/** @param {any} data @param {any} params @param {any} local */
function renderMachine(data, params, local) {
  local.params = params;
  local.sigs = {};
  local.seen = null;
  local.streamKey = null;
  local.hasModel = false;
  local.streamBox = h('div', { class: 'layers-stream' });
  local.slots = { lead: h('div', {}), projects: h('div', {}), foot: h('div', {}) };
  local.sections = h('div', { class: 'layers-sections', hidden: true }, [
    section('lead', 'Waiting for you', local.slots.lead),
    section('projects', 'Projects', local.slots.projects),
    local.slots.foot,
  ]);
  local.root = h('div', { class: 'layers layers--machine', dataset: { page: 'machine', stream: data.stream.token } }, [local.streamBox, local.sections]);
  updateMachine(local, data, params);
  return local.root;
}

/** @param {any} local @param {any} data @param {any} params */
function updateMachine(local, data, params) {
  local.params = params;
  const now = Date.now();
  const model = machineModel(data.machine);
  local.hasModel = model.present;
  local.model = model;
  paintStream(local, data);
  if ((local.sections.getAttribute('hidden') !== null) === model.present) {
    if (model.present) local.sections.removeAttribute('hidden');
    else local.sections.setAttribute('hidden', '');
  }
  if (!model.present) return;
  const keys = model.gates.map((/** @type {any} */ g) => `${g.projectKey}/${g.taskId}/${g.gateId}`);
  const first = local.seen === null;
  const fresh = new Set(first ? [] : keys.filter((/** @type {any} */ key) => !local.seen.has(key)));
  const arrived = model.gates.filter((/** @type {any} */ g) => fresh.has(`${g.projectKey}/${g.taskId}/${g.gateId}`));
  local.seen = new Set(keys);

  const current = new Set(model.rows.filter((r) => r.current).map((r) => r.projectKey));
  const held = new Map(model.gates.map((/** @type {any} */ g) => [`${g.projectKey}/${g.taskId}/${g.gateId}`, g]));
  local.heldGates = held;
  setSection(local, 'lead', JSON.stringify([model.activitySection, model.gates.map((/** @type {any} */ g) => [g.projectKey, g.taskId, g.gateId, g.name, g.slug, g.recordAt, g.revision ?? null]), [...fresh]]), () => {
    if (model.activitySection.state === 'unreadable') return unreadableNote('gates of every project', model.activitySection.code);
    if (model.activitySection.state === 'absent') return h('p', { class: 'layers-none' }, 'The activity of the projects has not arrived yet.');
    if (model.gates.length === 0) return h('p', { class: 'layers-none' }, 'Nothing is waiting for you in the projects summarized here.');
    return gateCards(model.gates, fresh, (g) => ({ projectKey: g.projectKey, projectLabel: g.projectLabel, openRun: current.has(g.projectKey) }), (key) => local.heldGates.get(key) ?? null);
  });
  setSection(local, 'projects', JSON.stringify([model.projectsSection, model.rows]), () => {
    if (model.projectsSection.state === 'unreadable') return unreadableNote('the project list', model.projectsSection.code);
    if (model.store === 'absent') return h('p', { class: 'layers-none' }, 'This machine has no DoFlow user state, so no project list can be read.');
    if (model.rows.length === 0) return h('p', { class: 'layers-none' }, 'No DoFlow project on this machine yet. A project appears here once DoFlow writes state in it or a hooked session starts there.');
    return h('ul', { class: 'project-list' }, model.rows.map((row) => projectRow(row, now)));
  });
  setSection(local, 'foot', JSON.stringify(model.foot), () => machineFoot(model));
  if (arrived.length === 1) announce(`A gate is waiting for you: ${arrived[0].name ?? arrived[0].gateId} in ${arrived[0].projectLabel ?? 'a project'}.`);
  else if (arrived.length > 1) announce(`${arrived.length} gates are waiting for you.`);
}

/** Rebuilds a section's slot when its signature changed. @param {any} local @param {string} name @param {string} sig @param {() => any} build */
function setSection(local, name, sig, build) {
  if (local.sigs[name] === sig) return;
  local.sigs[name] = sig;
  keepFocus(local.root, () => mount(local.slots[name], build()));
}

/** @param {any} params @param {any} data */
function machineMeta(params, data) {
  if (!data || !data.machine) return null;
  const model = machineModel(data.machine);
  const line = summarizedLine(model.foot);
  const waiting = model.gates.length;
  return h('p', { class: 'view-head__meta' }, withSep([waiting > 0 ? `${plural(waiting, 'gate')} waiting for you` : 'nothing waiting for you', line, model.store === 'absent' ? 'no DoFlow user state' : null]));
}

// ---- the project page ----------------------------------------------------------------------------------------------------

/** One agent row of a lane. @param {any} agent @param {string} pk @param {string | null} selected @param {number} now */
function agentRow(agent, pk, selected, now) {
  // 165: a started session says who started it, its phase and whether the harness's own session was seen; it has no transcript to state about.
  const started = agent.kind === 'started-session';
  const transcript = agent.linked ? 'transcript linked' : `transcript not observed: ${agent.reason ? agent.reason.replace(/-/g, ' ') : 'no record of one'}`;
  const words = withSep([
    started ? agent.phase : null,
    started ? agent.observed : null,
    agent.audit ? `${agent.audit.word}${agent.audit.at ? ` ${stamp(agent.audit.at, now)}` : ''}` : null,
    started ? null : agent.process,
    agent.lastRecordAt ? ['recorded ', reltime(agent.lastRecordAt, now)] : 'no record time',
    started && !agent.linked ? null : transcript,
    agent.eventsPerMin !== null && agent.eventsPerMin !== undefined ? `${agent.eventsPerMin} events/min` : null,
    agent.toolCalls !== null && agent.toolCalls !== undefined ? plural(agent.toolCalls, 'tool call') : null,
  ]);
  return h('li', { class: 'lrow lrow--agent', dataset: { kind: 'agent', key: agent.agentKey, selected: selected === agent.agentKey ? 'true' : 'false' } }, [
    h('div', { class: 'lrow__name' }, [
      h('a', { class: 'lrow__link layers-link', href: `#/layers/${pk}/agent/${agent.agentKey}`, 'aria-current': selected === agent.agentKey ? 'true' : null, dataset: { focusKey: `agent:${agent.agentKey}` } }, nodeTitle(agent)),
      agent.harness ? h('span', { class: 'tag tag--mono' }, agent.harness) : null,
      started ? h('span', { class: 'tag tag--accent', dataset: { startedBy: 'true' } }, agent.startedBy) : null,
      !started && titleIsLabel(agent) ? h('span', { class: 'tag' }, kindWord(agent)) : null,
      started && titleIsLabel(agent) ? h('span', { class: 'tag' }, kindWord(agent)) : null,
      agent.model ? h('span', { class: 'model-chip' }, agent.model) : h('span', { class: 'lrow__none' }, 'model not recorded'),
    ]),
    h('div', { class: 'lrow__facts' }, words),
  ]);
}

/** One run row of a lane. @param {any} run @param {number} now */
function runRow(run, now) {
  const b = RUN_BADGES[run.state] ?? { token: 'unknown', face: 'unknown', word: String(run.state) };
  const stage = run.current ? `${run.current.type} ${run.current.id}${run.skill ? ` · ${run.skill}` : ''}` : null;
  return h('li', { class: 'lrow lrow--run', dataset: { kind: 'run', key: run.runKey ?? run.taskId } }, [
    h('div', { class: 'lrow__name' }, [
      h('span', { class: 'lrow__id mono' }, run.taskId),
      run.featureSlug ? h('span', { class: 'run-row__slug' }, run.featureSlug) : null,
      h('span', { class: 'tag' }, run.workflowName ?? run.taskClass),
      badge(b.token, b.face, b.word),
      run.review ? badge(run.review.token, run.review.token === 'done' ? 'check' : run.review.token === 'unknown' ? 'unknown' : run.review.token, `review: ${run.review.words.join(', ')}`) : null,
    ]),
    h('div', { class: 'lrow__facts' }, withSep([
      stage,
      run.progress && run.progress.total > 0 ? `step ${run.progress.done} of ${run.progress.total}` : null,
      run.updatedAt ? ['updated ', reltime(run.updatedAt, now)] : null,
    ])),
    run.gates.length > 0
      ? h('ul', { class: 'lrow__gates' }, run.gates.map((/** @type {any} */ g) => h('li', { class: 'gate-chip', dataset: { state: g.token } }, [badge(g.token, gateFace(g), g.word), ' ', h('span', { class: 'mono' }, g.name || g.gateId)])))
      : null,
  ]);
}

/** One brief or hand-back row. @param {any} file @param {string} pk @param {string | null} selected @param {number} now */
function fileRow(file, pk, selected, now) {
  return h('li', { class: 'lrow lrow--file', dataset: { kind: 'file', key: file.fileKey, selected: selected === file.fileKey ? 'true' : 'false' } }, [
    h('div', { class: 'lrow__name' }, [
      h('a', { class: 'lrow__link layers-link', href: `#/layers/${pk}/file/${file.fileKey}`, 'aria-current': selected === file.fileKey ? 'true' : null, dataset: { focusKey: `file:${file.fileKey}` } }, file.kindWord),
      file.task ? h('span', { class: 'tag tag--mono' }, file.task) : null,
      file.feature ? h('span', { class: 'run-row__slug' }, file.feature) : null,
    ]),
    h('div', { class: 'lrow__facts' }, withSep([`${file.bytes} B`, ['at ', reltime(file.at, now)]])),
  ]);
}

/** A group of rows with its small heading, or nothing when empty. @param {string} title @param {any[]} rows */
const group = (title, rows) => (rows.length === 0 ? null : h('div', { class: 'lane__group' }, [h('h3', { class: 'lane__title' }, title), h('ul', { class: 'lane__rows' }, rows)]));

/** @param {any} lane @param {string} pk @param {any} sel @param {number} now */
function laneBox(lane, pk, sel, now) {
  const agent = sel.kind === 'agent' ? sel.key : null;
  const file = sel.kind === 'file' ? sel.key : null;
  const empty = lane.orchestrator.length + lane.runs.length + lane.workers.length + lane.subagents.length + lane.briefs.length === 0;
  return h('section', { class: 'lane', dataset: { key: lane.worktreeKey, main: lane.main ? 'true' : 'false' }, 'aria-label': `Checkout ${lane.label}` }, [
    h('div', { class: 'lane__head' }, [
      h('h3', { class: 'lane__name mono' }, lane.label),
      lane.main ? h('span', { class: 'tag tag--accent' }, 'main checkout') : null,
      lane.branch ? h('span', { class: 'tag tag--mono' }, lane.branch) : h('span', { class: 'lrow__none' }, 'no branch recorded'),
    ]),
    empty ? h('p', { class: 'layers-none' }, 'Nothing is recorded in this checkout yet.') : null,
    group('Orchestrator', lane.orchestrator.map((/** @type {any} */ a) => agentRow(a, pk, agent, now))),
    group('Runs', lane.runs.map((/** @type {any} */ r) => runRow(r, now))),
    group('Worker runs', lane.workers.map((/** @type {any} */ a) => agentRow(a, pk, agent, now))),
    group('Subagents', lane.subagents.map((/** @type {any} */ a) => agentRow(a, pk, agent, now))),
    group('Briefs and hand-backs', lane.briefs.map((/** @type {any} */ f) => fileRow(f, pk, file, now))),
  ]);
}

/** @param {any} model */
function coverageTable(model) {
  if (model.sections.coverage.state === 'unreadable') return unreadableNote('the coverage of each harness', model.sections.coverage.code);
  if (model.coverage.length === 0) return h('p', { class: 'layers-none' }, 'No harness has recorded anything in this project yet.');
  return h('table', { class: 'ttable layers-coverage' }, [
    h('caption', { class: 'vh' }, 'What each harness records for this project'),
    h('thead', {}, h('tr', {}, [h('th', { scope: 'col' }, 'Harness'), ...COVERAGE_COLUMNS.map(([, word]) => h('th', { scope: 'col' }, word))])),
    h('tbody', {}, model.coverage.map((/** @type {any} */ row) => h('tr', {}, [
      h('th', { scope: 'row', class: 'mono' }, row.harness),
      ...COVERAGE_COLUMNS.map(([column, word]) => {
        const cell = coverageCell(column, row[column]);
        return h('td', { dataset: { label: word, state: cell.observed ? 'done' : 'unknown' } }, cell.observed
          ? badge('done', 'check', cell.word)
          : [badge('unknown', 'unknown', cell.word), ' ', h('span', { class: 'ttable__n' }, cell.reason)]);
      }),
    ]))),
  ]);
}

/** @param {any} model @param {string} pk @param {number} now */
function looseBox(model, pk, now) {
  const loose = model.loose;
  const audit = model.auditOnly;
  if (loose.runs.length + loose.agents.length + audit.length === 0) return null;
  return h('section', { class: 'lane lane--loose', 'aria-label': 'Not placed in a checkout' }, [
    h('div', { class: 'lane__head' }, [h('h3', { class: 'lane__name' }, 'Not placed in a checkout')]),
    h('p', { class: 'layers-note' }, 'These records name no checkout the list above holds. They are shown as recorded and joined to nothing.'),
    group('Runs without an exact key', loose.runs.map((/** @type {any} */ r) => runRow(r, now))),
    group('Agents', loose.agents.map((/** @type {any} */ a) => agentRow(a, pk, null, now))),
    group('Audit lines that name no agent', audit.map((/** @type {any} */ line) => h('li', { class: 'lrow' }, [
      h('div', { class: 'lrow__name' }, [h('span', {}, line.event === 'SubagentStart' ? 'started' : line.event === 'SubagentStop' ? 'stopped' : 'recorded'), line.agentType ? h('span', { class: 'tag tag--mono' }, line.agentType) : null, line.harness ? h('span', { class: 'tag' }, line.harness) : null]),
      h('div', { class: 'lrow__facts' }, line.at ? ['at ', reltime(line.at, now)] : 'no time'),
    ]))),
  ]);
}

/** @param {any} data @param {any} params @param {any} local */
function renderProject(data, params, local) {
  local.params = params;
  local.sigs = {};
  local.seen = null;
  local.streamKey = null;
  local.hasModel = false;
  local.selKey = null;
  local.streamBox = h('div', { class: 'layers-stream' });
  local.slots = { lead: h('div', {}), lanes: h('div', { class: 'layers-lanes' }), coverage: h('div', {}), withheld: h('div', {}) };
  local.sections = h('div', { class: 'layers-sections', hidden: true }, [
    section('lead', 'Waiting for you', local.slots.lead),
    section('lanes', 'Checkouts', local.slots.lanes),
    section('coverage', 'What each harness records', local.slots.coverage),
    local.slots.withheld,
  ]);
  local.root = h('div', { class: 'layers layers--project', dataset: { page: 'project', stream: data.stream.token } }, [local.streamBox, local.sections]);
  updateProject(local, data, params);
  return local.root;
}

/** The selection a route names: `{ kind: 'agent' | 'file' | null, key }`. @param {any} params */
const selectionOf = (params) => (params.agent ? { kind: 'agent', key: params.agent } : params.file ? { kind: 'file', key: params.file } : { kind: null, key: null });

/** @param {any} local @param {any} data @param {any} params */
function updateProject(local, data, params) {
  local.params = params;
  const now = Date.now();
  const pk = params.project;
  const model = projectModel(data.layers);
  const who = projectLabel(data.machine, pk);
  local.hasModel = model.present;
  local.model = model;
  local.who = who;
  paintStream(local, data);
  if ((local.sections.getAttribute('hidden') !== null) === model.present) {
    if (model.present) local.sections.removeAttribute('hidden');
    else local.sections.setAttribute('hidden', '');
  }
  setHead(local, who);
  if (!model.present) {
    syncInspector(local, data, params);
    return;
  }
  const sel = selectionOf(params);
  const keys = model.waiting.map((g) => `${pk}/${g.taskId}/${g.gateId}`);
  const first = local.seen === null;
  const fresh = new Set(first ? [] : keys.filter((key) => !local.seen.has(key)));
  const arrived = model.waiting.filter((g) => fresh.has(`${pk}/${g.taskId}/${g.gateId}`));
  local.seen = new Set(keys);

  local.heldGates = new Map(model.waiting.map((g) => [`${pk}/${g.taskId}/${g.gateId}`, g]));
  setSection(local, 'lead', JSON.stringify([model.sections.gates, model.sections.sessions, model.waiting.map((g) => [g.taskId, g.gateId, g.name, g.slug, g.at, g.revision ?? null]), model.asks, model.asksUnobserved, who.current, [...fresh], who.label]), () => {
    const gatesRead = model.sections.gates.state !== 'unreadable';
    const sessionsRead = model.sections.sessions.state !== 'unreadable';
    // 180 IC-180-D4: a session's open ask, in the words of its kind and tool, with its time; a harness that records none is not observed.
    const none = gatesRead && sessionsRead && model.waiting.length === 0 && model.asks.length === 0;
    return h('div', { class: 'lane__group' }, [
      gatesRead ? null : unreadableNote('the gates', model.sections.gates.code),
      sessionsRead ? null : unreadableNote('the sessions', model.sections.sessions.code),
      none ? h('p', { class: 'layers-none' }, model.asksUnobserved.length > 0 ? 'Nothing recorded is waiting for you in this project.' : 'Nothing is waiting for you in this project.') : null,
      model.waiting.length > 0 ? gateCards(model.waiting, fresh, () => ({ projectKey: pk, projectLabel: null, openRun: who.current, label: who.label }), (key) => local.heldGates.get(key) ?? null) : null,
      group('Sessions', model.asks.map((/** @type {any} */ ask) => h('li', { class: 'lrow', dataset: { kind: 'ask', key: ask.sessionKey } }, [
        h('div', { class: 'lrow__name' }, [badge('awaiting', 'awaiting', ask.word), h('span', { class: 'tag tag--mono' }, ask.harness)]),
        h('div', { class: 'lrow__facts' }, ['since ', reltime(ask.at, now)]),
      ]))),
      ...model.asksUnobserved.map((/** @type {any} */ u) => h('p', { class: 'layers-foot__line', dataset: { state: 'unknown' } }, [badge('unknown', 'unknown', 'not observed'), ` whether ${u.harness} sessions ask you something: ${u.reason}`])),
    ]);
  });
  setSection(local, 'lanes', JSON.stringify([model.sections, model.lanes, model.loose, model.auditOnly, sel]), () => {
    const failed = ['checkouts', 'tree', 'runs', 'artifacts'].filter((name) => model.sections[/** @type {'tree'} */ (name)].state === 'unreadable');
    return [
      ...failed.map((name) => unreadableNote(name, model.sections[/** @type {'tree'} */ (name)].code)),
      model.sections.checkouts.state === 'ok' && model.lanes.length === 0 ? h('p', { class: 'layers-none' }, 'DoFlow has no checkout of this project on record.') : null,
      ...model.lanes.map((lane) => laneBox(lane, pk, sel, now)),
      looseBox(model, pk, now),
      model.notChecked > 0 ? h('p', { class: 'layers-note' }, `${model.notChecked} agents not checked (the page reads a bounded number of nodes and process checks).`) : null,
    ];
  });
  setSection(local, 'coverage', JSON.stringify([model.sections.coverage, model.coverage]), () => coverageTable(model));
  const rest = model.withheld.filter((w) => !['checkouts', 'tree', 'runs', 'artifacts', 'gates', 'sessions', 'coverage'].includes(w.section));
  // 161 review C: an audit or denial log that exists but could not be read is said so, never left out as quiet.
  const unreadLogs = model.unreadLogs;
  setSection(local, 'withheld', JSON.stringify([rest, unreadLogs]), () => (rest.length + unreadLogs.length === 0 ? null : h('div', { class: 'layers-foot' }, [
    ...rest.map((w) => unreadableNote(w.section, w.code)),
    ...unreadLogs.map((u) => h('p', { class: 'layers-unreadable', dataset: { state: 'failed' } }, [badge('failed', 'failed', 'unreadable'), ` The ${LOG_WORD[u.log] ?? u.log} log of a ${u.harness} session: not read. Nothing is claimed about it.`])),
  ])));
  if (arrived.length === 1) announce(`A gate is waiting for you: ${arrived[0].name ?? arrived[0].gateId}.`);
  else if (arrived.length > 1) announce(`${arrived.length} gates are waiting for you.`);
  syncInspector(local, data, params);
}

/** The head's label and tags follow the machine member. @param {any} local @param {any} who */
function setHead(local, who) {
  setText(document.querySelector('.layers-title__label'), who.label);
  setText(document.querySelector('.layers-crumb__label'), who.label);
  const tag = /** @type {any} */ (document.querySelector('.layers-title__tag'));
  if (tag) {
    const marks = [who.current ? 'this project' : null, who.temp ? 'temp' : null].filter(Boolean).join('|');
    if (tag.dataset.marks !== marks) {
      tag.dataset.marks = marks;
      mount(tag, [who.current ? h('span', { class: 'tag tag--accent' }, 'this project') : null, who.temp ? h('span', { class: 'tag' }, 'temp') : null]);
    }
  }
}

/** The head of a project: crumb, the label in mono and the meta line. @param {any} params */
function buildProjectHead(params) {
  const agentCrumb = h('span', { class: 'layers-crumb__agent' });
  const crumb = h('nav', { class: 'run-head__crumb layers-crumb', 'aria-label': 'Breadcrumb' }, [
    h('a', { href: '#/layers' }, 'Layers'), h('span', { 'aria-hidden': 'true' }, ' / '), h('a', { class: 'layers-crumb__label mono', href: `#/layers/${params.project}` }, 'Project'),
    h('span', { class: 'layers-crumb__sep', 'aria-hidden': 'true' }, ' / '), agentCrumb,
  ]);
  const h1 = h('h1', { class: 'view-title mono layers-title', tabindex: '-1' }, [h('span', { class: 'layers-title__label' }, 'Project'), h('span', { class: 'layers-title__tag' })]);
  const meta = h('div', { class: 'view-head__metawrap' });
  return { root: h('header', { class: 'view-head layers-head' }, [crumb, h1, meta]), h1, meta, step: null };
}

/** @param {any} params @param {any} data @param {number} now */
function projectMeta(params, data, now) {
  if (!data || !data.layers) return null;
  const model = projectModel(data.layers);
  const nodes = model.nodes.size;
  const waiting = model.waiting.length;
  return h('p', { class: 'view-head__meta' }, withSep([
    plural(model.lanes.length, 'checkout'),
    model.sections.tree.state === 'ok' ? plural(nodes, 'agent') : null,
    waiting > 0 ? `${plural(waiting, 'gate')} waiting for you` : null,
    model.notChecked > 0 ? `${model.notChecked} not checked` : null,
  ]));
}

/** @param {any} params @param {any} data */
function projectTitle(params, data) {
  const who = projectLabel(data ? data.machine : null, params.project);
  const model = data && data.layers ? projectModel(data.layers) : null;
  const node = params.agent && model ? model.nodes.get(params.agent) : null;
  return node ? `${nodeTitle(node)} · ${who.label} · Layers` : `${who.label} · Layers`;
}

// ---- the inspector ---------------------------------------------------------------------------------------------------------------

/** The file pane: the held text of a `file:` lane as text nodes, with its notes. */
function filePane() {
  const notes = h('div', { class: 'layers-inspect__notes' });
  const pre = h('pre', { class: 'logpane__text', tabindex: '0', hidden: true });
  const title = h('h2', { class: 'fpanel__title', id: 'layers-file-title', tabindex: '-1' }, 'File');
  const el = h('section', { class: 'logpane layers-inspect', 'aria-labelledby': 'layers-file-title', dataset: { stream: 'file', state: 'loading' } }, [title, h('p', { class: 'logpane__note' }, MASKED_SENTENCE), notes, pre]);
  const shown = { ino: /** @type {string | null} */ (null), from: -1, count: 0, lastAt: -1 };
  return {
    el,
    title,
    /** @param {any} state @param {{ kind: string, word: string } | null} file */
    render(state, file) {
      const mode = state.mode;
      const lines = [];
      if (state.error && state.error.code) lines.push(`The stream is down (code ${state.error.code}). The text below is what was last received.`);
      else if (mode === 'down') lines.push('The stream is down. The text below is what was last received.');
      if (state.log === 'none') lines.push('This file is empty.');
      else if (state.log === 'gone') lines.push('This file is no longer there.');
      else if (state.pieces.length === 0 && mode !== 'down') lines.push('Waiting for the first text of this file.');
      if (state.notices.includes('reset')) lines.push('The file was replaced; showing its newest text.');
      if (state.notices.includes('withheld')) lines.push('A line too long to show after masking was left out.');
      mount(notes, lines.map((line) => h('p', { class: 'logpane__note' }, line)));
      setText(title, file ? file.word : 'File');
      el.dataset.state = state.pieces.length > 0 ? 'ready' : mode === 'down' ? 'error' : 'loading';
      const same = state.ino !== null && state.ino === shown.ino && state.from === shown.from && state.pieces.length >= shown.count && (shown.count === 0 || state.pieces[shown.count - 1].at === shown.lastAt);
      const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 48 || !(pre.scrollHeight > 0);
      if (!same) {
        pre.replaceChildren();
        shown.count = 0;
      }
      for (let i = shown.count; i < state.pieces.length; i += 1) pre.append(document.createTextNode((i > 0 && state.pieces[i - 1].cut !== true ? '\n' : '') + state.pieces[i].text));
      shown.ino = state.ino;
      shown.from = state.from;
      shown.count = state.pieces.length;
      shown.lastAt = state.pieces.length > 0 ? state.pieces[state.pieces.length - 1].at : -1;
      if (state.pieces.length > 0) pre.removeAttribute('hidden');
      else pre.setAttribute('hidden', '');
      if (near) pre.scrollTop = pre.scrollHeight;
    },
  };
}

/** Closes the lane the inspector follows. @param {any} local */
function closeLane(local) {
  if (local.laneOff) local.laneOff();
  local.laneOff = null;
  if (local.fileStream) local.fileStream.close();
  local.fileStream = null;
  // 165: the two output lanes of a started session.
  for (const stream of local.startedStreams ?? []) stream.close();
  local.startedStreams = [];
  local.startedPane = null;
  local.laneKey = null;
}

/** The route of the project without its selection. @param {any} local */
const backHash = (local) => `#/layers/${local.params.project}`;

/**
 * Makes the inspector follow the route's selection: an agent opens its panel and the `transcript:` lane, a file its pane and the
 * `file:` lane; no selection closes both. A frame of the page changes nothing here unless the selection or the node did.
 * @param {any} local @param {any} data @param {any} params
 */
function syncInspector(local, data, params) {
  const sel = selectionOf(params);
  const pk = params.project;
  const model = local.model;
  const node = sel.kind === 'agent' && model ? model.nodes.get(sel.key) ?? null : null;
  const file = sel.kind === 'file' && model ? model.files.get(sel.key) ?? null : null;
  const present = sel.kind === null ? 'none' : sel.kind === 'agent' ? (node ? 'node' : model && model.sections.tree.state === 'ok' ? 'gone' : 'wait') : (file ? 'node' : model && model.sections.artifacts.state === 'ok' ? 'gone' : 'wait');
  const key = `${sel.kind}|${sel.key}|${present}`;
  if (local.selKey === key) {
    if (sel.kind === 'agent' && node && node.kind === 'started-session' && local.startedPane) {
      const sig = startedSig(local, node);
      if (local.nodeSig !== sig) {
        local.nodeSig = sig;
        local.startedPane.update(node);
      }
    } else if (sel.kind === 'agent' && node && local.panel) {
      const sig = JSON.stringify(node);
      if (local.nodeSig !== sig) {
        local.nodeSig = sig;
        local.panel.state.node = node;
        local.panel.refresh();
      }
    }
    return;
  }
  local.selKey = key;
  closeLane(local);
  const crumb = /** @type {any} */ (document.querySelector('.layers-crumb'));
  const agentCrumb = document.querySelector('.layers-crumb__agent');
  if (crumb) crumb.dataset.agent = sel.kind === 'agent' && node ? 'true' : 'false';
  setText(agentCrumb, node ? nodeTitle(node) : '');
  if (sel.kind === null) {
    hidePanel(local.inspector, local);
    return;
  }
  const close = () => {
    if (local.params.agent || local.params.file) globalThis.location.hash = backHash(local);
  };
  if (present === 'wait') return; // the records the selection names have not arrived: nothing to open yet
  if (present === 'gone') {
    showPanel(local.inspector, local, {
      title: sel.kind === 'agent' ? 'Agent transcript' : 'File',
      body: h('div', { class: 'fpanel__empty' }, [
        h('p', {}, sel.kind === 'agent' ? 'This agent is no longer in this project’s records.' : 'This file is no longer in this project’s records.'),
        h('a', { class: 'btn btn--secondary', href: backHash(local) }, 'Back to the project'),
      ]),
      onClose: close,
    });
    return;
  }
  if (sel.kind === 'agent' && node.kind === 'started-session') openStarted(local, pk, node, close);
  else if (sel.kind === 'agent') openAgent(local, pk, sel.key, node, close);
  else openFile(local, pk, sel.key, file, close);
}

/** @param {any} local @param {string} pk @param {string} ak @param {any} node @param {() => void} close */
function openAgent(local, pk, ak, node, close) {
  if (!local.panel) {
    local.panel = createPanel({ nodeOf: (/** @type {string} */ key) => (local.model ? local.model.nodes.get(key) ?? null : null), select: (/** @type {string} */ key) => { globalThis.location.hash = `#/layers/${pk}/agent/${key}`; }, back: () => { globalThis.location.hash = backHash(local); } });
    local.laneNote = h('p', { class: 'layers-inspect__note', hidden: true });
    local.panelHost = h('div', { class: 'layers-inspect' }, [local.laneNote, local.panel.el]);
  }
  local.nodeSig = JSON.stringify(node);
  const panel = local.panel;
  panel.setAgent(null);
  panel.setAgent(node);
  setLaneNote(local, null);
  const channel = `transcript:${pk}:${ak}`;
  local.laneKey = channel;
  local.laneOff = local.store.subscribe(channel, (/** @type {any} */ event) => {
    if (local.laneKey !== channel) return;
    if (event.kind === 'state') {
      // A snapshot after a reconnect holds events the panel has: those are dropped by the panel, its counters start over.
      Object.assign(panel.state, { masked: 0, other: 0, unparsable: 0 });
      setLaneNote(local, null);
      panel.receive(event.state, { resumed: true });
    } else if (event.kind === 'append') panel.receive(event.state, { resumed: false });
    else if (event.kind === 'reset') {
      panel.setAgent(null);
      panel.setAgent(local.model ? local.model.nodes.get(ak) ?? node : node);
    } else if (event.kind === 'error') {
      panel.setMissing(event.code);
      setLaneNote(local, event.code);
    } else if (event.kind === 'gone') {
      panel.setMissing('agent-not-in-project');
    }
  });
  showPanel(local.inspector, local, { title: 'Agent transcript', labelledBy: 'fpanel-title', body: local.panelHost, owner: null, onClose: close });
}

/** @param {any} local @param {string | null} code */
function setLaneNote(local, code) {
  if (!local.laneNote) return;
  if (code === null || code === 'agent-not-in-project') {
    local.laneNote.setAttribute('hidden', '');
    return;
  }
  setText(local.laneNote, code === 'too-many-lanes' ? 'Too many transcripts are open in this Console. Close one, then this one follows.' : code === 'events-down' ? 'The transcript stream is down. The events below are the last received.' : `The transcript stream reports code ${code}.`);
  local.laneNote.removeAttribute('hidden');
}

/** The channels entry of a started session from the page's model: `{ state, code, item }` as derive/layers.js `channelIn` says it. @param {any} model @param {string} runId */
const channelsOf = (model, runId) => (model ? { state: model.channels.state, code: model.channels.code, item: model.channels.items.get(runId) ?? null } : { state: 'absent', code: null, item: null });

/** What the started pane draws from: the node and the run's channels entry, so a change of either repaints it. @param {any} local @param {any} node */
const startedSig = (local, node) => JSON.stringify([node, channelsOf(local.model, node.runId)]);

/**
 * 165: the pane of a started session: who started it, its phase and whether the harness's own session was seen, the two output lanes
 * (`file:` lanes, masked, the last 200 lines). 170: the turn badge, the message box (Send, Steer, Stop turn), the recent messages and End
 * session, which opens the cancel-worker confirmation of the `started-sessions` store (views/start.js `createSessionControls`).
 * The node carries its own run id and how it ended (165 F2), so neither depends on the machine's started list.
 * @param {any} local @param {string} pk @param {any} node @param {() => void} close
 */
function openStarted(local, pk, node, close) {
  const title = h('h2', { class: 'fpanel__title', id: 'layers-started-title', tabindex: '-1' }, 'Started session');
  const facts = h('div', { class: 'started__facts' });
  const out = tailPane('Output');
  const err = tailPane('Error output');
  let held = node;
  const controls = createSessionControls({
    projectKey: pk, project: () => (local.who ? local.who.label : null), runId: node.runId, harness: node.harness ?? null, phase: node.phase ?? null,
    stopSpec: () => (held.phase !== 'starting' && held.phase !== 'running' ? null : buildConfirmation('cancel-worker', {
      projectKey: pk, project: local.who ? local.who.label : null, slug: 'started-sessions', worker: { runId: held.runId, harness: held.harness, task: 'main-session' },
    })),
  });
  const el = h('section', { class: 'layers-inspect started', 'aria-labelledby': 'layers-started-title', dataset: { stream: 'started' } }, [
    title, facts, controls.el, h('p', { class: 'logpane__note' }, MASKED_SENTENCE), out.el, err.el,
  ]);
  /** @param {any} current */
  const update = (current) => {
    held = current;
    const words = startedWords(current);
    mount(facts, [
      h('p', { class: 'started__line' }, withSep([current.harness ? h('span', { class: 'tag tag--mono' }, current.harness) : null, current.model ?? 'model not recorded', words.startedBy, words.phase])),
      h('p', { class: 'started__line' }, words.observed),
      current.ended ? h('p', { class: 'started__line' }, ['ended ', reltime(current.ended.at, Date.now()), words.end ? `. ${words.end}` : '']) : null,
    ]);
    controls.set({ channels: channelsOf(local.model, current.runId), phase: current.phase ?? null });
  };
  update(node);
  local.startedPane = { update };
  local.nodeSig = startedSig(local, node);
  local.startedStreams = [];
  local.laneKey = `started:${pk}:${node.agentKey}`;
  /** @type {Array<() => void>} */
  const offs = [() => controls.destroy()];
  for (const [which, pane] of /** @type {const} */ ([['out', out], ['err', err]])) {
    const fileKey = node.fileKeys ? node.fileKeys[which] : null;
    if (typeof fileKey !== 'string' || !/^[0-9a-f]{16}$/.test(fileKey)) continue;
    const stream = createLogStream({ store: local.store, file: { projectKey: pk, fileKey } });
    local.startedStreams.push(stream);
    offs.push(stream.onChange((/** @type {any} */ state) => pane.render(state)));
    stream.open();
  }
  local.laneOff = () => { for (const off of offs) off(); };
  showPanel(local.inspector, local, { title: 'Started session', labelledBy: 'layers-started-title', body: el, owner: null, onClose: close });
}

/** @param {any} local @param {string} pk @param {string} fk @param {any} file @param {() => void} close */
function openFile(local, pk, fk, file, close) {
  const pane = filePane();
  const stream = createLogStream({ store: local.store, file: { projectKey: pk, fileKey: fk } });
  local.fileStream = stream;
  const word = file ? `${file.kindWord}${file.task ? ` · ${file.task}` : ''}` : 'File';
  const off = stream.onChange((/** @type {any} */ state) => pane.render(state, { kind: file ? file.kind : '', word }));
  local.laneOff = off;
  local.laneKey = `file:${pk}:${fk}`;
  stream.open();
  showPanel(local.inspector, local, { title: 'File', labelledBy: 'layers-file-title', body: pane.el, owner: null, onClose: close });
}

/**
 * The shell moved between two selections of one project page: the body is kept, so the focus stays; the inspector follows the
 * new selection. @param {any} local @param {any} params @param {any} data
 */
function rerouteProject(local, params, data) {
  local.params = params;
  local.sigs.lanes = null;
  updateProject(local, data, params);
  if ((params.agent || params.file) && local.inspector && local.inspector.mode() !== 'dock' && local.panel) local.panel.focusTitle();
}

/** The shell leaves the view: the lanes close and the panel's timers end. @param {any} local */
function teardownLayers(local) {
  closeLane(local);
  if (local.panel) local.panel.destroy();
}

// ---- skeletons ---------------------------------------------------------------------------------------------------------------------

const skeletonLayers = () => h('div', { class: 'skeleton skeleton--layers' }, [h('div', { class: 'skel skel--prow', 'aria-hidden': 'true' }), h('div', { class: 'skel skel--prow', 'aria-hidden': 'true' })]);

export {
  connectLayers, renderMachine, updateMachine, machineMeta, renderProject, updateProject, rerouteProject, buildProjectHead, projectMeta, projectTitle, teardownLayers, skeletonLayers,
};
