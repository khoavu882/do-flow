// Fleet derivations (V.10; design/ui/V8.md sections 7b.4, 7b.5, 7b.10; IC-019, IC-020, IC-022, IC-023, IC-025). Pure
// functions over the bodies of the Fleet routes: the agent tree layout, the traffic aggregation that keeps unknown apart
// from zero, the "Working together" groups, the accessible name of a tree node, the merge of a stream delta into the
// fleet body, and the bounded list of stream events. Nothing here reads the DOM, a clock or a store; the words never say
// that an agent is working now, because no record states it (R23): they say what was recorded.

/** The events a stream panel keeps (IC-025, V8 7b.2). */
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
 * `HH:MM` for today, `Oct 24 HH:MM` for an older day, "–" for a missing or unreadable time (V8 7b.5 meta line).
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
 * word. "Lead" is never derived (gate-a Q9 A).
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

// ---- the tree ------------------------------------------------------------------------------------------

/**
 * A start time for ordering: null sorts last.
 * @param {any} iso
 */
const time = (iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** Ascending by time, nulls last, ties by agentKey. @param {any} a @param {any} b @param {string} field */
function byTimeAsc(a, b, field) {
  const [x, y] = [time(a[field]), time(b[field])];
  if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
  return a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0;
}

/** Descending by time, nulls last, ties by agentKey. @param {any} a @param {any} b @param {string} field */
function byTimeDesc(a, b, field) {
  const [x, y] = [time(a[field]), time(b[field])];
  if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
  return a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0;
}

/**
 * The tree of one project (V8 7b.5). Top-level items are the main sessions, newest last record first; children follow the
 * edges in spawn order (start time ascending, nulls last, ties by key). A node with no drawn incoming edge that is not a
 * main session is still drawn, after the main sessions, as an `orphan` ("No parent in the records"). An edge whose end is
 * not among the nodes (dropped by the cap) is not drawn. Nodes are never merged and never attached to a guessed parent; a
 * node with several incoming edges hangs under the first one in edge order and keeps its other parents unrecorded here.
 * `items` is every drawn node in DOM order; `roots` the top-level keys; `children` the child keys of each key.
 * @param {any} tree the `data` of a tree section ({nodes, edges})
 * @returns {{ items: any[], roots: string[], orphans: string[], children: Map<string, string[]>, byKey: Map<string, any>, parent: Map<string, string | null> }}
 */
function layoutTree(tree) {
  const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
  const edges = Array.isArray(tree && tree.edges) ? tree.edges : [];
  /** @type {Map<string, any>} */
  const byKey = new Map(nodes.map((/** @type {any} */ node) => [node.agentKey, node]));
  /** @type {Map<string, string | null>} */
  const parent = new Map();
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  for (const edge of edges) {
    if (!byKey.has(edge.from) || !byKey.has(edge.to) || edge.from === edge.to || parent.has(edge.to)) continue;
    if (byKey.get(edge.to).kind === 'main-session') continue;
    parent.set(edge.to, edge.from);
    kids.set(edge.from, [...(kids.get(edge.from) ?? []), edge.to]);
  }
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const [key, list] of kids) children.set(key, list.slice().sort((a, b) => byTimeAsc(byKey.get(a), byKey.get(b), 'startedAt')));
  const mains = nodes.filter((/** @type {any} */ n) => n.kind === 'main-session').sort((/** @type {any} */ a, /** @type {any} */ b) => byTimeDesc(a, b, 'lastRecordAt')).map((/** @type {any} */ n) => n.agentKey);
  const orphans = nodes.filter((/** @type {any} */ n) => n.kind !== 'main-session' && !parent.has(n.agentKey)).sort((/** @type {any} */ a, /** @type {any} */ b) => byTimeAsc(a, b, 'startedAt')).map((/** @type {any} */ n) => n.agentKey);
  const roots = [...mains, ...orphans];
  /** @type {any[]} */
  const items = [];
  const seen = new Set();
  /** @param {string} key @param {string | null} up @param {number} level @param {number} setSize @param {number} pos @param {boolean} orphan */
  const walk = (key, up, level, setSize, pos, orphan) => {
    if (seen.has(key)) return;
    seen.add(key);
    const own = children.get(key) ?? [];
    items.push({ key, node: byKey.get(key), parent: up, level, setSize, pos, orphan, childCount: own.length });
    own.forEach((child, index) => walk(child, key, level + 1, own.length, index + 1, false));
  };
  roots.forEach((key, index) => walk(key, null, 1, roots.length, index + 1, orphans.includes(key)));
  // A cycle leaves nodes unreached: draw them as top-level orphans rather than lose them.
  for (const node of nodes) if (!seen.has(node.agentKey)) walk(node.agentKey, null, 1, roots.length, roots.length + 1, true);
  return { items, roots, orphans, children, byKey, parent: new Map(items.map((/** @type {any} */ item) => [item.key, item.parent])) };
}

/** Counts by IC-020 kind, for a project row. @param {any} tree the `data` of a tree section */
function agentCounts(tree) {
  const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
  const count = (/** @type {string[]} */ kinds) => nodes.filter((/** @type {any} */ n) => kinds.includes(n.kind)).length;
  return {
    main: count(['main-session']),
    subagents: count(['harness-subagent', 'doflow-run']),
    workers: count(['worker-run', 'child-worker-run']),
    processSeen: nodes.filter((/** @type {any} */ n) => n.liveness === 'process-seen').length,
    total: nodes.length,
  };
}

/** The distinct models of a tree, most frequent first (ties by name); a null model is not counted. @param {any} tree */
function modelsOf(tree) {
  const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const node of nodes) if (typeof node.model === 'string') counts.set(node.model, (counts.get(node.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([model]) => model);
}

// ---- traffic -------------------------------------------------------------------------------------------

/**
 * The events per minute of a whole project: the sum of the agents that report one. A project with no agent that reports
 * one is `null` ("no linked transcript"), never 0 (IC-023: unknown is never zero). @param {any} traffic the `data` of a traffic section
 */
function projectRate(traffic) {
  const agents = Array.isArray(traffic && traffic.agents) ? traffic.agents : [];
  const known = agents.filter((/** @type {any} */ a) => typeof a.eventsPerMin === 'number');
  return known.length === 0 ? null : Math.round(known.reduce((/** @type {number} */ sum, /** @type {any} */ a) => sum + a.eventsPerMin, 0) * 10) / 10;
}

/** Descending by a number, nulls last, then by a stable key. @param {any[]} rows @param {(row: any) => number | null} value @param {(row: any) => string} tie */
function sortByNumber(rows, value, tie) {
  return rows.slice().sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    return tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0;
  });
}

/**
 * The per-agent table: one row per traffic agent, sorted by events per minute descending, nulls last. Each row carries the
 * node it belongs to (or null when the tree no longer holds it). @param {any} traffic @param {Map<string, any>} byKey
 */
function agentRows(traffic, byKey) {
  const agents = Array.isArray(traffic && traffic.agents) ? traffic.agents : [];
  return sortByNumber(agents.map((/** @type {any} */ a) => ({ ...a, node: byKey.get(a.agentKey) ?? null })), (r) => (typeof r.eventsPerMin === 'number' ? r.eventsPerMin : null), (r) => r.agentKey);
}

/** The per-model table, same ordering. @param {any} traffic */
function modelRows(traffic) {
  const models = Array.isArray(traffic && traffic.models) ? traffic.models : [];
  return sortByNumber(models, (r) => (typeof r.eventsPerMin === 'number' ? r.eventsPerMin : null), (r) => r.model);
}

/** The largest value of a column, for the bars (0 when none is known). @param {any[]} rows @param {string} field */
function maxOf(rows, field) {
  return rows.reduce((max, row) => (typeof row[field] === 'number' && row[field] > max ? row[field] : max), 0);
}

/** The width of a bar, 0 to 100 with one decimal; an unknown value or no maximum gives 0. @param {any} value @param {number} max */
function barWidth(value, max) {
  if (typeof value !== 'number' || !(max > 0)) return 0;
  return Math.round(Math.min(100, (value / max) * 100) * 10) / 10;
}

/** "12.4k" from 10 000, else the whole number with thousands separators; null stays null. @param {any} n */
function tokenCount(n) {
  if (typeof n !== 'number') return null;
  if (n >= 10000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/** "12.4k in · 3.1k out", or null when the agent reports no tokens. @param {any} tokens */
function tokenLine(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const [input, output] = [tokenCount(tokens.input), tokenCount(tokens.output)];
  return input === null && output === null ? null : [input === null ? null : `${input} in`, output === null ? null : `${output} out`].filter(Boolean).join(' · ');
}

/** Seconds with one decimal under a minute, from a millisecond count. @param {number} ms */
function seconds(ms) {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

/** "p50 1.2 s · max 9.8 s" and "n=14", or null. @param {any} duration */
function toolTime(duration) {
  if (!duration || typeof duration !== 'object') return null;
  return { line: `p50 ${seconds(duration.p50)} · max ${seconds(duration.max)}`, n: `n=${duration.n}` };
}

// ---- working together ----------------------------------------------------------------------------------

/**
 * The three groups of "Working together" (IC-023 `pairs`), each in a stable order. `sameTask`: one entry per task id with
 * its agents; `overlap`: one per pair with the two task ids; `sameModel`: the pairs' agents grouped by their model (so no
 * extra field is needed). @param {any} traffic @param {Map<string, any>} byKey
 */
function pairGroups(traffic, byKey) {
  const pairs = Array.isArray(traffic && traffic.pairs) ? traffic.pairs : [];
  const modelOf = (/** @type {string} */ key) => {
    const fromTraffic = (Array.isArray(traffic && traffic.agents) ? traffic.agents : []).find((/** @type {any} */ a) => a.agentKey === key);
    return (byKey.get(key) && byKey.get(key).model) ?? (fromTraffic && fromTraffic.model) ?? null;
  };
  /** @type {Map<string, Set<string>>} */
  const tasks = new Map();
  /** @type {Map<string, Set<string>>} */
  const models = new Map();
  const overlap = [];
  for (const pair of pairs) {
    if (pair.basis === 'same-task' && typeof pair.task === 'string') {
      tasks.set(pair.task, (tasks.get(pair.task) ?? new Set()).add(pair.a).add(pair.b));
    } else if (pair.basis === 'overlap') {
      overlap.push({ a: pair.a, b: pair.b, tasks: Array.isArray(pair.tasks) ? pair.tasks : [] });
    } else if (pair.basis === 'same-model') {
      const model = modelOf(pair.a) ?? modelOf(pair.b);
      if (model !== null) models.set(model, (models.get(model) ?? new Set()).add(pair.a).add(pair.b));
    }
  }
  const byText = (/** @type {string} */ x, /** @type {string} */ y) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    sameTask: [...tasks.entries()].sort((x, y) => byText(x[0], y[0])).map(([task, agents]) => ({ task, agents: [...agents].sort() })),
    overlap: overlap.sort((x, y) => byText(`${x.a}${x.b}`, `${y.a}${y.b}`)),
    sameModel: [...models.entries()].sort((x, y) => byText(x[0], y[0])).map(([model, agents]) => ({ model, agents: [...agents].sort() })),
    empty: tasks.size === 0 && overlap.length === 0 && models.size === 0,
  };
}

/**
 * Which basis each other agent shares with the selected one: "same task", "same model" or "overlap" (V8 7b.5 partner tags).
 * @param {any} traffic @param {string | null} selected
 * @returns {Map<string, Set<string>>}
 */
function partnersOf(traffic, selected) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  if (selected === null) return out;
  for (const pair of Array.isArray(traffic && traffic.pairs) ? traffic.pairs : []) {
    const other = pair.a === selected ? pair.b : pair.b === selected ? pair.a : null;
    if (other === null) continue;
    out.set(other, (out.get(other) ?? new Set()).add(pair.basis));
  }
  return out;
}

/** The overlap pairs of a traffic body as stable ids, to announce each new one once. @param {any} traffic */
function overlapIds(traffic) {
  return (Array.isArray(traffic && traffic.pairs) ? traffic.pairs : [])
    .filter((/** @type {any} */ p) => p.basis === 'overlap')
    .map((/** @type {any} */ p) => `${[p.a, p.b].sort().join('+')}:${Array.isArray(p.tasks) ? p.tasks.join('+') : ''}`);
}

// ---- words ---------------------------------------------------------------------------------------------

/** The liveness words of V8 7b.5, for the name and the detail. @param {any} node @param {number} nowMs @param {number | null} tickAt */
function livenessWords(node, nowMs, tickAt) {
  if (node.ended && typeof node.ended === 'object') {
    return `Ended at ${stamp(node.ended.at, nowMs)}${node.ended.result ? `, ${node.ended.result}` : ''}.`;
  }
  if (node.liveness === 'process-seen') return tickAt === null ? 'Process seen.' : `Process seen at ${stamp(new Date(tickAt).toISOString(), nowMs)}.`;
  if (node.liveness === 'process-gone') return 'Process gone, no end record.';
  return 'Recorded, process not checked.';
}

/** The transcript note of a node (V8 7b.5), or null when the transcript is available. @param {any} node */
function transcriptNote(node) {
  const t = node.transcript;
  if (!t || (t.linked && t.reason === null)) return null;
  if (t.reason === 'no-reader') return `no transcript reader for ${node.harness ?? 'this harness'}`;
  if (t.reason === 'not-linked') return 'transcript not linked';
  return 'transcript not found';
}

/** @param {any} node */
function modelWords(node) {
  if (typeof node.model !== 'string') return 'model not recorded.';
  return node.modelBasis === 'hook-observation' ? 'model first seen in a hook record.' : `model ${node.model}${node.modelBasis === 'harness-record' ? ', from the harness record' : ''}.`;
}

/**
 * The accessible name of a tree node (V8 7b.10); the ARIA level, position, expansion and selection carry the structure, so
 * the name does not repeat them. `traffic` is the node's IC-023 entry or null; `ctx` holds `nowMs`, `tickAt` (ms of the
 * last tick, for "process seen at"), `partner` (shares a basis with the selected agent) and `orphan`.
 * @param {any} node
 * @param {any} traffic
 * @param {{ nowMs: number, tickAt?: number | null, partner?: Set<string> | null, orphan?: boolean }} ctx
 */
function fleetNodeName(node, traffic, ctx) {
  const parts = [];
  parts.push(titleIsLabel(node) ? `${nodeTitle(node)}. ${kindWord(node)}.` : `${nodeTitle(node)}.`);
  parts.push(node.harness ? `${node.harness}, ${modelWords(node)}` : modelWords(node).replace(/^./, (c) => c.toUpperCase()));
  parts.push(`Started ${stamp(node.startedAt, ctx.nowMs)}, last record ${stamp(node.lastRecordAt, ctx.nowMs)}.`);
  parts.push(livenessWords(node, ctx.nowMs, ctx.tickAt ?? null));
  const note = transcriptNote(node);
  parts.push(note === null ? 'Transcript available.' : `${note.charAt(0).toUpperCase()}${note.slice(1)}.`);
  if (traffic && typeof traffic.eventsPerMin === 'number') {
    parts.push(`${traffic.eventsPerMin} events per minute${typeof traffic.toolCalls === 'number' ? `, ${traffic.toolCalls} tool calls` : ''}.`);
  }
  if (ctx.partner && ctx.partner.size > 0) {
    const words = [...ctx.partner].map((b) => (b === 'same-task' ? 'Same task' : b === 'same-model' ? 'Same model' : 'Overlapping files')).join(', ');
    parts.push(`${words} as the selected agent.`);
  }
  if (ctx.orphan) parts.push('No parent in the records.');
  return parts.join(' ');
}

/** The one-line description of a project row for `aria-describedby` (V8 7b.10). @param {any} project @param {number} nowMs */
function projectDescription(project, nowMs) {
  const tree = project.tree && project.tree.ok ? project.tree.data : null;
  const traffic = project.traffic && project.traffic.ok ? project.traffic.data : null;
  const parts = [`${project.label}.`];
  if (project.current) parts.push('This project.');
  parts.push(`${project.checkouts} ${project.checkouts === 1 ? 'checkout' : 'checkouts'}.`);
  if (tree) {
    const c = agentCounts(tree);
    const words = [];
    if (c.main > 0) words.push(`${c.main} main ${c.main === 1 ? 'session' : 'sessions'}`);
    if (c.subagents > 0) words.push(`${c.subagents} ${c.subagents === 1 ? 'subagent' : 'subagents'}`);
    if (c.workers > 0) words.push(`${c.workers} worker ${c.workers === 1 ? 'run' : 'runs'}`);
    parts.push(`${words.length ? words.join(', ') : 'No agents recorded'}${c.processSeen > 0 ? `; ${c.processSeen} ${c.processSeen === 1 ? 'process' : 'processes'} seen` : ''}.`);
    const models = modelsOf(tree);
    if (models.length) parts.push(`Models: ${models.join(', ')}.`);
  }
  const rate = traffic ? projectRate(traffic) : null;
  parts.push(rate === null ? 'No linked transcript.' : `${Math.round(rate * 10) / 10} events per minute over the last 10 minutes.`);
  parts.push(project.lastRecordAt ? `Last record ${stamp(project.lastRecordAt, nowMs)}.` : 'No record time.');
  return parts.join(' ');
}

// ---- the fleet body ------------------------------------------------------------------------------------

/** IC-019's order: the Console's own project first, then the newest last record, nulls last. @param {any[]} projects */
function orderProjects(projects) {
  return projects.slice().sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const [x, y] = [time(a.lastRecordAt), time(b.lastRecordAt)];
    if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    return a.projectKey < b.projectKey ? -1 : 1;
  });
}

/**
 * Merges an `event: fleet` delta into the body held so far (V8 7b.2): the changed project sections replace theirs by
 * `projectKey`, every key in `gone` is removed, and the top-level fields come from the delta. A delta with no body yet is
 * ignored (the snapshot comes first). @param {any} body @param {any} delta
 */
function mergeFleet(body, delta) {
  if (!body) return body;
  const gone = new Set(Array.isArray(delta.gone) ? delta.gone : []);
  /** @type {Map<string, any>} */
  const next = new Map(body.projects.filter((/** @type {any} */ p) => !gone.has(p.projectKey)).map((/** @type {any} */ p) => [p.projectKey, p]));
  for (const section of Array.isArray(delta.projects) ? delta.projects : []) next.set(section.projectKey, section);
  return { ...body, ...(delta.store === undefined ? {} : { store: delta.store }), ...(delta.excluded === undefined ? {} : { excluded: delta.excluded }), ...(delta.limits === undefined ? {} : { limits: delta.limits }), projects: orderProjects([...next.values()]) };
}

// ---- the stream panel's events -------------------------------------------------------------------------

/**
 * One stable text for an event, to drop an event the panel already holds (a stream reopened after a hidden tab starts from
 * the transcript's last records; a browser's new EventSource cannot send Last-Event-ID). @param {any} event
 */
function fingerprint(event) {
  const tool = event.tool ? [event.tool.callKey, event.tool.name, event.tool.status, event.tool.bytes, event.tool.durationMs] : null;
  return JSON.stringify([event.kind, event.at, event.model, tool, event.text, event.args, event.tokens, event.record]);
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
  const fresh = known ? batch.filter((event) => !known.has(fingerprint(event))) : batch;
  const all = [...base, ...fresh];
  const dropped = Math.max(0, all.length - max);
  return { events: dropped > 0 ? all.slice(dropped) : all, fresh, added: fresh.length, dropped };
}

/**
 * The rows of the panel from its events: a `tool-result` attaches to the `tool-call` with the same `callKey` and is not a
 * row of its own; a result whose call is outside the held events is a row of its own ("orphan result"). Order is record
 * order. @param {any[]} events
 * @returns {Array<{ event: any, result: any | null, orphanResult: boolean }>}
 */
function panelRows(events) {
  /** @type {Map<string, any>} */
  const results = new Map();
  const calls = new Set();
  for (const event of events) {
    if (event.kind === 'tool-call' && event.tool) calls.add(event.tool.callKey);
  }
  for (const event of events) {
    if (event.kind === 'tool-result' && event.tool && calls.has(event.tool.callKey)) results.set(event.tool.callKey, event);
  }
  const rows = [];
  for (const event of events) {
    if (event.kind === 'tool-result') {
      if (!event.tool || !calls.has(event.tool.callKey)) rows.push({ event, result: null, orphanResult: true });
    } else rows.push({ event, result: event.kind === 'tool-call' && event.tool ? results.get(event.tool.callKey) ?? null : null, orphanResult: false });
  }
  return rows;
}

const MARKERS = /(<masked>|<email>|<ip>)/;
/** @type {Readonly<Record<string, string>>} */
const MARKER_WORD = Object.freeze({ '<masked>': 'masked', '<email>': 'email', '<ip>': 'ip' });

/**
 * Splits text on exactly the redactor's three markers (V8 7b.5). A segment is `{ text }` or `{ mask }` with the word.
 * @param {any} text
 */
function splitMasked(text) {
  return String(text ?? '').split(MARKERS).filter((part) => part !== '').map((part) => (MARKER_WORD[part] ? { mask: MARKER_WORD[part] } : { text: part }));
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

/** The words of a `record` event (V8 7b.5). @param {any} record */
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

export {
  MAX_EVENTS, stamp, secondsStamp, kindWord, nodeTitle, titleIsLabel, layoutTree, agentCounts, modelsOf, projectRate, agentRows, modelRows,
  maxOf, barWidth, tokenCount, tokenLine, toolTime, pairGroups, partnersOf, overlapIds, livenessWords, transcriptNote, fleetNodeName,
  projectDescription, orderProjects, mergeFleet, fingerprint, appendEvents, panelRows, splitMasked, usageLine, resultBits, recordWords, seconds,
};
