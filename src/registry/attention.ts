'use strict';

// Row 180 design §5 (IC-180-D0): the static checks of a harness's top-level `attention` key, which says how a hook of
// that harness records an ask that waits on the person (a permission prompt, a question, an idle wait) and which hook
// events answer it. The mechanism is data (owner ruling 2026-11-20): one shared bridge step
// (core/harnesses/shared/hooks/bridge/observe-attention.sh) reads `projectAttention(registry)`, checked in beside it as
// attention.json. A supported entry names the payload fields read (`sessionField`, an ask's `kindField` and
// `toolField`); no other payload field is read, so no message text and no tool input reach the record (O-1 a).
// Events are checked against the harness's contract event list in core/registry/contracts.json, the registry's own
// inventory of the harness's hook events. Pure: no I/O, no runtime require.

const STATUSES = Object.freeze(['supported', 'unknown']);
const KINDS = Object.freeze(['permission', 'question', 'idle', 'other']);
/** One top-level payload key name. */
const FIELD_RE = /^[a-z_]{1,40}$/;
/** A value of an ask's kindField, as a key of `kinds` or a member of `skip`. */
const VALUE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 240;
const ASKS_MAX = 4;
const ANSWERED_MAX = 8;
const VALUES_MAX = 16;
const ENTRY_MAX_BYTES = 2048;
const FIELDS = new Set(['status', 'reason', 'sessionField', 'asks', 'answeredBy', 'evidence', 'verification', 'verifiedOn', 'note']);
const ASK_FIELDS = new Set(['event', 'kind', 'kindField', 'kinds', 'skip', 'otherwise', 'toolField']);
const MECHANISM = Object.freeze(['sessionField', 'asks', 'answeredBy']);

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value: any): boolean => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value) && value.length <= TEXT_MAX;
const kindOk = (value: any): boolean => KINDS.includes(value);
const KINDS_TEXT = KINDS.join(', ');

function checkAsk(ask: any, at: string, events: ReadonlySet<string>, fail: (message: string) => void): void {
  if (!isObject(ask)) { fail(`${at} must be an object`); return; }
  for (const key of Object.keys(ask)) if (!ASK_FIELDS.has(key)) fail(`${at} has unknown field '${key}'`);
  if (typeof ask.event !== 'string' || !events.has(ask.event)) fail(`${at} event '${ask.event}' is not an event of the harness contract`);
  if (Object.hasOwn(ask, 'toolField') && (typeof ask.toolField !== 'string' || !FIELD_RE.test(ask.toolField))) fail(`${at} toolField must match ${FIELD_RE}`);
  const fixed = Object.hasOwn(ask, 'kind');
  if (fixed === Object.hasOwn(ask, 'kindField')) { fail(`${at} needs exactly one of kind and kindField`); return; }
  if (fixed) {
    if (!kindOk(ask.kind)) fail(`${at} kind must be one of ${KINDS_TEXT}`);
    for (const key of ['kinds', 'skip', 'otherwise']) if (Object.hasOwn(ask, key)) fail(`${at} a fixed kind forbids '${key}'`);
    return;
  }
  if (typeof ask.kindField !== 'string' || !FIELD_RE.test(ask.kindField)) fail(`${at} kindField must match ${FIELD_RE}`);
  const kinds = isObject(ask.kinds) ? Object.entries(ask.kinds) : [];
  if (kinds.length < 1 || kinds.length > VALUES_MAX) fail(`${at} kinds must be 1 to ${VALUES_MAX} entries`);
  for (const [value, kind] of kinds) {
    if (!VALUE_RE.test(value)) fail(`${at} kinds key '${value}' must match ${VALUE_RE}`);
    if (!kindOk(kind)) fail(`${at} kinds '${value}' must be one of ${KINDS_TEXT}`);
  }
  if (Object.hasOwn(ask, 'skip')) {
    const skip = ask.skip;
    if (!Array.isArray(skip) || skip.length > VALUES_MAX || new Set(skip).size !== skip.length || skip.some((v: any) => typeof v !== 'string' || !VALUE_RE.test(v))) {
      fail(`${at} skip must be at most ${VALUES_MAX} distinct values matching ${VALUE_RE}`);
    } else for (const value of skip) if (isObject(ask.kinds) && Object.hasOwn(ask.kinds, value)) fail(`${at} skip '${value}' is also in kinds`);
  }
  if (!Object.hasOwn(ask, 'otherwise')) fail(`${at} kindField requires otherwise`);
  else if (!kindOk(ask.otherwise)) fail(`${at} otherwise must be one of ${KINDS_TEXT}`);
}

/** Design §5: one refusal per rule. `events` is the harness's contract event list (contracts.json `hookEvents`). */
function validateAttention(entry: any, at: string, errors: string[], { events = [] }: { events?: readonly string[] } = {}): void {
  const fail = (message: string) => { errors.push(`${at} attention: ${message}`); };
  if (!isObject(entry)) { fail('must be an object'); return; }
  for (const key of Object.keys(entry)) if (!FIELDS.has(key)) fail(`has unknown field '${key}'`);
  if (!STATUSES.includes(entry.status)) { fail('status must be supported or unknown'); return; }
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (bytes > ENTRY_MAX_BYTES) fail(`entry is ${bytes} bytes serialized; the limit is ${ENTRY_MAX_BYTES}`);
  if (Object.hasOwn(entry, 'note') && !oneLine(entry.note)) fail(`note must be a string of at most ${TEXT_MAX} characters`);
  if (Object.hasOwn(entry, 'evidence') && (!Array.isArray(entry.evidence) || entry.evidence.some((item: any) => typeof item !== 'string' || !/^https:\/\/\S+$/.test(item)))) fail('evidence must be an array of https URLs');
  if (Object.hasOwn(entry, 'verifiedOn') && (typeof entry.verifiedOn !== 'string' || !DATE_RE.test(entry.verifiedOn))) fail('verifiedOn must be an ISO date (YYYY-MM-DD)');

  if (entry.status === 'unknown') {
    if (!Object.hasOwn(entry, 'reason')) fail('status unknown requires a reason');
    else if (!oneLine(entry.reason)) fail(`reason must be a non-empty line of at most ${TEXT_MAX} characters`);
    for (const key of MECHANISM) if (Object.hasOwn(entry, key)) fail(`status unknown forbids '${key}'`);
    return;
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) fail('evidence must not be empty when status is supported');
  if (typeof entry.verification !== 'string' || !entry.verification.trim()) fail('requires a verification instruction');
  if (!Object.hasOwn(entry, 'verifiedOn')) fail('status supported requires verifiedOn');
  if (typeof entry.sessionField !== 'string' || !FIELD_RE.test(entry.sessionField)) fail(`sessionField must match ${FIELD_RE}`);
  const known = new Set(events);
  const asks = entry.asks;
  const askEvents = new Set<string>();
  if (!Array.isArray(asks) || asks.length < 1 || asks.length > ASKS_MAX) fail(`asks must be 1 to ${ASKS_MAX} entries`);
  else {
    asks.forEach((ask: any, index: number) => checkAsk(ask, `asks[${index}]`, known, fail));
    for (const ask of asks) if (isObject(ask)) askEvents.add(ask.event);
    if (askEvents.size !== asks.length) fail('asks events must be distinct');
  }
  const answered = entry.answeredBy;
  if (!Array.isArray(answered) || answered.length < 1 || answered.length > ANSWERED_MAX || new Set(answered).size !== answered.length) {
    fail(`answeredBy must be 1 to ${ANSWERED_MAX} distinct events`);
    return;
  }
  for (const event of answered) {
    if (typeof event !== 'string' || !known.has(event)) fail(`answeredBy event '${event}' is not an event of the harness contract`);
    else if (askEvents.has(event)) fail(`answeredBy event '${event}' is also an ask`);
  }
}

/** Every shipped harness declares `attention`, and each entry passes against the harness's contract events. */
function attentionProblems(registry: any): string[] {
  const errors: string[] = [];
  for (const harness of registry.harnesses || []) {
    const at = `harness '${harness.id}'`;
    if (harness.attention === undefined) { errors.push(`${at} declares no attention`); continue; }
    const events = (registry.contracts || []).find((c: any) => c.harness === harness.id)?.hookEvents || [];
    validateAttention(harness.attention, at, errors, { events });
  }
  return errors;
}

/** The map the shared step reads: `{<harness>: {sessionField, asks, answeredBy}}` of the supported harnesses, in registry order. */
function projectAttention(registry: any): Record<string, { sessionField: string; asks: any[]; answeredBy: string[] }> {
  const map: Record<string, { sessionField: string; asks: any[]; answeredBy: string[] }> = {};
  for (const harness of registry.harnesses || []) {
    const entry = harness.attention;
    if (!isObject(entry) || entry.status !== 'supported') continue;
    map[harness.id] = { sessionField: entry.sessionField, asks: structuredClone(entry.asks), answeredBy: [...entry.answeredBy] };
  }
  return map;
}

module.exports = { validateAttention, attentionProblems, projectAttention, KINDS };
