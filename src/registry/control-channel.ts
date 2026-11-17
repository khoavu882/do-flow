'use strict';

/**
 * The static checks of the `control-channel-v1` grammar (design 170 section 4.2): C0 shape, C1 placeholders, C2
 * literals, C3 tests, C4 argv, C5 parser, C6 needs, C7 unverified, plus the optional `commandPrefix` (owner ruling
 * R-4). Pure: no I/O, nothing under `src/runtime/`. `validateWorker` (index.ts) runs it for `worker.controlChannel`
 * beside the checks every capability entry takes (status, evidence, verification, verifiedOn, the closed field set per
 * status), so this module reads only what the grammar adds. Every message is `<location>: <message>` and starts, inside
 * the entry, with the JSON path it refers to.
 */

const { checkPath, checkTest, checkContradictions } = require('./field-map.ts');
const { wideningProblem } = require('./widening-flags.ts');
const { secretProblem } = require('./secret-flags.ts');

const MAX_BYTES = 8 * 1024;
const MAX_TESTS = 8;
const MAX_KEYS = 8;
const MAX_DEPTH = 2;
const MAX_ARGV = 32;
const MAX_STRING_CHARS = 200;
const MAX_UNVERIFIED = 8;
const MAX_UNVERIFIED_CHARS = 120;
const PREFIX_CHARS = [1, 4];
const GRACE_SECONDS = [1, 60];

/** The two whole-string placeholders a template may hold. */
const PLACEHOLDERS = Object.freeze(['{text}', '{id}']);
const TEXT = '{text}';
const ID = '{id}';

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ANY_BRACE = /[{}]/;
const PLACEHOLDER_LIKE = /\{[^{}]*\}/;
const WHITESPACE_OR_CONTROL = /[\p{C}\p{Z}\s]/u;

const ENTRY_KEYS = ['status', 'evidence', 'verification', 'verifiedOn', 'reason', 'argv', 'framing', 'parser', 'messages', 'turn', 'answer', 'close', 'unverified', 'commandPrefix'];
const SUPPORTED_REQUIRED = ['argv', 'framing', 'parser', 'messages', 'turn', 'close'];
const MESSAGE_KINDS = ['followUp', 'steer', 'stop'];

/** What validateWorker shares with this module, passed in so the registry's own rules stay in one place. */
type Context = {
  binary?: unknown;                 // worker.cli.binary, for the per-binary widening and secret sets
  declared?: readonly any[];        // worker.wideningFlags
  secretDeclared?: readonly any[];  // worker.secretFlags
  parsers?: readonly string[];      // the PARSERS keys, when the caller has them; absent means shape only
  fieldMapId?: string | null;       // this worker's own structuredOutput.fieldMap.id
  mainSessionStatus?: string;       // worker.mainSession.status
  harnessId?: string | null;        // the harness whose evidence directory a live-run record sits in
};

function issue(errors: string[], location: string, message: string): void { errors.push(`${location}: ${message}`); }
function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(value: any, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function chars(value: string): number { return Array.from(value).length; }

/** Reports every key of `value` outside `allowed`, and every missing `required` key. */
function closedKeys(value: any, allowed: string[], required: string[], location: string, errors: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(errors, location, `unknown key '${key}'`);
  for (const key of required) if (!has(value, key)) issue(errors, location, `missing key '${key}'`);
}

/** Key order does not make two templates different. */
function canonical(value: any): string {
  if (!object(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** Walks one template; counts its placeholders into `seen` and reports C0, C1 and C2 problems. */
function checkTemplate(node: any, depth: number, location: string, errors: string[], seen: Record<string, number>): void {
  if (!object(node)) { issue(errors, location, 'a template is an object of literals, placeholders and one level of nested objects'); return; }
  if (depth > MAX_DEPTH) { issue(errors, location, `a template is at most ${MAX_DEPTH} objects deep`); return; }
  const keys = Object.keys(node);
  if (keys.length > MAX_KEYS) issue(errors, location, `an object holds at most ${MAX_KEYS} keys`);
  for (const key of keys) {
    const at = `${location}.${key}`;
    if (!SEGMENT.test(key)) issue(errors, at, `a key matches ${SEGMENT}`);
    else if (FORBIDDEN_KEYS.has(key)) issue(errors, at, `a key must not be '${key}'`);
    const value = node[key];
    if (object(value)) { checkTemplate(value, depth + 1, at, errors, seen); continue; }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) issue(errors, at, 'a number must be finite');
      continue;
    }
    if (typeof value !== 'string') { issue(errors, at, 'a value is a string, a finite number, a boolean, null or an object'); continue; }
    if (PLACEHOLDERS.includes(value)) { seen[value] = (seen[value] ?? 0) + 1; continue; }
    if (ANY_BRACE.test(value)) { issue(errors, at, `a placeholder (${PLACEHOLDERS.join(', ')}) is a whole string value, never part of one`); continue; }
    if (chars(value) > MAX_STRING_CHARS) issue(errors, at, `a string literal is at most ${MAX_STRING_CHARS} characters`);
  }
}

function checkTests(list: any, location: string, errors: string[]): boolean {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TESTS) { issue(errors, location, `holds 1 to ${MAX_TESTS} tests`); return false; }
  const before = errors.length;
  list.forEach((test, i) => checkTest(test, `${location}[${i}]`, errors));
  if (errors.length > before) return false;
  const contradictions: string[] = [];
  checkContradictions({ when: list }, location, contradictions);
  if (contradictions.length > 0) { errors.push(...contradictions); return false; }
  return true;
}

/** Two clean test lists must not both match one event: joined, the tests contradict (the S4 check of field-map.ts). */
function checkExclusive(a: any[], b: any[], location: string, errors: string[], names: string): void {
  const joined: string[] = [];
  checkContradictions({ when: [...a, ...b] }, location, joined);
  if (joined.length === 0) issue(errors, location, `${names} can both match one event; one test of each must exclude the other`);
}

function checkArgv(argv: any, location: string, errors: string[], ctx: Context): void {
  if (!Array.isArray(argv) || argv.some((item: any) => typeof item !== 'string')) { issue(errors, location, 'argv must be an array of strings'); return; }
  if (argv.length > MAX_ARGV) { issue(errors, location, `argv must have at most ${MAX_ARGV} elements`); return; }
  if (argv.some((item: string) => item.length > MAX_STRING_CHARS)) { issue(errors, location, `argv elements must be at most ${MAX_STRING_CHARS} characters`); return; }
  if (argv.some((item: string) => item.includes('\0'))) { issue(errors, location, 'argv elements must not contain NUL'); return; }
  for (const item of argv) {
    if (item === '-' || item === '--') issue(errors, location, `argv must not contain the element '${item}'`);
    const token = PLACEHOLDER_LIKE.exec(item);
    if (token) issue(errors, location, `argv must not contain the placeholder '${token[0]}'; a message travels in a record, not on the command line`);
  }
  const widening = wideningProblem(argv, { binary: ctx.binary, declared: ctx.declared ?? [], mainSession: true });
  if (widening) issue(errors, location, `argv must not contain the widening flag '${widening}'`);
  const secret = secretProblem(argv, { binary: ctx.binary, declared: ctx.secretDeclared ?? [] });
  if (secret) issue(errors, location, `argv must not contain the secret-printing flag or command '${secret}'`);
}

function checkUnverified(entry: any, location: string, errors: string[], ctx: Context): void {
  const evidence: unknown[] = Array.isArray(entry.evidence) ? entry.evidence : [];
  const liveRun = ctx.harnessId
    ? new RegExp(`^core/worker-evidence/${ctx.harnessId.replace(/[^A-Za-z0-9-]/g, '')}/[^/]*live-run[^/]*\\.json$`)
    : null;
  const live = liveRun !== null && evidence.some((item) => typeof item === 'string' && liveRun.test(item));
  if (!has(entry, 'unverified')) {
    if (!live) issue(errors, `${location}.unverified`, 'is required unless an evidence item is a live-run record of this harness');
    return;
  }
  const list = entry.unverified;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_UNVERIFIED) { issue(errors, `${location}.unverified`, `holds 1 to ${MAX_UNVERIFIED} phrases`); return; }
  list.forEach((phrase: any, i: number) => {
    if (typeof phrase !== 'string' || !phrase.trim() || chars(phrase) > MAX_UNVERIFIED_CHARS || /[\p{C}]/u.test(phrase)) {
      issue(errors, `${location}.unverified[${i}]`, `a phrase is 1 to ${MAX_UNVERIFIED_CHARS} printable characters`);
    }
  });
}

/**
 * Validates one `controlChannel` capability entry and pushes one error string per problem onto `errors`.
 * `unsupported` and `unknown` entries carry a reason and no recipe field (the closed field set per status is
 * validateWorker's); a `supported` entry is the full grammar of design 170 section 4.1.
 */
function validateControlChannel(entry: any, location: string, errors: string[], ctx: Context = {}): void {
  if (!object(entry)) { issue(errors, location, 'a control channel is an object'); return; }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(entry)); } catch { issue(errors, location, 'the entry cannot be serialized'); return; }
  if (bytes > MAX_BYTES) { issue(errors, location, `the entry is ${bytes} bytes, at most ${MAX_BYTES}`); return; }
  if (entry.status !== 'supported') {
    if (entry.status === 'unsupported' && (typeof entry.reason !== 'string' || !entry.reason.trim())) issue(errors, location, 'unsupported requires a reason');
    return;
  }

  closedKeys(entry, ENTRY_KEYS, SUPPORTED_REQUIRED, location, errors);
  if (has(entry, 'framing') && entry.framing !== 'jsonl-lf') issue(errors, `${location}.framing`, "'framing' is 'jsonl-lf'");
  if (has(entry, 'commandPrefix')) {
    const prefix = entry.commandPrefix;
    if (typeof prefix !== 'string' || chars(prefix) < PREFIX_CHARS[0] || chars(prefix) > PREFIX_CHARS[1] || WHITESPACE_OR_CONTROL.test(prefix)) {
      issue(errors, `${location}.commandPrefix`, `'commandPrefix' is ${PREFIX_CHARS[0]} to ${PREFIX_CHARS[1]} printable characters with no space`);
    }
  }
  if (has(entry, 'argv')) checkArgv(entry.argv, `${location}.argv`, errors, ctx);

  if (has(entry, 'parser')) {
    const parser = entry.parser;
    if (parser !== null && (typeof parser !== 'string' || !parser.trim())) issue(errors, `${location}.parser`, "'parser' is a parser id or null");
    else if (typeof parser === 'string' && ctx.parsers !== undefined && !ctx.parsers.includes(parser) && parser !== ctx.fieldMapId) {
      issue(errors, `${location}.parser`, `'${parser}' is neither a registered parser nor this worker's structuredOutput.fieldMap.id`);
    }
  }

  if (ctx.mainSessionStatus !== undefined && ctx.mainSessionStatus !== 'supported') {
    issue(errors, location, `a supported channel needs a supported mainSession (it is ${ctx.mainSessionStatus}): the harness must be startable`);
  }

  const answered = has(entry, 'answer');
  if (has(entry, 'messages')) {
    const messages = entry.messages;
    if (!object(messages)) issue(errors, `${location}.messages`, "'messages' is an object");
    else {
      closedKeys(messages, MESSAGE_KINDS, ['followUp', 'stop'], `${location}.messages`, errors);
      const seenTemplates = new Map<string, string>();
      for (const kind of MESSAGE_KINDS) {
        if (!has(messages, kind)) continue;
        const at = `${location}.messages.${kind}`;
        const seen: Record<string, number> = {};
        const before = errors.length;
        checkTemplate(messages[kind], 1, at, errors, seen);
        if (errors.length > before) continue;
        const wantText = kind === 'stop' ? 0 : 1;
        if ((seen[TEXT] ?? 0) !== wantText) issue(errors, at, wantText === 0 ? `a stop record holds no ${TEXT}` : `holds ${TEXT} exactly once`);
        if ((seen[ID] ?? 0) > 1) issue(errors, at, `holds ${ID} at most once`);
        else if (answered && (seen[ID] ?? 0) !== 1) issue(errors, at, `holds ${ID} once because 'answer' is declared`);
        else if (!answered && (seen[ID] ?? 0) !== 0) issue(errors, at, `holds ${ID} but no 'answer' is declared to match it`);
        const form = canonical(messages[kind]);
        const same = seenTemplates.get(form);
        if (same !== undefined) issue(errors, at, `equals messages.${same}; each record is its own`);
        else seenTemplates.set(form, kind);
      }
    }
  }

  let working: any[] | null = null;
  let settled: any[] | null = null;
  if (has(entry, 'turn')) {
    const turn = entry.turn;
    if (!object(turn)) issue(errors, `${location}.turn`, "'turn' is an object");
    else {
      closedKeys(turn, ['working', 'settled'], ['working', 'settled'], `${location}.turn`, errors);
      if (has(turn, 'working') && checkTests(turn.working, `${location}.turn.working`, errors)) working = turn.working;
      if (has(turn, 'settled') && checkTests(turn.settled, `${location}.turn.settled`, errors)) settled = turn.settled;
      if (working && settled) checkExclusive(working, settled, `${location}.turn`, errors, 'working and settled');
    }
  }

  if (answered) {
    const answer = entry.answer;
    if (!object(answer)) issue(errors, `${location}.answer`, "'answer' is an object");
    else {
      closedKeys(answer, ['id', 'accepted', 'refused'], ['id', 'accepted', 'refused'], `${location}.answer`, errors);
      if (has(answer, 'id')) checkPath(answer.id, `${location}.answer.id`, errors);
      let accepted: any[] | null = null;
      let refused: any[] | null = null;
      if (has(answer, 'accepted') && checkTests(answer.accepted, `${location}.answer.accepted`, errors)) accepted = answer.accepted;
      if (has(answer, 'refused') && checkTests(answer.refused, `${location}.answer.refused`, errors)) refused = answer.refused;
      if (accepted && refused) checkExclusive(accepted, refused, `${location}.answer`, errors, 'accepted and refused');
    }
  }

  if (has(entry, 'close')) {
    const close = entry.close;
    if (!object(close)) issue(errors, `${location}.close`, "'close' is an object");
    else {
      closedKeys(close, ['stdinEof', 'graceSeconds'], ['stdinEof', 'graceSeconds'], `${location}.close`, errors);
      if (has(close, 'stdinEof') && close.stdinEof !== 'exits') issue(errors, `${location}.close.stdinEof`, "'stdinEof' is 'exits'");
      if (has(close, 'graceSeconds') && (!Number.isInteger(close.graceSeconds) || close.graceSeconds < GRACE_SECONDS[0] || close.graceSeconds > GRACE_SECONDS[1])) {
        issue(errors, `${location}.close.graceSeconds`, `'graceSeconds' is an integer from ${GRACE_SECONDS[0]} to ${GRACE_SECONDS[1]}`);
      }
    }
  }

  checkUnverified(entry, location, errors, ctx);
}

module.exports = { validateControlChannel, PLACEHOLDERS, MAX_BYTES };
