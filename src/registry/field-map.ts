'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The static checks of the `jsonl-field-map-v1` grammar (design 171 section 3.4): S0 shape, S1 guarded captures,
 * S2 event type, S3 reachable success, S4 no contradiction, and the id pattern of S5 (the package/PARSERS part of S5
 * belongs to the catalogue). Pure: no I/O, no state, nothing under `src/runtime/`. Every error is
 * `<location>.<json path>: <message>` and names the JSON location it refers to.
 */

const FIELD_MAP_FORMAT = 'jsonl-field-map-v1';
const MAX_BYTES = 16 * 1024;
const MAX_RULES = 32;
const MAX_TESTS = 8;
const MAX_SEGMENTS = 8;
const MAX_VALUES = 32;
const MAX_SUM = 4;
const MAX_STRING_CHARS = 200;

const ID = /^[a-z][a-z0-9-]{1,47}-v[1-9][0-9]*$/;
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const LITERAL = /^[a-z][a-z0-9-]{0,63}$/;
const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const IS_KINDS = ['string', 'number', 'integer', 'count', 'boolean', 'object', 'array', 'null', 'present'];
const OUTCOMES = ['completed', 'failed'];
const REQUIRES = ['any', 'all'];

/** The value classes a path can hold; each `is` kind is a set of them. A scalar belongs to exactly one. */
const KIND_ATOMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  string: ['string'],
  number: ['count', 'negint', 'float'],
  integer: ['count', 'negint'],
  count: ['count'],
  boolean: ['boolean'],
  object: ['object'],
  array: ['array'],
  null: ['null'],
  present: ['string', 'count', 'negint', 'float', 'boolean', 'object', 'array', 'null'],
});

const TEST_KEYS = ['path', 'equals', 'in', 'is'];
const THEN_KEYS = ['final', 'spawn', 'denial', 'usage', 'streamError', 'terminal'];

function issue(errors: string[], location: string, message: string): void { errors.push(`${location}: ${message}`); }
function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(value: any, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function same(a: string[], b: string[]): boolean { return a.length === b.length && a.every((segment, i) => segment === b[i]); }

/** Reports every key of `value` outside `allowed`, and every missing `required` key. */
function closedKeys(value: any, allowed: string[], required: string[], location: string, errors: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(errors, location, `unknown key '${key}'`);
  for (const key of required) if (!has(value, key)) issue(errors, location, `missing key '${key}'`);
}

function scalarClass(value: any): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (Number.isInteger(value)) return value >= 0 ? 'count' : 'negint';
  return 'float';
}

function checkScalar(value: any, location: string, errors: string[]): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Array.from(value).length > MAX_STRING_CHARS) issue(errors, location, `a string value is at most ${MAX_STRING_CHARS} characters`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issue(errors, location, 'a number value must be finite');
    return;
  }
  issue(errors, location, 'must be a string, a finite number, a boolean or null');
}

function checkPath(value: any, location: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS) {
    issue(errors, location, `a path is an array of 1 to ${MAX_SEGMENTS} segments`);
    return;
  }
  value.forEach((segment, i) => {
    if (typeof segment !== 'string' || !SEGMENT.test(segment)) issue(errors, `${location}[${i}]`, `a path segment matches ${SEGMENT}`);
    else if (FORBIDDEN_SEGMENTS.has(segment)) issue(errors, `${location}[${i}]`, `a path segment must not be '${segment}'`);
  });
}

function checkTest(test: any, location: string, errors: string[]): void {
  if (!object(test)) { issue(errors, location, 'a test is an object'); return; }
  closedKeys(test, TEST_KEYS, ['path'], location, errors);
  if (has(test, 'path')) checkPath(test.path, `${location}.path`, errors);
  const forms = ['equals', 'in', 'is'].filter((key) => has(test, key));
  if (forms.length !== 1) issue(errors, location, "a test holds exactly one of 'equals', 'in' or 'is'");
  if (has(test, 'equals')) checkScalar(test.equals, `${location}.equals`, errors);
  if (has(test, 'in')) {
    const list = test.in;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_VALUES) issue(errors, `${location}.in`, `'in' holds 1 to ${MAX_VALUES} values`);
    else {
      list.forEach((value, i) => checkScalar(value, `${location}.in[${i}]`, errors));
      if (new Set(list).size !== list.length) issue(errors, `${location}.in`, "'in' values must be distinct");
    }
  }
  if (has(test, 'is') && !IS_KINDS.includes(test.is)) issue(errors, `${location}.is`, `'is' is one of ${IS_KINDS.join(', ')}`);
}

function checkText(text: any, location: string, errors: string[]): void {
  if (!object(text)) { issue(errors, location, 'a text source is an object'); return; }
  if (has(text, 'literal')) {
    closedKeys(text, ['literal'], [], location, errors);
    if (typeof text.literal !== 'string' || !LITERAL.test(text.literal)) issue(errors, `${location}.literal`, `a literal matches ${LITERAL}`);
    return;
  }
  closedKeys(text, ['path', 'as'], ['path', 'as'], location, errors);
  if (has(text, 'path')) checkPath(text.path, `${location}.path`, errors);
  if (has(text, 'as') && text.as !== 'text') issue(errors, `${location}.as`, "'as' is 'text'");
}

function checkThen(then: any, location: string, errors: string[]): void {
  if (!object(then)) { issue(errors, location, "'then' is an object"); return; }
  closedKeys(then, THEN_KEYS, [], location, errors);
  if (Object.keys(then).length === 0) issue(errors, location, "'then' holds at least one action");
  if (has(then, 'final')) checkPath(then.final, `${location}.final`, errors);
  if (has(then, 'streamError')) checkPath(then.streamError, `${location}.streamError`, errors);
  if (has(then, 'spawn') && then.spawn !== true) issue(errors, `${location}.spawn`, "'spawn' is true");
  if (has(then, 'denial')) {
    const denial = then.denial;
    if (!object(denial)) issue(errors, `${location}.denial`, "'denial' is an object");
    else {
      closedKeys(denial, ['action', 'detail'], ['action', 'detail'], `${location}.denial`, errors);
      if (has(denial, 'action')) checkText(denial.action, `${location}.denial.action`, errors);
      if (has(denial, 'detail')) checkText(denial.detail, `${location}.denial.detail`, errors);
    }
  }
  if (has(then, 'usage')) {
    const usage = then.usage;
    if (!object(usage)) issue(errors, `${location}.usage`, "'usage' is an object");
    else {
      closedKeys(usage, ['tokens'], ['tokens'], `${location}.usage`, errors);
      const tokens = usage.tokens;
      if (has(usage, 'tokens')) {
        if (!object(tokens)) issue(errors, `${location}.usage.tokens`, "'tokens' is an object");
        else {
          closedKeys(tokens, ['sum', 'require'], ['sum', 'require'], `${location}.usage.tokens`, errors);
          if (has(tokens, 'sum')) {
            if (!Array.isArray(tokens.sum) || tokens.sum.length < 1 || tokens.sum.length > MAX_SUM) issue(errors, `${location}.usage.tokens.sum`, `'sum' holds 1 to ${MAX_SUM} paths`);
            else tokens.sum.forEach((path: any, i: number) => checkPath(path, `${location}.usage.tokens.sum[${i}]`, errors));
          }
          if (has(tokens, 'require') && !REQUIRES.includes(tokens.require)) issue(errors, `${location}.usage.tokens.require`, "'require' is 'any' or 'all'");
        }
      }
    }
  }
  if (has(then, 'terminal')) {
    const terminal = then.terminal;
    if (!object(terminal)) issue(errors, `${location}.terminal`, "'terminal' is an object");
    else {
      closedKeys(terminal, ['outcome', 'summary'], ['outcome'], `${location}.terminal`, errors);
      if (has(terminal, 'outcome') && !OUTCOMES.includes(terminal.outcome)) issue(errors, `${location}.terminal.outcome`, "'outcome' is 'completed' or 'failed'");
      if (has(terminal, 'summary')) {
        if (terminal.outcome !== 'failed') issue(errors, `${location}.terminal.summary`, "'summary' is only for outcome 'failed'");
        checkPath(terminal.summary, `${location}.terminal.summary`, errors);
      }
    }
  }
}

function checkRule(rule: any, location: string, errors: string[]): void {
  if (!object(rule)) { issue(errors, location, 'a rule is an object'); return; }
  closedKeys(rule, ['when', 'then'], ['when', 'then'], location, errors);
  if (has(rule, 'when')) {
    if (!Array.isArray(rule.when) || rule.when.length < 1 || rule.when.length > MAX_TESTS) issue(errors, `${location}.when`, `'when' holds 1 to ${MAX_TESTS} tests`);
    else rule.when.forEach((test: any, i: number) => checkTest(test, `${location}.when[${i}]`, errors));
  }
  if (has(rule, 'then')) checkThen(rule.then, `${location}.then`, errors);
}

/** S0 for the whole map. Returns nothing; the caller compares the error count before and after. */
function checkShape(map: any, location: string, errors: string[]): void {
  if (!object(map)) { issue(errors, location, 'a field map is an object'); return; }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(map)); } catch { issue(errors, location, 'the map cannot be serialized'); return; }
  if (bytes > MAX_BYTES) { issue(errors, location, `the map is ${bytes} bytes, at most ${MAX_BYTES}`); return; }

  closedKeys(map, ['id', 'format', 'eventType', 'missingTerminal', 'finalFallback', 'rules'], ['id', 'format', 'eventType', 'missingTerminal', 'rules'], location, errors);
  if (has(map, 'id') && (typeof map.id !== 'string' || !ID.test(map.id))) issue(errors, `${location}.id`, `'id' matches ${ID}`);
  if (has(map, 'format') && map.format !== FIELD_MAP_FORMAT) issue(errors, `${location}.format`, `'format' is '${FIELD_MAP_FORMAT}'`);
  if (has(map, 'eventType')) checkPath(map.eventType, `${location}.eventType`, errors);
  if (has(map, 'missingTerminal') && (typeof map.missingTerminal !== 'string' || !REASON.test(map.missingTerminal))) issue(errors, `${location}.missingTerminal`, `'missingTerminal' matches ${REASON}`);
  if (has(map, 'finalFallback') && map.finalFallback !== 'last-message-file') issue(errors, `${location}.finalFallback`, "'finalFallback' is 'last-message-file'");
  if (has(map, 'rules')) {
    if (!Array.isArray(map.rules) || map.rules.length < 1 || map.rules.length > MAX_RULES) issue(errors, `${location}.rules`, `'rules' holds 1 to ${MAX_RULES} rules`);
    else map.rules.forEach((rule: any, i: number) => checkRule(rule, `${location}.rules[${i}]`, errors));
  }
}

/** The classes of value a test lets through on its path, or null when it lets nothing be excluded (never). */
function allowedClasses(test: any): Set<string> {
  if (has(test, 'equals')) return new Set([scalarClass(test.equals)]);
  if (has(test, 'in')) return new Set(test.in.map(scalarClass));
  return new Set(KIND_ATOMS[test.is]);
}

/** True when `a` and `b`, two tests on one path, can not both hold. */
function exclude(a: any, b: any): boolean {
  if (has(a, 'equals') && has(b, 'equals')) return a.equals !== b.equals;
  if (has(a, 'equals') && has(b, 'in')) return !b.in.includes(a.equals);
  if (has(a, 'in') && has(b, 'equals')) return !a.in.includes(b.equals);
  if (has(a, 'in') && has(b, 'in')) return !a.in.some((value: any) => b.in.includes(value));
  // At least one is an `is`: the classes of a value that both allow must have one in common.
  // `equals`/`in` against `is` compares the scalar's class, and an `equals` against an `equals` was handled above.
  const left = allowedClasses(a);
  const right = allowedClasses(b);
  for (const atom of left) if (right.has(atom)) return false;
  return true;
}

/** True when `test` leaves its path holding something a step cannot go through (a scalar, null or an array). */
function pinsNonObject(test: any): boolean {
  if (has(test, 'equals') || has(test, 'in')) return true;
  return test.is !== 'object' && test.is !== 'present';
}

function checkContradictions(rule: any, location: string, errors: string[]): void {
  const tests: any[] = rule.when;
  tests.forEach((test, j) => {
    for (let i = 0; i < j; i++) {
      const earlier = tests[i];
      if (same(earlier.path, test.path)) {
        if (exclude(earlier, test)) issue(errors, `${location}.when[${j}]`, `contradicts when[${i}] on the same path, so the rule can never match`);
      } else if (earlier.path.length < test.path.length && same(earlier.path, test.path.slice(0, earlier.path.length)) && pinsNonObject(earlier)) {
        issue(errors, `${location}.when[${j}]`, `reads through the path when[${i}] pins to a non-object (prefix conflict), so the rule can never match`);
      } else if (test.path.length < earlier.path.length && same(test.path, earlier.path.slice(0, test.path.length)) && pinsNonObject(test)) {
        issue(errors, `${location}.when[${i}]`, `reads through the path when[${j}] pins to a non-object (prefix conflict), so the rule can never match`);
      }
    }
  });
}

/** True when every value `later` lets through, `earlier` lets through too (both on one path; every test needs the path present). */
function implies(later: any, earlier: any): boolean {
  if (!same(later.path, earlier.path)) return false;
  if (has(earlier, 'equals')) return has(later, 'equals') && later.equals === earlier.equals;
  if (has(earlier, 'in')) {
    if (has(later, 'equals')) return earlier.in.includes(later.equals);
    return has(later, 'in') && later.in.every((value: any) => earlier.in.includes(value));
  }
  if (earlier.is === 'present') return true;
  const wide = KIND_ATOMS[earlier.is];
  return [...allowedClasses(later)].every((atom) => wide.includes(atom));
}

/** The index of an earlier rule whose every test is implied by a test of `rule`, so it matches whenever `rule` does. */
function hiddenBy(rules: any[], index: number): number {
  const later: any[] = rules[index].when;
  return rules.slice(0, index).findIndex((rule) => rule.when.every((earlier: any) => later.some((test) => implies(test, earlier))));
}

function guarded(rule: any, path: string[]): boolean {
  return rule.when.some((test: any) => test.is === 'string' && same(test.path, path));
}

/**
 * Validates `map` and pushes one error string per problem onto `errors`, each starting with `location` and the JSON
 * path of the offending part (for example `fieldMap.rules[3].when[1].path[0]: ...`). S1 to S4 run only on a map that
 * passed S0, because they read the shapes S0 vouches for.
 */
function validateFieldMap(map: any, location: string, errors: string[]): void {
  const before = errors.length;
  checkShape(map, location, errors);
  if (errors.length > before) return;

  const rules: any[] = map.rules;
  rules.forEach((rule, i) => {
    const at = `${location}.rules[${i}]`;
    const captures: Array<[string, string[] | undefined]> = [
      ['final', rule.then.final], ['terminal.summary', rule.then.terminal?.summary], ['streamError', rule.then.streamError],
    ];
    for (const [name, path] of captures) {
      if (path && !guarded(rule, path)) issue(errors, `${at}.then.${name}`, `needs an 'is: "string"' test on the same path in 'when' (S1)`);
    }
    const eventTested = rule.when.some((test: any) => (has(test, 'equals') || has(test, 'in')) && same(test.path, map.eventType));
    if (!eventTested) issue(errors, `${at}.when`, `needs an 'equals' or 'in' test on eventType [${map.eventType.join(', ')}] (S2)`);
    checkContradictions(rule, at, errors);
    for (const [j, test] of rule.when.entries()) {
      if (!same(test.path, map.eventType)) continue;
      if (has(test, 'equals') && typeof test.equals !== 'string') issue(errors, `${at}.when[${j}].equals`, 'an event type is always a string, so this rule can never match');
      if (has(test, 'in')) test.in.forEach((value: any, k: number) => { if (typeof value !== 'string') issue(errors, `${at}.when[${j}].in[${k}]`, 'an event type is always a string, so this value can never match'); });
    }
    if (rule.then.terminal?.outcome === 'completed') {
      if (rule.then.spawn) issue(errors, `${at}.then.spawn`, "a rule with terminal outcome 'completed' cannot also set 'spawn' (a spawn is reported as a failure)");
      const hider = hiddenBy(rules, i);
      if (hider >= 0) issue(errors, `${at}.when`, `rules[${hider}] matches whenever this rule does and comes first, so this completed rule can never run`);
    }
  });

  if (!rules.some((rule) => rule.then.terminal?.outcome === 'completed')) issue(errors, `${location}.rules`, "no rule has terminal outcome 'completed', so success is unreachable (S3)");
  if (!rules.some((rule) => rule.then.final) && !has(map, 'finalFallback')) issue(errors, `${location}.rules`, "no rule has 'final' and 'finalFallback' is not set, so success is unreachable (S3)");
}

module.exports = { validateFieldMap, FIELD_MAP_FORMAT, MAX_BYTES, MAX_RULES, MAX_TESTS, MAX_SEGMENTS, MAX_VALUES };
