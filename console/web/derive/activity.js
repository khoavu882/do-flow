// Current-activity derivation (IC-009, design note E.2 sections 4, 8.1 and 11.2): what the run is doing right now,
// from the run row, the registry workflow, the timeline and the task attempts. Pure functions: no DOM, no fetch and
// no clock reads (the caller passes `nowMs`), so console/test/derive-activity.test.ts runs it in Node.

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const lower = (/** @type {string} */ text) => text.charAt(0).toLowerCase() + text.slice(1);

/** At most this many attempts are listed in the slot; the rest are counted. */
const ATTEMPT_LIMIT = 8;

/** The result words of an attempt that finished, and the state words of one that ended without a result. */
const RESULT_WORD = Object.freeze({ COMPLETED: 'completed', BLOCKED: 'blocked', ABANDONED: 'abandoned', INCONCLUSIVE: 'inconclusive', FAILED: 'failed' });

/** A note moves nothing (E.2 Q1); every other action is a progress event. @param {any} event */
const isProgress = (event) => isObject(event) && event.action !== 'annotate';

/**
 * The words of one timeline event (E.2 section 8.1). The note text is never sent (IC-012).
 * @param {any} event
 */
function eventWords(event) {
  const node = typeof event.node === 'string' ? event.node : null;
  const mark = event.synthetic === true ? ', imported' : '';
  switch (event.action) {
    case 'start': return `Run started${mark}`;
    case 'complete-stage': return `${node ?? 'A stage'} completed${typeof event.outcome === 'string' ? `, ${event.outcome}` : ''}${mark}`;
    case 'skip-stage':
    case 'skip-gate': return `${node ?? 'A step'} skipped${mark}`;
    case 'decide-gate': return `${node ?? 'A gate'} ${event.decision === 'reject' ? 'rejected' : 'approved'}${event.decision !== 'reject' && event.forced === true ? ', forced' : ''}${mark}`;
    case 'annotate': return `${node === null ? 'Note added' : `Note added on ${node}`}${mark}`;
    case 'complete-run': return `Run completed${mark}`;
    default: return `${String(event.action)}${mark}`;
  }
}

/**
 * The same words as the clause of a sentence ("Running since 13:43, when gate-a was approved").
 * @param {any} event
 */
function clauseWords(event) {
  const node = typeof event.node === 'string' ? event.node : null;
  if (event.action === 'start') return 'the run started';
  if (event.action === 'annotate') return node === null ? 'a note was added' : `a note was added on ${node}`;
  if (event.action === 'complete-run') return 'the run completed';
  const words = eventWords(event);
  const passive = /^(\S+) (skipped|approved|rejected)(.*)$/.exec(words);
  if (passive) return `${passive[1]} was ${passive[2]}${passive[3]}`;
  return lower(words);
}

/**
 * The two complete decide lines of a gate (E.2 Q2). They need only the run id and the gate id.
 * @param {any} row
 */
function decideCommands(row) {
  const current = isObject(row) && isObject(row.current) ? row.current : null;
  if (current === null || typeof row.taskId !== 'string' || typeof current.id !== 'string') return null;
  const base = `doflow orchestrate --action decide-gate --task-id ${row.taskId} --gate ${current.id} --decision`;
  return { approve: `${base} approve`, reject: `${base} reject` };
}

/**
 * Every active attempt of the plan, oldest first (ties by task id), at most `limit` shown and the rest counted.
 * `attemptNo` is the 1-based position of the attempt in its task's ledger. Null without a task plan.
 * @param {any} tasks the run route's `tasks` body, or null
 * @param {number} [limit]
 * @returns {{ shown: any[], more: number } | null}
 */
function attemptRows(tasks, limit = ATTEMPT_LIMIT) {
  if (!isObject(tasks) || !Array.isArray(tasks.tasks)) return null;
  /** @type {any[]} */
  const rows = [];
  for (const task of tasks.tasks) {
    const attempts = isObject(task) && Array.isArray(task.attempts) ? task.attempts : [];
    attempts.forEach((/** @type {any} */ attempt, /** @type {number} */ index) => {
      if (isObject(attempt) && attempt.state === 'active') rows.push({ taskId: task.id, owner: attempt.owner ?? null, mode: attempt.mode ?? null, attemptNo: index + 1, startedAt: attempt.startedAt ?? null });
    });
  }
  const rank = (/** @type {any} */ row) => { const at = timeOf(row.startedAt); return Number.isFinite(at) ? at : Infinity; };
  rows.sort((a, b) => (rank(a) === rank(b) ? String(a.taskId).localeCompare(String(b.taskId), 'en', { numeric: true }) : rank(a) < rank(b) ? -1 : 1));
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** The registry stages of a workflow body (empty when it could not be read). @param {any} workflow */
const stagesOf = (workflow) => (isObject(workflow) && Array.isArray(workflow.stages) ? workflow.stages : []);

/**
 * The slot's node, from the registry and never from `run.awaitingGate` (the journal copy). A step the registry does
 * not hold is `{ missing: true }` with its other fields null; the id and kind still come from `row.current`.
 * @param {any} row
 * @param {any} workflow
 * @param {any} current `row.current`
 */
function nodeOf(row, workflow, current) {
  if (!isObject(current) || typeof current.id !== 'string') return null;
  const stages = stagesOf(workflow);
  if (current.type === 'gate') {
    for (const stage of stages) {
      const entry = (Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []).find((/** @type {any} */ item) => isObject(item) && item.id === current.id);
      if (entry) return { type: 'gate', id: current.id, name: entry.name ?? null, kind: entry.kind ?? current.kind ?? null, prompt: entry.prompt ?? null, after: stage.id ?? null };
    }
    return { type: 'gate', id: current.id, missing: true, name: null, kind: typeof current.kind === 'string' ? current.kind : null, prompt: null, after: null };
  }
  const index = stages.findIndex((/** @type {any} */ stage) => isObject(stage) && stage.id === current.id);
  const count = stages.length > 0 ? stages.length : null;
  if (index >= 0) {
    const entry = stages[index];
    return { type: 'stage', id: current.id, skill: entry.skill ?? null, agent: entry.agent ?? null, purpose: entry.purpose ?? null, index: index + 1, count };
  }
  return { type: 'stage', id: current.id, missing: true, skill: null, agent: null, purpose: null, index: null, count };
}

/**
 * IC-009. `since` is the time of the last progress event; `waitedMs` is `nowMs - since` (never below zero) and null
 * without one. `lastEvent` is the literal last event, a note included. A finished run's `waitedMs` is how long the run
 * took (COMPLETED) or how long the rejecting gate waited (REJECTED).
 * @param {any} row the run route's `run`
 * @param {any} workflow the registry workflow body
 * @param {any} timeline the timeline body, or null when it could not be read
 * @param {any} tasks the `tasks` body, or null
 * @param {number} nowMs
 */
function deriveActivity(row, workflow, timeline, tasks, nowMs) {
  const state = row.state;
  const kind = state === 'AWAITING_GATE' ? 'gate' : state === 'RUNNING' ? 'stage' : 'finished';
  const current = isObject(row.current) ? row.current : null;
  const available = isObject(timeline);
  /** @type {any[]} */
  const events = available && Array.isArray(timeline.events) ? timeline.events.filter(isObject) : [];

  let progressAt = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (isProgress(events[i])) {
      progressAt = i;
      break;
    }
  }
  const sinceEvent = progressAt >= 0 ? events[progressAt] : null;
  const sinceMs = sinceEvent ? timeOf(sinceEvent.at) : Number.NaN;
  const since = Number.isFinite(sinceMs) ? sinceEvent.at : null;

  /** @type {number | null} */
  let waitedMs = Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : null;
  if (kind === 'finished') {
    waitedMs = null;
    if (state === 'COMPLETED') {
      const end = [...events].reverse().find((event) => event.action === 'complete-run');
      const endMs = end ? timeOf(end.at) : Number.NaN;
      const startMs = timeOf(available && timeline.startedAt ? timeline.startedAt : row.startedAt);
      if (Number.isFinite(endMs) && Number.isFinite(startMs)) waitedMs = Math.max(0, endMs - startMs);
    } else if (progressAt >= 0) {
      let before = progressAt - 1;
      while (before >= 0 && !isProgress(events[before])) before -= 1;
      const beforeMs = before >= 0 ? timeOf(events[before].at) : Number.NaN;
      if (Number.isFinite(sinceMs) && Number.isFinite(beforeMs)) waitedMs = Math.max(0, sinceMs - beforeMs);
    }
  }

  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    kind,
    node: kind === 'finished' && state === 'COMPLETED' ? null : nodeOf(row, workflow, current),
    since,
    waitedMs,
    running: attemptRows(tasks, ATTEMPT_LIMIT),
    lastEvent: last ? { at: last.at ?? null, action: last.action, node: last.node ?? null, words: eventWords(last) } : null,
    command: kind === 'gate' ? decideCommands(row) : null,
    sinceEvent,
    journalGateDiffers: row.journalGateDiffers === true,
    origin: row.origin ?? null,
    timelineAvailable: available,
    workflowUnavailable: stagesOf(workflow).length === 0,
  };
}

/**
 * What changed among the attempts since the previous poll of this view (E.2 section 11.2): a map of
 * `<taskId>#<attemptNo>` to the attempt's state, the changes against the previous map, and the sentence to announce.
 * Nothing is announced for the first render (no previous map).
 * @param {Record<string, string> | null | undefined} prev
 * @param {any} tasks the run route's `tasks` body, or null
 * @returns {{ map: Record<string, string>, changes: Array<{ key: string, taskId: string, attemptNo: number, owner: string | null, state: string, result: string | null, started: boolean }>, sentence: string | null }}
 */
function attemptChanges(prev, tasks) {
  /** @type {Record<string, string>} */
  const map = {};
  /** @type {Array<any>} */
  const changes = [];
  const list = isObject(tasks) && Array.isArray(tasks.tasks) ? tasks.tasks : [];
  for (const task of list) {
    const attempts = isObject(task) && Array.isArray(task.attempts) ? task.attempts : [];
    attempts.forEach((/** @type {any} */ attempt, /** @type {number} */ index) => {
      if (!isObject(attempt)) return;
      const key = `${task.id}#${index + 1}`;
      map[key] = String(attempt.state);
      if (!prev) return;
      const before = prev[key];
      if (before === String(attempt.state)) return;
      if (attempt.state === 'active') changes.push({ key, taskId: task.id, attemptNo: index + 1, owner: attempt.owner ?? null, state: 'active', result: null, started: true });
      else if (before === 'active') changes.push({ key, taskId: task.id, attemptNo: index + 1, owner: attempt.owner ?? null, state: String(attempt.state), result: attempt.result ?? null, started: false });
    });
  }
  let sentence = null;
  if (changes.length === 1) {
    const change = changes[0];
    if (change.started) sentence = change.attemptNo === 1 ? `${change.taskId} started by ${change.owner ?? 'an owner'}.` : `${change.taskId} attempt ${change.attemptNo} started by ${change.owner ?? 'an owner'}.`;
    else sentence = `${change.taskId} attempt ${change.attemptNo} finished: ${(change.result && /** @type {any} */ (RESULT_WORD)[change.result]) || change.state}.`;
  } else if (changes.length > 1) sentence = `${changes.length} task attempts changed.`;
  return { map, changes, sentence };
}

/**
 * The counts line of a completed run ("3 steps: 2 passed, 1 skipped."), from the rail nodes; null without nodes.
 * @param {any[]} nodes
 */
function finishedCounts(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const count = { passed: 0, failed: 0, unverified: 0, approved: 0, forced: 0, skipped: 0 };
  for (const node of nodes) {
    if (node.state === 'skipped') count.skipped += 1;
    else if (node.state !== 'done') continue;
    else if (node.type === 'gate') count[node.forced ? 'forced' : 'approved'] += 1;
    else if (node.outcome === 'failed') count.failed += 1;
    else if (node.outcome === 'unverified') count.unverified += 1;
    else count.passed += 1;
  }
  const parts = Object.entries(count).filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`);
  return `${nodes.length} step${nodes.length === 1 ? '' : 's'}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

export { ATTEMPT_LIMIT, isProgress, eventWords, clauseWords, decideCommands, attemptRows, deriveActivity, attemptChanges, finishedCounts };
