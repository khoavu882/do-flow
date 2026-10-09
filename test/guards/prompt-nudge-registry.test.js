'use strict';

// G25 — `promptNudge` registry shape. The standalone-prompt nudge reads its rules from the top-level
// `promptNudge` key of core/registry/workflows.json with jq, and the hook has no defaults: a missing
// or mistyped field makes the decision error, which is silent. This guard turns that silence into a
// red suite. It checks the shape and ranges (IC-007), the message rules (IC-010: names `/do` and no
// other skill, 300 characters at most, no model or provider identifier) and that `pathPattern`
// compiles in jq. The workflow engine does not read this key, so it is not validated anywhere else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');

const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');

const STRING_FIELDS = ['description', 'message', 'pathPattern'];
const INTEGER_RANGES = { maxScanChars: [50, 4000], minChars: [1, 100] };
const ARRAY_FIELDS = [
  'leadIns', 'verbs', 'nouns', 'excludeStartWords', 'excludeContainsPhrases', 'stallWords',
  'excludePrefixes', 'objectBlockers', 'contextBlockers',
];
const FIELDS = [...STRING_FIELDS, ...Object.keys(INTEGER_RANGES), ...ARRAY_FIELDS];

const MAX_MESSAGE_CHARS = 300;
const MODEL_OR_PROVIDER = /\b(claude|anthropic|openai|chatgpt|gpt-?\d|gemini|haiku|sonnet|opus|llama|mistral|grok|deepseek|qwen)\b/i;

/** Every problem found in a `promptNudge` value, as strings; an empty list means it is well formed. */
function problems(nudge) {
  if (nudge === null || typeof nudge !== 'object' || Array.isArray(nudge)) {
    return ['promptNudge is missing or not an object'];
  }
  const out = [];
  for (const key of Object.keys(nudge)) if (!FIELDS.includes(key)) out.push(`unknown field ${key}`);
  for (const key of STRING_FIELDS) {
    if (typeof nudge[key] !== 'string' || nudge[key] === '') out.push(`${key} must be a non-empty string`);
  }
  for (const [key, [lo, hi]] of Object.entries(INTEGER_RANGES)) {
    const v = nudge[key];
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${key} must be an integer in ${lo}..${hi}`);
  }
  for (const key of ARRAY_FIELDS) {
    const list = nudge[key];
    if (!Array.isArray(list) || list.length === 0) { out.push(`${key} must be a non-empty array`); continue; }
    const seen = new Set();
    for (const entry of list) {
      if (typeof entry !== 'string' || entry === '') { out.push(`${key} has an empty or non-string entry`); continue; }
      if (entry !== entry.trim()) out.push(`${key} entry "${entry}" is not trimmed`);
      if (entry !== entry.toLowerCase()) out.push(`${key} entry "${entry}" is not lowercase`);
      if (seen.has(entry)) out.push(`${key} entry "${entry}" is duplicated`);
      seen.add(entry);
    }
  }
  const msg = nudge.message;
  if (typeof msg === 'string' && msg !== '') {
    if (msg.length > MAX_MESSAGE_CHARS) out.push(`message is ${msg.length} characters, over ${MAX_MESSAGE_CHARS}`);
    if (!/(^|[^\w-])\/do(?![\w-])/.test(msg)) out.push('message must contain /do as a token');
    if (/\/do-/.test(msg)) out.push('message must not name a /do- skill');
    const hit = msg.match(MODEL_OR_PROVIDER);
    if (hit) out.push(`message names a model or provider: ${hit[0]}`);
  }
  return out;
}

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));

test('G25 promptNudge in core/registry/workflows.json is well formed', () => {
  assert.deepEqual(problems(registry.promptNudge), []);
});

test('G25 promptNudge has exactly the IC-007 fields', () => {
  assert.deepEqual(Object.keys(registry.promptNudge ?? {}).sort(), [...FIELDS].sort());
});

test('G25 promptNudge.pathPattern compiles in jq', (t) => {
  const probe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('jq is not installed');
  const pattern = registry.promptNudge?.pathPattern;
  assert.equal(typeof pattern, 'string', 'pathPattern must be a string');
  const r = spawnSync('jq', ['-n', '--arg', 'p', pattern, '"probe" | test($p)'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `jq rejected pathPattern: ${r.stderr}`);
});

test('G25 control: the checks report an uppercase entry, a duplicate and a /do- skill in the message', () => {
  const fixture = structuredClone(registry.promptNudge);
  fixture.verbs = [...fixture.verbs, 'Add'];
  fixture.nouns = [...fixture.nouns, fixture.nouns[0]];
  fixture.message = 'Try /do-flow for this.';
  const found = problems(fixture);
  assert.ok(found.some((p) => p === 'verbs entry "Add" is not lowercase'), found.join('\n'));
  assert.ok(found.some((p) => p === `nouns entry "${fixture.nouns[0]}" is duplicated`), found.join('\n'));
  assert.ok(found.some((p) => p === 'message must not name a /do- skill'), found.join('\n'));
});
