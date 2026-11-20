// The runs home (E.1 note section 6): summary tiles that filter, the three sections (Needs you, Running, Finished),
// the run rows with their compact rails, change memory and announcements. `derive/rail.js` holds the logic that
// needs no DOM; this module builds the element trees and owns the filter for the life of the tab.

import { h, icon, mount, announce } from '../dom.js';
import { reltime, clockTime, skel } from '../states.js';
import {
  deriveRail, programLength, runKey, groupRuns, countRuns, describeRun, updatedText, stepText, changedNodes, runToken,
  awaitingGateOf, waitStamp, waitText, describeGate, tileFacts, stepPart, stepFraction, progressOf, stepNumber, runWord,
} from '../derive/rail.js';
import { railCompact, railFallback } from './rail.js';
// Leaf module routes.js provides hashFor without circular dependency.
import { hashFor } from '../routes.js';
import { connectLive } from '../live-view.js';
import { createLiveStore } from '../store.js';
import { createLiveAdapter } from '../live.js';
import { sinceLooked, nextSeen, ownRows, machineRows, machineRuns } from '../derive/digest.js';
import { readSeen, writeSeen, setNotify, canNotify, permission, notifyActive, ask, notifyWaiting } from '../notify.js';
import { savedBar, take, follow } from '../filters.js';

/** How many finished runs the list shows before "Show all". */
const FINISHED_CAP = 10;
/** A workflows fetch is retried at most this often (E.1 section 3). */
const WORKFLOWS_RETRY_MS = 60_000;

/** Now must be shown this long for a look to be recorded (FR-A4). */
const LOOK_MS = 2000;

/** The filter, the Finished expansion and the project scope: they survive route changes and reset on reload (not stored). */
const page = { filter: /** @type {string | null} */ (null), expanded: false, scope: /** @type {'every' | 'this'} */ ('every') };

/** For tests: a fresh module state, as after a reload. */
function resetHome() {
  page.filter = null;
  page.expanded = false;
  page.scope = 'every';
  if (watch.off) watch.off();
  watch.off = null;
  watch.store = null;
}

/** @type {Record<string, { label: string, face: string, token: string, sentence: string, empty: string, emptyEvery?: string, emptyFace: string }>} */
const SECTIONS = {
  needs: { label: 'Needs you', face: 'awaiting', token: 'awaiting', sentence: 'Showing only runs that need you.', empty: 'Nothing is waiting for you in this project.', emptyEvery: 'Nothing is waiting for you in the projects shown.', emptyFace: 'check' },
  running: { label: 'Running', face: 'running', token: 'running', sentence: 'Showing only running runs.', empty: 'Nothing is running in this project right now.', emptyEvery: 'Nothing is running in the projects shown right now.', emptyFace: 'pending' },
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
  const pending = firstWorkflows(local, apiGet);
  const body = await apiGet('/api/runs');
  if (pending) await pending;
  else if (needsWorkflows(local, body.runs)) void fetchWorkflows(local, apiGet);
  return homeData(local, body);
}

/**
 * The first workflows read of a view instance: started on the first call, null on later ones. Kept in `local.workflowsFirst`
 * until it settles, so a live `runs` member that arrives meanwhile waits for it as the first load does.
 * @param {any} local
 * @param {(path: string) => Promise<any>} apiGet
 * @returns {Promise<void> | null}
 */
function firstWorkflows(local, apiGet) {
  if (!(local.workflows instanceof Map)) local.workflows = new Map();
  if (local.workflowsAt !== undefined) return null;
  const pending = fetchWorkflows(local, apiGet).finally(() => { local.workflowsFirst = null; });
  local.workflowsFirst = pending;
  return pending;
}

/** The home's data from an `/api/runs` body and the workflows kept in the view instance. @param {any} local @param {any} body */
function homeData(local, body) {
  return { runs: body.runs, unreadableCount: body.unreadableCount, workflows: local.workflows, machine: local.machine ?? null };
}

/**
 * The `/api/runs` wrapping of loadHome for a body that arrived another way (the live `runs` member, IC-012): the workflows are
 * read as loadHome reads them, and while the first read is pending the data waits for it (a promise is returned).
 * @param {any} local
 * @param {any} body an `/api/runs` body
 * @param {(path: string) => Promise<any>} apiGet
 */
function homeOf(local, body, apiGet) {
  const pending = firstWorkflows(local, apiGet) ?? local.workflowsFirst ?? null;
  if (pending) return pending.then(() => homeData(local, body));
  if (needsWorkflows(local, body.runs)) void fetchWorkflows(local, apiGet);
  return homeData(local, body);
}

/** IC-018: the `runs` member of `now`, wrapped as loadHome wraps `/api/runs`; polled every 5 s without the stream. */
const connectNow = connectLive({ channel: () => 'now', member: 'runs', intervalMs: 5000, wrap: homeOf });

/** The `machine` member body of a store event, or undefined when the event carries none. @param {any} event */
function machineOf(event) {
  if (!event || event.kind !== 'state') return undefined;
  const member = event.state && typeof event.state === 'object' ? event.state.machine : undefined;
  return member && member.status === 200 && member.body && typeof member.body === 'object' ? member.body : undefined;
}

/**
 * `spec.connect` of Now (180 C3, design §2): the `now` connector as before, and the `machine` channel of the page's store, whose
 * other projects' open runs Now merges in. A `machine` frame delivers the last data again with it; an error or a closed channel
 * drops it, so Now never shows another project's rows it no longer follows.
 * @param {any} local @param {any} params @param {any} hooks
 */
function connectHome(local, params, hooks) {
  const inner = connectNow(local, params, { ...hooks, onData: (/** @type {any} */ data) => { local.last = data; hooks.onData(data); } });
  const { start, stop } = inner;
  /** @type {(() => void) | null} */
  let off = null;
  const onMachine = (/** @type {any} */ event) => {
    if (!event || event.kind === 'reset') return; // the snapshot that follows replaces it
    const body = machineOf(event) ?? null;
    if (body === null && local.machine === null) return;
    local.machine = body;
    if (local.last) hooks.onData({ ...local.last, machine: body });
  };
  return Object.assign(inner, {
    start() {
      if (!('machine' in local)) local.machine = null;
      start();
      if (off === null) off = hooks.store().subscribe('machine', onMachine);
      local.watchStore = hooks.watchStore;
      syncWatch(hooks.watchStore);
    },
    stop() {
      stop();
      if (off) off();
      off = null;
    },
  });
}

// ---- the notification watcher (FR-A5) ------------------------------------------------------------------------------------

/**
 * The page's store closes its stream while the tab is hidden (store.js, DEC-016), so a hidden tab hears nothing. Once the person
 * switched notifications on, a second store follows `machine` only while the tab is hidden: its visibility is the page's, turned
 * over, so it is never open beside the page's own; it stops following when the switch goes off. It lives for the page, not for Now:
 * app start begins it for a stored opt-in (180 review B-4), and Now's start finds it running and starts no second one.
 */
const watch = { store: /** @type {any} */ (null), off: /** @type {(() => void) | null} */ (null) };

const SHOWN_IS_AWAY = Object.freeze({
  hidden: () => globalThis.document.hidden !== true,
  subscribe(/** @type {() => void} */ listener) {
    globalThis.document.addEventListener('visibilitychange', listener);
    return () => globalThis.document.removeEventListener('visibilitychange', listener);
  },
});

/** Follows `machine` while hidden when notifications are on and allowed; stops otherwise. @param {(() => any) | undefined} [makeStore] a test's store */
function syncWatch(makeStore) {
  const want = notifyActive();
  if (want && watch.off === null) {
    if (watch.store === null) watch.store = makeStore ? makeStore() : createLiveStore({ adapter: createLiveAdapter(), visibility: SHOWN_IS_AWAY });
    watch.off = watch.store.subscribe('machine', (/** @type {any} */ event) => {
      const body = machineOf(event);
      if (body !== undefined) notifyWaiting(machineRows(body), readSeen());
    });
  } else if (!want && watch.off !== null) {
    watch.off();
    watch.off = null;
  }
}

/**
 * What decides a re-mount: the runs, the unreadable count, which classes have a workflow, and which runs are stale
 * (age alone can flip that). Not the workflow bodies: re-reading the same registry must not re-mount the body.
 * @param {any} data
 */
function homeKey(data) {
  const now = Date.now();
  const classes = data.workflows instanceof Map ? [...data.workflows.keys()].sort() : [];
  // Of the `machine` member only what Now draws: a session or a worker of another project does not re-mount the body.
  return `${JSON.stringify({ runs: data.runs, unreadableCount: data.unreadableCount, machine: machineRuns(data.machine ?? null) })}|${classes.join(',')}|${staleKeys(data.runs, now)}`;
}

/** Which runs are stale at `now`, as one string to compare. @param {any[]} runs @param {number} now */
function staleKeys(runs, now) {
  return runs.filter((run) => runToken(run, now) === 'stale').map(runKey).join(',');
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
  // A run named after its feature (most are) shows the name once; the link's title still carries both.
  if (run.taskId === run.featureSlug) return [h('span', { class: 'run-row__slug' }, run.featureSlug)];
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
 * The Chain link of a row or card (150 IC-020): the run's Session screen, after the link that opens the run. Null when the
 * route has no hash. `run-row__chain` lifts it above the stretched run link, so a click on it opens the chain.
 * @param {string} slug @param {string} taskId @param {string} key the run key, for the focus key
 */
function chainLink(slug, taskId, key) {
  const href = hashFor({ id: 'session', params: { slug, taskId } });
  if (href === null) return null;
  return h('a', { class: 'graph__back run-row__chain', href, 'aria-label': `Chain: ${slug} / ${taskId}`, dataset: { focusKey: `chain:${key}` } }, 'Chain');
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
  const fraction = run.state === 'COMPLETED' || run.state === 'REJECTED' || run.state === 'CLOSED' ? null : stepFraction(run);
  const part = stepPart(run);
  const exception = run.state !== 'RUNNING' || token === 'stale';

  return h('li', { class: 'run-row', dataset: { state: token, openable: openable ? 'true' : 'false' } }, [
    h('div', { class: 'run-row__title' }, [
      title, run.origin === 'other' ? tag('Other checkout') : null, openable ? chainLink(slug, run.taskId, key) : tag('No feature folder'),
    ]),
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
  // The view's one loop (IC-022): the gate glyph of the first Needs you card pulses; every other card shows the still glyph.
  const loop = context.loop === true;
  context.loop = false;

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
        model && drawn ? railCompact(model, { large: true, loop, changed: changed.get(runKey(run)) ?? new Set() }) : railFallback(run, reason, now, loop),
        h('p', { class: 'gate-card__meta' }, done === null || total === null ? workflowName : `${workflowName} · step ${stepNumber(run)} of ${total}`),
      ]),
      openable
        ? h('a', {
          class: 'gate-card__link', href: `#/run/${slug}/${run.taskId}`, 'aria-label': `Open the run to decide: ${slug} / ${run.taskId}`,
          'aria-describedby': id, dataset: { focusKey: `run:${runKey(run)}` },
        }, ['Open the run to decide', h('span', { 'aria-hidden': 'true' }, ' →')])
        : h('p', { class: 'gate-card__note' }, 'Decide in a terminal. This run has no feature folder, so it cannot be opened here.'),
      openable ? chainLink(slug, run.taskId, runKey(run)) : null,
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
  if (local && Array.isArray(local.homeRuns) && typeof local.homeRebuild === 'function' && staleKeys(local.homeRuns, nowMs) !== local.homeStale) {
    local.homeRebuild(nowMs);
  }
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

/**
 * A run of another project (FR-A2): its project as a tag, and a link to that project's Layers page, because the run page reads
 * this project only. @param {any} run a row of digest.js `machineRuns().others` @param {any} context
 */
function otherRow(run, context) {
  const { now, badge } = context;
  const name = run.slug ?? run.taskId;
  const href = hashFor({ id: 'layers-project', params: { project: run.projectKey } });
  const runLike = { taskId: run.taskId, featureSlug: run.slug ?? run.taskId, state: run.state, updatedAt: run.updatedAt };
  const title = href === null
    ? h('span', { class: 'run-row__id' }, name)
    : h('a', {
      class: 'run-row__link', href, title: `${run.projectLabel}: ${name} / ${run.taskId}`, 'aria-label': `${run.projectLabel}: ${name} / ${run.taskId}, open the project in Layers`,
      dataset: { focusKey: `other:${run.projectKey}:${run.taskId}` },
    }, titleParts(runLike));
  const step = run.step && run.step.total > 0 ? `${run.step.done} of ${run.step.total} steps done` : null;
  const gate = run.state === 'AWAITING_GATE' && run.gateName ? `at ${run.gateName}` : null;
  const at = Date.parse(run.updatedAt);
  const token = runToken(runLike, now);
  return h('li', { class: 'run-row', dataset: { state: token, openable: href === null ? 'false' : 'true', project: run.projectKey } }, [
    h('div', { class: 'run-row__title' }, [title, tag(run.projectLabel)]),
    h('p', { class: 'run-row__meta' }, [run.workflowName, step, gate].filter(Boolean).join(' · ')),
    h('div', { class: 'run-row__state' }, run.state !== 'RUNNING' || token === 'stale' ? badge(runLike, now) : null),
    h('p', { class: 'run-row__time' }, Number.isFinite(at) ? [h('span', { class: 'run-row__upd' }, 'Updated '), reltime(run.updatedAt, now)] : 'Update time unknown'),
  ]);
}

/** @param {string} id @param {any[]} runs @param {any} context */
function section(id, runs, context) {
  const spec = SECTIONS[id];
  const capped = id === 'finished' && !page.expanded && runs.length > FINISHED_CAP;
  const shown = capped ? runs.slice(0, FINISHED_CAP) : runs;
  let index = context.rowIndex;
  const own = shown.filter((run) => !run.other);
  const others = shown.filter((run) => run.other).map((run) => otherRow(run.other, context));
  const rows = own.map((run) => (id === 'needs' ? gateCard(run, index++, context) : runRow(run, index++, context)));
  context.rowIndex = index;
  const merged = context.merged === true && spec.emptyEvery;
  return h('section', { class: 'run-section', dataset: { section: id }, 'aria-labelledby': `sec-${id}` }, [
    h('h2', { class: 'run-section__title', id: `sec-${id}` }, [spec.label, h('span', { class: 'run-section__count' }, String(runs.length))]),
    runs.length === 0
      ? h('p', { class: 'run-section__empty' }, [icon(spec.emptyFace, 16), merged ? spec.emptyEvery : spec.empty])
      : id === 'needs'
        // A gate card needs the run's workflow, which another project's row does not carry: those are rows below the cards.
        ? [rows.length ? h('ul', { class: 'gate-cards' }, rows) : null, others.length ? h('ul', { class: 'run-list' }, others) : null]
        : h('ul', { class: 'run-list' }, mergeOrder(shown, rows, others)),
    id === 'finished' && runs.length > FINISHED_CAP
      ? h('button', {
        type: 'button', class: 'btn btn--ghost run-section__more', 'aria-expanded': page.expanded ? 'true' : 'false', dataset: { focusKey: 'finished-more' },
        on: { click: () => { page.expanded = !page.expanded; context.rerender('finished-more'); } },
      }, page.expanded ? 'Show fewer' : `Show all ${runs.length} finished runs`)
      : null,
  ]);
}

/**
 * One summary tile. `staleCount` (the Running tile only) shows beside the count when above zero: silent runs are not "running".
 * @param {string} id @param {number} count @param {{ long: string, short: string, prefix: string }} fact @param {any} context @param {number} [staleCount]
 */
function tile(id, count, fact, context, staleCount = 0) {
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
    h('span', { class: 'tile__count' }, [
      String(count),
      pressed ? h('span', { class: 'tile__check' }, icon('check', 16)) : null,
      // Read aloud as "3 live runs, 2 stale": the noun comes before the chip, and says the count is the live ones.
      staleCount > 0 ? h('span', { class: 'vh' }, count === 1 ? ' live run, ' : ' live runs, ') : null,
      staleCount > 0 ? h('span', { class: 'tile__stale', dataset: { state: 'stale' } }, `${staleCount} stale`) : null,
    ]),
    staleCount > 0 ? null : h('span', { class: 'vh' }, count === 1 ? ' run' : ' runs'),
    h('span', { class: 'tile__sub' }, [
      h('span', { class: 'tile__sub-long' }, fact.long),
      h('span', { class: 'tile__sub-short' }, [h('span', { class: 'vh tile__sub-prefix' }, fact.prefix), h('span', { class: 'tile__sub-text' }, fact.short)]),
    ]),
  ]);
}

/** The built rows in the order of the runs they came from (own and other projects' runs are sorted together). @param {any[]} shown @param {any[]} own @param {any[]} others */
function mergeOrder(shown, own, others) {
  let o = 0;
  let x = 0;
  return shown.map((run) => (run.other ? others[x++] : own[o++]));
}

/** Another project's row as a run the grouping and the counts read. @param {any} row */
const asRun = (row) => ({ taskId: row.taskId, featureSlug: row.slug, state: row.state, updatedAt: row.updatedAt, other: row });

/** The runs the scope shows: this project's, and in Every project the other shown projects' open runs. @param {any} data */
function shownRuns(data) {
  const machine = machineRuns(data && data.machine ? data.machine : null);
  if (page.scope !== 'every' || machine === null) return data.runs;
  return [...data.runs, ...machine.others.map(asRun)];
}

/** Now is empty when this project has no run and no other shown project has an open one. @param {any} data */
function homeEmpty(data) {
  const machine = machineRuns(data && data.machine ? data.machine : null);
  return data.runs.length === 0 && (machine === null || (machine.others.length === 0 && machine.countsOnly.length === 0));
}

/** The words of a run state in the digest. @param {string} state */
const stateWords = (state) => runWord({ state, updatedAt: null }, 0);

/** The filter Now shows, as a saved filter keeps it (FR-B2): the pressed tile and the project scope. */
const currentFilter = () => ({ chips: page.filter === null ? [] : [page.filter], scope: page.scope });

/** Shows a saved filter: a chip id Now does not have shows every section. @param {any} filter */
function setFilter(filter) {
  const chip = filter.chips[0];
  page.filter = typeof chip === 'string' && Object.hasOwn(SECTIONS, chip) ? chip : null;
  if (filter.scope === 'every' || filter.scope === 'this') page.scope = filter.scope;
}

/** The rows `j` and `k` move along (FR-B4): each row's link, in the order drawn. @param {any} root */
const rowLinks = (root) => [...root.querySelectorAll('[data-focus-key]')].filter((/** @type {any} */ el) => /^(run|other):/.test(el.dataset.focusKey));

/** The scope chips and the notification switch (FR-A3, FR-A5). @param {any} machine @param {any} context */
function toolbar(machine, context) {
  const chip = (/** @type {'every' | 'this'} */ id, /** @type {string} */ label) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': page.scope === id ? 'true' : 'false', dataset: { focusKey: `scope:${id}` },
    on: { click: () => { page.scope = id; context.rerender(`scope:${id}`); context.retitle(); } },
  }, label);
  const scope = machine === null ? null : h('span', { class: 'filter-status', role: 'group', 'aria-label': 'Projects shown' }, [chip('every', 'Every project'), chip('this', 'This project')]);
  const asked = canNotify() ? h('button', {
    type: 'button', class: 'chip', 'aria-pressed': notifyActive() ? 'true' : 'false', dataset: { focusKey: 'notify' },
    on: { click: () => toggleNotify(context) },
  }, 'Notify me when a run waits') : null;
  const blocked = asked && permission() === 'denied' ? h('span', {}, 'This browser blocks notifications for this page.') : null;
  if (scope === null && asked === null) return null;
  return h('div', { class: 'filter-status' }, [scope, asked, blocked]);
}

/** The switch's click: the one place the permission is asked (notify.js `ask`). @param {any} context */
function toggleNotify(context) {
  const done = () => { syncWatch(context.local.watchStore); context.rerender('notify'); };
  if (notifyActive()) setNotify(false);
  else if (permission() === 'granted') setNotify(true);
  else {
    void ask().then(done);
    return;
  }
  done();
}

/** The "Since you looked" strip (FR-A4): what appeared, changed state or left, and "Mark as seen". @param {any} data @param {any} machine @param {any} context */
function digestStrip(data, machine, context) {
  const { local } = context;
  if (machine === null || !Array.isArray(local.lookRows)) return null;
  const result = sinceLooked(local.base, local.lookRows, context.now);
  const inScope = (/** @type {string} */ projectKey) => page.scope === 'every' || projectKey === machine.currentKey;
  const labels = new Map(local.lookRows.map((/** @type {any} */ row) => [row.projectKey, row.projectLabel]));
  const line = (/** @type {string} */ project, /** @type {string} */ name, /** @type {string} */ what) => h('li', {}, [tag(project), ' ', h('span', { class: 'mono' }, name), `: ${what}`]);
  const items = [
    ...result.appeared.filter((item) => inScope(item.row.projectKey)).map((item) => line(item.row.projectLabel, item.row.slug ?? item.row.taskId, `new, ${stateWords(item.to).toLowerCase()}`)),
    ...result.changed.filter((item) => inScope(item.row.projectKey)).map((item) => line(item.row.projectLabel, item.row.slug ?? item.row.taskId, `${stateWords(item.from).toLowerCase()} → ${stateWords(item.to).toLowerCase()}`)),
    ...result.left.filter((item) => inScope(item.projectKey)).map((item) => line(labels.get(item.projectKey) ?? item.projectKey.slice(0, 8), item.taskId, 'no longer open')),
  ];
  if (result.since === null || items.length === 0) return null;
  return h('section', { class: 'run-section', dataset: { section: 'digest' }, 'aria-labelledby': 'sec-digest' }, [
    h('h2', { class: 'run-section__title', id: 'sec-digest' }, ['Since you looked', h('span', { class: 'run-section__count' }, String(items.length))]),
    h('p', { class: 'view-head__meta' }, `Last look at ${clockTime(result.since)}.`),
    h('ul', {}, items),
    h('button', {
      type: 'button', class: 'btn btn--ghost run-section__more', dataset: { focusKey: 'mark-seen' },
      on: { click: () => { recordLook(local, true); context.rerender('tile:needs'); announce('Marked as seen.'); } },
    }, 'Mark as seen'),
  ]);
}

/** The other projects an older core gave counts only for, and the projects past the 16 summarized. @param {any} machine */
function machineNotes(machine) {
  if (machine === null || page.scope !== 'every') return [];
  const link = (/** @type {string} */ projectKey, /** @type {string} */ label) => {
    const href = hashFor({ id: 'layers-project', params: { project: projectKey } });
    return href === null ? label : h('a', { href }, label);
  };
  const counts = machine.countsOnly.flatMap((/** @type {any} */ item, /** @type {number} */ i) => [
    i === 0 ? null : '; ', link(item.projectKey, item.label), ` ${item.open} open${item.awaiting > 0 ? `, ${item.awaiting} waiting` : ''}`,
  ]);
  return [
    machine.countsOnly.length > 0 ? h('p', { class: 'view-note', dataset: { note: 'counts-only' } }, ['Other projects, counts only (this DoFlow core lists no runs): ', ...counts, '.']) : null,
    machine.notShown > 0 ? h('p', { class: 'view-note', dataset: { note: 'not-shown' } }, [
      `${machine.notShown} more ${machine.notShown === 1 ? 'project is' : 'projects are'} not shown here. `, h('a', { href: '#/layers' }, 'Layers'), ' lists every project.',
    ]) : null,
  ];
}

/** @param {any} data @param {any} context */
function homeContent(data, context) {
  const machine = machineRuns(data.machine ?? null);
  const runs = shownRuns(data);
  context.merged = machine !== null && page.scope === 'every';
  const groups = groupRuns(runs);
  const counts = countRuns(runs, context.now);
  const facts = tileFacts(runs, context.now);
  const filter = page.filter;
  const unreadable = data.unreadableCount;
  return [
    toolbar(machine, context),
    savedBar('runs', {
      current: currentFilter,
      apply: (filter, focusKey) => { setFilter(filter); context.rerender(focusKey); context.retitle(); },
      redraw: (focusKey) => context.rerender(focusKey),
    }),
    digestStrip(data, machine, context),
    h('div', { class: 'summary', role: 'group', 'aria-label': 'Filter runs by state' }, SECTION_ORDER.map((id) => tile(id, counts[/** @type {'needs'} */ (id)], facts[id], context, id === 'running' ? counts.stale : 0))),
    filter
      ? h('div', { class: 'filter-status' }, [
        h('span', {}, SECTIONS[filter].sentence),
        h('button', { type: 'button', class: 'btn btn--ghost', dataset: { focusKey: 'filter-clear' }, on: { click: () => { page.filter = null; context.rerender(`tile:${filter}`); } } }, 'Show all runs'),
      ])
      : null,
    SECTION_ORDER.filter((id) => !filter || filter === id).map((id) => section(id, groups[id], context)),
    machineNotes(machine),
    unreadable > 0
      ? h('p', { class: 'view-note view-note--unreadable' }, [icon('unknown', 16), `${unreadable} ${unreadable === 1 ? 'run' : 'runs'} could not be read.`])
      : null,
  ];
}

/**
 * The loaded home. A tile or a "Show ..." button rebuilds the content in place and keeps focus by its key.
 * @param {any} data `{ runs, unreadableCount, workflows }` from `loadHome`
 * @param {{ badge: (run: any, nowMs: number) => any, local: any, retitle?: () => void }} context the badge, the view's memory, and what sets the title again after a scope chip
 */
function renderHome(data, { badge, local, retitle = () => {} }) {
  const root = h('div', { class: 'home' });
  const now = Date.now();
  if (!(local.workflows instanceof Map)) local.workflows = data.workflows instanceof Map ? data.workflows : new Map();
  local.homeRuns = data.runs;
  const machine = machineRuns(data.machine ?? null);
  // Every row Now can show, whatever the scope: the look and the digest compare them all (the scope only filters what is drawn).
  local.lookRows = machine === null ? null : [...ownRows(data.runs, machine.currentKey, machine.currentLabel), ...machine.others];
  if (local.base === undefined) local.base = readSeen();
  watchVisibility(local);
  armLook(local);
  let changed = ingest({ ...data, workflows: local.workflows }, local, now);
  /** @type {any} */
  const context = { now, local, badge, rowIndex: 0, changed, retitle };
  const build = (at = Date.now()) => {
    // A saved filter chosen in the palette (FR-B2) waits here until Now draws.
    const asked = take('runs');
    if (asked !== null) setFilter(asked);
    context.rowIndex = 0;
    context.loop = true;
    context.changed = changed;
    context.now = at;
    mount(root, homeContent(data, context));
    local.homeStale = staleKeys(data.runs, at);
    changed = new Map(); // a rebuild for a filter must not replay the change marks
  };
  // A run can turn stale by age alone while no poll lands: the tick asks for a rebuild then, keeping focus.
  local.homeRebuild = (/** @type {number} */ at) => {
    const active = root.ownerDocument && root.ownerDocument.activeElement;
    const focusKey = active && root.contains(active) && active.dataset ? active.dataset.focusKey : null;
    build(at);
    const target = focusKey ? root.querySelector(`[data-focus-key="${focusKey}"]`) : null;
    if (target) target.focus({ preventScroll: true });
  };
  context.rerender = (/** @type {string} */ focusKey) => {
    build();
    const target = root.querySelector(`[data-focus-key="${focusKey}"]`);
    if (target) target.focus({ preventScroll: true });
  };
  // The palette asks the Now that is shown; a Now no longer on the page leaves the request to the next one.
  follow('runs', () => {
    if (root.isConnected === false) return;
    local.homeRebuild(Date.now());
    retitle();
  });
  // j and k are read on the document (keys.js), so they work while the focus is on the body, as after a hash navigation.
  local.stepRows = () => rowLinks(root);
  build();
  return root;
}

// ---- the look (FR-A4) ------------------------------------------------------------------------------------------------------

/**
 * Stores the look of the rows Now holds. `asBase` (Mark as seen) also makes it what the digest compares with, so the strip empties;
 * the look after 2 s visible does not, so the strip stays while it is read. @param {any} local @param {boolean} [asBase]
 */
function recordLook(local, asBase = false) {
  if (!Array.isArray(local.lookRows)) return;
  const look = nextSeen(local.lookRows, Date.now());
  writeSeen(look);
  if (asBase) local.base = look;
}

/** A look 2 s after the rows were drawn, while the tab is visible; a hidden tab records none. @param {any} local */
function armLook(local) {
  if (local.lookTimer) globalThis.clearTimeout(local.lookTimer);
  local.lookTimer = null;
  if (!Array.isArray(local.lookRows) || globalThis.document.hidden === true) return;
  local.lookTimer = globalThis.setTimeout(() => {
    local.lookTimer = null;
    recordLook(local);
  }, LOOK_MS);
}

/** Back to the tab: the digest compares with the last look again, and a new look is armed; hidden: none is. @param {any} local */
function watchVisibility(local) {
  if (local.onVisibility) return;
  local.onVisibility = () => {
    if (globalThis.document.hidden === true) {
      armLook(local);
      return;
    }
    local.base = readSeen();
    if (typeof local.homeRebuild === 'function') local.homeRebuild(Date.now());
    armLook(local);
  };
  globalThis.document.addEventListener('visibilitychange', local.onVisibility);
}

/** `spec.teardown`: the look timer and the visibility listener end with the view. @param {any} local */
function teardownHome(local) {
  if (local.lookTimer) globalThis.clearTimeout(local.lookTimer);
  local.lookTimer = null;
  if (local.onVisibility) globalThis.document.removeEventListener('visibilitychange', local.onVisibility);
  local.onVisibility = null;
}

/** The loading placeholder (E.1 section 6.6): the strip, a section title and a list block. */
function skeletonHome() {
  return h('div', { class: 'skeleton skeleton--home' }, [
    h('div', { class: 'summary' }, [skel('skel--tile'), skel('skel--tile'), skel('skel--tile')]),
    skel('skel--title'),
    skel('skel--list'),
  ]);
}

export {
  loadHome, homeOf, connectHome, renderHome, skeletonHome, homeKey, tickHome, teardownHome, resetHome, syncWatch, shownRuns, homeEmpty, FINISHED_CAP, WORKFLOWS_RETRY_MS, LOOK_MS,
};
