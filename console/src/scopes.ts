'use strict';

// The one list of what a paired device may reach (feature 160, IC-007). `buildRoutes` (routes.ts) asks
// `deviceMayUse` for every /api route in LAN mode, after the device check, and checks `session.scope`.
//
// Feature 161 (IC-009, DEC-008): both scopes gain the live stream (every channel kind), the sessions
// read and the worker-run reads. Briefs and task reports reach a device only through `/api/live`
// lanes (a worker run's result, status, log and transcript are also listed below); every route not listed
// here stays refused. A live stream re-runs the device check on every keepalive and ends on a refusal
// (routes.ts `requireDevice`, live-stream.ts).
//
// Feature 162 (IC-007, D6, DEC-009): both scopes read `GET /api/actions`; `control` alone lists the action
// routes `POST /api/actions/<id>`, one per ACTION_IDS entry (three then; 165 adds a fourth, below). The list is necessary, not sufficient: an
// action also needs `deviceMayAct` (a `control` record paired natively, over the native transport), which the
// action handler checks (actions.ts), so a control token carried in a browser cookie never acts.
//
// Feature 165 (IC-004, D7): `start-session` is a fourth action id, and the start form's two reads, `GET /api/start` and
// `GET /api/start/options`, are `control` only (and the loopback session): a `view` device would see a form it can never
// submit. The reads need the scope alone; the transport rule (`deviceMayAct`) is the action's, as for every action.
//
// Feature 172 (IC-005): `GET /api/harness-login` (each worker harness's login answer) is a plain read for both scopes.

/** The Console's action ids (IC-001): each is a route suffix, an actions.ts ACTIONS row and a verb-runner WRITE_SHAPES id. 170 IC-005: `session-send`, `session-steer` and `session-stop` are three more, control scope and loopback like the rest. */
const ACTION_IDS: readonly string[] = Object.freeze(['decide-gate', 'close-run', 'cancel-worker', 'start-session', 'session-send', 'session-steer', 'session-stop']);
/** 165 D7: the start form's reads, the action's own scope. */
const START_READS: readonly string[] = Object.freeze(['GET /api/start', 'GET /api/start/options']);

const READS = Object.freeze([
  'GET /api/info', 'GET /api/runs', 'GET /api/runs/:slug/:taskId', 'GET /api/workflows',
  'GET /api/live', 'GET /api/sessions',
  'GET /api/worker-runs/:slug', 'GET /api/worker-runs/:slug/:runId/result', 'GET /api/worker-runs/:slug/:runId/status',
  'GET /api/worker-runs/:slug/:runId/log', 'GET /api/worker-runs/:slug/:runId/transcript',
  'GET /api/actions', 'GET /api/harness-login',
]);

const DEVICE_ROUTES: Readonly<Record<'view' | 'control', readonly string[]>> = Object.freeze({
  view: READS,
  control: Object.freeze([...READS, ...START_READS, ...ACTION_IDS.map((id) => `POST /api/actions/${id}`)]),
});

/** Reachable with no device: the pairing exchange itself. */
const PAIRING_ROUTES: readonly string[] = Object.freeze(['POST /api/pair']);

/** Reachable with no credential at all: they carry no data, and the page must load before it can pair. */
const PUBLIC_PATHS: readonly string[] = Object.freeze(['GET /healthz', 'GET /* (static web bundle)']);

/** True when a device of `scope` may call `method` on the route declared as `routePath`. */
function deviceMayUse(scope: string, method: string, routePath: string): boolean {
  const list = Object.hasOwn(DEVICE_ROUTES, scope) ? DEVICE_ROUTES[scope as 'view' | 'control'] : [];
  return list.includes(`${method} ${routePath}`);
}

/**
 * D6 / DEC-009: a device session may act only when all three hold: its stored scope is `control`, its record was
 * paired over the native transport (`via`), and this request came over the native class (Bearer, no Origin,
 * no Sec-Fetch-Site, no device cookie; server.ts). The loopback session never reaches this (it has no `via`).
 */
function deviceMayAct(session: { scope?: unknown, via?: unknown } | null | undefined, clientClass: unknown): boolean {
  return !!session && session.scope === 'control' && session.via === 'native' && clientClass === 'native';
}

module.exports = { ACTION_IDS, DEVICE_ROUTES, PAIRING_ROUTES, PUBLIC_PATHS, deviceMayUse, deviceMayAct };
