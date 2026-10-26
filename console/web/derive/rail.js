// Stage rail derivation (IC-008, design note E.1 sections 4, 6.1, 7 and 8): pure functions over the registry
// workflow, a run row and its timeline. No DOM and no fetch, so console/test/derive-rail.test.ts runs it in Node.

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);
/** The timeline actions that give a node its own event (IC-012). */
const NODE_ACTIONS = Object.freeze({ stage: ['complete-stage', 'skip-stage'], gate: ['decide-gate', 'skip-gate'] });

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const isCount = (/** @type {any} */ value) => Number.isInteger(value) && value >= 0;
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const capital = (/** @type {string} */ text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The run state, or `stale` when the run is RUNNING and its record was last updated over 24 h before `nowMs`.
 * @param {any} row
 * @param {number} nowMs
 */
function runToken(row, nowMs) {
  const updated = timeOf(row && row.updatedAt);
  return row && row.state === 'RUNNING' && Number.isFinite(updated) && nowMs - updated > DAY_MS ? 'stale' : String(row && row.state);
}

/**
 * The program of a workflow: each stage, then its gates after it, in order. Null when the body has no stages.
 * @param {any} workflow
 * @returns {any[] | null}
 */
function programOf(workflow) {
  if (!isObject(workflow) || !Array.isArray(workflow.stages)) return null;
  /** @type {any[]} */
  const nodes = [];
  for (const stage of workflow.stages) {
    nodes.push({ type: 'stage', id: stage.id, kind: stage.kind, optional: stage.optional === true });
    for (const gate of Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []) nodes.push({ type: 'gate', id: gate.id, kind: gate.kind, optional: false });
  }
  return nodes;
}

/** How many steps a workflow runs through, or null without a readable workflow. @param {any} workflow */
function programLength(workflow) {
  const program = programOf(workflow);
  return program === null ? null : program.length;
}

/**
 * The index of the node the row stands on: past the end for COMPLETED, the node whose type and id equal `row.current`
 * otherwise, and -1 when there is none.
 * @param {any[]} nodes
 * @param {any} row
 */
function findCursor(nodes, row) {
  if (row.state === 'COMPLETED') return nodes.length;
  const current = row.current;
  if (!isObject(current)) return -1;
  return nodes.findIndex((node) => node.type === current.type && node.id === current.id);
}

/**
 * Whether the cursor can be where the run state puts it (IC-008 defines RUNNING on a stage and AWAITING_GATE or
 * REJECTED on a gate; any other pair reads as "not found").
 * @param {any[]} nodes
 * @param {number} cursor
 * @param {string} state
 */
function cursorFitsState(nodes, cursor, state) {
  if (state === 'COMPLETED') return cursor === nodes.length;
  const node = nodes[cursor];
  if (!node) return false;
  return state === 'RUNNING' ? node.type === 'stage' : node.type === 'gate';
}

/**
 * The rail of one run. `nodes` and `degraded` are IC-008's; `cursor` and `runToken` are additive. `degraded` is
 * `shape-mismatch`, `cursor-mismatch`, or (additive) `workflow-unavailable` when the workflow body has no stages.
 * @param {any} workflow
 * @param {any} row
 * @param {any} [timeline] the run route's timeline body, or null (the home has none)
 * @param {number} [nowMs]
 */
function deriveRail(workflow, row, timeline = null, nowMs = Date.now()) {
  const token = runToken(row, nowMs);
  const program = programOf(workflow);
  if (program === null) return { nodes: [], degraded: 'workflow-unavailable', cursor: -1, runToken: token };
  const state = row.state;
  const total = isObject(row.progress) ? row.progress.total : undefined;
  const done = isObject(row.progress) ? row.progress.done : undefined;
  const cursor = findCursor(program, row);

  /** @type {string | null} */
  let degraded = null;
  if (program.length !== total) degraded = 'shape-mismatch';
  else if (!RUN_STATES.includes(state) || !isCount(done) || cursor !== done || !cursorFitsState(program, cursor, state)) degraded = 'cursor-mismatch';

  const events = isObject(timeline) && Array.isArray(timeline.events) ? timeline.events : [];
  const nodes = program.map((node, index) => {
    /** @type {string} */
    let nodeState = 'pending';
    if (index < cursor) nodeState = 'done';
    else if (index === cursor) nodeState = state === 'RUNNING' ? (token === 'stale' ? 'stale' : 'running') : state === 'AWAITING_GATE' ? 'awaiting' : state === 'REJECTED' ? 'rejected' : 'pending';
    else if (state === 'REJECTED') nodeState = 'not-reached';
    return { ...node, state: nodeState, outcome: null, synthetic: false, decision: null, forced: false, at: null, durationMs: null, since: null };
  });

  if (events.length > 0) {
    nodes.forEach((node, index) => {
      if (node.state !== 'done' && node.state !== 'rejected') return;
      const actions = NODE_ACTIONS[/** @type {'stage' | 'gate'} */ (node.type)];
      let at = -1;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (isObject(events[i]) && events[i].node === node.id && actions.includes(events[i].action)) {
          at = i;
          break;
        }
      }
      if (at === -1) return;
      const event = events[at];
      node.at = typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? event.at : null;
      const before = at > 0 && isObject(events[at - 1]) ? timeOf(events[at - 1].at) : Number.NaN;
      const own = timeOf(event.at);
      node.durationMs = Number.isFinite(own) && Number.isFinite(before) ? Math.max(0, own - before) : null;
      if (node.state === 'done' && (event.action === 'skip-stage' || event.action === 'skip-gate')) node.state = 'skipped';
      else if (node.type === 'stage') {
        node.outcome = typeof event.outcome === 'string' ? event.outcome : null;
        node.synthetic = event.synthetic === true;
      } else {
        node.decision = typeof event.decision === 'string' ? event.decision : null;
        node.forced = event.forced === true;
      }
    });
    const last = events[events.length - 1];
    const cursorNode = nodes[cursor];
    if (cursorNode && isObject(last) && typeof last.at === 'string' && Number.isFinite(Date.parse(last.at))) cursorNode.since = last.at;
  }
  return { nodes, degraded, cursor, runToken: token };
}

/**
 * "4 min", "under 1 s": floored figures; null stays null.
 * @param {number | null} ms
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return 'under 1 s';
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)} s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)} min`;
  if (clamped < DAY_MS) {
    const hours = Math.floor(clamped / 3_600_000);
    const minutes = Math.floor((clamped % 3_600_000) / 60_000);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  const days = Math.floor(clamped / DAY_MS);
  const hours = Math.floor((clamped % DAY_MS) / 3_600_000);
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

/**
 * A running or waiting duration at minute granularity, so a screen reader is not given a new string every second.
 * @param {number} ms
 */
function liveDuration(ms) {
  return ms < 60_000 ? 'under 1 min' : /** @type {string} */ (formatDuration(ms));
}

/** @param {any} row */
function progressOf(row) {
  const progress = isObject(row) && isObject(row.progress) ? row.progress : {};
  return { done: isCount(progress.done) ? progress.done : null, total: isCount(progress.total) ? progress.total : null };
}

/** The step the row is on, as a figure for display: `done + 1`, or `done` once COMPLETED. @param {any} row */
function stepNumber(row) {
  const { done } = progressOf(row);
  if (done === null) return null;
  return row.state === 'COMPLETED' ? done : done + 1;
}

/**
 * The one-line step text of a row (E.1 section 4).
 * @param {any} row
 */
function stepText(row) {
  const { done, total } = progressOf(row);
  if (done === null || total === null) return 'Progress unknown';
  const id = isObject(row.current) && typeof row.current.id === 'string' ? row.current.id : null;
  if (row.state === 'COMPLETED') return `${total} of ${total} steps`;
  if (row.state === 'REJECTED') return id ? `Stopped at ${id}` : `Step ${done + 1} of ${total}`;
  return id ? `Step ${done + 1} of ${total} · ${id}` : `Step ${done + 1} of ${total}`;
}

/** "Step 5 of 9" from the row's progress (the step is `done + 1`, or `done` once COMPLETED). @param {any} row */
function stepHead(row) {
  const { total } = progressOf(row);
  const step = stepNumber(row);
  return step === null || total === null ? 'Progress unknown' : `Step ${step} of ${total}`;
}

/**
 * The text of the fallback line (E.1 section 5.5).
 * @param {any} row
 * @param {string | null} reason `shape-mismatch`, `cursor-mismatch`, or null for "no workflow"
 */
function fallbackText(row, reason) {
  const tail = reason === 'shape-mismatch' ? 'workflow changed' : reason === 'cursor-mismatch' ? 'position unconfirmed' : 'workflow unavailable';
  return `${stepHead(row)} \u00b7 ${tail}`;
}

/**
 * Indexes whose state differs between two state arrays; empty without a previous array or on a different count.
 * @param {string[] | null | undefined} prev
 * @param {string[]} next
 * @returns {Set<number>}
 */
function changedNodes(prev, next) {
  /** @type {Set<number>} */
  const changed = new Set();
  if (!Array.isArray(prev) || prev.length !== next.length) return changed;
  next.forEach((state, index) => {
    if (state !== prev[index]) changed.add(index);
  });
  return changed;
}

// ---- state words (E.1 section 7.3) ------------------------------------------------------------------

/** @type {Record<string, string>} */
const OUTCOME_WORD = { passed: 'passed', failed: 'failed', unverified: 'unverified' };

/**
 * The state word of a node with its detail extras: "Done, passed, imported", "Approved, forced".
 * @param {any} node
 */
function stateWord(node) {
  switch (node.state) {
    case 'done': {
      if (node.type === 'gate') return node.forced ? 'Approved, forced' : 'Approved';
      const parts = ['Done'];
      if (node.outcome && OUTCOME_WORD[node.outcome]) parts.push(OUTCOME_WORD[node.outcome]);
      if (node.synthetic) parts.push('imported');
      return parts.join(', ');
    }
    case 'running': return 'Running';
    case 'stale': return 'Running, silent for over a day';
    case 'awaiting': return 'Waiting for you';
    case 'rejected': return 'Rejected';
    case 'skipped': return 'Skipped';
    case 'not-reached': return 'Not reached: the run was rejected';
    default: return 'Not started';
  }
}

/** "Stage", "Stage, optional", "Approval gate" or "Clarification gate". @param {any} node */
function kindWord(node) {
  if (node.type === 'stage') return node.optional ? 'Stage, optional' : 'Stage';
  return node.kind === 'clarification' ? 'Clarification gate' : 'Approval gate';
}

/**
 * The accessible name of a full-rail node: position, id, kind, state, then duration (E.1 section 7.2).
 * @param {any} node
 * @param {number} index
 * @param {number} count
 * @param {number} nowMs
 */
function nodeName(node, index, count, nowMs) {
  const parts = [`${index + 1} of ${count}`, node.id, kindWord(node), stateWord(node)].map((part) => `${part}.`);
  const since = timeOf(node.since);
  if ((node.state === 'running' || node.state === 'awaiting') && Number.isFinite(since)) {
    parts[3] = `${stateWord(node)} for ${liveDuration(Math.max(0, nowMs - since))}.`;
  } else if (node.state === 'done' || node.state === 'rejected') {
    const duration = formatDuration(node.durationMs);
    parts.push(duration === null ? 'Time not recorded.' : `${capital(duration)} after the previous event.`);
  }
  return parts.join(' ');
}

// ---- the runs home: grouping, order, descriptions (E.1 section 6 and 7.1) ------------------------------

/** `<slug>/<taskId>`, the key of a run in memory and in focus keys; a flat run has `-` for the slug. @param {any} run */
function runKey(run) {
  return `${run.featureSlug ?? '-'}/${run.taskId}`;
}

/** The section a run belongs to, or null for a state outside the four. @param {any} run */
function sectionOf(run) {
  if (run.state === 'AWAITING_GATE') return 'needs';
  if (run.state === 'RUNNING') return 'running';
  return run.state === 'COMPLETED' || run.state === 'REJECTED' ? 'finished' : null;
}

/**
 * The runs of each section in display order: Needs you oldest first, the others newest first; a null or unparsable
 * time sorts last; ties break by task id ascending.
 * @param {any[]} runs
 */
function groupRuns(runs) {
  /** @type {Record<string, any[]>} */
  const groups = { needs: [], running: [], finished: [] };
  for (const run of runs) {
    const section = sectionOf(run);
    if (section !== null) groups[section].push(run);
  }
  for (const [section, list] of Object.entries(groups)) {
    const ascending = section === 'needs';
    list.sort((/** @type {any} */ a, /** @type {any} */ b) => {
      const [ta, tb] = [timeOf(a.updatedAt), timeOf(b.updatedAt)];
      const [ka, kb] = [Number.isFinite(ta), Number.isFinite(tb)];
      if (ka !== kb) return ka ? -1 : 1;
      if (ka && ta !== tb) return ascending ? ta - tb : tb - ta;
      return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
    });
  }
  return groups;
}

/** @type {Record<string, string>} */
const RUN_WORDS = { RUNNING: 'Running', AWAITING_GATE: 'Waiting for you', COMPLETED: 'Completed', REJECTED: 'Rejected' };

/**
 * The badge word of a run: "Stale" for a RUNNING run silent over a day.
 * @param {any} run
 * @param {number} nowMs
 */
function runWord(run, nowMs) {
  return runToken(run, nowMs) === 'stale' ? 'Stale' : RUN_WORDS[run.state] ?? 'Unknown';
}

/** @param {number} n @param {string} unit */
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * "less than a minute ago", "2 minutes ago", "3 hours ago", "2 days ago": minute granularity.
 * @param {number} ms
 */
function agoText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  if (minutes < 1440) return `${plural(Math.floor(minutes / 60), 'hour')} ago`;
  return `${plural(Math.floor(minutes / 1440), 'day')} ago`;
}

/** @param {any} row */
function stepSentence(row) {
  const { done, total } = progressOf(row);
  if (done === null || total === null) return 'Progress unknown';
  const current = isObject(row.current) ? row.current : null;
  if (row.state === 'COMPLETED') return `${total} of ${total} steps`;
  if (row.state === 'REJECTED') return current && current.id ? `Stopped at ${current.id}` : `Step ${done + 1} of ${total}`;
  if (!current || !current.id) return `Step ${done + 1} of ${total}`;
  return `Step ${done + 1} of ${total}, ${current.type} ${current.id}${current.type === 'gate' && current.kind ? `, ${current.kind}` : ''}`;
}

const DEGRADED_SENTENCE = Object.freeze({
  'shape-mismatch': 'Workflow changed since this run started.',
  'cursor-mismatch': 'Position not confirmed.',
  unavailable: 'Workflow unavailable.',
  'workflow-unavailable': 'Workflow unavailable.',
});

/** The reason sentence of a degraded rail ("Position not confirmed."), or null. @param {string | null} reason */
function degradedSentence(reason) {
  return reason ? /** @type {any} */ (DEGRADED_SENTENCE)[reason] ?? null : null;
}

/**
 * The row description read on focus, one sentence per part: workflow name, state word, step, time, then the
 * degraded rail, flat-run and other-checkout notes.
 * @param {any} run
 * @param {{ workflowName: string, nowMs: number, degraded: string | null, timeText: string }} options
 *   `degraded`: `shape-mismatch`, `cursor-mismatch`, `unavailable`, or null; `timeText`: "Updated ..." from the caller
 */
function describeRun(run, { workflowName, nowMs, degraded, timeText }) {
  const parts = [workflowName, runWord(run, nowMs), stepSentence(run), timeText];
  if (degraded && /** @type {any} */ (DEGRADED_SENTENCE)[degraded]) parts.push(/** @type {any} */ (DEGRADED_SENTENCE)[degraded].replace(/\.$/, ''));
  if (run.featureSlug === null) parts.push('This run has no feature folder, so it cannot be opened here');
  if (run.origin === 'other') parts.push('From another checkout');
  return `${parts.join('. ')}.`;
}

/**
 * The "Updated ..." sentence of a description. Relative when the data is fresh, absolute when stale.
 * @param {any} run
 * @param {number} nowMs
 * @param {{ stale?: boolean, clock?: (ms: number) => string }} [options]
 */
function updatedText(run, nowMs, { stale = false, clock = (ms) => new Date(ms).toISOString() } = {}) {
  const at = timeOf(run.updatedAt);
  if (!Number.isFinite(at)) return 'Update time unknown';
  return stale ? `Updated at ${clock(at)}` : `Updated ${agoText(nowMs - at)}`;
}

/**
 * The count of runs per tile and the sentence for each filter.
 * @param {any[]} runs
 */
function countRuns(runs) {
  const groups = groupRuns(runs);
  return { needs: groups.needs.length, running: groups.running.length, finished: groups.finished.length };
}

// ---- gate cards, tile facts, step parts, duration lines (E.1 sections 6.2, 6.4, 6.4a, 9.0, 9.2) ----------------

/**
 * The gate a run waits at: the registry gate matched by `row.awaitingGate.gateId` (else the current gate), or, when the
 * workflow lacks it, just its id and the kind of `row.current`. Null without any gate id.
 * @param {any} workflow
 * @param {any} row
 * @returns {{ id: string, name: string | null, kind: string | null, prompt: string | null } | null}
 */
function awaitingGateOf(workflow, row) {
  const current = isObject(row && row.current) ? row.current : null;
  const id = isObject(row && row.awaitingGate) && typeof row.awaitingGate.gateId === 'string' ? row.awaitingGate.gateId : current && current.type === 'gate' ? current.id : null;
  if (typeof id !== 'string') return null;
  const stages = isObject(workflow) && Array.isArray(workflow.stages) ? workflow.stages : [];
  for (const stage of stages) {
    const gate = (Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []).find((/** @type {any} */ item) => item && item.id === id);
    if (gate) return { id, name: typeof gate.name === 'string' ? gate.name : null, kind: typeof gate.kind === 'string' ? gate.kind : null, prompt: typeof gate.prompt === 'string' ? gate.prompt : null };
  }
  return { id, name: null, kind: current && current.type === 'gate' && typeof current.kind === 'string' ? current.kind : null, prompt: null };
}

/** How long a run has waited: now minus `updatedAt`, as text ("12 min"), or null when the time is unknown. @param {any} run @param {number} nowMs */
function waitText(run, nowMs) {
  const at = timeOf(run && run.updatedAt);
  return Number.isFinite(at) ? formatDuration(Math.max(0, nowMs - at)) : null;
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local "HH:MM". @param {number} ms */
function clockHM(ms) {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Local "24 Oct 19:59": a stale run's last update is more than a day old, so the day is part of it. @param {number} ms */
function stampDM(ms) {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clockHM(ms)}`;
}

/**
 * A "since" time (R4-3): local `HH:MM` when the instant is on today's local date, `D Mon HH:MM` otherwise.
 * @param {number} ms
 * @param {number} nowMs
 */
function sinceStamp(ms, nowMs) {
  const [a, b] = [new Date(ms), new Date(nowMs)];
  const today = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return today ? clockHM(ms) : stampDM(ms);
}

/**
 * What a gate card's wait reads: the duration, or on stale data the time it has waited since (the clock stops counting),
 * or null when the time is unknown.
 * @param {any} run
 * @param {number} nowMs
 * @param {boolean} [stale]
 */
function waitStamp(run, nowMs, stale = false) {
  if (!stale) return waitText(run, nowMs);
  const at = timeOf(run && run.updatedAt);
  return Number.isFinite(at) ? sinceStamp(at, nowMs) : null;
}

/**
 * The one-sentence description of a gate card (E.1 section 7.1). On stale data the wait reads "since HH:MM" (R3-7).
 * @param {any} run
 * @param {{ gate: any, named: boolean, workflowName: string, nowMs: number, stale?: boolean }} options `named`: the gate was found in the workflow
 */
function describeGate(run, { gate, named, workflowName, nowMs, stale = false }) {
  const parts = [];
  const at = timeOf(run.updatedAt);
  const waiting = !Number.isFinite(at) ? 'Waiting for you' : stale ? `Waiting for you since ${sinceStamp(at, nowMs)}` : `Waiting for you for ${liveDuration(Math.max(0, nowMs - at))}`;
  if (named && gate && gate.name) parts.push(gate.name, gate.kind === 'clarification' ? 'Clarification gate' : 'Approval gate', waiting);
  else parts.push(gate && gate.id ? `Gate ${gate.id}` : 'Gate', waiting);
  const { done, total } = progressOf(run);
  parts.push(done === null || total === null ? workflowName : `${workflowName}, step ${stepNumber(run)} of ${total}`);
  if (run.origin === 'other') parts.push('From another checkout');
  return `${parts.join('. ')}.`;
}

/**
 * The fact each summary tile states (E.1 section 6.2): `long` from 768, `short` below it, and the visually hidden
 * `prefix` the short form needs to be read whole.
 * On stale data (R3-7) the durations that grow with the clock read "since": "waiting since 19:59", "no update since 24 Oct 19:59".
 * @param {any[]} runs
 * @param {number} nowMs
 * @param {{ stale?: boolean }} [options]
 */
function tileFacts(runs, nowMs, { stale = false } = {}) {
  const groups = groupRuns(runs);
  /** @param {any[]} list @returns {number | null} the oldest valid updatedAt */
  const oldest = (list) => {
    const times = list.map((run) => timeOf(run.updatedAt)).filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
  };
  /** @type {Record<string, { long: string, short: string, prefix: string }>} */
  const facts = {};
  const waiting = groups.needs;
  const first = oldest(waiting);
  facts.needs = waiting.length === 0
    ? { long: 'nothing waiting', short: 'nothing waiting', prefix: '' }
    : first === null
      ? { long: 'wait unknown', short: 'wait unknown', prefix: '' }
      : stale
        ? { long: `waiting since ${sinceStamp(first, nowMs)}`, short: sinceStamp(first, nowMs), prefix: 'waiting since ' }
        : { long: `longest wait ${formatDuration(nowMs - first)}`, short: /** @type {string} */ (formatDuration(nowMs - first)), prefix: 'longest wait ' };
  const staleRuns = groups.running.filter((run) => runToken(run, nowMs) === 'stale');
  const silent = oldest(staleRuns);
  facts.running = groups.running.length === 0
    ? { long: 'nothing running', short: 'nothing running', prefix: '' }
    : staleRuns.length === 0
      ? { long: 'all updating', short: 'all updating', prefix: '' }
      : { long: silent === null ? `${staleRuns.length} stale` : `${staleRuns.length} stale, no update ${stale ? `since ${sinceStamp(silent, nowMs)}` : `for ${formatDuration(nowMs - silent)}`}`, short: `${staleRuns.length} stale`, prefix: '' };
  const completed = groups.finished.filter((run) => run.state === 'COMPLETED').length;
  const rejected = groups.finished.length - completed;
  facts.finished = groups.finished.length === 0
    ? { long: 'none yet', short: 'none yet', prefix: '' }
    : { long: `${completed} completed, ${rejected} rejected`, short: rejected > 0 ? `${rejected} rejected` : `${completed} completed`, prefix: '' };
  return facts;
}

/**
 * The step part of a row's meta: RUNNING or AWAITING the current id, COMPLETED "all steps done", REJECTED "stopped at <id>".
 * `lead` is plain text, `id` is set in mono; both empty when the run has no current node.
 * @param {any} row
 * @returns {{ lead: string, id: string | null }}
 */
function stepPart(row) {
  const id = isObject(row.current) && typeof row.current.id === 'string' ? row.current.id : null;
  if (row.state === 'COMPLETED') return { lead: 'all steps done', id: null };
  if (row.state === 'REJECTED') return id ? { lead: 'stopped at ', id } : { lead: '', id: null };
  return { lead: '', id };
}

/** "6/9", or null without progress. @param {any} row */
function stepFraction(row) {
  const { total } = progressOf(row);
  const step = stepNumber(row);
  return step === null || total === null ? null : `${step}/${total}`;
}

/**
 * The step copy of the run head (E.1 section 9.0): the numeral is large except when COMPLETED. Null without progress.
 * @param {any} row
 * @returns {{ lead: string, n: number | null, tail: string } | null}
 */
function runStepCopy(row) {
  const { total } = progressOf(row);
  const step = stepNumber(row);
  if (step === null || total === null) return null;
  if (row.state === 'COMPLETED') return { lead: `all ${total} steps done`, n: null, tail: '' };
  return { lead: row.state === 'REJECTED' ? 'stopped at step ' : 'step ', n: step, tail: ` of ${total}` };
}

/**
 * The duration line under a node of the full rail (E.1 section 9.2): text, and which fg it takes.
 * @param {any} node
 * @param {number} nowMs
 * @returns {{ text: string, tone: 'running' | 'stale' | 'awaiting' | null }}
 */
function durationLine(node, nowMs) {
  const dash = '–';
  if (node.state === 'pending' || node.state === 'not-reached') return { text: ' ', tone: null };
  if (node.state === 'skipped') return { text: 'skipped', tone: null };
  if (node.state === 'running' || node.state === 'stale' || node.state === 'awaiting') {
    const since = timeOf(node.since);
    return Number.isFinite(since) ? { text: `for ${liveDuration(Math.max(0, nowMs - since))}`, tone: /** @type {any} */ (node.state) } : { text: dash, tone: null };
  }
  const duration = formatDuration(node.durationMs);
  return { text: duration === null ? dash : duration, tone: null };
}

export {
  DAY_MS, deriveRail, programOf, programLength, runToken, formatDuration, liveDuration, stepText, stepNumber, stepHead, fallbackText,
  changedNodes, stateWord, kindWord, nodeName, degradedSentence, runKey, sectionOf, groupRuns, runWord, agoText, describeRun, updatedText, countRuns,
  progressOf, awaitingGateOf, waitText, waitStamp, sinceStamp, clockHM, stampDM, describeGate, tileFacts, stepPart, stepFraction, runStepCopy, durationLine,
};
