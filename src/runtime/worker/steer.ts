'use strict';

// Row 170 (design D4, D5, D6, D8, IC-001, section 7; owner ruling R-4): `worker --action send | steer | stop`, the only way
// a message reaches a running started session. A verb checks in IC-001's order, each refusal before any write, drops
// ONE spool file through `channel-spool.ts` (the verb's only write) and waits at most 2 s for the supervisor's ledger
// entry, which is the answer. The text is read from stdin only and never leaves this process but in that file.
//
// The checks, in order: (1) `nested-send` (command.ts asks it before it reads any flag, as for 165's `nested-start`) and
// `sender-in-run`, (2) usage, (3) `project-mismatch` / `project-not-indexed`, (4) `unknown-run`,
// `not-a-session`, `run-ended`, (5) a replay by request id, (6) `no-channel` / `started-without-channel`, `no-steer`,
// (7) the text (`prompt-empty`, `prompt-too-long`, `command-not-allowed`), (8) `channel-closed`, (9) `not-working`,
// (10) `channel-busy`, (11) `actor-rate-limited`. The supervisor re-checks 7, 9 to 11 and its refusal comes back with the
// same code. A message that is in the spool but not yet in the ledger is found by a replay too (`pending`).

const fs = require('node:fs');
const path = require('node:path');
const { storeFileFor, readRuns, RUN_ID } = require('./run-store.ts');
const { STARTED_SLUG, KIND, StartUsageError, resolveProject, pattern, refusal, KEY16, REQUEST_ID } = require('./start-session.ts');
const { STARTED_RUN_VAR } = require('./launch.ts');
const { compileChannel, frameMessage, admit, idOf, CHANNEL_LIMITS } = require('./channel.ts');
const { spoolDir, dropMessage, waitingNames, FILE_MAX } = require('./channel-spool.ts');
const { callerRefusal } = require('./cancel.ts');
const processTree = require('./process-tree.ts');
const { RELAY_LABEL } = require('../relay-label.ts');
const { runKeyFor } = require('../task-run.ts');

/** IC-001: the longest the verb waits for the supervisor's ledger entry, and the poll between reads of the record. */
const WAIT_MS = 2000;
const POLL_MS = 25;
/** After a written entry, the longest extra wait for the harness's answer (inside the 2 s). */
const ANSWER_MS = 500;
const MESSAGE_KIND: Record<string, 'follow-up' | 'steer' | 'stop'> = Object.freeze({ send: 'follow-up', steer: 'steer', stop: 'stop' });
const ACTIONS = Object.freeze(Object.keys(MESSAGE_KIND));

type Turn = { observed: true; state: 'working' | 'waiting'; since: string; seq: number } | { observed: false; reason: string; since: string | null };

/** The cancel that ends a session whose channel is closed or whose supervisor is gone (IC-001 check 8). */
const cancelWords = (runId: string) => `doflow worker --action cancel --slug ${STARTED_SLUG} --worker-run ${runId} --operator --via console --reason ended`;

const WORDS: Record<string, (harness: string, prefix: string | null) => string> = {
  'prompt-empty': () => 'the message is empty',
  'prompt-too-long': () => `the message is over ${CHANNEL_LIMITS.textCodePoints} characters or ${CHANNEL_LIMITS.textBytes} bytes`,
  'command-not-allowed': (harness, prefix) => `${harness} reads a message starting with '${prefix}' as its own command; DoFlow does not send one`,
  'no-steer': (harness) => `${harness} declares no steer message; send a follow-up instead`,
};

/** The turn a reader reports now: the supervisor's own, unless the reader sees the supervisor gone or the channel closed (D9, section 7). */
function turnNow(run: any, supervisorGone: boolean): Turn {
  if (supervisorGone) return { observed: false, reason: 'supervisor-gone', since: null };
  if (run.channel?.state === 'closed') return { observed: false, reason: 'channel-closed', since: null };
  const turn = run.channel?.turn;
  return turn && typeof turn.observed === 'boolean' ? turn : { observed: false, reason: 'no-event-yet', since: null };
}

const channelState = (run: any): 'open' | 'closed' => (run.channel?.state === 'closed' ? 'closed' : 'open');

/** The ledger entry written for `requestId` (the starter's `first` entry carries the start request, which is not a message). */
function entryOf(run: any, requestId: string): any {
  const ledger = Array.isArray(run?.channel?.ledger) ? run.channel.ledger : [];
  return ledger.find((entry: any) => entry?.requestId === requestId && entry.kind !== 'first') ?? null;
}

/** A message with `requestId` still waiting in the spool (read, never taken): `{ kind, at, bytes }` or null. Reading only. */
function waitingFor(root: string, runId: string, requestId: string): { kind: string; at: string; bytes: number } | null {
  let dir: string;
  let names: string[];
  try {
    dir = spoolDir(root, runId);
    names = waitingNames(root, runId);
  } catch { return null; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > FILE_MAX) continue;
      const found = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (found?.requestId === requestId) return { kind: found.kind, at: found.at, bytes: typeof found.text === 'string' ? Buffer.byteLength(found.text, 'utf8') : 0 };
    } catch { /* taken meanwhile, or not a message: not ours */ }
  }
  return null;
}

/**
 * The verbs' one body. `o`: `action` (`send` | `steer` | `stop`), `projectKey`, `workerRun`, `requestId`, `via`, `stdin`,
 * `readStdin()`, `env`, `cwd`, `root` (the lifecycle project root), `platform`, `clock`, `sleep`, `projects(o)` (listProjects).
 * Resolves IC-001's reply; a caller error throws a usage error.
 */
async function steerSession(o: any) {
  const { action, env, cwd, root, platform, clock, sleep, projects } = o;
  const kind = MESSAGE_KIND[action];
  const nowMs = () => clock().getTime();

  // Check 1: a message from inside a started session (`command.ts` answers this one before it reads any flag), or from
  // inside a run or a worker session (cancel's operator rule).
  if (typeof env[STARTED_RUN_VAR] === 'string') return refusal('nested-send', 'a started session cannot send a message to a session', { runId: env[STARTED_RUN_VAR] });
  const key = runKeyFor(env, cwd);
  const who = callerRefusal(key, env, 'operator');
  if (who) return refusal('sender-in-run', 'a message is sent from outside every run and worker session; this caller is inside one', { reason: who.reason });

  // Check 2: the flags, each by pattern.
  const projectKey = pattern(o.projectKey, KEY16, '--project-key', '16 lowercase hex characters');
  const runId = pattern(o.workerRun, RUN_ID, '--worker-run', "'w-' plus 12 lowercase hex characters");
  const requestId = pattern(o.requestId, REQUEST_ID, '--request-id', '22 base64url characters beginning with a letter or digit');
  const by = o.via === undefined || o.via === null ? 'manual' : pattern(o.via, RELAY_LABEL, '--via', 'console or device.d-<12 lowercase hex>');
  if (kind !== 'stop' && o.stdin !== true) throw new StartUsageError('--stdin is required: the message is read from stdin');

  // Check 3: the cwd's project is the one --project-key names, and it is indexed.
  const resolved = resolveProject({ cwd, env, projectKey, projects });
  if (resolved.refused) return resolved.refused;

  // Check 4: the run.
  const file = storeFileFor(root, STARTED_SLUG);
  const run = readRuns(file)[runId] ?? null;
  if (!run) return refusal('unknown-run', `no started session ${runId} in this project`, { runId });
  if (run.kind !== KIND) return refusal('not-a-session', `${runId} is not a started session`, { runId });
  if (run.phase === 'ended') return refusal('run-ended', `the session ${runId} has ended`, { runId });
  // R-9: a recorded supervisor seen gone, whatever its harness still does; one that cannot be read is not called gone.
  const gone = Boolean(run.supervisor) && processTree.alive(run.supervisor, { platform }) === false;

  // Check 5: a replay by request id answers with what was recorded (or the file still waiting), and writes nothing.
  const replayEntry = entryOf(run, requestId);
  if (replayEntry) return answer(run, replayEntry, true, gone, nowMs());
  const waiting = waitingFor(root, runId, requestId);
  if (waiting) return { ok: true, replayed: true, message: { seq: null, kind: waiting.kind, state: 'pending', answer: null, at: waiting.at, bytes: waiting.bytes }, turn: turnNow(run, gone), channel: channelState(run) };

  // Check 6: the session has a channel, and a steer record when steering.
  const descriptor = run.descriptor?.controlChannel;
  if (!run.channel) {
    if (!descriptor || typeof descriptor !== 'object') return refusal('started-without-channel', 'this session was started before sessions had a control channel; it takes no message', { runId });
    const why = descriptor.status === 'supported' ? 'its channel did not open' : typeof descriptor.reason === 'string' ? descriptor.reason : 'its harness declares none';
    return refusal('no-channel', `this session has no control channel: ${why}`, { runId });
  }
  const compiled = compileChannel(run.descriptor);
  if (compiled === null) return refusal('no-channel', 'this session has no usable control channel', { runId });

  // Check 7: the text, the caps and the harness's own command prefix. The text is read from stdin and from nowhere else.
  let text: string | undefined;
  if (kind !== 'stop') {
    text = o.readStdin();
    const framed = frameMessage(compiled, kind, { text, id: idOf(0) });
    if (!framed.ok) return refusal(framed.code, (WORDS[framed.code] ?? (() => `the message is refused: ${framed.code}`))(run.harness, compiled.commandPrefix), { runId });
  }

  // Check 8: the channel is open and its supervisor is there.
  if (run.channel.state === 'closed' || gone) {
    const reason = gone ? 'supervisor-gone' : typeof run.channel.closedReason === 'string' ? run.channel.closedReason : 'closed';
    return refusal('channel-closed', `the session's channel is closed (${reason}); end the session with: ${cancelWords(runId)}`, { runId, reason });
  }

  // Check 9: steer and stop need a turn in progress (FR-013).
  const turn = turnNow(run, false);
  if (kind !== 'follow-up' && turn.observed && turn.state === 'waiting') return refusal('not-working', `the session is waiting for a message; a ${kind} needs a turn in progress`, { turn });

  // Checks 10 and 11: waiting files and the per-actor limits (D6).
  let queued = 0;
  try { queued = waitingNames(root, runId).length; } catch { queued = 0; }
  const admitted = admit(run.channel.ledger, by, kind, nowMs(), queued);
  if (!admitted.ok) {
    return admitted.code === 'channel-busy'
      ? refusal('channel-busy', `${CHANNEL_LIMITS.waiting} messages already wait for this session; try again in a moment`, { runId })
      : refusal('actor-rate-limited', `too many messages from ${by}; try again in ${admitted.retryAfterSeconds} s`, { retryAfterSeconds: admitted.retryAfterSeconds });
  }

  // One spool file, then the wait for the supervisor's ledger entry.
  const at = clock().toISOString();
  const bytes = text === undefined ? 0 : Buffer.byteLength(text, 'utf8'); // the text's size, as a replay and the ledger give it (not the spool file's)
  try {
    dropMessage(root, runId, { kind, requestId, by, at, ...(text === undefined ? {} : { text }) });
  } catch (error: any) {
    if (error?.name !== 'SpoolError') throw error;
    if (error.code === 'message-too-large') return refusal('prompt-too-long', 'the message is too large for the channel', { runId });
    return refusal('channel-closed', `the session's channel has no open spool; end the session with: ${cancelWords(runId)}`, { runId, reason: error.code });
  }
  const deadline = nowMs() + WAIT_MS;
  let seen = readRuns(file)[runId] ?? run;
  let entry = entryOf(seen, requestId);
  while (!entry && nowMs() < deadline) {
    await sleep(POLL_MS);
    seen = readRuns(file)[runId] ?? seen;
    entry = entryOf(seen, requestId);
  }
  if (!entry) {
    return { ok: true, replayed: false, message: { seq: null, kind, state: 'pending', answer: null, at, bytes }, turn: turnNow(seen, false), channel: channelState(seen) };
  }
  // The harness answers a record a moment after it is written: wait for that, inside the same 2 s.
  if (entry.outcome === 'written' && entry.answer === null && compiled.answer !== null) {
    const until = Math.min(deadline, nowMs() + ANSWER_MS);
    while (entry.answer === null && nowMs() < until) {
      await sleep(POLL_MS);
      seen = readRuns(file)[runId] ?? seen;
      entry = entryOf(seen, requestId) ?? entry;
    }
  }
  return answer(seen, entry, false, false, nowMs());
}

/** IC-001's reply from a ledger entry: written is `ok`; a refused or failed entry is `ok: false` with its reason as the code. */
function answer(run: any, entry: any, replayed: boolean, gone: boolean, now: number) {
  const turn = turnNow(run, gone);
  if (entry.outcome !== 'written') {
    const code = typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : entry.outcome;
    const current: any = { runId: run.runId, turn };
    if (code === 'actor-rate-limited') {
      const again = admit(run.channel?.ledger ?? [], entry.by, entry.kind, now, 0);
      if (!again.ok && again.retryAfterSeconds) current.retryAfterSeconds = again.retryAfterSeconds;
    }
    return refusal(code, `the session ${entry.outcome === 'refused' ? 'refused' : 'could not take'} the message: ${code}`, current);
  }
  return {
    ok: true, replayed,
    message: { seq: entry.seq, kind: entry.kind, state: 'written', answer: entry.answer ?? null, at: entry.at, bytes: entry.bytes },
    turn, channel: channelState(run),
  };
}

module.exports = { steerSession, ACTIONS, WAIT_MS };
