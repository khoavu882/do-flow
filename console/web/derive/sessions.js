// Sessions derivation (IC-018 e; plan task E.7; design.md section 7a). Pure functions: no DOM, no fetch and no clock reads
// (the caller passes `nowMs`), so console/test/derive-sessions.test.ts runs it in Node. The input is the `GET /api/sessions`
// body (`{ sections: { observed, slots, runs, tasks, workers, roadmap }, limits }`); nothing here reads a path, a pid or a
// raw session id, because none reaches the page. A lane exists per record identifier and lanes are never merged without a
// shared key: a hook session is keyed by its session key, a DoFlow run by (worktree, run, lineage), a worker by (slug,
// task, token), a lock by its slot name. No main-session record has a heartbeat, so no hook or launched lane is ever live.

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const list = (/** @type {any} */ value) => (Array.isArray(value) ? value.filter(isObject) : []);

/** IC-018 e's sections in the order a note lists them. */
const SECTIONS = Object.freeze(['observed', 'slots', 'runs', 'tasks', 'workers', 'roadmap']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** The run states whose feature the route inspects (routes.ts LIVE_RUN_STATES). */
const LIVE_RUN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE']);
/** The worker states with a process to find. */
const LIVE_WORKER_STATES = Object.freeze(['starting', 'running']);

/** The UTC `HH:MM` of a time: the default clock of the words below (the view passes the local one). @param {number} ms */
const defaultClock = (ms) => new Date(ms).toISOString().slice(11, 16);

/** "12 min", "30 h" (hours up to 72), then "4 d": how long ago a claim was made. @param {number} ms */
function ageWords(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 72 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const when = (/** @type {any} */ iso, /** @type {(ms: number) => string} */ clock) => (Number.isFinite(timeOf(iso)) ? clock(timeOf(iso)) : 'not recorded');

/** The newest of some ISO times, as the original string, or null when none parses. @param {any[]} times */
function latest(times) {
  let best = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const iso of times) {
    const ms = timeOf(iso);
    if (Number.isFinite(ms) && ms > bestMs) { best = iso; bestMs = ms; }
  }
  return best;
}

/** The oldest of some ISO times, as the original string, or null when none parses. @param {any[]} times */
function earliest(times) {
  let best = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const iso of times) {
    const ms = timeOf(iso);
    if (Number.isFinite(ms) && ms < bestMs) { best = iso; bestMs = ms; }
  }
  return best;
}

/** @param {any} section */
const dataOf = (section) => (isObject(section) && section.ok === true ? section.data : null);

// ---- lane makers --------------------------------------------------------------------------------------

/**
 * @param {string} key @param {string} kind @param {string} title @param {any} [more]
 * @returns {any}
 */
function makeLane(key, kind, title, more = {}) {
  return {
    key, kind, title, token: 'unknown', mark: 'recorded', liveness: 'recorded only',
    harness: null, model: null, startedAt: null, modelFirstSeenAt: null, lastRecordAt: null,
    holds: [], children: [], launched: [], times: [], ...more,
  };
}

/** The key of a run lane: where the claim was made, and under which run and lineage. @param {any} worktreeKey @param {any} run @param {any} lineage */
const runLaneKey = (worktreeKey, run, lineage) => `run:${worktreeKey ?? '-'}/${run ?? '-'}/${lineage ?? '-'}`;

/** A worker run as a lane: the process check is the one fact the core proves for it. @param {any} slug @param {any} entry */
function workerLane(slug, entry) {
  const { worker } = entry;
  const live = LIVE_WORKER_STATES.includes(worker.state);
  /** @type {Record<string, [string, string, string]>} */
  const byState = {
    starting: ['running', 'checked', 'process seen, starting'],
    running: ['running', 'checked', 'process seen'],
    unknown: ['unknown', 'recorded', 'process state not known'],
    exited: ['done', 'checked', 'process gone, exited'],
    'timed-out': ['failed', 'checked', 'process gone, timed out'],
    cancelled: ['failed', 'checked', 'process gone, cancelled'],
  };
  const [state, mark, words] = byState[worker.state] ?? byState.unknown;
  const lost = worker.supervisorLost === true;
  return makeLane(`worker:${slug}/${entry.task}/${entry.token}`, 'worker', 'Worker', {
    harness: worker.harness ?? null,
    token: live && lost ? 'stale' : state,
    mark,
    liveness: lost ? `${words}, supervisor lost` : worker.overdue === true && live ? `${words}, past its time` : words,
    startedAt: worker.startedAt ?? null,
    lastRecordAt: worker.endedAt ?? worker.startedAt ?? null,
    times: [worker.startedAt, worker.endedAt],
    worker: { state: worker.state, reason: worker.reason ?? null, endedAt: worker.endedAt ?? null, overdue: worker.overdue === true, supervisorLost: lost, task: entry.task, token: entry.token, slug },
  });
}

/** A slot holder as a lane: alive true is a process seen, false a process gone, unknown a record only. @param {any} slot */
function lockLane(slot) {
  const { holder } = slot;
  const byAlive = holder.alive === true ? ['running', 'checked', 'process seen']
    : holder.alive === false ? ['stale', 'checked', 'process gone'] : ['unknown', 'recorded', 'liveness not checked'];
  return makeLane(`lock:${slot.name}`, 'lock', `Lock ${slot.name}`, {
    token: byAlive[0], mark: byAlive[1], liveness: byAlive[2], startedAt: holder.since ?? null, lastRecordAt: holder.since ?? null, times: [holder.since],
    holds: [{ kind: 'slot', text: `the slot ${slot.name}`, since: holder.since ?? null, slot: slot.name }],
    lock: { name: slot.name, label: holder.label ?? null, alive: holder.alive, waiters: Number.isInteger(slot.waiters) ? slot.waiters : 0 },
  });
}

// ---- the derivation -----------------------------------------------------------------------------------

/**
 * IC-018 e's body to rows, lanes, holds and conflicts C1 to C4.
 *
 * - One row per checkout (`observed.checkouts`), plus one `unplaced` row for a record that names no listed checkout
 *   (a null worktree key, a checkout this project does not list, a lock held from another directory).
 * - Rows are ordered: the current checkout, then rows with a conflict, then rows with records (newest first), then the
 *   rest; the unplaced row comes after the others of its group.
 * - C1: an `overlaps` pair whose two tasks both have an active attempt, the two from a different worktree, run or lineage.
 *   C2: an active attempt over 24 h old with no live worker (absent, unknown or ended). C3: a lock holder with
 *   `alive: false`. C4: a checkout whose HEAD commit is after the newest record of that checkout (or has none).
 * @param {any} body
 * @param {number} nowMs
 * @returns {{ rows: any[], conflicts: any[], notes: Array<{ name: string, code: string }>, storeAbsent: boolean, empty: boolean, observedOk: boolean, summary: { checkouts: number, lanes: number, holds: number, conflicts: number }, limits: any }}
 */
function deriveSessions(body, nowMs) {
  const sections = isObject(body) && isObject(body.sections) ? body.sections : {};
  /** @type {Array<{ name: string, code: string }>} */
  const notes = [];
  for (const name of SECTIONS) {
    const section = sections[name];
    if (!(isObject(section) && section.ok === true)) notes.push({ name, code: isObject(section) && typeof section.code === 'string' ? section.code : 'core-error' });
  }
  const observed = dataOf(sections.observed);
  const slotData = dataOf(sections.slots);
  const runData = dataOf(sections.runs);
  const tasks = list(dataOf(sections.tasks));
  const workers = list(dataOf(sections.workers));
  const roadmap = dataOf(sections.roadmap);

  // ---- rows ----
  /** @type {Map<string, any>} */
  const byKey = new Map();
  const newRow = (/** @type {any} */ checkout) => /** @type {any} */ ({
    key: checkout ? checkout.worktreeKey : 'unplaced',
    kind: checkout ? 'checkout' : 'unplaced',
    current: checkout ? checkout.current === true : false,
    role: checkout ? checkout.role : null,
    branch: checkout ? checkout.branch ?? null : null,
    head7: checkout && typeof checkout.head === 'string' ? checkout.head.slice(0, 7) : null,
    headCommittedAt: checkout ? checkout.headCommittedAt ?? null : null,
    label: checkout
      ? (checkout.branch ?? (typeof checkout.head === 'string' ? `detached at ${checkout.head.slice(0, 7)}` : 'detached'))
      : 'Another directory',
    lanes: [], holds: [], conflicts: [], lastRecordAt: null, counts: { lanes: 0, holds: 0 }, group: 'none',
  });
  for (const checkout of list(observed && observed.checkouts)) if (typeof checkout.worktreeKey === 'string') byKey.set(checkout.worktreeKey, newRow(checkout));
  const checkoutRows = [...byKey.values()];
  /** @type {any} */
  let unplaced = null;
  const rowFor = (/** @type {any} */ worktreeKey) => {
    if (typeof worktreeKey === 'string' && byKey.has(worktreeKey)) return byKey.get(worktreeKey);
    if (unplaced === null) unplaced = newRow(null);
    return unplaced;
  };

  // ---- run lanes: active attempts grouped by (worktree, run, lineage) ----
  /** @type {Map<string, any>} */
  const runLanes = new Map();
  /** @type {Map<string, any>} */
  const attemptLane = new Map();
  /** @type {Map<string, string[]>} */
  const runIdsBySlug = new Map();
  for (const run of list(runData && runData.runs)) {
    if (typeof run.featureSlug !== 'string' || !LIVE_RUN_STATES.includes(run.state)) continue;
    runIdsBySlug.set(run.featureSlug, [...(runIdsBySlug.get(run.featureSlug) ?? []), String(run.taskId)]);
  }
  for (const entry of tasks) {
    for (const attempt of list(entry.active)) {
      const row = rowFor(attempt.worktreeKey);
      const laneKey = runLaneKey(attempt.worktreeKey, attempt.run, attempt.lineage);
      let lane = runLanes.get(laneKey);
      if (!lane) {
        lane = makeLane(laneKey, 'run', 'DoFlow run', { run: attempt.run ?? null, lineage: attempt.lineage ?? null, attempts: [], runIds: [], liveness: 'claim recorded, liveness not checked' });
        runLanes.set(laneKey, lane);
        row.lanes.push(lane);
      }
      lane.attempts.push({ slug: entry.slug, task: attempt.task, token: attempt.token, owner: attempt.owner ?? null, mode: attempt.mode ?? null, startedAt: attempt.startedAt ?? null });
      lane.times.push(attempt.startedAt);
      lane.holds.push({ kind: 'attempt', text: `${attempt.task} in ${entry.slug} by ${attempt.owner ?? 'unknown owner'}`, since: attempt.startedAt ?? null, slug: entry.slug, task: attempt.task });
      for (const taskId of runIdsBySlug.get(entry.slug) ?? []) {
        if (lane.runIds.includes(taskId)) continue;
        lane.runIds.push(taskId);
        lane.holds.push({ kind: 'run', text: `run ${taskId}`, since: null, taskId });
      }
      attemptLane.set(`${entry.slug}|${attempt.task}|${attempt.token}`, lane);
    }
  }

  // ---- workers nest under the run lane of the attempt they serve ----
  /** @type {Map<string, any>} */
  const workerOf = new Map();
  for (const entry of workers) {
    if (!isObject(entry.worker)) continue;
    const parent = attemptLane.get(`${entry.slug}|${entry.task}|${entry.token}`);
    if (!parent) continue;
    const lane = workerLane(entry.slug, entry);
    parent.children.push(lane);
    workerOf.set(`${entry.slug}|${entry.task}|${entry.token}`, lane);
  }

  // ---- hook sessions and launched units ----
  // A lane is its key: a second record under the same key is the same lane, and nothing else ever is.
  /** @type {Map<string, any>} */
  const lanesByKey = new Map();
  const place = (/** @type {any} */ row, /** @type {any} */ lane) => {
    const same = lanesByKey.get(lane.key);
    if (!same) {
      lanesByKey.set(lane.key, lane);
      row.lanes.push(lane);
      return;
    }
    for (const field of ['harness', 'model', 'startedAt', 'modelFirstSeenAt']) same[field] = same[field] ?? lane[field];
    same.lastRecordAt = latest([same.lastRecordAt, lane.lastRecordAt]);
    same.times.push(...lane.times);
  };
  for (const s of list(observed && observed.sessions)) {
    const row = rowFor(s.worktreeKey);
    const times = [s.startedAt, s.modelFirstSeenAt, s.lastHookRecordAt];
    if (s.kind === 'launched' && isObject(s.launched)) {
      const unit = { sessionKey: s.sessionKey, run: s.launched.run, lineage: s.launched.lineage, attempt: s.launched.attempt, startedAt: s.startedAt ?? null, lastHookRecordAt: s.lastHookRecordAt ?? null };
      const joined = runLanes.get(runLaneKey(s.worktreeKey, unit.run, unit.lineage));
      if (joined && row.lanes.includes(joined)) {
        joined.launched.push(unit);
        joined.times.push(...times);
      } else {
        place(row, makeLane(`launched:${s.sessionKey}`, 'launched', 'Launched unit', {
          harness: s.harness ?? null, model: s.model ?? null, startedAt: s.startedAt ?? null, modelFirstSeenAt: s.modelFirstSeenAt ?? null, lastRecordAt: s.lastHookRecordAt ?? null,
          times, launched: [unit], unit,
        }));
      }
      continue;
    }
    place(row, makeLane(`hook:${s.sessionKey}`, 'hook', 'Hook session', {
      harness: s.harness ?? null, model: s.model ?? null, startedAt: s.startedAt ?? null, modelFirstSeenAt: s.modelFirstSeenAt ?? null, lastRecordAt: s.lastHookRecordAt ?? null, times,
      sessionKey: s.sessionKey,
    }));
  }

  // ---- locks ----
  for (const slot of list(slotData && slotData.slots)) {
    if (!isObject(slot.holder)) continue;
    rowFor(slot.holder.worktreeKey).lanes.push(lockLane(slot));
  }

  // ---- finish the run lanes: their newest record and what they read as ----
  for (const lane of runLanes.values()) {
    lane.startedAt = earliest(lane.attempts.map((/** @type {any} */ a) => a.startedAt));
    lane.lastRecordAt = latest(lane.times);
    const live = lane.children.some((/** @type {any} */ child) => child.token === 'running');
    if (live) { lane.token = 'running'; lane.mark = 'checked'; lane.liveness = 'claim recorded, worker process seen'; }
  }

  // ---- conflicts ----
  /** @type {any[]} */
  const conflicts = [];
  const tuple = (/** @type {any} */ a) => `${a.worktreeKey ?? ''}|${a.run ?? ''}|${a.lineage ?? ''}`;
  for (const entry of tasks) {
    const active = list(entry.active);
    for (const pair of list(entry.overlaps)) {
      const left = active.filter((a) => a.task === pair.a);
      const right = active.filter((a) => a.task === pair.b);
      let found = null;
      for (const x of left) { for (const y of right) { if (found === null && tuple(x) !== tuple(y)) found = [x, y]; } }
      if (found === null) continue;
      conflicts.push({
        id: `C1:${entry.slug}:${pair.a}:${pair.b}`, code: 'C1', kind: 'overlap', subject: `${pair.a} and ${pair.b}`,
        slug: entry.slug, a: pair.a, b: pair.b, fileCount: Number.isInteger(pair.fileCount) ? pair.fileCount : 0,
        rowKeys: [...new Set(found.map((x) => rowFor(x.worktreeKey).key))],
      });
    }
    for (const attempt of active) {
      const started = timeOf(attempt.startedAt);
      if (!Number.isFinite(started) || nowMs - started <= DAY_MS) continue;
      const worker = workerOf.get(`${entry.slug}|${attempt.task}|${attempt.token}`);
      if (worker && LIVE_WORKER_STATES.includes(worker.worker.state)) continue;
      conflicts.push({
        id: `C2:${entry.slug}:${attempt.task}:${attempt.token}`, code: 'C2', kind: 'stale-claim', subject: `${attempt.task} in ${entry.slug}`,
        slug: entry.slug, task: attempt.task, token: attempt.token, startedAt: attempt.startedAt, ageMs: nowMs - started,
        rowKeys: [rowFor(attempt.worktreeKey).key],
      });
      const lane = attemptLane.get(`${entry.slug}|${attempt.task}|${attempt.token}`);
      if (lane && lane.token !== 'running') lane.token = 'stale';
    }
  }
  for (const slot of list(slotData && slotData.slots)) {
    if (!isObject(slot.holder) || slot.holder.alive !== false) continue;
    conflicts.push({
      id: `C3:${slot.name}`, code: 'C3', kind: 'dead-holder', subject: `lock ${slot.name}`, name: slot.name, since: slot.holder.since ?? null,
      rowKeys: [rowFor(slot.holder.worktreeKey).key],
    });
  }

  // ---- rows: holds, newest record, the C4 comparison, order ----
  /** @type {(lanes: any[]) => any[]} */
  const flatten = (lanes) => lanes.flatMap((lane) => [lane, ...flatten(lane.children)]);
  /** Holds that belong to a row and no lane: the roadmap lease and its held rows sit on the main checkout. @type {any[]} */
  const rowHolds = [];
  if (isObject(roadmap)) {
    if (isObject(roadmap.lease)) rowHolds.push({ kind: 'lease', text: 'Roadmap loop lease recorded, liveness not checked', since: roadmap.lease.acquiredAt ?? null });
    const held = list(roadmap.holds).length;
    if (held > 0) rowHolds.push({ kind: 'roadmap-hold', text: `${plural(held, 'roadmap row')} held or paused`, since: null });
  }
  const leaseRow = rowHolds.length === 0 ? null : checkoutRows.find((row) => row.role === 'main') ?? rowFor(null);
  const rows = [...checkoutRows];
  if (unplaced !== null) rows.push(unplaced);
  for (const row of rows) {
    const all = flatten(row.lanes);
    row.lastRecordAt = latest(all.flatMap((lane) => [...lane.times, lane.lastRecordAt]));
    row.holds = [...all.flatMap((lane) => lane.holds), ...(row === leaseRow ? rowHolds : [])];
  }
  for (const row of checkoutRows) {
    const commit = timeOf(row.headCommittedAt);
    if (!Number.isFinite(commit)) continue;
    const record = timeOf(row.lastRecordAt);
    if (Number.isFinite(record) && commit <= record) continue;
    conflicts.push({ id: `C4:${row.key}`, code: 'C4', kind: 'outside', subject: row.label, commitAt: row.headCommittedAt, recordAt: row.lastRecordAt, rowKeys: [row.key] });
  }
  for (const row of rows) {
    row.conflicts = conflicts.filter((c) => c.rowKeys.includes(row.key));
    row.counts = { lanes: flatten(row.lanes).length, holds: row.holds.length };
    row.group = row.current ? 'current' : row.conflicts.length > 0 ? 'conflict' : row.counts.lanes > 0 || row.counts.holds > 0 ? 'records' : 'none';
  }
  const rank = { current: 0, conflict: 1, records: 2, none: 3 };
  const ms = (/** @type {any} */ iso) => (Number.isFinite(timeOf(iso)) ? timeOf(iso) : Number.NEGATIVE_INFINITY);
  const activity = (/** @type {any} */ row) => Math.max(ms(row.lastRecordAt), ms(row.headCommittedAt));
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((l, r) => rank[/** @type {'current'} */ (l.row.group)] - rank[/** @type {'current'} */ (r.row.group)]
      || (l.row.kind === 'unplaced' ? 1 : 0) - (r.row.kind === 'unplaced' ? 1 : 0)
      || activity(r.row) - activity(l.row)
      || l.index - r.index)
    .map((item) => item.row);

  const lim = isObject(body) && isObject(body.limits) ? body.limits : {};
  const count = (/** @type {any} */ n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  const totals = ordered.reduce((sum, row) => ({ lanes: sum.lanes + row.counts.lanes, holds: sum.holds + row.counts.holds }), { lanes: 0, holds: 0 });
  return {
    rows: ordered,
    conflicts,
    notes,
    storeAbsent: Boolean(observed) && observed.store === 'absent',
    empty: Boolean(observed) && ordered.length === 1 && totals.lanes === 0 && totals.holds === 0,
    observedOk: Boolean(observed),
    summary: { checkouts: checkoutRows.length, lanes: totals.lanes, holds: totals.holds, conflicts: conflicts.length },
    limits: {
      runsInspected: count(lim.runsInspected), runsNotChecked: count(lim.runsNotChecked), workersChecked: count(lim.workersChecked), workersNotChecked: count(lim.workersNotChecked),
      truncated: Boolean(observed) && observed.truncated === true, observedUnreadable: count(observed && observed.unreadable), slotsUnreadable: count(slotData && slotData.unreadable),
    },
  };
}

// ---- words --------------------------------------------------------------------------------------------

/**
 * The label, the sentence and the announcement of a conflict. C4 carries both times and claims nothing about who committed.
 * @param {any} conflict
 * @param {(ms: number) => string} [clock]
 */
function conflictWords(conflict, clock = defaultClock) {
  if (conflict.code === 'C1') {
    return {
      label: 'Overlap',
      text: `${conflict.a} and ${conflict.b} share ${plural(conflict.fileCount, 'declared file')}, held by two runs`,
      announce: `New conflict: ${conflict.a} and ${conflict.b} overlap, held by two runs`,
    };
  }
  if (conflict.code === 'C2') {
    const age = ageWords(conflict.ageMs);
    return { label: 'Stale claim', text: `Claimed ${age} ago; no record since`, announce: `New conflict: ${conflict.task} in ${conflict.slug} was claimed ${age} ago with no record since` };
  }
  if (conflict.code === 'C3') {
    return { label: 'Dead lock holder', text: 'Held by a process that has exited; the next slot call clears it', announce: `New conflict: lock ${conflict.name} is held by a process that has exited` };
  }
  const after = Number.isFinite(timeOf(conflict.recordAt)) ? ` after ${clock(timeOf(conflict.recordAt))}` : '';
  return {
    label: 'Outside DoFlow',
    text: `Git shows a commit at ${clock(timeOf(conflict.commitAt))}; DoFlow has no record from this checkout${after}`,
    announce: `New conflict: git shows a commit in ${conflict.subject} that DoFlow has no record of`,
  };
}

/** @type {Readonly<Record<string, string>>} */
const SECTION_LABEL = Object.freeze({
  observed: 'Checkouts and hook records', slots: 'Locks', runs: 'Runs', tasks: 'Task claims', workers: 'Workers', roadmap: 'The roadmap lease',
});

/** @type {Readonly<Record<string, string>>} */
const CODE_WORDS = Object.freeze({
  'cannot-list-checkouts': 'Git did not answer for this project.',
  'core-contract-mismatch': 'DoFlow sent data in a shape this Console does not read.',
  'core-unreachable': 'DoFlow was not reachable.',
});

/** The sentence of a failed section, in place of its part of the view. @param {{ name: string, code: string }} note */
function noteWords(note) {
  return `${SECTION_LABEL[note.name] ?? note.name} could not be read. ${CODE_WORDS[note.code] ?? 'DoFlow returned an error.'}`;
}

/** The "Checked this poll" lines: what was read and what was not, never dropped silently. @param {any} limits */
function limitWords(limits) {
  const checked = (/** @type {number} */ done, /** @type {number} */ skipped, /** @type {string} */ one, /** @type {string} */ many) =>
    `${plural(done, one, many)} checked${skipped > 0 ? `, ${skipped} not checked` : ''}`;
  return [
    checked(limits.runsInspected, limits.runsNotChecked, 'run', 'runs'),
    checked(limits.workersChecked, limits.workersNotChecked, 'worker', 'workers'),
    limits.truncated ? 'hook records cut at the read limit' : null,
    limits.observedUnreadable > 0 ? `${plural(limits.observedUnreadable, 'hook record')} unreadable` : null,
    limits.slotsUnreadable > 0 ? `${plural(limits.slotsUnreadable, 'lock')} unreadable` : null,
  ].filter((line) => line !== null);
}

/** The place words of a row inside a lane's name. @param {any} row */
const placeWords = (row) => (row.kind === 'unplaced' ? 'another directory' : row.label);

/**
 * A lane's accessible name: kind, harness or owner, times, holds and the checkout.
 * @param {any} lane
 * @param {any} row
 * @param {(ms: number) => string} [clock]
 */
function laneName(lane, row, clock = defaultClock) {
  const place = `checkout ${placeWords(row)}`;
  if (lane.kind === 'hook' || lane.kind === 'launched') {
    const lead = lane.kind === 'hook' ? 'Hook session' : `Launched unit, run ${lane.unit.run}, lineage ${lane.unit.lineage}`;
    return `${lead}, ${lane.harness ?? 'harness not recorded'}, model ${lane.model ?? 'not recorded'}, started ${when(lane.startedAt, clock)}, last hook record ${when(lane.lastRecordAt, clock)}, holds nothing, ${place}`;
  }
  if (lane.kind === 'run') {
    const claims = lane.attempts.map((/** @type {any} */ a) => `${a.task} in ${a.slug} by ${a.owner ?? 'unknown owner'} since ${when(a.startedAt, clock)}`);
    const id = lane.run === null ? 'run not recorded' : `${lane.run}/${lane.lineage ?? 'lineage not recorded'}`;
    return `DoFlow run ${id}, holds ${plural(claims.length, 'claim')}: ${claims.join('; ')}, last record ${when(lane.lastRecordAt, clock)}, ${place}`;
  }
  if (lane.kind === 'worker') {
    return `Worker, ${lane.harness ?? 'harness not recorded'}, ${lane.liveness}, started ${when(lane.startedAt, clock)}, holds nothing, ${place}`;
  }
  return `${lane.title}, ${lane.liveness}, since ${when(lane.startedAt, clock)}, holds ${lane.holds[0].text}, ${place}`;
}

/** A row's accessible name. @param {any} row @param {(ms: number) => string} [clock] */
function rowName(row, clock = defaultClock) {
  const conflicts = row.conflicts.length === 0 ? 'no conflicts' : plural(row.conflicts.length, 'conflict');
  const tail = `${plural(row.counts.lanes, 'lane')}, ${plural(row.counts.holds, 'hold')}, ${conflicts}`;
  if (row.kind === 'unplaced') return `Records not tied to a listed checkout, ${tail}`;
  const where = row.branch !== null ? `branch ${row.branch}` : `detached at ${row.head7 ?? 'no commit'}`;
  const head = row.head7 === null ? 'no commit' : `HEAD ${row.head7} committed ${when(row.headCommittedAt, clock)}`;
  return `${row.current ? 'This checkout' : 'Checkout'}, ${row.role}, ${where}, ${head}, ${tail}`;
}

// ---- filter, announcements, keyboard ------------------------------------------------------------------

/** The rows a filter chip keeps: `conflicts`, `records` (with a lane or hold), or everything. @param {any[]} rows @param {string} filter */
function filterRows(rows, filter) {
  if (filter === 'conflicts') return rows.filter((row) => row.conflicts.length > 0);
  if (filter === 'records') return rows.filter((row) => row.counts.lanes > 0 || row.counts.holds > 0);
  return rows;
}

/**
 * The conflicts to announce: those whose id the previous read did not have. The first read (`previous` null) announces nothing.
 * @param {Set<string> | null} previous @param {any[]} conflicts
 */
function newConflicts(previous, conflicts) {
  return previous === null ? [] : conflicts.filter((conflict) => !previous.has(conflict.id));
}

/**
 * Roving focus over the rows and their lanes. `layout[i].lanes` is the number of lanes row `i` shows (0 when collapsed);
 * `at` is `{ row, lane }` with `lane` null on a row. Down and Up walk the rows from a row and the lanes from a lane;
 * Right goes into the first lane; Left comes back to the row. Null when the key moves nowhere.
 * @param {Array<{ lanes: number }>} layout
 * @param {{ row: number, lane: number | null }} at
 * @param {string} key
 */
function moveFocus(layout, at, key) {
  if (at.lane === null) {
    if (key === 'Home') return at.row === 0 ? null : { row: 0, lane: null };
    if (key === 'End') return at.row === layout.length - 1 ? null : { row: layout.length - 1, lane: null };
    if (key === 'ArrowDown') return at.row + 1 < layout.length ? { row: at.row + 1, lane: null } : null;
    if (key === 'ArrowUp') return at.row > 0 ? { row: at.row - 1, lane: null } : null;
    if (key === 'ArrowRight') return layout[at.row].lanes > 0 ? { row: at.row, lane: 0 } : null;
    return null;
  }
  if (key === 'ArrowDown') return at.lane + 1 < layout[at.row].lanes ? { row: at.row, lane: at.lane + 1 } : null;
  if (key === 'ArrowUp') return at.lane > 0 ? { row: at.row, lane: at.lane - 1 } : null;
  if (key === 'ArrowLeft') return { row: at.row, lane: null };
  return null;
}

/**
 * The command that shows more about a lane, as text (never a button that runs it).
 * @param {any} lane
 * @returns {string | null}
 */
function commandFor(lane) {
  if (lane.kind === 'hook' || lane.kind === 'launched') return 'doflow primary --action observed --json';
  if (lane.kind === 'lock') return 'doflow slot --action peek --json';
  if (lane.kind === 'worker') return `doflow worker --action status --slug ${lane.worker.slug} --task ${lane.worker.task} --token ${lane.worker.token}`;
  if (lane.kind === 'run' && lane.attempts.length > 0) return `doflow task-attempt --action inspect --slug ${lane.attempts[0].slug}`;
  return null;
}

export {
  SECTIONS, SECTION_LABEL, defaultClock, deriveSessions, conflictWords, noteWords, limitWords, laneName, rowName, filterRows, newConflicts, moveFocus, commandFor,
};
