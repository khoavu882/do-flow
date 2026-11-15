'use strict';

// Feature 149 A.3 (IC-003, DEC-006, DEC-042): the channel grammar of `doflow events --follow`.
//
//   channel = "now" / "run:" id ":" id / "tasks:" id / "worker:" runid [ ":" stream ]
//           / "machine" / "layers:" key / "file:" key ":" key / "transcript:" key ":" key
//   id      = the Console's PARAM_PATTERN ^[A-Za-z0-9][A-Za-z0-9._-]*$ with the core's length bound
//   runid   = "w-" 12 lowercase hex (src/runtime/worker/run-store.ts RUN_ID)
//   stream  = "out" / "err"
//   key     = 16 lowercase hex (a project, file or agent key)
//
// Feature 150 A.6 (IC-006): `worker:<runId>:out` and `:err` are the log channels (kind `log`);
// any other stream, `last` included, is malformed, so no path to `<runId>.last.log` is ever named.
// Feature 161 (IC-001): `machine`, `layers:<pk>`, `file:<pk>:<fk>` and `transcript:<pk>:<ak>` join
// them; `machine` and `layers` are state channels, `file` and `transcript` are log channels. Every
// other form is refused, the kinds kept out by name (follow-ups, advice) so the usage error can say why. Pure: no I/O, no state. A refusal is a returned value; the
// events command turns it into its usage error.

const { ID_PATTERN } = require('../context/identity.ts');
const { RUN_ID } = require('../worker/run-store.ts');

/** DEC-042: the most channels one events process follows. */
const CHANNEL_LIMIT = 64;

/** The channel kinds IC-003 and 150 IC-006 accept. */
const CHANNEL_KINDS: readonly string[] = Object.freeze(['now', 'run', 'tasks', 'worker', 'log', 'machine', 'layers', 'file', 'transcript']);

/** 161 IC-001: a project, file or agent key. */
const KEY_PATTERN = /^[0-9a-f]{16}$/;

/** 161 IC-001, IC-008: the most distinct projects one events process follows across `layers`, `file` and `transcript`. */
const PROJECT_LIMIT = 8;

type Channel =
  | { kind: 'now'; name: 'now' }
  | { kind: 'run'; name: string; slug: string; taskId: string }
  | { kind: 'tasks'; name: string; slug: string }
  | { kind: 'worker'; name: string; runId: string }
  | { kind: 'log'; name: string; runId: string; stream: 'out' | 'err' }
  | { kind: 'machine'; name: 'machine' }
  | { kind: 'layers'; name: string; projectKey: string }
  | { kind: 'file'; name: string; projectKey: string; fileKey: string }
  | { kind: 'transcript'; name: string; projectKey: string; agentKey: string };

type RefusalCode = 'malformed' | 'refused-kind' | 'unknown-kind' | 'duplicate' | 'too-many-channels' | 'too-many-projects';

type ChannelResult = { ok: true; channel: Channel } | { ok: false; code: RefusalCode; reason: string };

type ChannelListResult = { ok: true; channels: Channel[] } | { ok: false; code: RefusalCode; reason: string };

/** Kinds that exist elsewhere in DoFlow but are not channels in this feature (DEC-006, AC-13). */
const REFUSED_KINDS: Record<string, string> = Object.freeze({
  followups: 'follow-ups',
  advice: 'advice',
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
    if (parts.length === 3 && RUN_ID.test(parts[1])) {
      const stream = parts[2];
      if (stream === 'out' || stream === 'err') return { ok: true, channel: { kind: 'log', name: text, runId: parts[1], stream } };
      return refuse('malformed', `${quoted(text)} is not a channel: only out and err are worker output channels`);
    }
    return refuse('malformed', `${quoted(text)} is not a channel: use worker:<runId> with a run id of 'w-' and 12 lowercase hex`);
  }
  if (kind === 'machine') {
    return parts.length === 1 ? { ok: true, channel: { kind: 'machine', name: 'machine' } } : refuse('malformed', `${quoted(text)} is not a channel: 'machine' takes no id`);
  }
  if (kind === 'layers') {
    if (parts.length === 2 && KEY_PATTERN.test(parts[1])) return { ok: true, channel: { kind: 'layers', name: text, projectKey: parts[1] } };
    return refuse('malformed', `${quoted(text)} is not a channel: use layers:<projectKey> with 16 lowercase hex`);
  }
  if (kind === 'file') {
    if (parts.length === 3 && KEY_PATTERN.test(parts[1]) && KEY_PATTERN.test(parts[2])) return { ok: true, channel: { kind: 'file', name: text, projectKey: parts[1], fileKey: parts[2] } };
    return refuse('malformed', `${quoted(text)} is not a channel: use file:<projectKey>:<fileKey>, each 16 lowercase hex`);
  }
  if (kind === 'transcript') {
    if (parts.length === 3 && KEY_PATTERN.test(parts[1]) && KEY_PATTERN.test(parts[2])) return { ok: true, channel: { kind: 'transcript', name: text, projectKey: parts[1], agentKey: parts[2] } };
    return refuse('malformed', `${quoted(text)} is not a channel: use transcript:<projectKey>:<agentKey>, each 16 lowercase hex`);
  }
  if (Object.prototype.hasOwnProperty.call(REFUSED_KINDS, kind)) {
    return refuse('refused-kind', `${quoted(text)} is refused: ${REFUSED_KINDS[kind]} are not a channel in this version`);
  }
  return refuse('unknown-kind', `${quoted(text)} is not a channel: use now, run:<slug>:<taskId>, tasks:<slug>, worker:<runId>, worker:<runId>:out|err, machine, layers:<projectKey>, file:<projectKey>:<fileKey> or transcript:<projectKey>:<agentKey>`);
}

/**
 * The project a `layers`, `file` or `transcript` channel names, else null: what the 8-project bound counts.
 * @param {Channel} channel
 * @returns {string | null}
 */
function projectKeyOf(channel: Channel): string | null {
  return channel.kind === 'layers' || channel.kind === 'file' || channel.kind === 'transcript' ? channel.projectKey : null;
}

/** Whether `channel` is a log channel (`worker:<runId>:out|err`, `file`, `transcript`): framed by LOG_ID, not sections. */
function isLogKind(channel: Channel): boolean {
  return channel.kind === 'log' || channel.kind === 'file' || channel.kind === 'transcript';
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
  const projects = new Set<string>();
  for (const name of names) {
    const parsed = parseChannel(name);
    if (!parsed.ok) return parsed;
    if (seen.has(name)) return refuse('duplicate', `${quoted(name)} is named more than once in --channels`);
    seen.add(name);
    const project = projectKeyOf(parsed.channel);
    if (project !== null) {
      projects.add(project);
      if (projects.size > PROJECT_LIMIT) return refuse('too-many-projects', `--channels names more than ${PROJECT_LIMIT} projects; at most ${PROJECT_LIMIT} are followed`);
    }
    channels.push(parsed.channel);
  }
  return { ok: true, channels };
}

module.exports = { parseChannel, parseChannelList, isChannelId, projectKeyOf, isLogKind, CHANNEL_LIMIT, CHANNEL_KINDS, PROJECT_LIMIT };
