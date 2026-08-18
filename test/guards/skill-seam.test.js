'use strict';

// G15 — the skill/runtime seam (feature 008, design C14 / FR-004, FR-022).
//
// FR-004: a skill reaches the runtime only by calling the entrypoint through its locator. A skill
// is prose, so it cannot `source` a shim — the one thing it legitimately spells out is the four
// lines that find `doflow-run`. Everything else it must ask the dispatcher for.
//
// Two failure shapes are guarded here, and both have already happened once.
//
//   1. A *second* resolver form. C.4 (08bddf6) replaced six inlined resolvers with
//      `../../bin/doflow-run <verb>`, described as resolving "relative to this skill's own
//      directory". A relative path in a shell command resolves against the working directory, and a
//      skill runs at the user's project root, so all 27 call-sites resolved to
//      <grandparent-of-project>/bin/doflow-run. G8 executes the snippets and would catch that exact
//      form; this is the general case — any path to the seam other than the installed one, and any
//      second spelling of the resolver, whether or not it happens to run today.
//
//   2. An *asset* reached by path. `$DOFLOW_CONFIG_DIR/templates/x.md` and friends bypass the seam
//      entirely: they hardcode the shared-tree layout into thirteen files, so moving an asset
//      breaks every skill that named it, silently, at the point the model tries to read it.
//
// The installed location is derived from the registry rather than restated, so this guard cannot
// agree with a skill that is wrong about where the runtime lives.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS } = require('./_shared');
const { loadRegistry } = require('../../src/registry');

const registry = loadRegistry({ repoRoot: REPO });
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

/** `<config>`-relative path the registry actually installs the dispatcher at, e.g.
 * `scripts/doflow/bin/doflow-run`. Derived exactly as runtime-unification.test.js derives it, from
 * the `scripts.doflow` nativeDir plus the dispatcher's position inside the asset source tree. */
function installedDispatcherRel() {
  const scripts = registry.assets.find((a) => a.id === 'scripts.doflow');
  assert.ok(scripts, 'scripts.doflow is the asset that ships the dispatcher');
  const inAsset = path.relative(path.join(REPO, scripts.source), DISPATCHER).split(path.sep).join('/');
  const nativeDirs = new Set(Object.values(scripts.nativeDir));
  const prefixes = new Set();
  for (const dir of nativeDirs) {
    const match = dir.match(/^\.\.\/\.doflow\/(.+)$/);
    assert.ok(match, `scripts.doflow nativeDir "${dir}" no longer targets the shared .doflow tree`);
    prefixes.add(match[1]);
  }
  assert.equal(prefixes.size, 1,
    `the harnesses install the dispatcher at different config-relative paths (${[...prefixes].join(', ')}); `
    + 'a skill can only spell one of them');
  return `${[...prefixes][0]}/${inAsset}`;
}

const INSTALLED_REL = installedDispatcherRel();
const INSTALLED_SUFFIX = `.doflow/${INSTALLED_REL}`;

function skillTreeFiles({ skillMdOnly = false } = {}) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      if (skillMdOnly && entry.name !== 'SKILL.md') continue;
      out.push({ rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
    }
  }(SKILLS));
  return out;
}

// -------------------------------------------------------- 1. one path to the seam, the right one

test('G15: every path to the runtime entrypoint is the path the registry installs it at (FR-004)', () => {
  const wrong = [];
  for (const { rel, text } of skillTreeFiles()) {
    for (const [token] of text.matchAll(/[\w~$.{}/-]*doflow-run\b/g)) {
      // A bare mention of the name in prose carries no path and resolves nothing.
      if (token === 'doflow-run') continue;
      if (!token.endsWith(INSTALLED_SUFFIX)) wrong.push(`${rel} -> ${token}`);
    }
  }
  assert.deepEqual([...new Set(wrong)].sort(), [],
    `the registry installs the dispatcher at <config>/${INSTALLED_REL}. These call-sites name a `
    + 'different path, so they resolve either to nothing or — worse, as C.4 shipped — to a plausible '
    + `location outside the project:\n  ${[...new Set(wrong)].sort().join('\n  ')}`);
});

// ------------------------------------------------------------- 2. one resolver, one spelling

/** Contiguous runs of resolver lines: the walk-up, the assignment, and the fallbacks that test the
 * handle. Collected as a block so two skills differing by a single character are two forms. */
function resolverBlocks(text) {
  const blocks = [];
  let current = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const isResolverLine = /doflow-run/.test(line)
      ? /(?:^|\W)DOFLOW=|while \[|\[ -x /.test(line)
      : /^\[ -x "\$DOFLOW" \]/.test(line);
    if (isResolverLine) current.push(line);
    else if (current.length) { blocks.push(current.join('\n')); current = []; }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

test('G15: the runtime resolver has exactly one spelling across the whole skill tree', () => {
  const forms = new Map();
  for (const { rel, text } of skillTreeFiles()) {
    for (const block of resolverBlocks(text)) {
      forms.set(block, [...(forms.get(block) || []), rel]);
    }
  }
  assert.ok(forms.size > 0,
    'no resolver block was found anywhere in the skill tree. Either the seam stopped being reached '
    + 'from skills, or resolverBlocks() stopped recognising it — the second would leave this guard '
    + 'passing while checking nothing');

  const rendered = [...forms].map(([block, files]) =>
    `${files.length} file(s): ${files.join(', ')}\n${block.split('\n').map((l) => `      ${l}`).join('\n')}`);
  assert.equal(forms.size, 1,
    'a second spelling of the resolver is a second seam: it has its own search order, its own '
    + 'failure message and its own bugs, and only one of them gets fixed when one is found. Make '
    + `every skill use the same block.\n\n    ${rendered.join('\n\n    ')}`);

  // A resolver that never reports failure is the "vacuous pass" shape again: the model would run
  // the next command against an empty $DOFLOW and read the shell's own error instead of ours.
  const [only] = [...forms.keys()];
  assert.match(only, /exit 2/,
    'the resolver must fail loudly with the uniform exit 2 when no runtime is found, not fall '
    + `through to an unset handle:\n${only}`);
});

// ---------------------------------------------------- 3. no asset reached by path, no config var

// Scoped to SKILL.md, matching FR-022's wording. Reference files under a skill's `references/` are
// deliberately out of scope: `parallel_dispatch.md` explains to the reader where the installed
// guidance tree sits (`<config-dir>/guidance/modes/...`), which is documentation about the layout
// rather than a skill instructing the model to fetch a file from it. Widening this to the whole
// tree would force that explanation to be deleted or obfuscated, which is not the goal.
const CONFIG_VAR = /\$\{?DOFLOW_(?:CONFIG_DIR|ROOT|HOME)\}?/g;

// The two config mentions that are not paths to anything: they are the text of the resolver's own
// error message, naming the two places it searched. Reasons recorded, staleness checked below.
const ALLOWED_CONFIG_MENTIONS = new Map([
  ['.doflow/', 'the resolver error message — "no runtime found in any .doflow/ above $PWD"'],
  ['$HOME/.doflow', 'the same error message, naming the global install it also checked'],
]);

test('G15: no SKILL.md interpolates a DoFlow config variable (FR-004)', () => {
  const findings = [];
  // Checked across the whole skill tree, not just SKILL.md: unlike a prose path, an interpolated
  // variable is only ever there to be executed, and nothing sets it outside the dispatcher.
  for (const { rel, text } of skillTreeFiles()) {
    for (const [hit] of text.matchAll(CONFIG_VAR)) findings.push(`${rel} -> ${hit}`);
  }
  assert.deepEqual([...new Set(findings)].sort(), [],
    'a skill that builds an asset path out of a config variable hardcodes the shared-tree layout '
    + 'into itself and is silently wrong the day the asset moves. Ask the dispatcher for the verb '
    + `that serves the asset instead:\n  ${[...new Set(findings)].sort().join('\n  ')}`);
});

test('G15: no SKILL.md reaches into the config directory for anything but the entrypoint', () => {
  const findings = [];
  for (const { rel, text } of skillTreeFiles({ skillMdOnly: true })) {
    for (const [token] of text.matchAll(/[\w~$.{}/-]*\.doflow[\w$./-]*/g)) {
      if (token.endsWith(INSTALLED_SUFFIX)) continue;
      const normalized = token.replace(/[.]$/, '');
      if (ALLOWED_CONFIG_MENTIONS.has(token) || ALLOWED_CONFIG_MENTIONS.has(normalized)) continue;
      findings.push(`${rel} -> ${token}`);
    }
  }
  assert.deepEqual([...new Set(findings)].sort(), [],
    'the only thing a skill may name inside the config directory is the entrypoint. Every other '
    + 'asset — template, script, guidance file — is reached through a verb, so that moving it is one '
    + `registry edit rather than thirteen prose edits:\n  ${[...new Set(findings)].sort().join('\n  ')}`);
});

test('G15: every recorded config mention still appears in a SKILL.md', () => {
  const all = skillTreeFiles({ skillMdOnly: true }).map(({ text }) => text).join('\n');
  const stale = [...ALLOWED_CONFIG_MENTIONS.keys()].filter((token) => !all.includes(token));
  assert.deepEqual(stale, [],
    'an allowance that outlives the text it allowed pre-approves the next occurrence of the same '
    + `string, which will not be the same thing:\n  ${stale.join('\n  ')}`);
});

// ------------------------------------------------------- 4. a classify call carries its identity

// `classify` judges two separate things: that the proposed class exists, and that the class's
// workflow has a stage the *calling skill* can occupy. Only the first is answerable without
// `--calling-skill`, and a call that omits it gets an ACCEPTED that establishes membership alone —
// correctly reported as `fit.state: NOT_EVALUATED`, and just as correctly read by a model as
// "validated". That back-compat path exists for skills installed before the flag did; it must not
// become the path this repo's own skills take. D.4 is what it looks like when it does: a diagnosis
// accepted under `research`, whose stages are `do` and `do-document`.
test('G15: every classify call names the skill making it, and names itself (FR-004)', () => {
  const wrong = [];
  let calls = 0;
  for (const { rel, text } of skillTreeFiles()) {
    const owner = rel.split(path.sep)[3];   // core/shared/skills/<owner>/...
    for (const [line] of text.matchAll(/^.*\bclassify\b.*$/gm)) {
      if (!/--task-class/.test(line)) continue;   // prose about the verb, not an invocation
      calls += 1;
      const match = line.match(/--calling-skill\s+(\S+)/);
      if (!match) wrong.push(`${rel} -> no --calling-skill: ${line.trim()}`);
      else if (match[1] !== owner) wrong.push(`${rel} -> --calling-skill ${match[1]} (owner is ${owner})`);
    }
  }
  assert.ok(calls > 0,
    'no classify invocation was found in the skill tree at all. Either the skills stopped '
    + 'classifying, or this scan stopped recognising the call — the second leaves the guard passing '
    + 'while checking nothing');
  assert.deepEqual(wrong.sort(), [],
    'a classify call without the caller\'s own id gets a membership-only pass and reads as '
    + 'validation, and a call naming a *different* skill has the runtime judge fit for someone '
    + `else:\n  ${wrong.sort().join('\n  ')}`);
});
