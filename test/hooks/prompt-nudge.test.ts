'use strict';
// prompt-nudge.test.js — the UserPromptSubmit policy's output (design CH5, CH6).
//
// `envelope`: the existing first-prompt context leaves in one nested envelope for Claude and Codex
// (IC-002); Claude's top-level `additionalContext` is ignored by Claude Code (memo T1).
// `corpus`: every prompt in the corpus through the shipped registry (IC-012, IC-013).
// `per-session` cases live in prompt-nudge-session / -failures / -process.test.js; helpers in
// prompt-nudge.shared.js.
const { describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  scratch, HOOK_TEST, POLICIES, REGISTRY, repo, prompt
} = require('./prompt-nudge.shared.ts');

after(() => scratch.remove());

describe('envelope', () => {
  HOOK_TEST('Claude first prompt: nested envelope with the context and the session title', () => {
    const { dir, sha } = repo();
    const parsed = JSON.parse(prompt('claude', 'env-claude', dir));
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
    const out = parsed.hookSpecificOutput;
    assert.deepStrictEqual(Object.keys(out), ['hookEventName', 'additionalContext', 'sessionTitle']);
    assert.strictEqual(out.hookEventName, 'UserPromptSubmit');
    assert.ok(out.additionalContext.startsWith('Git context — branch: main |'), out.additionalContext);
    assert.strictEqual(out.sessionTitle, `main — ${sha}`);
  });

  HOOK_TEST('Claude: a payload session_title suppresses sessionTitle, an empty one does not', () => {
    const { dir, sha } = repo();
    const titled = JSON.parse(prompt('claude', 'env-titled', dir, { extra: { session_title: 'mine' } }));
    assert.deepStrictEqual(Object.keys(titled), ['hookSpecificOutput']);
    assert.deepStrictEqual(Object.keys(titled.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    const empty = JSON.parse(prompt('claude', 'env-empty-title', dir, { extra: { session_title: '' } }));
    assert.strictEqual(empty.hookSpecificOutput.sessionTitle, `main — ${sha}`);
  });

  HOOK_TEST('Claude outside a git repository: the context and the no-git title, nested', () => {
    const { dir } = repo({ git: false });
    const parsed = JSON.parse(prompt('claude', 'env-nogit', dir));
    assert.deepStrictEqual(parsed.hookSpecificOutput.additionalContext, 'Not a git repository.');
    assert.strictEqual(parsed.hookSpecificOutput.sessionTitle, 'no-git');
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  });

  HOOK_TEST('Codex first prompt: exactly hookEventName and additionalContext, pretty-printed with a two-space indent and a final newline', () => {
    const { dir } = repo();
    const stdout = prompt('codex', 'env-codex', dir, { extra: { session_title: '' } });
    const parsed = JSON.parse(stdout);
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(parsed.hookSpecificOutput.additionalContext.startsWith('Git context — branch: main |'));
    assert.strictEqual(stdout, JSON.stringify(parsed, null, 2) + '\n');
  });

  HOOK_TEST('a second prompt prints {} on both harnesses', () => {
    const { dir } = repo();
    for (const agent of ['claude', 'codex']) {
      const id = `env-second-${agent}`;
      prompt(agent, id, dir);
      assert.deepStrictEqual(JSON.parse(prompt(agent, id, dir, { start: false })), {});
    }
  });

  HOOK_TEST('a session whose SessionStart never ran gets the nested fallback text and no sessionTitle', () => {
    const { dir } = repo();
    for (const agent of ['claude', 'codex']) {
      const parsed = JSON.parse(prompt(agent, `env-nostart-${agent}`, dir, { start: false }));
      assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
      assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
      assert.strictEqual(parsed.hookSpecificOutput.additionalContext, 'Git context unavailable for this session.');
    }
  });
});

// ── corpus ────────────────────────────────────────────────────────────────────
//
// IC-012 / IC-013: every prompt in the corpus goes through IC-005's invocation against the shipped
// registry. A `silent` case must not nudge; recall is reported and never asserted (D-2).

const CORPUS = path.join(__dirname, 'prompt-nudge.corpus.json');
const PROGRAM = path.join(POLICIES, 'prompt-nudge.jq');
const TAGS: any = ['positive', 'question', 'slash', 'stall', 'review', 'how-why-what-explain', 'contains-do', 'short', 'empty', 'non-english', 'near-miss'];
const REQUIRED_SILENT_TAGS: any = ['question', 'slash', 'stall', 'review', 'how-why-what-explain', 'contains-do'];
const ORIGINS: any = ['rules-aware', 'rules-blind'];
const BLIND_SILENT_FLOOR = 20;

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
}

/** IC-005's invocation for one prompt; returns the spawn result. */
function decideCorpusCase(prompt: any) {
  return spawnSync('jq', ['-r', '--slurpfile', 'R', REGISTRY, '-f', PROGRAM], {
    input: JSON.stringify({ session_id: 'corpus', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt }),
    env: scratch.env(),
    encoding: 'utf8',
  });
}

/** Every IC-012 violation in `doc`, as strings (empty when the file is valid). */
function corpusProblems(doc: any) {
  const problems: any = [];
  if (doc === null || typeof doc !== 'object' || doc.version !== 1) problems.push('version must be 1');
  const cases = doc && Array.isArray(doc.cases) ? doc.cases : null;
  if (!cases) return [...problems, 'cases must be an array'];
  const seen: any = new Set();
  cases.forEach((c: any, i: any) => {
    const where = `case ${i} (${c && c.id})`;
    if (c === null || typeof c !== 'object') { problems.push(`${where}: not an object`); return; }
    if (typeof c.id !== 'string' || !/^(pos|neg)-\d{3,}$/.test(c.id)) problems.push(`${where}: id must be pos-NNN or neg-NNN`);
    if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    seen.add(c.id);
    if (typeof c.prompt !== 'string') problems.push(`${where}: prompt must be a string`);
    if (c.expect !== 'nudge' && c.expect !== 'silent') problems.push(`${where}: expect must be nudge or silent`);
    if (!TAGS.includes(c.tag)) problems.push(`${where}: tag ${JSON.stringify(c.tag)} is not in the closed set`);
    if (!ORIGINS.includes(c.origin)) problems.push(`${where}: origin ${JSON.stringify(c.origin)} is not rules-aware or rules-blind`);
    if (typeof c.id === 'string' && c.id.startsWith('pos-') && c.expect !== 'nudge') problems.push(`${where}: pos- ids take expect nudge`);
    if (typeof c.id === 'string' && c.id.startsWith('neg-') && c.expect !== 'silent') problems.push(`${where}: neg- ids take expect silent`);
    if ((c.tag === 'positive') !== (c.expect === 'nudge')) problems.push(`${where}: tag positive goes with expect nudge, and only with it`);
  });
  const silent = cases.filter((c: any) => c && c.expect === 'silent');
  for (const tag of REQUIRED_SILENT_TAGS) {
    if (!silent.some((c: any) => c.tag === tag)) problems.push(`content floor: no silent case tagged ${tag}`);
  }
  const blind = silent.filter((c: any) => c.origin === 'rules-blind').length;
  if (blind < BLIND_SILENT_FLOOR) problems.push(`content floor: ${blind} rules-blind silent cases, need ${BLIND_SILENT_FLOOR}`);
  return problems;
}

describe('corpus', () => {
  HOOK_TEST('the corpus file holds valid IC-012 cases and meets the content floor', () => {
    assert.deepStrictEqual(corpusProblems(loadCorpus()), []);
  });

  HOOK_TEST('no silent case nudges; recall is printed, never asserted', (t: any) => {
    const { cases } = loadCorpus();
    const errors: any = [];
    const falseNudges: any = [];
    const recall: any = { all: [0, 0], 'rules-aware': [0, 0], 'rules-blind': [0, 0] };
    for (const c of cases) {
      const r = decideCorpusCase(c.prompt);
      if (r.status !== 0 || !/^(nudge|suppress|)\n$/.test(r.stdout)) {
        errors.push(`${c.id}: jq exit ${r.status} ${r.stderr.trim()} ${JSON.stringify(r.stdout)}`);
        continue;
      }
      const nudged = r.stdout === 'nudge\n';
      if (c.expect === 'silent' && nudged) falseNudges.push(c.id);
      if (c.expect === 'nudge') {
        for (const key of ['all', c.origin]) { recall[key][1] += 1; if (nudged) recall[key][0] += 1; }
      }
    }
    for (const [key, [n, m]] of Object.entries(recall)) {
      t.diagnostic(`prompt-nudge recall ${key} ${n}/${m} = ${m ? (n / m).toFixed(2) : 'n/a'}`);
    }
    assert.deepStrictEqual(errors, [], 'the decision program failed on these cases');
    assert.deepStrictEqual(falseNudges, [], `silent cases that nudged: ${falseNudges.join(', ')}`);
  });
});
