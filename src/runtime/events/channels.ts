'use strict';

// Feature 149 A.3 (IC-003, DEC-006, DEC-042): the channel grammar of `doflow events --follow`.
//
//   channel = "now" / "run:" id ":" id / "tasks:" id / "worker:" runid
//   id      = the Console's PARAM_PATTERN ^[A-Za-z0-9][A-Za-z0-9._-]*$ with the core's length bound
//   runid   = "w-" 12 lowercase hex (src/runtime/worker/run-store.ts RUN_ID)
//
// Every other form is refused, the P2 kinds by name (worker output, transcripts, follow-ups,
// advice, Fleet) so the usage error can say why. Pure: no I/O, no state. A refusal is a returned
// value; the events command turns it into its usage error.

const { ID_PATTERN } = require('../context/identity.ts');
const { RUN_ID } = require('../worker/run-store.ts');

/** DEC-042: the most channels one events process follows. */
const CHANNEL_LIMIT = 64;

/** The channel kinds IC-003 accepts. */
const CHANNEL_KINDS: readonly string[] = Object.freeze(['now', 'run', 'tasks', 'worker']);

type Channel =
  | { kind: 'now'; name: 'now' }
  | { kind: 'run'; name: string; slug: string; taskId: string }
  | { kind: 'tasks'; name: string; slug: string }
  | { kind: 'worker'; name: string; runId: string };

type RefusalCode = 'malformed' | 'refused-kind' | 'unknown-kind' | 'duplicate' | 'too-many-channels';

type ChannelResult = { ok: true; channel: Channel } | { ok: false; code: RefusalCode; reason: string };

type ChannelListResult = { ok: true; channels: Channel[] } | { ok: false; code: RefusalCode; reason: string };

/** Kinds that exist elsewhere in DoFlow but are not channels in this feature (DEC-006, AC-13). */
const REFUSED_KINDS: Record<string, string> = Object.freeze({
  transcript: 'transcripts',
  followups: 'follow-ups',
  advice: 'advice',
  fleet: 'Fleet',
});

/**
 * Whether `value` is a channel id: the Console's PARAM_PATTERN with the core's length bound. The
 * core's `ID_PATTERN` (src/runtime/context/identity.ts) holds both the shape and the bound but no
 * dot, so a dot is read as `_` before the test: the leading character must still be a letter or a
 * digit, and the length is unchanged. Task ids such as `A.3` therefore pass.
 * @param {unknown} value
 * @returns {boolean}
 */
function isChannelId(value: unknown): boolean {
  return typeof value === 'string' && ID_PATTERN.test(value.replace(/\./g, '_'));
}

function refuse(code: RefusalCode, reason: string): { ok: false; code: RefusalCode; reason: string } {
  return { ok: false, code, reason };
}

/** A channel name made safe to quote in a usage message: printable ASCII, at most 80 characters. */
function quoted(text: string): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '?');
  return `'${clean.length > 80 ? `${clean.slice(0, 80)}...` : clean}'`;
}

/**
 * Parses one channel name per IC-003. Opens nothing.
 * @param {unknown} text the channel as given (`--channels` element or a control line's `ch`)
 * @returns {ChannelResult} `{ok: true, channel}`, or `{ok: false, code, reason}` with `code`
 *   `malformed` (a known kind with a bad id), `refused-kind` (a kind kept out of this feature) or
 *   `unknown-kind`, and `reason` one human-readable sentence for the usage error
 */
function parseChannel(text: unknown): ChannelResult {
  if (typeof text !== 'string' || text === '') return refuse('malformed', 'a channel must be a non-empty string');
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === 'now') {
    return parts.length === 1 ? { ok: true, channel: { kind: 'now', name: 'now' } } : refuse('malformed', `${quoted(text)} is not a channel: 'now' takes no id`);
  }
  if (kind === 'run') {
    if (parts.length === 3 && isChannelId(parts[1]) && isChannelId(parts[2])) {
      return { ok: true, channel: { kind: 'run', name: text, slug: parts[1], taskId: parts[2] } };
    }
    return refuse('malformed', `${quoted(text)} is not a channel: use run:<slug>:<taskId>`);
  }
  if (kind === 'tasks') {
    if (parts.length === 2 && isChannelId(parts[1])) return { ok: true, channel: { kind: 'tasks', name: text, slug: parts[1] } };
    return refuse('malformed', `${quoted(text)} is not a channel: use tasks:<slug>`);
  }
  if (kind === 'worker') {
    if (parts.length === 2 && RUN_ID.test(parts[1])) return { ok: true, channel: { kind: 'worker', name: text, runId: parts[1] } };
    if (parts.length === 3 && (parts[2] === 'out' || parts[2] === 'err')) {
      return refuse('refused-kind', `${quoted(text)} is refused: worker output is not a channel in this version`);
    }
    return refuse('malformed', `${quoted(text)} is not a channel: use worker:<runId> with a run id of 'w-' and 12 lowercase hex`);
  }
  if (Object.prototype.hasOwnProperty.call(REFUSED_KINDS, kind)) {
    return refuse('refused-kind', `${quoted(text)} is refused: ${REFUSED_KINDS[kind]} are not a channel in this version`);
  }
  return refuse('unknown-kind', `${quoted(text)} is not a channel: use now, run:<slug>:<taskId>, tasks:<slug> or worker:<runId>`);
}

/**
 * Parses the value of `--channels`: comma-separated channels, each per `parseChannel`, distinct,
 * at most `CHANNEL_LIMIT`. The first failure is returned.
 * @param {unknown} text
 * @returns {ChannelListResult} `{ok: true, channels}` in the given order, or a refusal with the
 *   codes of `parseChannel` plus `duplicate` and `too-many-channels`
 */
function parseChannelList(text: unknown): ChannelListResult {
  if (typeof text !== 'string' || text === '') return refuse('malformed', '--channels needs at least one channel');
  const names = text.split(',');
  if (names.length > CHANNEL_LIMIT) return refuse('too-many-channels', `--channels names ${names.length} channels; at most ${CHANNEL_LIMIT} are followed`);
  const channels: Channel[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const parsed = parseChannel(name);
    if (!parsed.ok) return parsed;
    if (seen.has(name)) return refuse('duplicate', `${quoted(name)} is named more than once in --channels`);
    seen.add(name);
    channels.push(parsed.channel);
  }
  return { ok: true, channels };
}

module.exports = { parseChannel, parseChannelList, isChannelId, CHANNEL_LIMIT, CHANNEL_KINDS };
