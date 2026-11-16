// The start view (165, design §10; `#/start`): pick a project, a checkout, a harness, a model, an entry and the first text, confirm through
// the one confirmation dialog, then watch the session start and stream. The words and the state machine are derive/start.js; this module
// draws them and owns the three things the page keeps while it is open: the form, the options read for the project, and the run it started.
//
// Nothing is chosen for the person: no harness is preselected, and a harness the core says cannot start is listed with the core's words,
// never offered. A device that may not start (`GET /api/actions`) gets the explanation and the terminal command as text and no button.
// The text of the session's output arrives over the live hub's `file:` lanes (log-store.js) and is shown masked, the last 200 lines.
// The page reads the form back from `local.start`, so a repaint (the project list changed) loses nothing the person typed. Every string
// from the Console is a text node; no markup is written and no style is set.

import { h, mount } from '../dom.js';
import { commandBlock, reltime } from '../states.js';
import { createPoller } from '../poll.js';
import { createLogStream } from '../log-store.js';
import { actionPower, loadActions, onActions } from '../actions.js';
import { openConfirm, onRefetch, newRequestId, actionButton, notAllowedLine } from './confirm.js';
import { buildConfirmation } from '../derive/actions.js';
import {
  VIEW_ONLY_WORDS, terminalCommand, NOT_STARTABLE_TITLE, projectRows, harnessRows, harnessOf, modelGroups, checkoutRows, entryChoices, limitWords, dispatchWords,
  permissionWords, readiness, formFor, startBody, attemptFor, settleAttempt, startRefusalLines, refusalRereads, initialFlow, flowReduce, flowWords, optionsErrorWords,
  outputTail, nodeIn, startedByWords,
} from '../derive/start.js';

const START_POLL_MS = 30000;
const KEY16 = /^[0-9a-f]{16}$/;
const MASKED_SENTENCE = 'Text is masked, best effort: DoFlow’s redactor can miss a secret that has no known shape.';

/** What Start is waiting for, in words, in the order the form asks. @type {Readonly<Record<string, string>>} */
const MISSING_WORDS = Object.freeze({
  checkout: 'Choose a checkout that has no started session open.',
  harness: 'Choose a harness.',
  prompt: 'Write what the session should do first.',
});

/** @param {any[]} list */
const clean = (list) => list.filter((item) => item !== null && item !== undefined && item !== false);

/** The face of a state token on the panel's mark. @type {Readonly<Record<string, string>>} */
const MARK = Object.freeze({ running: '●', failed: '▲', stale: '◷', unknown: '?', rejected: '■', done: '✓' });

// ---- the connector --------------------------------------------------------------------------------------------------------------

/**
 * `spec.connect`: the project list is `GET /api/start`, polled; the connector also keeps the page's live store for the output lanes.
 * @param {any} local @param {any} _params @param {any} hooks
 */
function connectStart(local, _params, hooks) {
  local.getStore = hooks.store;
  return createPoller({
    fetchOnce: hooks.fetchOnce,
    intervalMs: START_POLL_MS,
    onSuccess: hooks.onData,
    onFailure: hooks.onFailure,
    retry: hooks.retry,
    isActive: hooks.isActive,
    size: hooks.size,
  });
}

// ---- the output pane --------------------------------------------------------------------------------------------------------------

/**
 * One output pane: the last 200 lines a `file:` lane holds, as text, with the notes of the lane. `render(state)` takes the state of a
 * `createLogStream` and returns whether any text is shown. @param {string} label
 */
function tailPane(label) {
  const note = h('p', { class: 'logpane__note' });
  const pre = h('pre', { class: 'logpane__text', tabindex: '0', hidden: true });
  const el = h('section', { class: 'logpane start__tail', 'aria-label': label }, [h('h3', {}, label), note, pre]);
  return {
    el,
    /** @param {any} state */
    render(state) {
      const { lines, dropped } = outputTail(state.pieces);
      const notes = [];
      if (state.mode === 'down' || (state.error && state.error.code)) notes.push('The stream is down. The text below is what was last received.');
      if (state.log === 'gone') notes.push('This file is no longer there.');
      if (state.notices.includes('reset')) notes.push('The file was replaced; showing its newest text.');
      if (state.notices.includes('withheld')) notes.push('A line too long to show after masking was left out.');
      if (dropped > 0) notes.push(`${dropped} older lines are not shown.`);
      if (lines.length === 0 && notes.length === 0) notes.push('Nothing was written here yet.');
      mount(note, notes.join(' '));
      const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 48 || !(pre.scrollHeight > 0);
      const text = lines.join('\n');
      if (pre.textContent !== text) pre.textContent = text;
      if (lines.length > 0) pre.removeAttribute('hidden');
      else pre.setAttribute('hidden', '');
      if (near) pre.scrollTop = pre.scrollHeight;
      return lines.some((line) => line !== '');
    },
  };
}

// ---- the state of the page -------------------------------------------------------------------------------------------------------

/** @param {any} local */
function stateOf(local) {
  if (!local.start) {
    local.start = {
      alive: true, body: null, projects: [], projectKey: null, seq: 0, options: { state: 'idle', body: null, error: null }, form: null, flow: initialFlow(), attempt: null,
      actionsRead: false, offActions: null, offRefetch: null, flowProject: null, run: null, streams: [], offs: [], tails: null, terminalRequestId: null,
    };
  }
  return local.start;
}

/** Restores the focus to the control with the same `data-focus-key` when a repaint lost it. @param {any} root @param {() => void} fn */
function keepFocus(root, fn) {
  const focused = globalThis.document.activeElement;
  const owner = /** @type {any} */ (focused && typeof focused.closest === 'function' && root.contains(focused) ? focused.closest('[data-focus-key]') : null);
  const key = owner && owner.dataset ? owner.dataset.focusKey : null;
  fn();
  if (key && !root.contains(globalThis.document.activeElement)) {
    const again = root.querySelector(`[data-focus-key="${key}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

/** @param {any} st */
function paint(st) {
  if (!st.alive || !st.body) return;
  keepFocus(st.body, () => mount(st.body, content(st)));
}

/** Closes the streams and the subscriptions of the run the page watches. @param {any} st */
function closeRun(st) {
  for (const stream of st.streams) stream.close();
  for (const off of st.offs) off();
  st.streams = [];
  st.offs = [];
  st.run = null;
  st.tails = null;
}

/**
 * Reads the options of the project. `keep` keeps what the person chose that is still on offer. Resolves true once the options are held
 * (the confirmation dialog waits for it), false when the read failed. @param {any} st @param {{ keep?: boolean }} [how]
 */
function loadOptions(st, how = {}) {
  const projectKey = st.projectKey;
  if (projectKey === null || typeof st.local.apiGet !== 'function') return Promise.resolve(false);
  st.seq += 1;
  const seq = st.seq;
  st.options = { state: 'loading', body: how.keep === true ? st.options.body : null, error: null };
  paint(st);
  return st.local.apiGet(`/api/start/options?projectKey=${encodeURIComponent(projectKey)}`).then((/** @type {any} */ body) => {
    if (!st.alive || seq !== st.seq) return false;
    if (!body || body.v !== 1) throw { status: 502, code: 'core-contract-mismatch', network: false };
    st.options = { state: 'ok', body, error: null };
    st.form = formFor(body, how.keep === true ? st.form : null);
    paint(st);
    return true;
  }, (/** @type {any} */ error) => {
    if (!st.alive || seq !== st.seq) return false;
    st.options = { state: 'error', body: null, error };
    st.form = null;
    paint(st);
    return false;
  }).catch((/** @type {any} */ error) => {
    if (!st.alive || seq !== st.seq) return false;
    st.options = { state: 'error', body: null, error };
    paint(st);
    return false;
  });
}

// ---- the form ---------------------------------------------------------------------------------------------------------------------

/** @param {string} id @param {string} text @param {any} [control] */
const labelled = (id, text, control) => h('div', { class: 'start__field' }, clean([h('label', { class: 'start__label', for: id }, text), control]));

/** @param {string} legend @param {any[]} rows */
const group = (legend, rows) => h('fieldset', { class: 'start__group' }, [h('legend', { class: 'start__legend' }, legend), ...rows]);

/** The words of one harness row's warnings. @param {any} row */
const warningLines = (row) => row.warnings.map((/** @type {any} */ w) => h('p', { class: 'start__warn', dataset: { warning: w.id } }, w.words));

/** @param {any} st */
function projectField(st) {
  if (st.projects.length <= 1) return st.projects.length === 1 ? h('p', { class: 'start__line' }, ['Project: ', h('span', { class: 'mono' }, st.projects[0].label)]) : null;
  const select = h('select', {
    id: 'start-project', class: 'start__select', dataset: { focusKey: 'start-project' },
    on: {
      change: (/** @type {any} */ event) => {
        st.projectKey = String(event.target.value);
        st.form = null;
        st.attempt = null;
        void loadOptions(st);
      },
    },
  }, st.projects.map((/** @type {any} */ p) => h('option', { value: p.projectKey, selected: p.projectKey === st.projectKey }, p.current ? `${p.label} (this Console’s project)` : p.label)));
  return labelled('start-project', 'Project', select);
}

/** @param {any} st @param {any} options */
function formBody(st, options) {
  const form = st.form;
  const ready = readiness(form, options);
  const { startable, blocked } = harnessRows(options);
  const chosen = harnessOf(options, form.harness);
  const set = (/** @type {any} */ patch) => {
    st.form = { ...st.form, ...patch };
    paint(st);
  };
  const checkouts = checkoutRows(options);
  const checkoutGroup = group('Checkout', checkouts.length === 0
    ? [h('p', { class: 'start__line' }, 'This project has no checkout on record.')]
    : checkouts.map((c) => h('label', { class: 'start__choice', dataset: { busy: c.busy ? 'true' : null } }, [
      h('input', { type: 'radio', name: 'start-checkout', value: c.worktreeKey, checked: form.worktreeKey === c.worktreeKey, disabled: c.busy !== null, dataset: { focusKey: `start-checkout:${c.worktreeKey}` }, on: { change: () => set({ worktreeKey: c.worktreeKey }) } }),
      h('span', { class: 'start__choice-text' }, [
        h('span', { class: 'mono' }, c.label),
        c.main ? h('span', { class: 'tag tag--accent' }, 'main checkout') : null,
        c.branch ? h('span', { class: 'tag tag--mono' }, c.branch) : null,
        c.note ? h('span', { class: 'start__note' }, c.note) : null,
      ]),
    ])));
  const harnessGroup = group('Harness', startable.length === 0
    ? [h('p', { class: 'start__line' }, 'No harness can start a session here. The reasons are listed below.')]
    : startable.map((/** @type {any} */ row) => h('label', { class: 'start__choice' }, [
      h('input', { type: 'radio', name: 'start-harness', value: row.harness, checked: form.harness === row.harness, dataset: { focusKey: `start-harness:${row.harness}` }, on: { change: () => set({ harness: row.harness, model: null }) } }),
      h('span', { class: 'start__choice-text' }, [
        h('span', { class: 'mono' }, row.harness),
        row.version ? h('span', { class: 'tag tag--mono' }, row.version) : null,
        h('span', { class: 'start__note' }, row.words),
        ...warningLines(row),
      ]),
    ])));
  const blockedList = blocked.length === 0 ? null : h('div', { class: 'start__blocked' }, [
    h('h3', { class: 'start__sub' }, NOT_STARTABLE_TITLE),
    h('ul', { class: 'start__blocked-list' }, blocked.map((/** @type {any} */ row) => h('li', { dataset: { harness: row.harness, reason: row.reason } }, [
      h('span', { class: 'mono' }, row.harness), ' ', row.words,
      row.checkedAt ? [' (login checked ', reltime(row.checkedAt, Date.now()), ')'] : null,
    ]))),
  ]);
  const groups = chosen === null ? [] : modelGroups(chosen.models);
  const modelSelect = h('select', {
    id: 'start-model', class: 'start__select', disabled: chosen === null, dataset: { focusKey: 'start-model' },
    on: { change: (/** @type {any} */ event) => set({ model: event.target.value === '' ? null : String(event.target.value) }) },
  }, chosen === null ? [h('option', { value: '' }, 'Choose a harness first')] : groups.map((g) => h('optgroup', { label: g.label }, g.models.map((m) => h('option', { value: m.id ?? '', selected: m.id === form.model }, m.label)))));
  const entryGroup = group('How the session starts', entryChoices(options).map((e) => h('label', { class: 'start__choice' }, [
    h('input', { type: 'radio', name: 'start-entry', value: e.id, checked: form.entry === e.id, dataset: { focusKey: `start-entry:${e.id}` }, on: { change: () => set({ entry: e.id }) } }),
    h('span', { class: 'start__choice-text' }, [h('span', {}, e.label), h('span', { class: 'start__note' }, e.note)]),
  ])));

  const count = h('span', { class: 'start__count', id: 'start-count', dataset: { over: ready.prompt.over ? 'true' : null } }, `${ready.prompt.codePoints} / ${ready.prompt.max}`);
  const issue = h('p', { class: 'start__warn', id: 'start-issue', hidden: !(ready.prompt.issue !== null && ready.prompt.issue !== 'prompt-empty') }, ready.prompt.issue !== null && ready.prompt.issue !== 'prompt-empty' ? startRefusalLines(ready.prompt.issue)[0] : '');
  const hint = h('p', { class: 'start__hint', id: 'start-hint', role: 'status' }, ready.dispatch ?? (ready.ok ? '' : ready.missing.map((m) => MISSING_WORDS[m]).join(' ')));
  const submit = h('button', { type: 'button', class: 'btn btn--act start__submit', id: 'start-submit', disabled: !ready.ok, 'aria-describedby': 'start-hint', dataset: { focusKey: 'start-submit' }, on: { click: () => openStart(st) } }, 'Start');
  const area = h('textarea', {
    id: 'start-prompt', class: 'start__prompt', rows: 6, autocomplete: 'off', 'aria-describedby': 'start-count start-issue', dataset: { focusKey: 'start-prompt' },
    on: {
      // Typing updates the count, the issue and the button in place: a repaint would take the caret away.
      input: (/** @type {any} */ event) => {
        st.form = { ...st.form, prompt: String(event.target.value ?? '') };
        const now = readiness(st.form, options);
        count.textContent = `${now.prompt.codePoints} / ${now.prompt.max}`;
        if (now.prompt.over) count.dataset.over = 'true';
        else delete count.dataset.over;
        const show = now.prompt.issue !== null && now.prompt.issue !== 'prompt-empty';
        issue.textContent = show ? startRefusalLines(now.prompt.issue)[0] : '';
        if (show) issue.removeAttribute('hidden');
        else issue.setAttribute('hidden', '');
        hint.textContent = now.dispatch ?? (now.ok ? '' : now.missing.map((m) => MISSING_WORDS[m]).join(' '));
        if (now.ok) submit.removeAttribute('disabled');
        else submit.setAttribute('disabled', '');
      },
    },
  }, form.prompt);
  const limits = limitWords(options);
  return h('form', { class: 'start__form', on: { submit: (/** @type {any} */ event) => event.preventDefault() } }, clean([
    projectField(st),
    checkoutGroup,
    harnessGroup,
    blockedList,
    labelled('start-model', 'Model', modelSelect),
    entryGroup,
    h('div', { class: 'start__field' }, [h('label', { class: 'start__label', for: 'start-prompt' }, 'First text for the session'), area, h('div', { class: 'start__under' }, [issue, count])]),
    h('p', { class: 'start__line', dataset: { fact: 'permission' } }, permissionWords(chosen === null ? 'the harness' : chosen.harness)),
    limits ? h('p', { class: 'start__line', dataset: { fact: 'limits' } }, limits) : null,
    h('div', { class: 'start__actions' }, [submit, hint]),
  ]));
}

// ---- the page ----------------------------------------------------------------------------------------------------------------------

/** What the page shows for the project's options: a read in flight, a failure, or the form. @param {any} st */
function optionsBody(st) {
  const { state, body, error } = st.options;
  if (st.projectKey === null) return h('p', { class: 'start__line' }, 'DoFlow lists no project on this machine, so there is nothing to start a session in.');
  if (state === 'error') {
    return h('div', { class: 'start__refusal', dataset: { state: 'failed' } }, [
      h('p', {}, optionsErrorWords(error)),
      h('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => void loadOptions(st) } }, 'Read again'),
    ]);
  }
  if (state !== 'ok' && body === null) return h('p', { class: 'start__line', role: 'status' }, 'Reading what this project can start…');
  if (st.form === null) return h('p', { class: 'start__line', role: 'status' }, 'Reading what this project can start…');
  return formBody(st, st.options.body);
}

/** The panel of a start that is under way or ended: the words, the output, Stop, and the way back. @param {any} st */
function flowPanel(st) {
  const words = flowWords(st.flow);
  const stop = words.stop ? actionButton({ id: 'cancel-worker', label: 'Stop session', tone: 'danger', make: () => stopSpec(st) }) : null;
  return h('section', { class: 'start__flow', 'aria-labelledby': 'start-flow-title', dataset: { state: words.token, step: st.flow.step } }, clean([
    h('h2', { class: 'start__flow-title', id: 'start-flow-title', tabindex: '-1' }, [h('span', { class: 'start__mark', 'aria-hidden': 'true' }, MARK[words.token] ?? '?'), ' ', words.title]),
    st.flow.run && st.flow.node ? h('p', { class: 'start__line' }, [startedByWords(st.flow.node.startedBy), ' · ', st.flow.node.observed && st.flow.node.observed.state === 'observed' ? 'session observed' : 'session not observed']) : null,
    ...words.lines.map((/** @type {string} */ line) => h('p', { class: 'start__line', role: 'status' }, line)),
    words.output && st.tails ? [h('p', { class: 'logpane__note' }, MASKED_SENTENCE), st.tails.out.el, st.tails.err.el] : null,
    st.run ? h('p', { class: 'start__line' }, [h('a', { class: 'layers-link', href: `#/layers/${st.flowProject}/agent/${st.run.agentKey}` }, 'Open it in Layers')]) : null,
    stop ? h('div', { class: 'acts' }, stop) : (words.stop ? h('div', { class: 'acts' }, notAllowedLine(['cancel-worker'])) : null),
    st.flow.step === 'ended' ? h('div', { class: 'start__actions' }, h('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => again(st) } }, 'Start another')) : null,
  ]));
}

/**
 * The view-only page: why, and the terminal command as text, built from the form's choices where the page holds them, with a request id
 * kept for the page's life so a repaint does not change the command being copied. @param {any} st
 */
function viewOnly(st) {
  if (typeof st.terminalRequestId !== 'string') st.terminalRequestId = newRequestId();
  const form = st.form ?? {};
  const command = terminalCommand({ ...form, projectKey: form.projectKey ?? st.projectKey }, st.terminalRequestId);
  return h('section', { class: 'start__viewonly', dataset: { state: 'view-only' } }, clean([
    h('p', { class: 'start__line' }, VIEW_ONLY_WORDS),
    notAllowedLine(['start-session']),
    h('p', { class: 'start__line' }, 'In a terminal on this machine, then type the first text and end it with Ctrl-D:'),
    commandBlock(command, 'the terminal command'),
    command.includes('<') ? h('p', { class: 'start__line' }, 'doflow fleet --action projects and doflow worker --action start-options --project-key <key> list the keys and the harnesses.') : null,
  ]));
}

/** @param {any} st */
function content(st) {
  if (!st.actionsRead) return h('p', { class: 'start__line', role: 'status' }, 'Checking what this device may do…');
  if (!actionPower('start-session').allowed) return viewOnly(st);
  const step = st.flow.step;
  const showForm = step === 'form' || step === 'refused' || step === 'unknown';
  return h('div', { class: 'start__page' }, clean([
    step === 'form' ? null : flowPanel(st),
    showForm ? optionsBody(st) : null,
  ]));
}

// ---- the start ---------------------------------------------------------------------------------------------------------------------

/** The Stop confirmation of the run the page started, or null once it cannot be stopped. @param {any} st */
function stopSpec(st) {
  const run = st.run;
  const phase = st.flow.node ? st.flow.node.phase : run ? run.phase : null;
  if (!run || (phase !== 'starting' && phase !== 'running')) return null;
  const project = st.projects.find((/** @type {any} */ p) => p.projectKey === st.flowProject);
  return buildConfirmation('cancel-worker', { projectKey: st.flowProject, project: project ? project.label : null, slug: 'started-sessions', worker: { runId: run.runId, harness: run.harness, task: run.kind ?? 'main-session' } });
}

/** The person presses Start: the confirmation of the form as it is now. @param {any} st */
function openStart(st) {
  const options = st.options.body;
  if (!options || st.form === null) return;
  const ready = readiness(st.form, options);
  if (!ready.ok) return;
  const project = st.projects.find((/** @type {any} */ p) => p.projectKey === st.projectKey);
  const spec = buildConfirmation('start-session', {
    projectKey: st.projectKey, project: project ? project.label : null, checkout: ready.checkout.label, worktreeKey: st.form.worktreeKey, harness: st.form.harness,
    model: st.form.model, entry: st.form.entry, prompt: st.form.prompt,
  });
  if (spec === null) return;
  const attempt = attemptFor(st.attempt, startBody(st.form), newRequestId);
  const info = { harness: st.form.harness, model: st.form.model, project: project ? project.label : 'this project', checkout: ready.checkout.label };
  const projectKey = st.projectKey;
  openConfirm({ ...spec, requestId: attempt.requestId, refusal: (/** @type {any} */ code, /** @type {any} */ reply) => startRefusalLines(code, reply && reply.body ? reply.body.current : null, { retryAfter: reply && reply.headers ? reply.headers['retry-after'] ?? null : null }) }, {
    onSend: () => {
      closeRun(st);
      st.flow = flowReduce(st.flow, { type: 'sending', info });
      paint(st);
    },
    onReply: (/** @type {any} */ reply, /** @type {string} */ state) => {
      st.attempt = settleAttempt(attempt, state);
      st.flow = flowReduce(st.flow, { type: 'reply', reply });
      if (st.flow.run) watch(st, projectKey, st.flow.run);
      else if (st.flow.step === 'refused' && refusalRereads(st.flow.refusal.code)) void loadOptions(st, { keep: true });
      paint(st);
    },
  });
}

/** Opens the output lanes and follows the run's node. @param {any} st @param {string} projectKey @param {any} run */
function watch(st, projectKey, run) {
  closeRun(st);
  st.run = run;
  st.flowProject = projectKey;
  st.tails = { out: tailPane('Output'), err: tailPane('Error output') };
  const store = typeof st.local.getStore === 'function' ? st.local.getStore() : null;
  if (!store) return;
  /** @param {any} event */
  const apply = (event) => {
    if (!st.alive || st.run !== run) return;
    const before = st.flow;
    st.flow = flowReduce(st.flow, event);
    if (before.step !== st.flow.step || before.node !== st.flow.node) paint(st);
  };
  for (const which of /** @type {const} */ (['out', 'err'])) {
    const fileKey = run.files ? run.files[which] : null;
    if (!KEY16.test(String(fileKey))) continue;
    const stream = createLogStream({ store, file: { projectKey, fileKey } });
    st.streams.push(stream);
    st.offs.push(stream.onChange((/** @type {any} */ state) => {
      if (!st.alive || st.run !== run || !st.tails) return;
      const shown = st.tails[which].render(state);
      if (which === 'out' && shown) apply({ type: 'output', text: true });
    }));
    stream.open();
  }
  st.offs.push(store.subscribe(`layers:${projectKey}`, (/** @type {any} */ event) => {
    if (event.kind !== 'state') return;
    const member = event.state && typeof event.state === 'object' ? event.state.layers : null;
    if (!member || member.status !== 200) return;
    apply({ type: 'node', node: nodeIn(member.body, run.agentKey) });
  }));
}

/** Back to a fresh form once a session ended. @param {any} st */
function again(st) {
  closeRun(st);
  st.flowProject = null;
  st.flow = flowReduce(st.flow, { type: 'again' });
  st.form = st.form ? { ...st.form, prompt: '' } : st.form;
  paint(st);
  void loadOptions(st, { keep: true });
}

// ---- the view ----------------------------------------------------------------------------------------------------------------------

/**
 * `spec.render`: the body of the page. The shell calls it again when the project list changes; the form, the options and the run are in
 * `local.start`, so nothing the person did is lost.
 * @param {any} data the body of `GET /api/start` @param {any} _params @param {any} local
 */
function renderStart(data, _params, local) {
  const st = stateOf(local);
  st.local = local;
  st.projects = projectRows(data);
  if (!st.projects.some((/** @type {any} */ p) => p.projectKey === st.projectKey)) {
    st.projectKey = st.projects.length > 0 ? st.projects[0].projectKey : null;
    st.options = { state: 'idle', body: null, error: null };
    st.form = null;
  }
  st.body = h('div', { class: 'start' });
  if (st.offActions === null) st.offActions = onActions(() => paint(st));
  if (st.offRefetch === null) st.offRefetch = onRefetch(() => loadOptions(st, { keep: true }));
  if (!st.actionsRead) {
    void loadActions().then(() => {
      st.actionsRead = true;
      paint(st);
    });
  }
  const root = h('div', { class: 'start-view' }, [
    h('p', { class: 'start__intro' }, 'Start a coding session in one of the projects on this machine. It runs with the harness you choose; you watch it here and in Layers.'),
    st.body,
  ]);
  mount(st.body, content(st));
  if (st.options.state === 'idle' && st.projectKey !== null) void loadOptions(st);
  return root;
}

/** The shell leaves the page: the streams and the subscriptions end. @param {any} local */
function teardownStart(local) {
  const st = local.start;
  if (!st) return;
  st.alive = false;
  closeRun(st);
  if (st.offActions) st.offActions();
  if (st.offRefetch) st.offRefetch();
  st.offActions = null;
  st.offRefetch = null;
}

/** @param {any} data */
const startKey = (data) => JSON.stringify(projectRows(data));

export { connectStart, renderStart, teardownStart, startKey, tailPane };
