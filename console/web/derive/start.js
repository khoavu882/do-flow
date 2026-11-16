// The words and the state of the start view (feature 165, design §9.5 and §10): `#/start`, the Layers node of a started session and the
// "Started here" list of Sessions. Pure functions: no DOM, no fetch, no clock. The options are the body of `GET /api/start/options`
// (IC-002) and what is built from them keeps these rules: no harness is ever preselected, a harness that cannot start is listed with the
// core's own words, the models are grouped by source in the core's order, and a new request id comes with every submit while a retry of
// an unanswered one (a 504) keeps its id, so the core replays it instead of starting twice. Every string reaches the page as a text node.

import { refusalWords } from './actions.js';

const KEY16 = /^[0-9a-f]{16}$/;
const RUN_ID = /^w-[0-9a-f]{12}$/;
/** The core's STRIPPED (src/runtime/worker/session-prompt.ts): C0 but tab and LF, DEL and C1, the ALM, LRM and RLM marks and the bidi controls. */
// eslint-disable-next-line no-control-regex
const PROMPT_REMOVED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

/** The core's patterns (src/runtime/worker/start-session.ts step 2): a value outside one is never written into the terminal command. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/;
const HARNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The one sentence of a page that cannot start (design §10 state 1). */
const VIEW_ONLY_WORDS = 'Starting a session needs this machine’s Console or a phone paired with control over the app.';
const ENTRY_DO = 'Start with DoFlow\'s do skill';
const ENTRY_NONE = 'Send my text only';
const NOT_STARTABLE_TITLE = 'Not available on this machine';

// ---- SHA-256, for the agent key of a started run (the core keys the node `sha16('worker:<runId>')`) ----------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The SHA-256 of a text as 64 hex characters (the Web Crypto digest is asynchronous and the page's derivations are not). @param {string} text */
function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (/** @type {number} */ x, /** @type {number} */ n) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = state;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { state[i] = (state[i] + v) >>> 0; });
  }
  return [...state].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * 165 review B-3: the terminal form of the start, for a device that may not start from the page: the whole command of docs/reference.md's
 * **Command.** line with the form's choices and a fresh request id, the first text on stdin. A choice the page does not hold, or one
 * outside the core's pattern, is the reference's placeholder; no `--model` is the harness default and no `--via` is a manual start.
 * @param {{ projectKey?: any, worktreeKey?: any, harness?: any, model?: any, entry?: any } | null | undefined} choices @param {any} requestId
 */
function terminalCommand(choices, requestId) {
  const c = choices && typeof choices === 'object' ? choices : {};
  const fit = (/** @type {any} */ value, /** @type {RegExp} */ re, /** @type {string} */ hole) => (typeof value === 'string' && re.test(value) ? value : hole);
  return [
    'doflow worker --action start-session',
    `--project-key ${fit(c.projectKey, KEY16, '<16 hex>')}`,
    `--worktree-key ${fit(c.worktreeKey, KEY16, '<16 hex>')}`,
    `--harness ${fit(c.harness, HARNESS_ID, '<id>')}`,
    typeof c.model === 'string' && MODEL_ID.test(c.model) ? `--model ${c.model}` : null,
    `--entry ${c.entry === 'none' ? 'none' : 'do'}`,
    `--request-id ${fit(requestId, REQUEST_ID, '<id>')}`,
    '--stdin',
  ].filter((part) => part !== null).join(' ');
}

/** The agent key of a started run in the Layers tree (src/runtime/fleet/tree.ts `workerKey`): 16 hex of the SHA-256 of `worker:<runId>`. @param {string} runId */
const agentKeyOf = (runId) => sha256Hex(`worker:${runId}`).slice(0, 16);

// ---- the words ---------------------------------------------------------------------------------------------------------------------

/** How a start reads on a badge: the Console, a direct command, or a paired device. @param {any} by */
function startedByWords(by) {
  if (by === 'console') return 'started from the Console';
  if (by === 'manual') return 'started by command';
  const device = typeof by === 'string' ? /^device\.(d-[0-9a-f]{12})$/.exec(by) : null;
  return device ? `started from paired device ${device[1]}` : 'starter not recorded';
}

/** The run phases of a started session in words. @type {Readonly<Record<string, string>>} */
const PHASE_WORDS = Object.freeze({ starting: 'starting', running: 'process seen', cancelling: 'stopping', ended: 'ended' });

/** Why a session never started, in words (the supervisor's `not-started` reasons). @type {Readonly<Record<string, string>>} */
const NOT_STARTED_WORDS = Object.freeze({ 'prompt-unwritable': 'its prompt could not be written' });

/**
 * The end of a started session in words, from the node's `end` (`{ state, exitCode, reason }`, 165 F2): the exit code when the process
 * left one, the stop and the time limit, and a session that never started. @param {any} end
 */
function endWords(end) {
  if (!end || typeof end !== 'object') return 'The session ended.';
  if (typeof end.reason === 'string') return `The session did not start: ${NOT_STARTED_WORDS[end.reason] ?? end.reason.replace(/-/g, ' ')}. Nothing ran.`;
  if (end.state === 'exited') {
    if (end.exitCode === 0) return 'The session exited with code 0.';
    return Number.isInteger(end.exitCode) ? `The session exited with code ${end.exitCode}. Its error output is below.` : 'The session exited. Its error output is below.';
  }
  if (end.state === 'timed-out') return 'The session passed its 3600 s limit and was stopped.';
  if (end.state === 'cancelled') return 'The session was stopped.';
  return 'The session ended.';
}

/** The permission sentence before Start (design §9.4). @param {string} harness */
const permissionWords = (harness) => `The session runs with ${harness}’s own permission settings in this checkout. If it needs an approval, nobody can give it here: it waits, skips that step or exits.`;

/** The words of a warning id of the options. @param {string} id @param {string} harness @returns {string | null} */
function warningWords(id, harness) {
  if (id === 'prompt-in-argv') return `${harness} takes the prompt as a command-line argument, so the text is visible in this machine’s process list while the session runs.`;
  if (id === 'runnable-not-checked') return `DoFlow has not checked that ${harness} can run here.`;
  if (id === 'login-not-checked') return `DoFlow has not checked that ${harness} is logged in.`;
  return null;
}

// ---- the options to rows ---------------------------------------------------------------------------------------------------------------

/**
 * The projects of `GET /api/start`: this Console's own first, then the core's order.
 * @param {any} body
 */
function projectRows(body) {
  const list = body && Array.isArray(body.projects) ? body.projects : [];
  const rows = list.filter((/** @type {any} */ p) => p && KEY16.test(String(p.projectKey))).map((/** @type {any} */ p) => ({ projectKey: p.projectKey, label: String(p.label ?? p.projectKey.slice(0, 8)), current: p.current === true }));
  return [...rows.filter((/** @type {any} */ p) => p.current), ...rows.filter((/** @type {any} */ p) => !p.current)];
}

/**
 * The harnesses of the options: the ones that can start in the core's registry order, then the ones that cannot, each with the core's
 * words and, for a logged-out one, when the login was checked. Nothing is marked preferred or chosen.
 * @param {any} options
 */
function harnessRows(options) {
  const list = options && Array.isArray(options.harnesses) ? options.harnesses : [];
  const rows = list.map((/** @type {any} */ item) => ({
    harness: item.harness,
    startable: item.startable === true,
    reason: item.startable === true ? null : (item.reason ?? null),
    words: String(item.words ?? ''),
    version: item.version ?? null,
    checkedAt: item.login && typeof item.login.checkedAt === 'string' ? item.login.checkedAt : null,
    warnings: (Array.isArray(item.warnings) ? item.warnings : []).map((/** @type {string} */ id) => ({ id, words: warningWords(id, item.harness) })).filter((/** @type {any} */ w) => w.words !== null),
    argv: Array.isArray(item.warnings) && item.warnings.includes('prompt-in-argv'),
    models: Array.isArray(item.models) ? item.models : [],
  }));
  return { startable: rows.filter((/** @type {any} */ r) => r.startable), blocked: rows.filter((/** @type {any} */ r) => !r.startable) };
}

/** The harness row by id, or null. @param {any} options @param {string | null} harness */
function harnessOf(options, harness) {
  const { startable, blocked } = harnessRows(options);
  return [...startable, ...blocked].find((/** @type {any} */ r) => r.harness === harness) ?? null;
}

const SOURCE_ORDER = Object.freeze(['orchestrator', 'frontier', 'standard', 'light', 'observed', 'default']);
/** @type {Readonly<Record<string, string>>} */
const SOURCE_LABEL = Object.freeze({ orchestrator: 'Orchestrator', frontier: 'Frontier', standard: 'Standard', light: 'Light', observed: 'Seen in use', default: 'Harness default' });

/**
 * The models of one harness grouped by source in the order orchestrator, frontier, standard, light, observed, then the harness default;
 * an empty group is left out. The `default` entry (id null) reads "Harness default".
 * @param {any[]} models
 */
function modelGroups(models) {
  const list = Array.isArray(models) ? models : [];
  return SOURCE_ORDER
    .map((source) => ({
      source,
      label: SOURCE_LABEL[source],
      models: list.filter((m) => m.source === source).map((m) => ({ id: m.id ?? null, label: m.id ?? 'Harness default' })),
    }))
    .filter((group) => group.models.length > 0);
}

/** The checkouts of the options: the main one first, a busy one marked and not choosable. @param {any} options */
function checkoutRows(options) {
  const list = options && Array.isArray(options.checkouts) ? options.checkouts : [];
  const rows = list.map((/** @type {any} */ c) => ({
    worktreeKey: c.worktreeKey, label: c.label, branch: c.branch ?? null, main: c.main === true, busy: c.busy ? { runId: c.busy.runId } : null,
    note: c.busy ? 'a started session is open here' : null,
  }));
  return [...rows.filter((/** @type {any} */ r) => r.main), ...rows.filter((/** @type {any} */ r) => !r.main)];
}

/** The two entries of the form, the default first (design §10). @param {any} options */
function entryChoices(options) {
  const offered = options && Array.isArray(options.entries) ? options.entries : ['do', 'none'];
  const line = options && typeof options.entryLine === 'string' ? options.entryLine : 'Use the DoFlow do skill for this request:';
  return [
    { id: 'do', label: ENTRY_DO, note: `Sends “${line}”, a blank line, then your text.` },
    { id: 'none', label: ENTRY_NONE, note: 'Sends your text and nothing else.' },
  ].filter((e) => offered.includes(e.id));
}

/** The limits of the options as one line, or null. @param {any} options */
function limitWords(options) {
  if (!options || !options.limits) return null;
  const { limits, open } = options;
  return `${open ? open.machine : 0} of ${limits.machine} sessions open on this machine; ${limits.perCheckout} per checkout, ${limits.perActor} per device and ${limits.perActorPerHour} starts per device per hour.`;
}

/** 165 review A-3: the core could not read the project's dispatch records, so it refuses as if one ran. */
const UNREADABLE_DISPATCH = 'This project’s dispatch records cannot be read, so a running dispatch cannot be ruled out';

/** The dispatch line of the options: a running dispatch holds the slot. @param {any} options */
function dispatchWords(options) {
  const d = options && options.dispatch;
  if (!d || d.running !== true) return null;
  if (d.slug === null && d.reason === 'dispatch-unreadable') return `${UNREADABLE_DISPATCH}; start again when they can be read.`;
  return `A dispatch is running${d.slug ? ` in ${d.slug}` : ''}; start again when it ends.`;
}

// ---- the prompt -------------------------------------------------------------------------------------------------------------------------

/**
 * What the person typed, as the Console and the core read it (CR to LF, the stripped characters removed): its length in code points and
 * UTF-8 bytes against the limits, and the one issue that would refuse it. A text starting with `-` is refused for a harness that takes the
 * prompt as an argument (opencode, pi), and for any harness when only the text is sent.
 * @param {any} value @param {{ codePoints: number, bytes: number } | undefined} max @param {{ entry: string, argv: boolean }} how
 */
function promptState(value, max, how) {
  const limit = max ?? { codePoints: 8000, bytes: 32768 };
  const raw = String(value ?? '');
  const nul = raw.includes('\u0000');
  const text = raw.replace(/\r\n?/g, '\n').replace(PROMPT_REMOVED, '');
  const codePoints = [...text].length;
  const bytes = new TextEncoder().encode(text).length;
  /** @type {string | null} */
  let issue = null;
  if (nul) issue = 'prompt-nul';
  else if (text.trim() === '') issue = 'prompt-empty';
  else if (codePoints > limit.codePoints || bytes > limit.bytes) issue = 'prompt-too-long';
  else if (text.startsWith('-') && (how.entry === 'none' || how.argv)) issue = 'prompt-leading-dash';
  else if (text.startsWith('@') && how.argv) issue = 'prompt-leading-at';
  return { text: raw, codePoints, bytes, max: limit.codePoints, issue, over: codePoints > limit.codePoints || bytes > limit.bytes };
}

// ---- the form ----------------------------------------------------------------------------------------------------------------------------

/**
 * The form after the options for a project arrived. No harness is chosen. The model starts as the harness default once a harness is
 * picked (`null`, a real choice), the entry as the do skill, and a checkout is chosen only when exactly one can be.
 * @param {any} options @param {any} [previous] the form before a re-read: what is still on offer stays chosen
 */
function formFor(options, previous) {
  const checkouts = checkoutRows(options);
  const free = checkouts.filter((c) => c.busy === null);
  const keep = previous && typeof previous === 'object' ? previous : {};
  const worktreeKey = checkouts.some((c) => c.worktreeKey === keep.worktreeKey && c.busy === null) ? keep.worktreeKey : free.length === 1 ? free[0].worktreeKey : null;
  const harness = harnessRows(options).startable.some((/** @type {any} */ r) => r.harness === keep.harness) ? keep.harness : null;
  const offered = harness === null ? [] : modelGroups(harnessOf(options, harness).models).flatMap((g) => g.models);
  const model = harness !== null && offered.some((m) => m.id === keep.model) ? keep.model : null;
  const entry = keep.entry === 'none' && entryChoices(options).some((e) => e.id === 'none') ? 'none' : 'do';
  return { projectKey: options && options.project ? options.project.projectKey : null, worktreeKey, harness, model, entry, prompt: typeof keep.prompt === 'string' ? keep.prompt : '' };
}

/**
 * Whether Start may be pressed and what is missing, in the order the form asks: checkout, harness, text. The prompt issue is the
 * state of `promptState`.
 * @param {any} form @param {any} options
 */
function readiness(form, options) {
  const missing = [];
  const checkout = checkoutRows(options).find((c) => c.worktreeKey === form.worktreeKey) ?? null;
  const row = form.harness === null ? null : harnessRows(options).startable.find((/** @type {any} */ r) => r.harness === form.harness) ?? null;
  if (checkout === null || checkout.busy !== null) missing.push('checkout');
  if (row === null) missing.push('harness');
  const prompt = promptState(form.prompt, options && options.promptMax, { entry: form.entry, argv: row !== null && row.argv });
  if (prompt.issue !== null) missing.push('prompt');
  const dispatch = dispatchWords(options);
  return { ok: missing.length === 0 && dispatch === null, missing, prompt, dispatch, checkout, harness: row };
}

/** The body of `POST /api/actions/start-session` without its request id (IC-004; the dialog adds it). @param {any} form */
function startBody(form) {
  return { v: 1, projectKey: form.projectKey, worktreeKey: form.worktreeKey, harness: form.harness, model: form.model, entry: form.entry, prompt: form.prompt };
}

// ---- the request id of an attempt ----------------------------------------------------------------------------------------------------------

/**
 * The attempt of a submit: a new request id for every submit, and the same one when the body is the one a 504 left unanswered, so the core
 * replays that start instead of making a second.
 * @param {{ requestId: string, signature: string } | null} previous @param {any} body @param {() => string} makeId
 */
function attemptFor(previous, body, makeId) {
  const signature = JSON.stringify(body);
  if (previous && previous.signature === signature) return { requestId: previous.requestId, signature, retry: true };
  return { requestId: makeId(), signature, retry: false };
}

/** What an attempt becomes once its dialog closed in `state`: only an unanswered one is kept for the retry. @param {any} attempt @param {string} state */
const settleAttempt = (attempt, state) => (state === 'unknown' ? attempt : null);

// ---- the refusals ---------------------------------------------------------------------------------------------------------------------------

/** Why a harness cannot start, from the core's reason id. @param {any} reason */
function reasonWords(reason) {
  if (reason === 'not-installed') return 'it is not installed on this machine';
  if (reason === 'logged-out') return 'it is logged out';
  if (reason === 'no-main-session-shape') return 'DoFlow has no recorded headless way to start it';
  if (reason === 'not-listed') return 'it is not a DoFlow harness';
  return 'it is not startable';
}

/**
 * The words of a refusal of the start (design §9.5): one sentence for each error id of IC-004, the `current` the Console gave with it
 * where the sentence uses it. A status and code the page does not know fall back to the generic words of derive/actions.js.
 * @param {any} code @param {any} [current] @param {{ retryAfter?: string | null }} [extra]
 * @returns {string[]}
 */
function startRefusalLines(code, current, extra = {}) {
  const c = current && typeof current === 'object' ? current : {};
  const wait = typeof extra.retryAfter === 'string' && /^[0-9]{1,4}$/.test(extra.retryAfter) ? [`Try again in ${extra.retryAfter} s.`] : [];
  switch (code) {
    case 'prompt-empty': return ['Write what the session should do first. Nothing was started.'];
    case 'prompt-nul': return ['The text holds a NUL character, which cannot be sent. Remove it. Nothing was started.'];
    case 'prompt-too-long': return ['The text is longer than 8000 characters or 32 KiB. Shorten it. Nothing was started.'];
    case 'prompt-leading-dash': return ['The text starts with “-”, which the harness would read as an option. Start it with a word. Nothing was started.'];
    case 'prompt-leading-at': return ['The text starts with “@”, which the harness would read as a file reference. Start it with a word. Nothing was started.'];
    case 'unknown-worktree': return ['This checkout is not one of the project’s checkouts. The options are read again. Nothing was started.'];
    case 'worktree-gone': return ['This checkout no longer exists. The options are read again. Nothing was started.'];
    case 'project-not-found': return ['This project is no longer in DoFlow’s index. The project list is read again. Nothing was started.'];
    case 'model-not-offered': return [`${typeof c.harness === 'string' ? c.harness : 'The harness'} does not offer that model any more. The options are read again. Nothing was started.`];
    case 'checkout-busy': return ['A started session is already open in this checkout. Stop it from Layers, then start again. Nothing was started.'];
    case 'checkout-busy-unknown': return [
      'A started session in this checkout may still be running, and DoFlow cannot check its processes. Nothing was started.',
      `If it has ended, clear it in a terminal on this machine: doflow worker --action cancel --operator --slug started-sessions --worker-run ${typeof c.runId === 'string' && RUN_ID.test(c.runId) ? c.runId : '<run id>'} --via console --reason ended`,
    ];
    case 'dispatch-running': if (c.slug === null && c.reason === 'dispatch-unreadable') return [`${UNREADABLE_DISPATCH}. Nothing was started.`];
      return [`A dispatch is running${typeof c.slug === 'string' ? ` in ${c.slug}` : ''}; start again when it ends. Nothing was started.`];
    case 'harness-not-startable': return [`${typeof c.harness === 'string' ? c.harness : 'The harness'} cannot start here: ${reasonWords(c.reason)}. Nothing was started.`];
    case 'nested-start': return ['This Console runs inside a started session, which cannot start another. Nothing was started.'];
    case 'actor-limit': return [`This device already has ${c.open ?? 'its'} of ${c.max ?? 'the allowed'} sessions open. Stop one from Layers, then start again. Nothing was started.`];
    case 'machine-limit': return [`This machine already has ${c.open ?? 'its'} of ${c.max ?? 'the allowed'} sessions open. Stop one from Layers, then start again. Nothing was started.`];
    case 'start-rate-limited': return ['Too many sessions were started from this device in the last hour. Nothing was started.', ...wait];
    case 'request-reused': return ['This start was already used for a different request. Start again. Nothing was started.'];
    case 'core-lacks-action': return ['The installed DoFlow core cannot start a session. Update the core, then reload this page. Nothing was started.'];
    case 'action-timeout': return ['No answer; check Sessions before trying again.'];
    default: return [refusalWords(code), ...wait];
  }
}

/** Whether a refusal means the options the form drew are old, so the page reads them again. @param {any} code */
const refusalRereads = (code) => ['unknown-worktree', 'worktree-gone', 'project-not-found', 'model-not-offered', 'checkout-busy', 'checkout-busy-unknown', 'dispatch-running', 'harness-not-startable', 'actor-limit', 'machine-limit'].includes(code);

// ---- the state of a start (design §10 states 4 to 8) ---------------------------------------------------------------------------------------------

/** @returns {{ step: string, info: any, run: any, refusal: any, node: any }} */
const initialFlow = () => ({ step: 'form', info: null, run: null, refusal: null, node: null });

/**
 * The state machine of one start: form -> starting -> running -> streaming -> ended, or form -> starting -> refused | unknown. Events:
 * `sending` (the dialog posted: `info` is `{ harness, model, project, checkout }`), `reply` (`{ status, body, headers }`, or null when the
 * transport failed), `output` (`{ text }` whether any output text arrived), `node` (the Layers node of the run, or null), `again`.
 * @param {any} flow @param {any} event
 */
function flowReduce(flow, event) {
  switch (event.type) {
    case 'sending': return { ...initialFlow(), step: 'starting', info: event.info };
    case 'reply': {
      const reply = event.reply;
      const code = reply && reply.body && reply.body.error && typeof reply.body.error.code === 'string' ? reply.body.error.code : null;
      const run = reply && reply.status === 200 && code === null && reply.body && reply.body.result ? reply.body.result.run : null;
      if (run && RUN_ID.test(String(run.runId))) return { ...flow, step: run.phase === 'ended' ? 'ended' : 'running', run, refusal: null };
      if (reply === null || reply.status === 504 || code === 'action-timeout') return { ...flow, step: 'unknown', run: null, refusal: null };
      return { ...flow, step: 'refused', run: null, refusal: { code, current: reply.body && reply.body.current ? reply.body.current : null, status: reply.status, retryAfter: reply.headers ? reply.headers['retry-after'] ?? null : null } };
    }
    case 'output': return flow.step === 'running' && event.text === true ? { ...flow, step: 'streaming' } : flow;
    case 'node': {
      if (flow.run === null || (flow.step !== 'running' && flow.step !== 'streaming' && flow.step !== 'ended')) return flow;
      const node = event.node;
      if (!node) return flow;
      const ended = node.phase === 'ended' || (node.ended && typeof node.ended === 'object');
      return { ...flow, node, step: ended ? 'ended' : flow.step };
    }
    case 'again': return initialFlow();
    default: return flow;
  }
}

/**
 * What the page says for a state of the start: the heading, the lines under it, a state token for the tint and whether a Stop is offered.
 * @param {any} flow
 */
function flowWords(flow) {
  const where = flow.info ? `${flow.info.harness} in ${flow.info.project} / ${flow.info.checkout}` : 'the session';
  switch (flow.step) {
    case 'starting': return { token: 'running', title: `Starting ${where}…`, lines: [], stop: false, output: false };
    case 'running': return { token: 'running', title: `Running: ${where}`, lines: ['No output yet. It appears here when the session writes some.'], stop: true, output: true };
    case 'streaming': return { token: 'running', title: `Running: ${where}`, lines: ['Output of the session, masked, the last 200 lines.'], stop: true, output: true };
    case 'ended': {
      const end = flow.node && flow.node.end ? flow.node.end : flow.run && flow.run.end ? { state: flow.run.end.state, exitCode: null, reason: null } : null;
      const state = end ? end.state : null;
      return { token: end && end.reason ? 'failed' : state === 'exited' || state === null ? 'unknown' : 'rejected', title: `Ended: ${where}`, lines: [endWords(end)], stop: false, output: true };
    }
    case 'unknown': return { token: 'stale', title: 'The outcome is unknown', lines: ['No answer; check Sessions before trying again.', 'Start again to reuse the same request: the core starts it once.'], stop: false, output: false };
    case 'refused': return { token: 'failed', title: 'The session did not start', lines: startRefusalLines(flow.refusal.code, flow.refusal.current, { retryAfter: flow.refusal.retryAfter }), stop: false, output: false };
    default: return { token: 'unknown', title: '', lines: [], stop: false, output: false };
  }
}

/**
 * What a failed read of the project list or of the options says (the statuses of `GET /api/start` and `/api/start/options`).
 * @param {{ status?: number | null, code?: string | null, network?: boolean }} error
 */
function optionsErrorWords(error) {
  const e = error && typeof error === 'object' ? error : {};
  if (e.network === true || e.status === null || e.status === undefined) return 'The Console could not be reached, so the options could not be read. Check that it is still running.';
  if (e.status === 403) return 'This device cannot read what starting needs. Starting a session needs this machine’s Console or a phone paired with control over the app.';
  if (e.status === 404) return 'This project is no longer in DoFlow’s index. Choose another project.';
  if (e.status === 501) return 'The installed DoFlow core cannot start a session. Update the core, then reload this page.';
  if (e.status === 502) return `The DoFlow core answered in a way this Console does not understand${typeof e.code === 'string' ? ` (${e.code})` : ''}. Update the core or the Console, then reload this page.`;
  return `The options could not be read${typeof e.code === 'string' ? ` (${e.code})` : ''}. Try again.`;
}

/** The tree node of a started run among the nodes of a `layers` member body, or null. @param {any} body @param {string} agentKey */
function nodeIn(body, agentKey) {
  const tree = body && body.sections ? body.sections.tree : null;
  if (!tree || tree.ok !== true || !tree.data || !Array.isArray(tree.data.nodes)) return null;
  return tree.data.nodes.find((/** @type {any} */ n) => n && n.agentKey === agentKey) ?? null;
}

/** The lines of output the page keeps (design §10 state 5). */
const OUTPUT_LINES = 200;

/**
 * The last `OUTPUT_LINES` lines of what a file lane holds: its pieces joined by a newline unless a piece was cut mid-line, then split.
 * `dropped` counts the older lines left out. @param {Array<{ text: string, cut?: boolean }>} pieces
 * @returns {{ lines: string[], dropped: number }}
 */
function outputTail(pieces) {
  if (!Array.isArray(pieces) || pieces.length === 0) return { lines: [], dropped: 0 };
  let text = '';
  pieces.forEach((piece, i) => { text += (i > 0 && pieces[i - 1].cut !== true ? '\n' : '') + piece.text; });
  const all = text.split('\n');
  return { lines: all.slice(-OUTPUT_LINES), dropped: Math.max(0, all.length - OUTPUT_LINES) };
}

// ---- the Layers node and the Sessions list ---------------------------------------------------------------------------------------------------------

/** The started sessions the `machine` activity of a project lists: `{ runId, harness, model, phase, startedBy, worktreeKey, createdAt }`, newest first. @param {any} machine @param {string} projectKey */
function startedItems(machine, projectKey) {
  const section = machine && machine.sections ? machine.sections.activity : null;
  if (!section || section.ok !== true || !section.data || !Array.isArray(section.data.items)) return null;
  const item = section.data.items.find((/** @type {any} */ i) => i.projectKey === projectKey);
  if (!item) return { list: [], count: 0 };
  if (!Array.isArray(item.started)) return null;
  return { list: item.started, count: Number.isSafeInteger(item.startedCount) ? item.startedCount : item.started.length };
}

/**
 * "Started here" of the Sessions page: the started sessions of the project the Console runs in, from the `machine` member. `state` is
 * `unread` before the member arrived or when its activity could not be read, `not-reported` for a core that lists none, else `ok`.
 * @param {any} machine
 */
function startedHere(machine) {
  const projects = machine && machine.sections && machine.sections.projects && machine.sections.projects.ok === true ? machine.sections.projects.data.projects : null;
  const here = Array.isArray(projects) ? projects.find((/** @type {any} */ p) => p.current === true) : null;
  if (!here) return { state: 'unread', projectKey: null, rows: [], more: 0 };
  const held = startedItems(machine, here.projectKey);
  if (held === null) return { state: machine && machine.sections && machine.sections.activity && machine.sections.activity.ok === true ? 'not-reported' : 'unread', projectKey: here.projectKey, rows: [], more: 0 };
  const rows = held.list.map((/** @type {any} */ s) => ({
    runId: s.runId, harness: s.harness, model: s.model ?? null, phase: s.phase, startedBy: s.startedBy ?? null, createdAt: s.createdAt ?? null,
    href: `#/layers/${here.projectKey}/agent/${agentKeyOf(s.runId)}`,
  }));
  return { state: 'ok', projectKey: here.projectKey, rows, more: Math.max(0, held.count - rows.length) };
}

export {
  VIEW_ONLY_WORDS, terminalCommand, ENTRY_DO, ENTRY_NONE, NOT_STARTABLE_TITLE, SOURCE_ORDER, PHASE_WORDS,
  sha256Hex, agentKeyOf, startedByWords, endWords, permissionWords, warningWords,
  projectRows, harnessRows, harnessOf, modelGroups, checkoutRows, entryChoices, limitWords, dispatchWords,
  promptState, formFor, readiness, startBody, attemptFor, settleAttempt,
  OUTPUT_LINES, outputTail, optionsErrorWords, nodeIn, startRefusalLines, refusalRereads, initialFlow, flowReduce, flowWords, startedItems, startedHere,
};
