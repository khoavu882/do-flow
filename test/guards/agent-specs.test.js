'use strict';

// G14 — agent-specification self-containment (feature 008, design C14 / FR-021, FR-022).
//
// An agent specification is prose handed to a harness that spawns a subagent. Unlike a skill, it
// has no working directory, no locator and no runtime seam: whatever it names, it names into a
// context that may not contain it. FR-021 is explicit that this property "holds today and MUST be
// preserved rather than achieved" — which is precisely why it needs a guard rather than a review
// note. Nothing fails when a spec acquires a dependency. The subagent simply cannot find the file,
// and either says so mid-task or, worse, invents what it thought the file said.
//
// The rule this encodes is *dependency-forming reference*, not *mention*. `design.md` named as the
// kind of artifact a caller hands the agent is a description of an input; `references/FOO.md` or
// `@../guidance/BAR.md` is an instruction to go and load something. The first is fine and the
// specs use it; the second is what breaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { agentSpecFiles } = require('./_shared');

const specs = agentSpecFiles().map(({ name, file }) => ({ name, text: fs.readFileSync(file, 'utf8') }));

/** Extensions that make a token a file rather than a word. Kept narrow on purpose: `OpenAPI/JSDoc`
 * and `WHY/WHAT` are slash-separated prose, not paths, and must not read as references. */
const FILE_EXT = 'md|markdown|txt|sh|bash|py|js|mjs|cjs|ts|json|ya?ml|toml|conf';

const EXTERNAL_REFERENCE_PATTERNS = [
  [new RegExp(String.raw`(?:^|\s)@[\w./-]+\.(?:${FILE_EXT})\b`, 'm'),
    'an `@file` import — the harness lazy-load idiom. A subagent context is not the always-loaded '
    + 'context, so this resolves to nothing'],
  [/\[[^\]]*\]\((?!https?:|#)[^)]+\)/,
    'a markdown link to a local target: a path the subagent has no root to resolve against'],
  [new RegExp(String.raw`[\w~$.-]*/[\w./$-]*\.(?:${FILE_EXT})\b`),
    'a slash-separated path to a file — a dependency on the repository layout the subagent cannot see'],
  [/\$\{?DOFLOW_[A-Z_]+\}?/,
    'an interpolated DoFlow config variable: agent specs run outside the runtime seam, so nothing '
    + 'sets it'],
  [/(?:^|\s)(?:\.\.?\/|~\/)/m,
    'a relative or home-anchored path: there is no working directory a subagent could resolve it from'],
  [new RegExp(String.raw`\b(?:read|load|open|consult|refer to|see|follow|per)\b[^.\n]{0,60}?\.(?:${FILE_EXT})\b`, 'i'),
    'an instruction to go and load a named file'],
];

// Bare artifact names the specs use to describe *what a caller hands them* or *what they produce*.
// None is a path and none is loaded by the spec: removing the named file would not make the spec
// wrong, only make the described input unavailable. Each entry states why it is not a dependency;
// the reverse check below deletes the entry when the mention goes.
const ARTIFACT_KIND_MENTIONS = new Map([
  ['design.md', 'named as the kind of contract a caller may hand core-implementer, alongside "a '
    + 'plain-language description or review finding" — the spec explicitly works without it'],
  ['plan.md', 'named in the same breath as design.md, as one possible form of the task given to the agent'],
  ['implementation-flow.md', 'named as an output research-writer produces, not an input it reads'],
]);

/** Everything that looks like a filename anywhere in a spec, however it is spelled. */
function fileTokens(text) {
  return [...text.matchAll(new RegExp(String.raw`[\w~$./-]*\b[\w.-]+\.(?:${FILE_EXT})\b`, 'g'))]
    .map(([token]) => token);
}

test('G14: no agent specification references a file outside itself (FR-021)', () => {
  assert.ok(specs.length >= 5, `expected the five archetypes, found ${specs.length}`);

  const findings = [];
  for (const { name, text } of specs) {
    for (const [pattern, why] of EXTERNAL_REFERENCE_PATTERNS) {
      const hit = text.match(pattern);
      if (hit) findings.push(`${name}: ${JSON.stringify(hit[0].trim())} — ${why}`);
    }
  }
  assert.deepEqual(findings.sort(), [],
    'an agent specification that names a file it cannot load is worse than one that names nothing: '
    + 'the subagent either stops mid-task or reconstructs what it assumes the file said. Inline the '
    + `content the spec needs instead:\n  ${findings.sort().join('\n  ')}`);
});

test('G14: every filename an agent specification mentions is a recorded artifact kind, not a dependency', () => {
  // The pattern list above catches references that carry a path or a load instruction. This is the
  // residual: a bare `foo.md` dropped into prose. Allowed only when it names a kind of artifact
  // rather than a file to fetch, and only with the reason written down.
  const unaccounted = [];
  for (const { name, text } of specs) {
    for (const token of fileTokens(text)) {
      if (!ARTIFACT_KIND_MENTIONS.has(token)) unaccounted.push(`${name} -> ${token}`);
    }
  }
  assert.deepEqual([...new Set(unaccounted)].sort(), [],
    'a filename in an agent specification is a dependency unless it is deliberately a description of '
    + 'an artifact kind. Remove it, or add an ARTIFACT_KIND_MENTIONS entry saying why the spec still '
    + `works when that file is absent:\n  ${[...new Set(unaccounted)].sort().join('\n  ')}`);
});

test('G14: every recorded artifact-kind mention is still mentioned', () => {
  // Without this, an allowance outlives the prose that needed it and quietly pre-approves the next
  // reference that happens to use the same name — this time as a real dependency.
  const all = specs.flatMap(({ text }) => fileTokens(text));
  const stale = [...ARTIFACT_KIND_MENTIONS.keys()].filter((token) => !all.includes(token));
  assert.deepEqual(stale, [],
    `ARTIFACT_KIND_MENTIONS entries no agent specification uses any more must be deleted:\n  ${stale.join('\n  ')}`);
});
