'use strict';

// The one list of what a paired device may reach (feature 160, IC-007). `buildRoutes` (routes.ts) asks
// `deviceMayUse` for every /api route in LAN mode, after the device check; row 162 adds `control`-only
// entries here and checks `session.scope`. In this row `control` is a value a device can hold and the
// list shows, but it reads exactly what `view` reads.
//
// Feature 161 (IC-009, DEC-008): both scopes gain the live stream (every channel kind), the sessions
// read and the worker-run reads. Briefs and task reports reach a device only through `/api/live`
// lanes (a worker run's result, status, log and transcript are also listed below); every route not listed
// here stays refused. A live stream re-runs the device check on every keepalive and ends on a refusal
// (routes.ts `requireDevice`, live-stream.ts).

const READS = Object.freeze([
  'GET /api/info', 'GET /api/runs', 'GET /api/runs/:slug/:taskId', 'GET /api/workflows',
  'GET /api/live', 'GET /api/sessions',
  'GET /api/worker-runs/:slug', 'GET /api/worker-runs/:slug/:runId/result', 'GET /api/worker-runs/:slug/:runId/status',
  'GET /api/worker-runs/:slug/:runId/log', 'GET /api/worker-runs/:slug/:runId/transcript',
]);

const DEVICE_ROUTES: Readonly<Record<'view' | 'control', readonly string[]>> = Object.freeze({
  view: READS,
  control: READS,
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

module.exports = { DEVICE_ROUTES, PAIRING_ROUTES, PUBLIC_PATHS, deviceMayUse };
