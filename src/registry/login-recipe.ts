'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The static checks of a declared login recipe, `worker.loginProbe` (design 172 section 3.2): L0 size, L1 the
 * `{provider}` slot, L2 output, L3 answers, L4 billing, L5 expiry signs, plus `hint` and `caveat` (LD-1). Pure: no
 * I/O, nothing under `src/runtime/`. `validateWorker` (index.ts) runs it beside the checks every capability entry
 * takes, which already cover the entry's closed key set per status, the required recipe fields, `argv`'s shape and its
 * other placeholders, and L6 (the widening and secret flags of `argv` and `providers.argv`, with the worker's own
 * declared flags). Every message starts with the JSON location inside the entry it refers to.
 */

const { checkPath, checkTest, checkContradictions, implies } = require('./field-map.ts');

const MAX_BYTES = 8 * 1024;
const MAX_ANSWERS = 8;
const MAX_TESTS = 8;
const MAX_PROVIDERS = 8;
const MAX_BILLING_VALUES = 16;
const MAX_BILLING_KEY_CHARS = 64;
const MAX_SIGNS = 8;
const SIGN_CHARS = [4, 120];
const SIGN_LEAD_CHARS = 4;
const HINT_CHARS = 120;
const CAVEAT_CHARS = 160;

const SLOT = '{provider}';
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const OUTPUTS = ['json', 'none'];
const STATES = ['logged-in', 'logged-out', 'expired', 'unknown'];
const EMPTY_MEANS = ['logged-out', 'unknown'];
const EXPIRY = ['seen', 'not-seen'];
const BASES = ['source', 'transcript', 'unverified'];
const MODES = ['subscription', 'api-key'];
const BILLING = ['free', 'metered', 'unknown'];
// Reported by validateWorker's own argv checks, so L1 does not report them a second time.
const CHECKED_ELSEWHERE = ['{prompt}', '{lastMessageFile}'];

/** What validateWorker shares with this module, passed in so the registry's own rules stay in one place. */
type Rules = { argvProblem: (value: unknown) => string | null; listingParse: RegExp; invisible: RegExp };
type Fail = (message: string) => void;

function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(value: any, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
const chars = (text: string) => Array.from(text).length;
const quoted = (list: string[]) => list.map((item) => `'${item}'`).join(', ').replace(/, ([^,]*)$/, ' or $1');

function closed(value: any, allowed: string[], required: string[], at: string, fail: Fail): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at} has unknown field '${key}'`);
  for (const key of required) if (!has(value, key)) fail(`${at} requires field '${key}'`);
}

/** Runs one of field-map.ts's checks, which push `<location>: <message>` onto a list, and forwards each message. */
function forward(check: (errors: string[]) => void, fail: Fail): boolean {
  const errors: string[] = [];
  check(errors);
  errors.forEach(fail);
  return errors.length === 0;
}

/** `hint` and `caveat`: a short line shown to the user, with no control or invisible character. */
function checkLine(value: any, at: string, max: number, rules: Rules, fail: Fail): void {
  if (typeof value !== 'string' || chars(value) < 1 || chars(value) > max) fail(`${at} must be a string of 1 to ${max} characters`);
  else if (CONTROL.test(value) || rules.invisible.test(value)) fail(`${at} must not contain a control or invisible character`);
}

function checkArgv(argv: any, providers: boolean, fail: Fail): void {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) return;
  if (argv.length === 0) { fail('argv must not be empty'); return; }
  const slots = argv.filter((item: string) => item === SLOT).length;
  if (providers && slots !== 1) fail(`argv must contain '${SLOT}' exactly once when providers is set`);
  if (!providers && slots > 0) fail(`argv must not contain '${SLOT}' without providers`);
  for (const item of argv) {
    const token = /\{[^{}]*\}/.exec(item)?.[0];
    if (!token || item === SLOT || token === '{model}' || CHECKED_ELSEWHERE.includes(item)) continue;
    if (token === SLOT) fail(`argv holds '${SLOT}' inside a longer element; a placeholder is a whole element`);
    else fail(`argv contains the unknown placeholder '${token}'`);
  }
}

function checkProviders(providers: any, rules: Rules, fail: Fail): void {
  if (!object(providers)) { fail('providers must be an object'); return; }
  closed(providers, ['argv', 'parse', 'emptyMeans', 'max'], ['argv', 'parse', 'emptyMeans'], 'providers', fail);
  if (has(providers, 'argv')) {
    const problem = rules.argvProblem(providers.argv);
    if (problem) fail(problem.replace(/^argv/, 'providers.argv'));
    else if (providers.argv.length === 0) fail('providers.argv must not be empty');
    else if (providers.argv.some((item: string) => item.includes('{'))) fail('providers.argv must not contain a placeholder');
  }
  if (has(providers, 'parse') && (typeof providers.parse !== 'string' || !rules.listingParse.test(providers.parse))) {
    fail('providers.parse must be lines, tsv-first-column or table-column:<name>');
  }
  if (has(providers, 'emptyMeans') && !EMPTY_MEANS.includes(providers.emptyMeans)) fail(`providers.emptyMeans must be ${quoted(EMPTY_MEANS)}`);
  if (has(providers, 'max') && !(Number.isInteger(providers.max) && providers.max >= 1 && providers.max <= MAX_PROVIDERS)) {
    fail(`providers.max must be an integer from 1 to ${MAX_PROVIDERS}`);
  }
}

/** One answer's own shape (L3) and, when its tests are sound, their S4 contradiction check. True when it is sound. */
function checkAnswer(answer: any, at: string, output: any, fail: Fail): boolean {
  if (!object(answer)) { fail(`${at} must be an object`); return false; }
  let sound = true;
  const bad = (message: string) => { sound = false; fail(message); };
  closed(answer, ['exit', 'when', 'state', 'reason'], ['exit', 'state'], at, bad);
  if (has(answer, 'exit') && !(Number.isInteger(answer.exit) && answer.exit >= 0 && answer.exit <= 255)) bad(`${at}.exit must be an integer from 0 to 255`);
  if (has(answer, 'state') && !STATES.includes(answer.state)) bad(`${at}.state must be logged-in, logged-out, expired or unknown`);
  if (has(answer, 'reason') && (typeof answer.reason !== 'string' || !REASON.test(answer.reason))) bad(`${at}.reason matches ${REASON}`);
  if (!has(answer, 'when')) return sound;
  if (output === 'none') fail(`${at}.when needs output "json": a test reads the JSON object on stdout`);
  const when = answer.when;
  if (!Array.isArray(when) || when.length < 1 || when.length > MAX_TESTS) { bad(`${at}.when holds 1 to ${MAX_TESTS} tests`); return false; }
  if (!forward((errors) => when.forEach((test: any, k: number) => checkTest(test, `${at}.when[${k}]`, errors)), bad)) return false;
  forward((errors) => checkContradictions(answer, at, errors), fail);
  return sound;
}

/** L3 over the list: 1 to 8 answers, at least one `logged-in`, and none hidden by an earlier one. */
function checkAnswers(answers: any, output: any, fail: Fail): void {
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_ANSWERS) { fail(`answers holds 1 to ${MAX_ANSWERS} rules`); return; }
  const sound = answers.map((answer: any, i: number) => checkAnswer(answer, `answers[${i}]`, output, fail)).every(Boolean);
  if (!sound) return;
  if (!answers.some((answer: any) => answer.state === 'logged-in')) fail('answers: no rule has state "logged-in", so a login can never be read');
  // An earlier rule on the same exit hides this one when each of its tests is implied by one of this rule's tests
  // (a rule with no tests hides every later rule on its exit).
  answers.forEach((answer: any, i: number) => {
    const tests: any[] = answer.when ?? [];
    const j = answers.slice(0, i).findIndex((earlier: any) => earlier.exit === answer.exit
      && (earlier.when ?? []).every((test: any) => tests.some((own) => implies(own, test))));
    if (j >= 0) fail(`answers[${i}] is shadowed by answers[${j}]: same exit, and answers[${j}] matches whenever this rule does, so it can never match`);
  });
}

function checkBilling(billing: any, output: any, fail: Fail): void {
  if (!object(billing)) { fail('billing must be an object'); return; }
  if (output === 'none') fail('billing needs output "json": it reads the JSON object on stdout');
  closed(billing, ['path', 'values'], ['path', 'values'], 'billing', fail);
  if (has(billing, 'path')) forward((errors) => checkPath(billing.path, 'billing.path', errors), fail);
  if (!has(billing, 'values')) return;
  const values = billing.values;
  const keys = object(values) ? Object.keys(values) : [];
  if (keys.length < 1 || keys.length > MAX_BILLING_VALUES) { fail(`billing.values holds 1 to ${MAX_BILLING_VALUES} values`); return; }
  for (const key of keys) {
    const at = `billing.values[${JSON.stringify(key)}]`;
    if (chars(key) > MAX_BILLING_KEY_CHARS || key === '') fail(`${at}: a key is 1 to ${MAX_BILLING_KEY_CHARS} characters`);
    const value = values[key];
    if (!object(value)) { fail(`${at} must be an object`); continue; }
    closed(value, ['mode', 'billing'], ['mode', 'billing'], at, fail);
    if (has(value, 'mode') && !MODES.includes(value.mode)) fail(`${at}.mode must be ${quoted(MODES)}`);
    if (has(value, 'billing') && !BILLING.includes(value.billing)) fail(`${at}.billing must be ${quoted(BILLING)}`);
  }
}

/** L5: literal, case-insensitive substrings a failed run's summary is matched against, at most one `{provider}` slot each. */
function checkSigns(signs: any, rules: Rules, fail: Fail): void {
  if (!object(signs)) { fail('expirySigns must be an object'); return; }
  closed(signs, ['signs', 'basis', 'evidence'], ['signs', 'basis', 'evidence'], 'expirySigns', fail);
  if (has(signs, 'signs')) {
    const list = signs.signs;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SIGNS) fail(`expirySigns.signs holds 1 to ${MAX_SIGNS} signs`);
    else list.forEach((sign: any, i: number) => {
      const at = `expirySigns.signs[${i}]`;
      if (typeof sign !== 'string' || chars(sign) < SIGN_CHARS[0] || chars(sign) > SIGN_CHARS[1]) { fail(`${at} must be a string of ${SIGN_CHARS[0]} to ${SIGN_CHARS[1]} characters`); return; }
      if (CONTROL.test(sign) || rules.invisible.test(sign)) fail(`${at} must not contain a control or invisible character`);
      const slots = sign.split(SLOT).length - 1;
      if (slots > 1) fail(`${at} holds ${slots} '${SLOT}' slots, at most one`);
      else if (slots === 1 && chars(sign.slice(0, sign.indexOf(SLOT))) < SIGN_LEAD_CHARS) fail(`${at} needs at least ${SIGN_LEAD_CHARS} literal characters before '${SLOT}'`);
    });
  }
  if (has(signs, 'basis') && !BASES.includes(signs.basis)) fail(`expirySigns.basis must be ${quoted(BASES)}`);
  if (has(signs, 'evidence') && (!Array.isArray(signs.evidence) || signs.evidence.length === 0
    || signs.evidence.some((item: any) => typeof item !== 'string' || !item.trim()))) {
    fail('expirySigns.evidence must be a non-empty array of non-empty strings');
  }
}

/**
 * Validates the recipe parts of one `loginProbe` entry and calls `fail` once per problem. A recipe field on an entry
 * that is not `supported` is validateWorker's to refuse, so only `expirySigns` and `hint` are read there.
 */
function validateLoginProbe(entry: any, rules: Rules, fail: Fail): void {
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(entry)); } catch { fail('the entry cannot be serialized'); return; }
  if (bytes > MAX_BYTES) { fail(`the entry is ${bytes} bytes, at most ${MAX_BYTES}`); return; }

  if (has(entry, 'expirySigns')) checkSigns(entry.expirySigns, rules, fail);
  if (has(entry, 'hint')) checkLine(entry.hint, 'hint', HINT_CHARS, rules, fail);
  if (entry.status !== 'supported') return;

  if (has(entry, 'output') && !OUTPUTS.includes(entry.output)) fail(`output must be ${quoted(OUTPUTS)}`);
  if (has(entry, 'expiry') && !EXPIRY.includes(entry.expiry)) fail(`expiry must be ${quoted(EXPIRY)}`);
  if (has(entry, 'caveat')) checkLine(entry.caveat, 'caveat', CAVEAT_CHARS, rules, fail);
  checkArgv(entry.argv, has(entry, 'providers'), fail);
  if (has(entry, 'providers')) checkProviders(entry.providers, rules, fail);
  if (has(entry, 'answers')) checkAnswers(entry.answers, entry.output, fail);
  if (has(entry, 'billing')) checkBilling(entry.billing, entry.output, fail);
}

module.exports = { validateLoginProbe, MAX_BYTES, MAX_ANSWERS };
