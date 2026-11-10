// Pure routing grammar, route patterns, and URI hash building (IC-003, IC-015, IC-019, IC-020).
// Leaf module: imports no view renderers and no other web modules, breaking ES module cycles.

/**
 * The core range this Console needs. IC-005 sends no range, so this is a client literal; client-core.test.ts
 * asserts it equals console/package.json `doflowCore`.
 */
const CORE_RANGE = '>=2.0.0-beta.7 <3.0.0';

/** IC-003's parameter pattern: a route parameter failing it is not-found before any fetch. */
const PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The Fleet keys of IC-019 and IC-020: 16 lower-case hex. */
const KEY16 = /^[0-9a-f]{16}$/;

/** IC-015's run id of a worker node (RUN_ID, src/runtime/worker/run-store.ts:27). */
const RUN_ID = /^w-[0-9a-f]{12}$/;

/** IC-015's worker tabs, in the order the tab list shows them. */
const SESSION_TABS = Object.freeze(['log', 'transcript', 'result', 'process']);

/** IC-019's worker token: a positive integer without a leading zero. */
const TOKEN = /^[1-9][0-9]*$/;

const SETTING_KEY = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+){1,7}$/;
const FOLLOWUP_ID = /^FU-[0-9a-hjkmnp-tv-z]{6}$/;
const ADVICE_KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ADVICE_PICK = /^adv-[0-9]{13}-[0-9a-f]{6}$/;
const WORKER_CELL = /^[a-z][A-Za-z0-9]{0,31}$/;

/**
 * A Sessions lane in the hash (IC-019) to its key in the form derive/sessions.js builds, or null when a part fails its
 * pattern. `parts` are the segments after `sessions`.
 * @param {string[]} parts
 */
function laneOfParts(parts) {
  const [kind, ...rest] = parts;
  if ((kind === 'hook' || kind === 'launched') && rest.length === 1 && KEY16.test(rest[0])) return `${kind}:${rest[0]}`;
  if (kind === 'lock' && rest.length === 1 && PARAM_PATTERN.test(rest[0])) return `lock:${rest[0]}`;
  if (kind === 'worker' && rest.length === 3 && PARAM_PATTERN.test(rest[0]) && PARAM_PATTERN.test(rest[1]) && TOKEN.test(rest[2])) return `worker:${rest.join('/')}`;
  if (kind === 'run' && rest.length === 3 && KEY16.test(rest[0]) && PARAM_PATTERN.test(rest[1]) && PARAM_PATTERN.test(rest[2])) return `run:${rest.join('/')}`;
  return null;
}

/**
 * The hash segments of a lane key, or null when the key cannot be linked: a part is absent (`-`, DEC-034) or fails its
 * pattern. The inverse of `laneOfParts`.
 * @param {any} key
 */
function laneSegments(key) {
  const text = String(key ?? '');
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const parts = [text.slice(0, colon), ...text.slice(colon + 1).split('/')];
  return laneOfParts(parts) === text ? parts.join('/') : null;
}

/**
 * The selection of a Session route (IC-015) from the segments after `session/<slug>/<taskId>`: `{}` for none, `{ node }` or
 * `{ node, tab }`, or null when a segment fails its pattern. `tab` comes only with a worker node.
 * @param {string[]} parts
 */
function sessionSelection(parts) {
  if (parts.length === 0) return {};
  const [kind, ...rest] = parts;
  if (kind === 'main') return rest.length === 0 ? { node: { kind: 'main' } } : null;
  if (kind === 'stage' || kind === 'gate' || kind === 'task') return rest.length === 1 && PARAM_PATTERN.test(rest[0]) ? { node: { kind, id: rest[0] } } : null;
  if (kind === 'attempt') {
    if (rest.length !== 2 || !PARAM_PATTERN.test(rest[0]) || !TOKEN.test(rest[1])) return null;
    const token = Number(rest[1]);
    return Number.isSafeInteger(token) ? { node: { kind: 'attempt', task: rest[0], token } } : null;
  }
  if (kind === 'worker' && (rest.length === 1 || rest.length === 2) && RUN_ID.test(rest[0])) {
    const node = { kind: 'worker', runId: rest[0] };
    if (rest.length === 1) return { node };
    return SESSION_TABS.includes(rest[1]) ? { node, tab: rest[1] } : null;
  }
  return null;
}

/**
 * The hash segments of a Session route's selection, the inverse of `sessionSelection`: '' for none, null when the node or tab
 * fails its pattern or a tab comes without a worker node.
 * @param {any} route
 */
function sessionSegments(route) {
  const { node, tab } = route;
  if (node === undefined) return tab === undefined ? '' : null;
  if (node === null || typeof node !== 'object') return null;
  if (tab !== undefined && (node.kind !== 'worker' || !SESSION_TABS.includes(tab))) return null;
  switch (node.kind) {
    case 'main': return '/main';
    case 'stage': case 'gate': case 'task': return typeof node.id === 'string' && PARAM_PATTERN.test(node.id) ? `/${node.kind}/${node.id}` : null;
    case 'attempt':
      return typeof node.task === 'string' && PARAM_PATTERN.test(node.task) && Number.isSafeInteger(node.token) && TOKEN.test(String(node.token))
        ? `/attempt/${node.task}/${node.token}` : null;
    case 'worker':
      return typeof node.runId === 'string' && RUN_ID.test(node.runId) ? `/worker/${node.runId}${tab === undefined ? '' : `/${tab}`}` : null;
    default: return null;
  }
}

/**
 * @param {string} hash
 * @param {string} id
 * @returns {boolean}
 */
function isValidManageHash(hash, id) {
  const parts = hash.slice(1).split('/');
  if (parts[1] !== id) return false;
  if (id === 'settings') return parts.length === 2 || (parts.length === 3 && typeof parts[2] === 'string' && parts[2].length <= 96 && SETTING_KEY.test(parts[2]));
  if (id === 'followups') return parts.length === 2 || (parts.length === 3 && FOLLOWUP_ID.test(parts[2]));
  if (id === 'health') return parts.length === 2 || (parts.length === 4 && parts[2] === 'store' && PARAM_PATTERN.test(parts[3]));
  if (id === 'workers') return parts.length === 2 || (parts.length === 5 && PARAM_PATTERN.test(parts[2]) && ['worker', 'orchestration'].includes(parts[3]) && WORKER_CELL.test(parts[4]));
  if (id === 'advice') {
    let i = 2;
    if (parts[i] === 'kind' && ADVICE_KIND.test(parts[i + 1])) i += 2;
    if (parts[i] === 'pick' && ADVICE_PICK.test(parts[i + 1])) i += 2;
    return i === parts.length;
  }
  return false;
}

/**
 * The hash of a route, the inverse of `parseRoute` (IC-019): `parseRoute(hashFor(route))` equals `route` for every route it
 * gives a hash for. Null for `not-found`, for a part failing its pattern, and for a lane that cannot be linked (DEC-034).
 * @param {any} route
 */
function hashFor(route) {
  const params = (route && route.params) || {};
  const id = route ? route.id : null;
  if (id === 'runs') return '#/';
  if (id === 'workflows') return '#/workflows';
  if (id === 'compare') {
    if (params.slugA && params.taskIdA && params.slugB && params.taskIdB) {
      if (!PARAM_PATTERN.test(params.slugA) || !PARAM_PATTERN.test(params.taskIdA) || !PARAM_PATTERN.test(params.slugB) || !PARAM_PATTERN.test(params.taskIdB)) return null;
      return `#/compare/${params.slugA}/${params.taskIdA}/${params.slugB}/${params.taskIdB}`;
    }
    return '#/compare';
  }
  if (['settings', 'advice', 'followups', 'health', 'workers'].includes(id)) {
    let hash = `#/${id}`;
    if (id === 'settings' && route.key !== undefined && typeof route.key !== 'string') return null;
    if (id === 'followups' && route.item !== undefined && typeof route.item !== 'string') return null;
    if (id === 'health' && route.store !== undefined && typeof route.store !== 'string') return null;
    if (id === 'workers' && route.cell !== undefined && (!route.cell || typeof route.cell.harness !== 'string' || typeof route.cell.group !== 'string' || typeof route.cell.cell !== 'string')) return null;
    if (id === 'advice' && ((params.kind !== undefined && typeof params.kind !== 'string') || (route.pick !== undefined && typeof route.pick !== 'string'))) return null;
    if (id === 'settings' && route.key !== undefined) hash += `/${route.key}`;
    if (id === 'followups' && route.item !== undefined) hash += `/${route.item}`;
    if (id === 'health' && route.store !== undefined) hash += `/store/${route.store}`;
    if (id === 'workers' && route.cell !== undefined) hash += `/${route.cell?.harness}/${route.cell?.group}/${route.cell?.cell}`;
    if (id === 'advice') { if (params.kind !== undefined) hash += `/kind/${params.kind}`; if (route.pick !== undefined) hash += `/pick/${route.pick}`; }
    return isValidManageHash(hash, id) ? hash : null;
  }
  if (id === 'fleet') return '#/fleet';
  if (id === 'fleet-project') {
    if (!KEY16.test(params.project) || (params.agent !== undefined && !KEY16.test(params.agent))) return null;
    return `#/fleet/${params.project}${params.agent === undefined ? '' : `/${params.agent}`}`;
  }
  if (id === 'sessions') {
    if (route.mode === 'history' || route.params?.mode === 'history') return '#/sessions/history';
    if (route.lane === undefined) return '#/sessions';
    const lane = laneSegments(route.lane);
    return lane === null ? null : `#/sessions/${lane}`;
  }
  if (id !== 'run' && id !== 'tasks' && id !== 'session') return null;
  if (!PARAM_PATTERN.test(params.slug) || !PARAM_PATTERN.test(params.taskId)) return null;
  if (id === 'session') {
    const selection = sessionSegments(route);
    return selection === null ? null : `#/session/${params.slug}/${params.taskId}${selection}`;
  }
  const base = `#/run/${params.slug}/${params.taskId}`;
  if (id === 'tasks') {
    if (route.task === undefined) return `${base}/tasks`;
    return PARAM_PATTERN.test(route.task) ? `${base}/tasks/${route.task}` : null;
  }
  if (route.sel === undefined) return base;
  const { type, id: selId } = route.sel;
  return (type === 'stage' || type === 'gate') && PARAM_PATTERN.test(selId) ? `${base}/${type}/${selId}` : null;
}

/**
 * The route without its selection (IC-019, 150 IC-015): the base a selection hash change stays inside. Fleet's base keeps the
 * project.
 * @param {any} route
 */
function baseRoute(route) {
  const { sel, task, lane, node, tab, key, pick, item, store, cell, ...rest } = route;
  if (route.id !== 'fleet-project') return rest;
  return { id: 'fleet-project', params: { project: route.params?.project } };
}

export {
  CORE_RANGE,
  PARAM_PATTERN,
  KEY16,
  RUN_ID,
  SESSION_TABS,
  TOKEN,
  laneOfParts,
  laneSegments,
  sessionSelection,
  sessionSegments,
  hashFor,
  baseRoute,
};
