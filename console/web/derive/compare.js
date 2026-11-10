// Compare derivation (feature 152, IC-008; FR-004, FR-005).
// Pure functions: no DOM, no fetch, no side-effects.

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';

/**
 * Format milliseconds into human-readable duration string.
 * @param {number | null | undefined} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format duration delta (ms) with explicit sign: `+12s`, `-5s`, `0s`, or `—`.
 * @param {number | null | undefined} deltaMs
 * @returns {string}
 */
function formatDurationDelta(deltaMs) {
  if (deltaMs === null || deltaMs === undefined || Number.isNaN(deltaMs)) return '—';
  const totalSeconds = Math.round(deltaMs / 1000);
  if (totalSeconds === 0) return '0s';
  const sign = totalSeconds > 0 ? '+' : '-';
  const absSeconds = Math.abs(totalSeconds);
  if (absSeconds < 60) return `${sign}${absSeconds}s`;
  const minutes = Math.floor(absSeconds / 60);
  const remainingSeconds = absSeconds % 60;
  return remainingSeconds > 0 ? `${sign}${minutes}m ${remainingSeconds}s` : `${sign}${minutes}m`;
}

/**
 * Format token count with commas, or "unknown" if null/undefined.
 * @param {number | null | undefined} count
 * @returns {string}
 */
function formatTokens(count) {
  if (count === null || count === undefined || Number.isNaN(count)) return 'unknown';
  return Number(count).toLocaleString('en-US');
}

/**
 * @param {any} run
 */
function normalizeHeader(run) {
  if (!isObject(run)) {
    return {
      slug: '',
      taskId: '',
      taskClass: 'unknown',
      workflowName: 'Unknown',
      harness: null,
      state: 'UNKNOWN',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      expired: false,
    };
  }
  return {
    slug: String(run.slug || ''),
    taskId: String(run.taskId || ''),
    taskClass: String(run.taskClass || 'unknown'),
    workflowName: String(run.workflowName || 'Workflow'),
    harness: run.harness ? String(run.harness) : null,
    state: String(run.state || 'UNKNOWN'),
    startedAt: run.startedAt ? String(run.startedAt) : null,
    endedAt: run.endedAt ? String(run.endedAt) : null,
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
    expired: Boolean(run.expired),
  };
}

/**
 * Pure comparison derivation aligning two workflow runs.
 * @param {any} runA
 * @param {any} runB
 */
function alignRuns(runA, runB) {
  const headerA = normalizeHeader(runA);
  const headerB = normalizeHeader(runB);

  const workersA = isObject(runA?.workers) ? runA.workers : {};
  const workersB = isObject(runB?.workers) ? runB.workers : {};

  const summary = {
    durationDeltaMs: (headerB.durationMs !== null && headerA.durationMs !== null)
      ? headerB.durationMs - headerA.durationMs
      : null,
    workerCountDelta: (Number(workersB.count) || 0) - (Number(workersA.count) || 0),
    attemptDelta: (Number(workersB.attempts) || 0) - (Number(workersA.attempts) || 0),
    retryDelta: (Number(workersB.retries) || 0) - (Number(workersA.retries) || 0),
    quotaStopDelta: (Number(workersB.quotaStops) || 0) - (Number(workersA.quotaStops) || 0),
  };

  const stagesListA = Array.isArray(runA?.stages) ? runA.stages.filter(isObject) : [];
  const stagesListB = Array.isArray(runB?.stages) ? runB.stages.filter(isObject) : [];

  const stageIds = [];
  const stageMapA = new Map();
  const stageMapB = new Map();

  for (const st of stagesListA) {
    const id = String(st.id || '');
    if (!stageMapA.has(id)) {
      stageIds.push(id);
      stageMapA.set(id, st);
    }
  }

  for (const st of stagesListB) {
    const id = String(st.id || '');
    if (!stageMapB.has(id)) {
      if (!stageMapA.has(id)) stageIds.push(id);
      stageMapB.set(id, st);
    }
  }

  const alignedStages = stageIds.map((id) => {
    const stA = stageMapA.get(id) || null;
    const stB = stageMapB.get(id) || null;
    const presence = (stA && stB) ? 'both' : (stA ? 'a-only' : 'b-only');

    const name = String(stA?.name || stB?.name || id);
    const skill = stA?.skill ? String(stA.skill) : (stB?.skill ? String(stB.skill) : null);
    const statusA = stA ? String(stA.status || 'completed') : 'not-in-run';
    const statusB = stB ? String(stB.status || 'completed') : 'not-in-run';
    const outcomeA = stA ? String(stA.outcome || 'completed') : 'not-in-run';
    const outcomeB = stB ? String(stB.outcome || 'completed') : 'not-in-run';
    const durationMsA = typeof stA?.durationMs === 'number' ? stA.durationMs : null;
    const durationMsB = typeof stB?.durationMs === 'number' ? stB.durationMs : null;
    const durationDeltaMs = (durationMsB !== null && durationMsA !== null)
      ? durationMsB - durationMsA
      : null;

    return {
      id,
      name,
      skill,
      presence,
      stageA: stA,
      stageB: stB,
      statusA,
      statusB,
      outcomeA,
      outcomeB,
      durationMsA,
      durationMsB,
      durationDeltaMs,
    };
  });

  // Cost comparison
  const costA = isObject(runA?.cost) ? runA.cost : {};
  const costB = isObject(runB?.cost) ? runB.cost : {};
  const tokensA = isObject(costA.tokens) ? costA.tokens : {};
  const tokensB = isObject(costB.tokens) ? costB.tokens : {};

  const tokenInA = typeof tokensA.input === 'number' ? tokensA.input : null;
  const tokenOutA = typeof tokensA.output === 'number' ? tokensA.output : null;
  const tokenTotalA = typeof tokensA.total === 'number' ? tokensA.total : null;

  const tokenInB = typeof tokensB.input === 'number' ? tokensB.input : null;
  const tokenOutB = typeof tokensB.output === 'number' ? tokensB.output : null;
  const tokenTotalB = typeof tokensB.total === 'number' ? tokensB.total : null;

  const cost = {
    telemetryA: String(costA.telemetry || 'unknown'),
    telemetryB: String(costB.telemetry || 'unknown'),
    modelsA: Array.isArray(costA.models) ? costA.models.map(String) : [],
    modelsB: Array.isArray(costB.models) ? costB.models.map(String) : [],
    tokensA: { input: tokenInA, output: tokenOutA, total: tokenTotalA },
    tokensB: { input: tokenInB, output: tokenOutB, total: tokenTotalB },
    tokenDelta: {
      input: (tokenInB !== null && tokenInA !== null) ? tokenInB - tokenInA : null,
      output: (tokenOutB !== null && tokenOutA !== null) ? tokenOutB - tokenOutA : null,
      total: (tokenTotalB !== null && tokenTotalA !== null) ? tokenTotalB - tokenTotalA : null,
    },
  };

  return {
    runA: headerA,
    runB: headerB,
    workersA: {
      count: Number(workersA.count) || 0,
      attempts: Number(workersA.attempts) || 0,
      retries: Number(workersA.retries) || 0,
      quotaStops: Number(workersA.quotaStops) || 0,
    },
    workersB: {
      count: Number(workersB.count) || 0,
      attempts: Number(workersB.attempts) || 0,
      retries: Number(workersB.retries) || 0,
      quotaStops: Number(workersB.quotaStops) || 0,
    },
    summary,
    stages: alignedStages,
    cost,
  };
}

export { alignRuns, formatDuration, formatDurationDelta, formatTokens };
