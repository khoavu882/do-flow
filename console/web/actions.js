// The page's client of the Console actions (feature 162, design IC-010, D13). `loadActions()` reads `GET /api/actions` once per page
// load, and again after a 501 (the core lacks the action: the reply then says so). `getActions()` and `actionPower(id)` answer from
// what was read, so a view decides at render whether to draw a button or keep its command block. `postAction(id, body)` is the only
// write of the page; it is imported by views/confirm.js and nowhere else (web-safety.test.ts), because a write follows only from a
// person pressing the verb button of the one confirmation dialog.
//
// Transport seam (row 163): every request here goes through one function, `fn({ method, path, headers, body }) -> Promise<{ status,
// headers, body }>`, `fetch` by default. The Android shell sets its own with `setActionTransport` (a bridge that sends the Bearer over
// the pinned connection); the default sends the cookie (`credentials: 'same-origin'`). `body` out is a JSON string or null; `body` in
// is the parsed JSON or null; header names come back lower-case. Nothing runs at import time.

/** @typedef {{ method: string, path: string, headers: Record<string, string>, body: string | null }} ActionRequest */
/** @typedef {{ status: number, headers: Record<string, string>, body: any }} ActionReply */

const ACTION_PATH = /^\/api\/actions(?:\/[a-z][a-z-]*)?$/;

/** The default transport: same-origin `fetch`, the reply's JSON (null when it has none). @param {ActionRequest} request @returns {Promise<ActionReply>} */
async function fetchTransport(request) {
  const response = await globalThis.fetch(request.path, { method: request.method, headers: request.headers, body: request.body ?? undefined, credentials: 'same-origin' });
  /** @type {Record<string, string>} */
  const headers = {};
  if (response.headers && typeof response.headers.forEach === 'function') response.headers.forEach((/** @type {string} */ value, /** @type {string} */ name) => { headers[name.toLowerCase()] = value; });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, headers, body };
}

/** @type {(request: ActionRequest) => Promise<ActionReply>} */
let transport = fetchTransport;

/**
 * Replaces the transport (row 163's native bridge). A function only; `null` puts `fetch` back.
 * @param {((request: ActionRequest) => Promise<ActionReply>) | null} fn
 */
function setActionTransport(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('setActionTransport(fn): fn({ method, path, headers, body }) -> Promise<{ status, headers, body }>');
  transport = fn === null ? fetchTransport : fn;
}

/** @type {{ state: 'idle' | 'loading' | 'ready' | 'failed', body: any, promise: Promise<any> | null }} */
let held = { state: 'idle', body: null, promise: null };
/** @type {Set<() => void>} */
const listeners = new Set();

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';

/** The reply of `GET /api/actions` when it has the IC-002 shape, else null. @param {any} body */
function shapeOf(body) {
  if (!isObject(body) || body.v !== 1 || !isObject(body.actor) || !Array.isArray(body.actions)) return null;
  const actions = body.actions.filter((/** @type {any} */ item) => isObject(item) && typeof item.id === 'string' && typeof item.allowed === 'boolean')
    .map((/** @type {any} */ item) => ({ id: item.id, allowed: item.allowed, reason: typeof item.reason === 'string' ? item.reason : null }));
  const project = isObject(body.project) && typeof body.project.projectKey === 'string' ? { projectKey: body.project.projectKey, label: typeof body.project.label === 'string' ? body.project.label : null } : null;
  return { actor: body.actor, actions, textMax: typeof body.textMax === 'number' ? body.textMax : 500, project };
}

function changed() {
  for (const listener of [...listeners]) listener();
}

/**
 * Reads `GET /api/actions`: once per page load (the answer, or the failure, is kept), and again when `again` is true. Resolves to the
 * shaped body or null (an older Console has no such route; a failed read leaves the page without buttons and keeps every command block).
 * @param {{ again?: boolean }} [options]
 * @returns {Promise<any>}
 */
function loadActions(options = {}) {
  if (held.promise !== null && options.again !== true) return held.promise;
  held = { state: 'loading', body: held.body, promise: null };
  const mine = transport({ method: 'GET', path: '/api/actions', headers: { Accept: 'application/json' }, body: null }).then(
    (reply) => (reply.status === 200 ? shapeOf(reply.body) : null),
    () => null,
  ).then((shaped) => {
    if (held.promise === mine) {
      held = { state: shaped === null ? 'failed' : 'ready', body: shaped, promise: mine };
      changed();
    }
    return shaped;
  });
  held.promise = mine;
  return mine;
}

/** What `loadActions` read, or null before it answered or when it failed. */
const getActions = () => held.body;

/**
 * Whether the page may draw the button of action `id`, and the reason when the Console says it may not. Before the read answers, and
 * when it failed, nothing is allowed and there is no reason to give (the command block simply stays).
 * @param {string} id @returns {{ allowed: boolean, reason: string | null }}
 */
function actionPower(id) {
  const entry = held.body && held.body.actions.find((/** @type {any} */ item) => item.id === id);
  return entry ? { allowed: entry.allowed === true, reason: entry.allowed === true ? null : entry.reason } : { allowed: false, reason: null };
}

/** The project the Console runs in, as `GET /api/actions` names it (`{ projectKey, label }`), or null. */
const currentProject = () => (held.body ? held.body.project : null);

/**
 * Calls `fn` whenever a read of the actions answers, so a view can draw its buttons once they are known. Returns the way to stop.
 * @param {() => void} fn
 */
function onActions(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The write: `POST /api/actions/<id>` with `Content-Type: application/json` exactly and the cookie (`credentials: 'same-origin'`, in
 * the default transport). The reply is handed back as the transport gave it, a refusal included; a transport that fails rejects
 * (the dialog reads that as "outcome unknown"). A 501 means the core lacks the action: the actions are read again.
 * @param {string} id @param {Record<string, any>} body
 * @returns {Promise<ActionReply>}
 */
async function postAction(id, body) {
  const path = `/api/actions/${id}`;
  if (!ACTION_PATH.test(path) || !isObject(body)) throw new TypeError('postAction(id, body): an action id and a JSON object');
  const reply = await transport({ method: 'POST', path, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (reply.status === 501) void loadActions({ again: true });
  return reply;
}

/** Forgets what was read, for a page that starts over (and for tests). */
function resetActions() {
  held = { state: 'idle', body: null, promise: null };
  listeners.clear();
  transport = fetchTransport;
}

export { loadActions, getActions, actionPower, currentProject, onActions, postAction, setActionTransport, resetActions };
