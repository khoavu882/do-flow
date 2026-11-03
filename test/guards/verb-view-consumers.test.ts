'use strict';

// G81 — a brief view keeps the keys its callers read (feature 137, FR-001, FR-008)
//
// A skill that runs a verb with `--view brief` reads some of that answer's keys, and the brief keep list
// (CLASSIFY_BRIEF, OVERVIEW_BRIEF, FOLLOWUP_LIST_BRIEF) decides which survive. Nothing tied the two: a key
// a skill reads could be dropped from a keep list and every test would stay green. This guard derives the
// callers' side from the skill text and checks it against the verb's real answers on the G80 fixture.
//
// For each (skill, verb) pair where the skill's SKILL.md runs the verb with `--view brief`: every backticked
// identifier in that SKILL.md and its references/ files is a candidate. A dotted token (`stages[].readinessTemplate`)
// matches as a path (the end of a path in the full answer), a bare token (`proposeDone`) as a key name anywhere in
// it. Each key the full answer has and the candidates name must also be in the brief answer. A key a skill names
// but does not read from this verb is listed in EXEMPT with the reason; an exemption that no longer matches
// anything fails the guard, so the list cannot go stale.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKILLS } = require('./_shared.ts');
const { buildFixture, measureVerb } = require('../helper/verb-fixture.ts');

/** The calls a skill can make with `--view brief`: how to spot them in text and the argv of the same call on the fixture. */
const VERBS: Record<string, { detect: RegExp; argv(maintain: boolean): string[] }> = {
  classify: {
    detect: /(?:\$DOFLOW"?|doflow-run|doflow)\s+classify\b/,
    argv: () => ['classify', '--task-class', 'feature', '--calling-skill', 'do-design'],
  },
  'lifecycle overview': {
    detect: /(?:\$DOFLOW"?|doflow-run|doflow)\s+lifecycle\s+--action\s+overview\b/,
    argv: (maintain) => ['lifecycle', '--action', 'overview', ...(maintain ? ['--maintain'] : [])],
  },
  'followup list': {
    detect: /(?:\$DOFLOW"?|doflow-run|doflow)\s+followup\s+--action\s+list\b/,
    argv: () => ['followup', '--action', 'list'],
  },
};

/** `skill|verb|token` to the reason that skill's mention of the token is not a read of this verb's answer. */
const EXEMPT: Record<string, string> = {
  'do|lifecycle overview|intent': 'references/program_mode.md names the `intent` line of a program plan item, not a follow-up\'s promoted intent',
  'do-brainstorm|classify|name': 'references/handoff_branches.md names the `name` of the orchestrate verb\'s awaitingGate, not a classify gate name',
};

type Calls = { verb: string; maintain: boolean };

/** The `--view brief` calls in one text; a `--view brief` line naming no known verb throws, so a new verb is added here. */
function briefCalls(text: string): Calls[] {
  const calls: Calls[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('--view brief')) continue;
    const verb = Object.keys(VERBS).find((name) => VERBS[name].detect.test(line));
    if (!verb) throw new Error(`a '--view brief' call names no verb this guard knows: ${line.trim()}`);
    calls.push({ verb, maintain: line.includes('--maintain') });
  }
  return calls;
}

const IDENTIFIER = /^(?:\$\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/;

/** The backticked identifiers of a text, `$.` stripped. */
function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    if (IDENTIFIER.test(span)) out.add(span.replace(/^\$\./, ''));
  }
  return out;
}

/** Every key path in an answer, arrays as `[]`: `workflow.stages[].id`. */
function pathsOf(value: any, at = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) pathsOf(element, `${at}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const next = at ? `${at}.${key}` : key;
      out.add(next);
      pathsOf(value[key], next, out);
    }
  }
  return out;
}

const lastKey = (p: string) => p.slice(p.lastIndexOf('.') + 1).replace(/\[\]$/, '');

/**
 * The keys of `full` that `tokens` name, and the ones among them `brief` lost.
 * @returns {{checked: string[], lost: string[]}} `token -> full path` pairs
 */
function keysRead(tokens: ReadonlySet<string>, full: any, brief: any) {
  const fullPaths = pathsOf(full);
  const briefPaths = pathsOf(brief);
  const briefNames = new Set([...briefPaths].map(lastKey));
  const checked: string[] = [];
  const lost: string[] = [];
  for (const token of tokens) {
    const dotted = token.includes('.') || token.includes('[]');
    const hit = dotted ? [...fullPaths].filter((p) => p === token || p.endsWith(`.${token}`)) : [...fullPaths].filter((p) => lastKey(p) === token);
    if (!hit.length) continue;
    checked.push(token);
    const kept = dotted ? hit.every((p) => briefPaths.has(p)) : briefNames.has(token);
    if (!kept) lost.push(token);
  }
  return { checked, lost };
}

// ------------------------------------------------------------------------------------------ the pairs

const pairs: { skill: string; verb: string; maintain: boolean; tokens: Set<string> }[] = [];
for (const skill of fs.readdirSync(SKILLS)) {
  const main = path.join(SKILLS, skill, 'SKILL.md');
  if (!fs.existsSync(main)) continue;
  const text = fs.readFileSync(main, 'utf8');
  const calls = briefCalls(text);
  if (!calls.length) continue;
  const tokens = identifiers(text);
  const refs = path.join(SKILLS, skill, 'references');
  if (fs.existsSync(refs)) for (const name of fs.readdirSync(refs).filter((n: string) => n.endsWith('.md'))) {
    for (const t of identifiers(fs.readFileSync(path.join(refs, name), 'utf8'))) tokens.add(t);
  }
  for (const call of calls) {
    const seen = pairs.find((p) => p.skill === skill && p.verb === call.verb && p.maintain === call.maintain);
    if (!seen) pairs.push({ skill, ...call, tokens });
  }
}

const answers = new Map<string, { full: any; brief: any }>();
before(() => {
  const fixture = buildFixture();
  for (const { verb, maintain } of pairs) {
    const key = `${verb}|${maintain}`;
    if (answers.has(key)) continue;
    const base = VERBS[verb].argv(maintain);
    const full = measureVerb(fixture, [...base, ...(verb === 'followup list' ? ['--view', 'full'] : []), '--json']);
    const brief = measureVerb(fixture, [...base, '--view', 'brief', '--json']);
    assert.equal(full.status, 0, `${key} full answers`);
    assert.equal(brief.status, 0, `${key} brief answers`);
    answers.set(key, { full: JSON.parse(full.stdout), brief: JSON.parse(brief.stdout) });
  }
});

test('G81: at least one skill runs a verb with --view brief', () => {
  assert.ok(pairs.length >= 1);
});

for (const pair of pairs) {
  test(`G81: ${pair.skill} finds the keys it reads in the brief ${pair.verb}${pair.maintain ? ' --maintain' : ''} answer`, () => {
    const { full, brief } = answers.get(`${pair.verb}|${pair.maintain}`)!;
    const { checked, lost } = keysRead(pair.tokens, full, brief);
    assert.ok(checked.length > 0, 'the guard checked no key for this pair, so it proves nothing');
    const exempt = (t: string) => Object.hasOwn(EXEMPT, `${pair.skill}|${pair.verb}|${t}`);
    assert.deepEqual(lost.filter((t) => !exempt(t)), [], `${pair.skill} names keys of ${pair.verb} that its brief answer lacks; keep them in the keep list or exempt them with a reason`);
  });
}

test('G81: every exemption still names a key the skill mentions that the brief answer lacks', () => {
  const stale: string[] = [];
  for (const [id, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 0, `${id} has a reason`);
    const [skill, verb, token] = id.split('|');
    const matching = pairs.filter((p) => p.skill === skill && p.verb === verb);
    const live = matching.some((p) => {
      const { full, brief } = answers.get(`${p.verb}|${p.maintain}`)!;
      return keysRead(new Set([token]), full, brief).lost.includes(token) && p.tokens.has(token);
    });
    if (!live) stale.push(id);
  }
  assert.deepEqual(stale, []);
});

// ------------------------------------------------------------------------------------------ controls

test('G81 control: a key a skill names that the brief answer lacks is reported, one the brief keeps is not', () => {
  const full = { a: 1, deep: { kept: 1, lost: 2 }, list: [{ id: 1, gone: 2 }] };
  const brief = { a: 1, deep: { kept: 1 }, list: [{ id: 1 }] };
  assert.deepEqual(keysRead(new Set(['a', 'deep.kept', 'deep.lost', 'list[].gone', 'list[].id', 'unrelated']), full, brief),
    { checked: ['a', 'deep.kept', 'deep.lost', 'list[].gone', 'list[].id'], lost: ['deep.lost', 'list[].gone'] });
});

test('G81 control: a --view brief call naming no known verb throws, and the known verbs are found', () => {
  assert.throws(() => briefCalls('run `"$DOFLOW" mystery --view brief --json`'), /names no verb/);
  assert.deepEqual(briefCalls('`doflow-run lifecycle --action overview --maintain --since T --view brief --json`'), [{ verb: 'lifecycle overview', maintain: true }]);
});
