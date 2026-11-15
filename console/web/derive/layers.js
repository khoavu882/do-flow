// Layers derivations (feature 161, design §8; FR-009, FR-010, AC-5). Pure functions over the members of the browser channels
// `machine` and `layers:<pk>` (console/src/layers-compose.ts: `{ v: 1, [projectKey,] sections }`, each section `{ ok: true, data }`
// or `{ ok: false, code }`) and over the store's transport state. Nothing here reads the DOM, a clock or a store.
//
// The words follow what a record states and never more (D5, D7): an agent is "recorded", "started", "stopped" or "process seen";
// never a word that claims the agent is up right now (D5, D7). A source the harness does not expose is `not observed` with its reason, a store
// that failed to read is `unreadable`, and "waiting for you" is an orchestration gate in `awaiting` and nothing else.
//
// This file also holds the transcript-event helpers the transcript panel (views/transcript.js, shared with the Session view's
// worker tabs) reads: the bounded event list, the redactor markers, and the words of one event.

// ---- the transcript panel's helpers --------------------------------------------------------------------------------------

/** The events a stream panel keeps (V8 7b.2). */
const MAX_EVENTS = 500;

const KIND_WORD = Object.freeze({
  'main-session': 'Main session',
  'harness-subagent': 'Subagent',
  'doflow-run': 'DoFlow run',
  'worker-run': 'Worker run',
  'child-worker-run': 'Child worker run',
});

const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/**
 * `HH:MM` for today, `Oct 24 HH:MM` for an older day, "–" for a missing or unreadable time.
 * @param {any} iso
 * @param {number} nowMs
 */
function stamp(iso, nowMs) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '–';
  const date = new Date(ms);
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return new Date(nowMs).toDateString() === date.toDateString() ? clock : `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`;
}

/** `HH:MM:SS` of an ISO time, or null. @param {any} iso */
function secondsStamp(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** @param {any} node */
function kindWord(node) {
  return /** @type {Record<string, string>} */ (KIND_WORD)[node.kind] ?? 'Agent';
}

/**
 * The title of a node: a main session is "Main session"; any other node shows the label its record states, else the kind
 * word. "Lead" is never derived.
 * @param {any} node
 */
function nodeTitle(node) {
  if (node.kind === 'main-session') return 'Main session';
  return typeof node.label === 'string' && node.label !== '' ? node.label : kindWord(node);
}

/** True when the title is a record label, so the kind word follows it as a tag. @param {any} node */
function titleIsLabel(node) {
  return node.kind !== 'main-session' && typeof node.label === 'string' && node.label !== '';
}

/**
 * One stable text for an event, to drop an event the panel already holds (a lane resent as a snapshot after a reconnect holds
 * events the panel has). @param {any} event
 */
function fingerprint(event) {
  const tool = event.tool ? [event.tool.callKey, event.tool.name, event.tool.status, event.tool.bytes, event.tool.durationMs] : null;
  return JSON.stringify([event.kind, event.at, event.model, tool, event.text, event.args, event.tokens, event.record]);
}

/** What makes a `record` event the same event again: its agent, time, record type and task. @param {any} event */
function recordIdentity(event) {
  const record = event.record || {};
  return JSON.stringify([event.agentKey, event.at, record.type, record.task]);
}

/**
 * Appends a batch to the held events and applies the bound: above `max`, the oldest are removed. `reset` starts the list
 * over. With `dedupe`, an event whose fingerprint is already held is dropped. Returns the next list, the events added,
 * how many were added and how many were dropped from the top. @param {any[]} held @param {any[]} batch @param {{ reset?: boolean, dedupe?: boolean, max?: number }} [options]
 */
function appendEvents(held, batch, options = {}) {
  const max = options.max ?? MAX_EVENTS;
  const base = options.reset ? [] : held;
  const known = options.dedupe ? new Set(base.map(fingerprint)) : null;
  // A `record` event is held once whether or not the batch is a resume: a reader that cannot raise its watermark past one
  // (Kiro) sends it again on every tick.
  const records = new Set(base.filter((event) => event.kind === 'record').map(recordIdentity));
  const fresh = batch.filter((event) => !(known && known.has(fingerprint(event))) && !(event.kind === 'record' && records.has(recordIdentity(event))));
  const all = [...base, ...fresh];
  const dropped = Math.max(0, all.length - max);
  return { events: dropped > 0 ? all.slice(dropped) : all, fresh, added: fresh.length, dropped };
}

const MARKERS = /(<masked>|<email>|<ip>)/;
/** @type {Readonly<Record<string, string>>} */
const MARKER_WORD = Object.freeze({ '<masked>': 'masked', '<email>': 'email', '<ip>': 'ip' });

/**
 * Splits text on exactly the redactor's three markers. A segment is `{ text }` or `{ mask }` with the word.
 * @param {any} text
 */
function splitMasked(text) {
  return String(text ?? '').split(MARKERS).filter((part) => part !== '').map((part) => (MARKER_WORD[part] ? { mask: MARKER_WORD[part] } : { text: part }));
}

/** Seconds with one decimal under a minute, from a millisecond count. @param {number} ms */
function seconds(ms) {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

/** "Tokens: 1,204 in · 312 out · 18,000 cache read · 0 cache write" from a usage event; a null field is left out. @param {any} tokens */
function usageLine(tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const part = (/** @type {any} */ n, /** @type {string} */ word) => (typeof n === 'number' ? `${n.toLocaleString('en-US')} ${word}` : null);
  const list = [part(t.input, 'in'), part(t.output, 'out'), part(t.cacheRead, 'cache read'), part(t.cacheWrite, 'cache write'), part(t.reasoning, 'reasoning')].filter(Boolean);
  return list.length === 0 ? 'Tokens: not recorded' : `Tokens: ${list.join(' · ')}`;
}

/** "ok · 2.4 KB · 1.2 s" pieces of a tool result (each left out when null). @param {any} tool */
function resultBits(tool) {
  const bits = [];
  if (tool && typeof tool.bytes === 'number') bits.push(tool.bytes >= 1024 ? `${(Math.round(tool.bytes / 102.4) / 10).toFixed(1)} KB` : `${tool.bytes} B`);
  if (tool && typeof tool.durationMs === 'number') bits.push(seconds(tool.durationMs));
  return bits;
}

/** The words of a `record` event. @param {any} record */
function recordWords(record) {
  const task = record && record.task ? ` for ${record.task}` : '';
  switch (record && record.type) {
    case 'hook-record': return 'hook record';
    case 'attempt-claim': return `attempt claimed${task}`;
    case 'attempt-end': return record.result ? `attempt finished, ${String(record.result).toLowerCase()}` : 'attempt released';
    case 'worker-run-start': return 'worker run started';
    case 'worker-run-end': return `worker run ended${record.result ? `, ${String(record.result).toLowerCase()}` : ''}`;
    default: return 'record';
  }
}

// ---- sections --------------------------------------------------------------------------------------------------------------

/**
 * One section of a member body as `{ state: 'ok', data }`, `{ state: 'unreadable', code }` (the section is there and failed) or
 * `{ state: 'absent' }` (no body yet, or the section is not in it).
 * @param {any} body @param {string} name
 */
function sectionOf(body, name) {
  const sections = body && typeof body === 'object' && body.sections && typeof body.sections === 'object' ? body.sections : null;
  const section = sections ? sections[name] : null;
  if (!section || typeof section !== 'object') return { state: 'absent', code: null, data: null };
  if (section.ok === true) return { state: 'ok', code: null, data: section.data };
  return { state: 'unreadable', code: typeof section.code === 'string' ? section.code : 'unknown', data: null };
}

const time = (/** @type {any} */ iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** Newest first, a missing time last, then by the key. @param {any} a @param {any} b @param {string} field @param {string} tie */
function byNewest(a, b, field, tie) {
  const [x, y] = [time(a[field]), time(b[field])];
  if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
  return String(a[tie]) < String(b[tie]) ? -1 : String(a[tie]) > String(b[tie]) ? 1 : 0;
}

// ---- the stream's states -----------------------------------------------------------------------------------------------

/** The stream states of design §8, as the tokens the views carry in `data-stream`. */
const STREAM_STATES = Object.freeze(['connecting', 'following', 'down', 'refused', 'unsupported', 'core-lacks-channel', 'paused']);

/** Channel error codes that mean the core cannot stream the channel at all (plan DEC-012). */
const NO_CHANNEL = Object.freeze(['core-lacks-channel']);

/**
 * The stream state of a Layers page: the store's transport and the error codes of the channels it follows. `hasData`: every
 * channel the page needs holds a member. An old core is `core-lacks-channel` whatever the transport says; any other channel
 * error, or a transport that is retrying or closed, is `down` (the page keeps its last members and says when they came);
 * `refused` and `unsupported` are the store's own.
 * @param {{ transport: { state: string, code: string | null } | null, errors: Array<string | null>, hasData: boolean }} input
 * @returns {{ token: string, code: string | null }}
 */
function streamState({ transport, errors, hasData }) {
  const state = transport ? transport.state : 'none';
  const code = transport && typeof transport.code === 'string' ? transport.code : null;
  const lacking = errors.find((error) => error !== null && NO_CHANNEL.includes(error));
  if (lacking !== undefined) return { token: 'core-lacks-channel', code: lacking };
  if (state === 'unsupported') return { token: 'unsupported', code };
  if (state === 'refused') return { token: 'refused', code };
  if (state === 'paused') return { token: 'paused', code: null };
  const failed = errors.find((error) => error !== null);
  if (failed !== undefined) return { token: 'down', code: failed };
  if (state === 'retrying' || state === 'closed') return { token: 'down', code };
  return { token: hasData ? 'following' : 'connecting', code: null };
}

/** The title and sentence of each stream state that is not `following` (the `.state-panel` of design §8). */
const STREAM_COPY = Object.freeze({
  connecting: { title: 'Connecting', sentence: 'Waiting for the first record from the Console. Layers only shows what the stream sends; there is no page to read instead.' },
  down: { title: 'Stream down', sentence: 'The Console is not sending. The page retries by itself and keeps the last records below.' },
  refused: { title: 'This tab cannot follow', sentence: 'The Console refused this stream.' },
  unsupported: { title: 'Streaming is not available', sentence: 'This browser or this DoFlow core cannot hold a stream, and Layers has no polling fallback.' },
  'core-lacks-channel': { title: 'This DoFlow core cannot stream Layers', sentence: 'The installed DoFlow core is older than the Layers stream. Update the core, then reload this page.' },
  paused: { title: 'Paused', sentence: 'Updates are paused. The records below are the last ones received; resume to follow again.' },
});

/** The sentence of a `refused` state by its code. @type {Readonly<Record<string, string>>} */
const REFUSED_SENTENCE = Object.freeze({
  'stream-limit': 'This Console already holds as many streams as it allows. Close another Console tab, then it connects again by itself.',
  'retry-limit': 'The stream dropped three times in a row without a record. The page tries again every 30 seconds.',
});

/** The sentence of an `unsupported` state by its code. @type {Readonly<Record<string, string>>} */
const UNSUPPORTED_SENTENCE = Object.freeze({
  'no-eventsource': 'This browser cannot follow a stream, and Layers has no polling fallback.',
  'live-unavailable': 'The DoFlow core in this project cannot stream (it is older than the Console needs). Update the core, then reload.',
});

/** The state panel copy of a stream state: `{ title, sentence }`, or null for `following`. @param {{ token: string, code: string | null }} state */
function streamCopy(state) {
  const copy = /** @type {Record<string, { title: string, sentence: string }>} */ (STREAM_COPY)[state.token];
  if (!copy) return null;
  if (state.token === 'refused') return { title: copy.title, sentence: (state.code && REFUSED_SENTENCE[state.code]) || `${copy.sentence} This device may not be allowed to read the stream.` };
  if (state.token === 'unsupported') return { title: copy.title, sentence: (state.code && UNSUPPORTED_SENTENCE[state.code]) || copy.sentence };
  return copy;
}

// ---- gates --------------------------------------------------------------------------------------------------------------------

/**
 * The words of a gate event's state and decider (plan DEC-006): `by` is `autopilot`, `manual` (a direct command: a person, or an attended agent for them) or null (no decider recorded).
 * @param {{ state: string, by: string | null }} gate
 * @returns {{ token: string, word: string }}
 */
function gateWords(gate) {
  if (gate.state === 'awaiting') return { token: 'awaiting', word: 'waiting for you' };
  if (gate.state === 'skipped') return { token: 'skipped', word: 'skipped' };
  const verb = gate.state === 'rejected' ? 'rejected' : 'approved';
  const token = gate.state === 'rejected' ? 'rejected' : 'done';
  if (gate.by === 'autopilot') return { token, word: `${verb} by autopilot` };
  if (gate.by === 'manual') return { token, word: 'decided manually' };
  return { token, word: 'decider not recorded' };
}

// ---- the machine page ----------------------------------------------------------------------------------------------------------

const NOT_OBSERVED = 'Not observed: agent questions and permission prompts, because no harness records them. A gate waiting for you is the only waiting this page can state.';

/**
 * `#/layers`: the "Waiting for you" lead (gates of every summarized project, newest first), one row per project (the current one
 * first) with its strip, and the foot. A project the activity section does not cover has no strip (`summarized` false).
 * @param {any} body the `machine` member body, or null
 */
function machineModel(body) {
  const projectsSection = sectionOf(body, 'projects');
  const activitySection = sectionOf(body, 'activity');
  const projects = projectsSection.state === 'ok' && Array.isArray(projectsSection.data.projects) ? projectsSection.data.projects : [];
  const items = activitySection.state === 'ok' && Array.isArray(activitySection.data.items) ? activitySection.data.items : [];
  const byKey = new Map(items.map((/** @type {any} */ item) => [item.projectKey, item]));
  const labels = new Map(projects.map((/** @type {any} */ p) => [p.projectKey, p.label]));
  const rows = [...projects]
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.current === b.current ? byNewest(a, b, 'lastRecordAt', 'projectKey') : a.current ? -1 : 1))
    .map((/** @type {any} */ project) => {
      const item = byKey.get(project.projectKey) ?? null;
      return {
        projectKey: project.projectKey, label: project.label, current: project.current === true, temp: project.temp === true, checkouts: project.checkouts,
        lastRecordAt: project.lastRecordAt ?? null,
        summarized: item !== null,
        sessions: item ? item.sessions : null,
        runs: item ? item.runs : null,
        workers: item ? item.workers : null,
        unreadable: item ? item.unreadable : [],
        gates: item ? item.gates.length : 0,
      };
    });
  const gates = items
    .flatMap((/** @type {any} */ item) => item.gates.map((/** @type {any} */ gate) => ({ ...gate, projectKey: item.projectKey, projectLabel: labels.get(item.projectKey) ?? null })))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => byNewest(a, b, 'recordAt', 'taskId'));
  const limits = activitySection.state === 'ok' ? activitySection.data.limits : null;
  const total = projectsSection.state === 'ok' ? projects.length : null;
  return {
    present: body !== null && body !== undefined,
    projectsSection: { state: projectsSection.state, code: projectsSection.code },
    activitySection: { state: activitySection.state, code: activitySection.code },
    store: projectsSection.state === 'ok' ? projectsSection.data.store : null,
    gates,
    rows,
    foot: {
      summarized: items.length,
      total,
      notShown: limits ? limits.notShown : 0,
      excluded: projectsSection.state === 'ok' ? projectsSection.data.excluded : null,
      truncated: projectsSection.state === 'ok' ? projectsSection.data.truncated === true : false,
      notObserved: NOT_OBSERVED,
    },
  };
}

/** "16 of 23 projects summarized", or null while the project list is unknown. @param {{ summarized: number, total: number | null, notShown: number }} foot */
function summarizedLine(foot) {
  if (foot.total === null) return foot.summarized > 0 ? `${foot.summarized} projects summarized` : null;
  return `${foot.summarized} of ${Math.max(foot.total, foot.summarized + foot.notShown)} projects summarized`;
}

// ---- the project page ------------------------------------------------------------------------------------------------------------

/** The lane rows of a checkout take at most this many briefs and hand-backs. */
const BRIEF_LIMIT = 12;

/** Worker-run nodes of the agent tree. */
const WORKER_KINDS = Object.freeze(['worker-run', 'child-worker-run']);

/** The liveness words of a tree node (D5: a process is "seen", "gone" or "not checked", never "running"). @type {Readonly<Record<string, string>>} */
const PROCESS_WORD = Object.freeze({ 'process-seen': 'process seen', 'process-gone': 'process gone', 'not-checked': 'process not checked' });

/** The one word of an audit event. @type {Readonly<Record<string, string>>} */
const AUDIT_WORD = Object.freeze({ SubagentStart: 'started', SubagentStop: 'stopped' });

/** The artifact kinds of the briefs and hand-backs row, in words. @type {Readonly<Record<string, string>>} */
const KIND_WORDS = Object.freeze({
  'task-brief': 'task brief', 'task-brief-record': 'task brief record', 'group-brief': 'group brief', 'group-brief-record': 'group brief record',
  'task-report': 'task report', handoff: 'hand-back', result: 'result', 'spawn-prompt': 'spawn prompt', 'worker-out': 'worker stdout', 'worker-err': 'worker stderr',
});

/**
 * The review badge of a feature: its open blocker and should-fix counts and its converged findings, or the state word when the
 * record is not readable. Null when no review record exists for the feature. @param {any} review
 */
function reviewWords(review) {
  if (!review || review.state === 'absent') return null;
  if (review.state === 'unreadable' || review.state === 'invalid') return { token: 'unknown', words: [`review ${review.state}`] };
  const c = review.counts;
  if (!c) return { token: 'unknown', words: ['review recorded'] };
  const words = [];
  if (c.blocker > 0) words.push(`${c.blocker} blocker`);
  if (c.should_fix > 0) words.push(`${c.should_fix} should fix`);
  if (c.converged > 0) words.push(`${c.converged} converged`);
  return { token: c.blocker > 0 ? 'rejected' : c.should_fix > 0 ? 'awaiting' : 'done', words: words.length > 0 ? words : ['no findings'] };
}

/**
 * The subagent lines of an audit: the last event per agent key, and the lines whose key is null (shown audit-only).
 * @param {any[]} sessionList the `sessions` section rows
 * @returns {{ byKey: Map<string, { event: string, at: string | null, agentType: string | null }>, auditOnly: any[] }}
 */
function auditLines(sessionList) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  /** @type {any[]} */
  const auditOnly = [];
  for (const session of sessionList) {
    if (!session.audit || session.audit.observed !== true) continue;
    for (const line of session.audit.recent) {
      const entry = { event: line.event, at: line.at, agentType: line.agentType, harness: session.harness };
      if (line.agentKey === null) auditOnly.push(entry);
      else {
        const held = byKey.get(line.agentKey);
        if (!held || (time(line.at) ?? 0) >= (time(held.at) ?? 0)) byKey.set(line.agentKey, entry);
      }
    }
  }
  auditOnly.sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0));
  return { byKey, auditOnly };
}

/**
 * `#/layers/<pk>`: the waiting gates of the project, one lane per checkout (the main one first) with the rows of design §8, the
 * coverage table and the sources that did not read. A run joins a checkout by the first segment of its exact `runKey` (D5); a run
 * with no key stands in a lane of its own. A main session or an artifact joins by its `worktreeKey`.
 * @param {any} body the `layers` member body, or null
 */
function projectModel(body) {
  const sec = {
    checkouts: sectionOf(body, 'checkouts'), tree: sectionOf(body, 'tree'), runs: sectionOf(body, 'runs'), gates: sectionOf(body, 'gates'),
    artifacts: sectionOf(body, 'artifacts'), reviews: sectionOf(body, 'reviews'), sessions: sectionOf(body, 'sessions'),
    traffic: sectionOf(body, 'traffic'), coverage: sectionOf(body, 'coverage'),
  };
  const state = (/** @type {string} */ name) => ({ state: sec[/** @type {keyof typeof sec} */ (name)].state, code: sec[/** @type {keyof typeof sec} */ (name)].code });
  /** @type {any[]} */
  const checkouts = sec.checkouts.state === 'ok' ? sec.checkouts.data : [];
  /** @type {any[]} */
  const nodes = sec.tree.state === 'ok' ? sec.tree.data.nodes : [];
  /** @type {any[]} */
  const runs = sec.runs.state === 'ok' ? sec.runs.data.runs : [];
  /** @type {any[]} */
  const gateEvents = sec.gates.state === 'ok' ? sec.gates.data : [];
  /** @type {any[]} */
  const artifacts = sec.artifacts.state === 'ok' ? sec.artifacts.data : [];
  /** @type {any[]} */
  const reviews = sec.reviews.state === 'ok' ? sec.reviews.data : [];
  /** @type {any[]} */
  const sessions = sec.sessions.state === 'ok' ? sec.sessions.data : [];
  const traffic = sec.traffic.state === 'ok' ? sec.traffic.data : null;
  const trafficBy = new Map((traffic && Array.isArray(traffic.agents) ? traffic.agents : []).map((/** @type {any} */ a) => [a.agentKey, a]));
  const audit = auditLines(sessions);

  const waiting = gateEvents.filter((g) => g.state === 'awaiting').sort((a, b) => byNewest(a, b, 'at', 'taskId'));
  /** The decided and skipped gate events of a run, newest first. @param {string | null} runKey @param {string} taskId */
  const gatesOf = (runKey, taskId) => gateEvents
    .filter((g) => g.state !== 'awaiting' && (runKey !== null ? g.runKey === runKey : g.runKey === null && g.taskId === taskId))
    .sort((a, b) => byNewest(a, b, 'at', 'gateId'));

  /** @param {any} run */
  const runRow = (run) => {
    const review = reviews.find((r) => r.feature === run.featureSlug && run.featureSlug !== null && (run.runKey === null || r.worktreeKey === run.runKey.split('/')[0]));
    return {
      taskId: run.taskId, featureSlug: run.featureSlug, taskClass: run.taskClass, workflowName: run.workflowName, state: run.state, current: run.current,
      skill: run.skill ?? null, progress: run.progress, runKey: run.runKey ?? null, updatedAt: run.updatedAt,
      gates: gatesOf(run.runKey ?? null, run.taskId).slice(0, 3).map((g) => ({ gateId: g.gateId, name: g.name, at: g.at, ...gateWords(g) })),
      review: reviewWords(review),
    };
  };

  /** @param {any} node */
  const agentRow = (node) => {
    const line = audit.byKey.get(node.agentKey) ?? null;
    const t = trafficBy.get(node.agentKey) ?? null;
    return {
      agentKey: node.agentKey, kind: node.kind, label: node.label, title: nodeTitle(node), harness: node.harness, model: node.model, startedAt: node.startedAt, lastRecordAt: node.lastRecordAt,
      process: PROCESS_WORD[node.liveness] ?? 'process not checked', linked: node.transcript.linked === true, reason: node.transcript.reason,
      audit: line ? { word: AUDIT_WORD[line.event] ?? 'recorded', at: line.at } : null,
      toolCalls: t ? t.toolCalls : null, eventsPerMin: t ? t.eventsPerMin : null,
    };
  };

  const ordered = [...checkouts].sort((a, b) => (a.main === b.main ? (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) : a.main ? -1 : 1));
  const keys = new Set(ordered.map((c) => c.worktreeKey));
  const placed = (/** @type {string | null} */ worktreeKey) => worktreeKey !== null && keys.has(worktreeKey);
  const lanes = ordered.map((checkout) => {
    const mine = (/** @type {any} */ n) => n.worktreeKey === checkout.worktreeKey;
    const sorted = (/** @type {any[]} */ list) => [...list].sort((a, b) => byNewest(a, b, 'startedAt', 'agentKey'));
    return {
      worktreeKey: checkout.worktreeKey, label: checkout.label, branch: checkout.branch, main: checkout.main,
      orchestrator: sorted(nodes.filter((n) => mine(n) && n.kind === 'main-session')).map(agentRow),
      runs: runs.filter((r) => r.runKey !== null && r.runKey !== undefined && r.runKey.split('/')[0] === checkout.worktreeKey).map(runRow),
      workers: sorted(nodes.filter((n) => mine(n) && WORKER_KINDS.includes(n.kind))).map(agentRow),
      subagents: sorted(nodes.filter((n) => mine(n) && n.kind === 'harness-subagent')).map(agentRow),
      briefs: artifacts.filter((a) => a.worktreeKey === checkout.worktreeKey).sort((a, b) => byNewest(a, b, 'at', 'fileKey')).slice(0, BRIEF_LIMIT)
        .map((a) => ({ fileKey: a.fileKey, kind: a.kind, kindWord: KIND_WORDS[a.kind] ?? a.kind, task: a.task ?? null, feature: a.feature, bytes: a.bytes, at: a.at })),
    };
  });
  // What no checkout of the list holds: runs with no exact key, and nodes or artifacts of a checkout the list does not name.
  const loose = {
    runs: runs.filter((r) => r.runKey === null || r.runKey === undefined || !placed(r.runKey.split('/')[0])).map(runRow),
    agents: nodes.filter((n) => !placed(n.worktreeKey) && n.kind !== 'doflow-run').map(agentRow),
  };
  const withheld = [];
  for (const name of /** @type {const} */ (['checkouts', 'tree', 'runs', 'gates', 'artifacts', 'reviews', 'sessions', 'traffic', 'coverage'])) {
    if (sec[name].state === 'unreadable') withheld.push({ section: name, code: sec[name].code });
  }
  return {
    present: body !== null && body !== undefined,
    sections: { checkouts: state('checkouts'), tree: state('tree'), runs: state('runs'), gates: state('gates'), artifacts: state('artifacts'), reviews: state('reviews'), sessions: state('sessions'), traffic: state('traffic'), coverage: state('coverage') },
    waiting: waiting.map((g) => ({ ...g, ...gateWords(g) })),
    lanes,
    loose,
    nodes: new Map(nodes.map((n) => [n.agentKey, n])),
    files: new Map(artifacts.map((a) => [a.fileKey, a])),
    auditOnly: audit.auditOnly,
    coverage: sec.coverage.state === 'ok' ? sec.coverage.data : [],
    notChecked: sec.tree.state === 'ok' && sec.tree.data.limits ? sec.tree.data.limits.notChecked : 0,
    withheld,
  };
}

/** The coverage sources in the order of the table, with their words. */
const COVERAGE_COLUMNS = Object.freeze([['main', 'Main session'], ['subagents', 'Subagents'], ['transcript', 'Transcript'], ['permissions', 'Permission refusals'], ['questions', 'Questions']]);

/** The reasons of a `not observed` source, in words. @type {Readonly<Record<string, string>>} */
const REASON_WORD = Object.freeze({
  'no-harness-record': 'no harness record',
  'no-audit-hook': 'no audit hook',
  'no-reader': 'no transcript reader',
});

/** A reason code as words; an unknown code stays as it is. @param {string} code */
const reasonWord = (code) => REASON_WORD[code] ?? code.replace(/-/g, ' ');

/**
 * One coverage cell: `observed`, or `not observed` with its reason (FR-009). `questions` is `not observed` for every harness
 * whatever the core said: no harness records a question (D7).
 * @param {string} column @param {any} cell
 */
function coverageCell(column, cell) {
  if (column === 'questions') return { observed: false, word: 'not observed', reason: reasonWord(cell && cell.observed === false && typeof cell.reason === 'string' ? cell.reason : 'no-harness-record') };
  if (cell && cell.observed === true) return { observed: true, word: 'observed', reason: null };
  return { observed: false, word: 'not observed', reason: reasonWord(cell && typeof cell.reason === 'string' ? cell.reason : 'no-harness-record') };
}

/** The project's label from the `machine` member, else its key's first 8 characters. @param {any} machine @param {string} projectKey */
function projectLabel(machine, projectKey) {
  const section = sectionOf(machine, 'projects');
  const found = section.state === 'ok' ? section.data.projects.find((/** @type {any} */ p) => p.projectKey === projectKey) : null;
  return found ? { label: found.label, current: found.current === true, temp: found.temp === true, known: true } : { label: projectKey.slice(0, 8), current: false, temp: false, known: false };
}

export {
  MAX_EVENTS, stamp, secondsStamp, kindWord, nodeTitle, titleIsLabel, fingerprint, appendEvents, splitMasked, usageLine, resultBits, recordWords, seconds,
  sectionOf, STREAM_STATES, streamState, streamCopy, gateWords, machineModel, summarizedLine, BRIEF_LIMIT, projectModel, COVERAGE_COLUMNS, coverageCell,
  reasonWord, projectLabel, reviewWords, PROCESS_WORD,
};
