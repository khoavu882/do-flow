'use strict';

// G73 — no exemption of the pre-implementation gate covers the gate's own evidence (maint-testdiet).
//
// pre-implementation-gate.sh decides from files: the readiness record, the orchestration run, the
// do-paths.sh resolver it runs, the workflow registry it reads, and the feature artifacts. Two
// reviews (hook-tiers R-1, thin-defaults P1) found exemptions in the gate (the git-ignore skip, the
// agent-docs skip) that let a model Write one of those files and forge READY. This guard keeps the
// door shut for the exemptions that exist and for any added later:
//
//   1. The evidence paths are ENUMERATED FROM THE SCRIPT'S OWN TEXT (the stores its record_in calls
//      read, its RESOLVER_CANDIDATES array, its registry candidates, the files probe_artifacts
//      probes), so a store or candidate added to the gate joins the check by itself. An entry whose
//      form this guard cannot classify fails the guard rather than being skipped.
//   2. On a feature branch whose repository ignores every DoFlow directory (the worst case for an
//      ignore-based exemption), an Edit and a Write to each in-repository path is run through the
//      real script, in a state where an ordinary source edit is denied. Anything the script lets
//      through that is not in AUTHORING_SURFACE fails the guard.
//   3. The check itself is shown to fail: it is re-run on copies of the script with an exemption
//      planted for the readiness store, the run store, an in-repository resolver candidate and the
//      registry, and each plant must be reported.
//
// AUTHORING_SURFACE is the one deliberate hole: the feature artifacts and the decision register live
// under agent-docs/ and are written by the model through Edit and Write while /do-brainstorm,
// /do-design and /do-plan run, so the gate's documented rule is "edits under agent-docs/ are always
// allowed" (the message it prints, and pre-implementation-gate-readiness.test.ts). They are not the
// forgeable part of the gate: READY comes from the readiness record, which no artifact can supply.
// The set is pinned both ways: a path in it that the gate starts denying breaks authoring, and a
// path outside it that the gate starts allowing is the hole this guard exists for.
//
// KNOWN_GAPS is the one finding this guard was written with, pinned as a ratchet (like the
// ALLOWED_GAPS of gate-vocabulary.test.ts): the in-repository resolver candidates of the harness
// directories (.claude, .codex, .kiro) are NOT covered by the gate's `.doflow` / `agent-docs/doflow`
// segment rule, so when a repository git-ignores those directories the gate's ignore skip lets an
// Edit or Write of the resolver through. The gate runs that file and takes feature_dir and the
// has_* answers from it, so rewriting an installed (executable) resolver can make the gate find no
// feature and allow. Fixing it is a core/ change (extend the segment rule to the resolver paths);
// this file only pins it: the list may only shrink, and a gap the gate now closes must be removed.
//
// Paths outside the repository (the $HOME and harness-config resolver candidates) are outside what
// this gate decides: "edit target outside the repo -> allow" is in its header. They are classified
// here by their expression and listed in OUT_OF_REPO, so a new candidate form is a finding.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { encodeEnvelope } = require('../helper/hook-fixtures.ts');

const POLICY_DIR = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const POLICY = path.join(POLICY_DIR, 'pre-implementation-gate.sh');
const CONTRACT = path.join(POLICY_DIR, 'contract.sh');
const BRIDGE = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'bridge');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');
const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // needs bash, jq and git
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const SLUG = '900-demo';
const TASK = 'T1';

/** Feature artifacts and the register: written by the model through Edit/Write, so allowed. */
const KNOWN_GAPS = Object.freeze([
  '.claude/scripts/doflow/bash/do-paths.sh',
  '.codex/scripts/doflow/bash/do-paths.sh',
  '.kiro/scripts/doflow/bash/do-paths.sh',
]);
const AUTHORING_SURFACE = Object.freeze(['intention/requirement.md', 'design/design.md', 'plan.md', 'requirement.md', 'design.md', 'decisions/register.json']);
/** Resolver and registry candidates whose root is not the repository, by the expression the script writes. */
const OUT_OF_REPO = Object.freeze([
  '$HOME/.doflow/scripts/doflow/bash/do-paths.sh',
  '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh',
  '${CODEX_HOME:-$HOME/.codex}/scripts/doflow/bash/do-paths.sh',
  '$HOME/.kiro/scripts/doflow/bash/do-paths.sh',
  '$HOME/.doflow/runtime/core/registry/workflows.json',
]);
/** In-repository roots, by the expression the script writes. */
const REPO_ROOT_EXPR = ['$ROOT/', '$repo_root/'];
/** `${CLAUDE_PROJECT_DIR:-}/.claude/...` is the project's when the harness names it; it is the same file as `$ROOT/.claude/...`. */
const PROJECT_DIR_EXPR = '${CLAUDE_PROJECT_DIR:-}/';

const scratch = createScratch('doflow-gate-evidence-');
after(() => scratch.remove());

function write(file: any, text: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Every quoted entry of the bash array/for-list that starts at the first line matching `open`, up to its closer. */
function entriesAfter(text: any, open: any, closer: any) {
  const lines = text.split('\n');
  const start = lines.findIndex((line: any) => open.test(line));
  assert.ok(start >= 0, `the gate no longer has a block matching ${open}; update the enumeration`);
  const out: any = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (closer.test(lines[i])) break;
    const match = lines[i].match(/^\s*"([^"]+)"/);
    if (match) out.push(match[1]);
  }
  assert.ok(out.length > 0, `no entries found after ${open}`);
  return out;
}

/** The evidence the script at `policyFile` reads, as repository-relative paths and out-of-repo expressions. */
function enumerate(policyFile: any) {
  const text = fs.readFileSync(policyFile, 'utf8');
  const inRepo: any = new Map();     // relative path -> what it is evidence of
  const outOfRepo: any = [];

  // 1. Stores: every `record_in <root> <store> <feature>` call reads <root>/.doflow/state/<store>/.
  const stores = new Set([...text.matchAll(/record_in\s+"[^"]+"\s+([a-z-]+)\s/g)].map((m: any) => m[1]));
  assert.ok(stores.has('readiness') && stores.has('orchestration'), `the gate reads stores ${[...stores]}; expected readiness and orchestration`);
  for (const store of stores) {
    inRepo.set(`.doflow/state/${store}/${TASK}.json`, `${store} record`);
    inRepo.set(`.doflow/state/${store}/${SLUG}.json`, `${store} record`);
    inRepo.set(`.doflow/state/${store}/${SLUG}/${TASK}.json`, `${store} record`);
    inRepo.set(`.doflow/state/${store}/other-feature/${TASK}.json`, `${store} record`);
  }

  // 2. Resolver candidates, and 3. registry candidates (the gate runs the first and reads the second).
  const candidates = [
    ...entriesAfter(text, /^RESOLVER_CANDIDATES=\(/, /^\)/),
    ...entriesAfter(text, /^for candidate in \\$/, /;\s*do\s*$/).filter((entry: any) => /workflows\.json$/.test(entry)),
  ];
  for (const raw of candidates) {
    const root = REPO_ROOT_EXPR.find((prefix: any) => raw.startsWith(prefix));
    if (root) { inRepo.set(raw.slice(root.length), 'resolver or registry candidate'); continue; }
    if (raw.startsWith(PROJECT_DIR_EXPR)) { inRepo.set(raw.slice(PROJECT_DIR_EXPR.length), 'resolver candidate'); continue; }
    if (raw.includes('POLICY_DIR')) continue; // beside the policy itself, in the install, not in the repository
    assert.ok(OUT_OF_REPO.includes(raw), `unclassified evidence candidate ${raw}: put it in OUT_OF_REPO if it is outside the repository, else teach enumerate() its root`);
    outOfRepo.push(raw);
  }

  // 4. Feature artifacts: the files probe_artifacts looks for under the feature folder, and the register.
  const probed = [...text.matchAll(/\$dir\/([A-Za-z0-9_./-]+\.md)/g)].map((m: any) => m[1]);
  const register = [...text.matchAll(/\$feature_dir\/(decisions\/register\.json)/g)].map((m: any) => m[1]);
  for (const rel of new Set([...probed, ...register])) inRepo.set(`agent-docs/doflow/${SLUG}/${rel}`, 'feature artifact');
  return { inRepo, outOfRepo, stores, probed: new Set(probed), register };
}

/** A copy of the script at `<dir>/shared/hooks/policies/` beside `<dir>/runtime/core/registry/workflows.json`. */
function install(dir: any, policyText: any) {
  const policy = path.join(dir, 'shared', 'hooks', 'policies', 'pre-implementation-gate.sh');
  write(policy, policyText);
  write(path.join(path.dirname(policy), 'contract.sh'), fs.readFileSync(CONTRACT, 'utf8'));
  fs.cpSync(BRIDGE, path.join(dir, 'shared', 'hooks', 'bridge'), { recursive: true });
  write(path.join(dir, 'runtime', 'core', 'registry', 'workflows.json'), fs.readFileSync(REGISTRY, 'utf8'));
  return policy;
}

function env(extra: any = {}) {
  return scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', DOFLOW_PROJECT_DIR: '', ...extra });
}

function git(cwd: any, ...args: any[]) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: env(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/**
 * A repository on feat/<SLUG> that ignores every DoFlow directory, with a planned feature folder
 * (the three artifacts and the register) and no readiness record or run: an ordinary source edit is
 * denied here, so a path the gate lets through is one it has exempted.
 */
function makeRepo(name: any, ignore: any = 'agent-docs/\n.doflow/\n.claude/\n.codex/\n.kiro/\n') {
  const main = path.join(scratch.dir, name);
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'src', 'a.js'), 'a\n');
  write(path.join(main, '.gitignore'), ignore);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'checkout', '-q', '-b', `feat/${SLUG}`);
  const folder = path.join(main, 'agent-docs', 'doflow', SLUG);
  write(path.join(folder, 'intention', 'requirement.md'), '# requirement\n');
  write(path.join(folder, 'design', 'design.md'), '# design\n');
  write(path.join(folder, 'plan.md'), '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n');
  write(path.join(folder, 'decisions', 'register.json'), `${JSON.stringify({ version: 1, slug: SLUG, nextId: 1, decisions: [] })}\n`);
  return fs.realpathSync(main);
}

/** The gate's exit status for `tool` on `file`, run from `root`. */
function decide(policy: any, root: any, tool: any, file: any) {
  const event = JSON.stringify({ tool_name: tool, tool_input: { file_path: file } });
  const input = encodeEnvelope('claude', 'PreToolUse', 'pre-implementation-gate', event, { DOFLOW_PROJECT_DIR: root });
  const result = spawnSync('bash', [policy], { cwd: root, input, env: env({ DOFLOW_PROJECT_DIR: root }), encoding: 'utf8' });
  return { code: result.status, stderr: result.stderr };
}

/**
 * Runs the script on every enumerated in-repository path with Edit and Write (`tools`). Returns the
 * relative paths it lets through and the controls' verdicts.
 */
function probe(policy: any, root: any, inRepo: any, tools: any = ['Edit', 'Write']) {
  const allowed: any = [];
  for (const rel of inRepo.keys()) {
    for (const tool of tools) {
      const verdict = decide(policy, root, tool, path.join(root, rel));
      if (verdict.code !== 2) allowed.push(`${tool} ${rel} (exit ${verdict.code})`);
    }
  }
  return allowed;
}

/** The enumerated paths the gate lets through today: the authoring surface, then KNOWN_GAPS. */
function expectedAllowed(inRepo: any) {
  const out: any = [];
  for (const [rel, kind] of inRepo) if (kind === 'feature artifact' || KNOWN_GAPS.includes(rel)) out.push(rel);
  return out;
}

const REAL = install(path.join(scratch.dir, 'real'), fs.readFileSync(POLICY, 'utf8'));

HOOK_TEST('the gate\'s evidence enumeration reads the shapes this guard knows', () => {
  const { inRepo, outOfRepo, stores, probed, register } = enumerate(POLICY);
  assert.deepEqual([...stores].sort(), ['orchestration', 'readiness']);
  assert.deepEqual([...outOfRepo].sort(), OUT_OF_REPO.filter((e: any) => !e.endsWith('workflows.json')).sort(), 'the out-of-repo resolver candidates the gate lists');
  for (const rel of ['.doflow/scripts/doflow/bash/do-paths.sh', '.claude/scripts/doflow/bash/do-paths.sh', '.codex/scripts/doflow/bash/do-paths.sh', '.kiro/scripts/doflow/bash/do-paths.sh', '.doflow/runtime/core/registry/workflows.json']) {
    assert.ok(inRepo.has(rel), `${rel} is not enumerated`);
  }
  // The artifacts the gate probes are exactly the authoring surface the guard pins.
  assert.deepEqual([...new Set([...probed, ...register])].sort(), [...AUTHORING_SURFACE].sort(), 'the files the gate probes under the feature folder');
});

HOOK_TEST('an Edit or Write to the gate\'s evidence is denied on a feature branch; only the authoring surface passes', { timeout: 240_000 }, () => {
  const root = makeRepo('real-repo');
  const { inRepo } = enumerate(POLICY);

  // Controls: the state denies ordinary source and allows nothing but agent-docs/, so a pass means an exemption.
  assert.equal(decide(REAL, root, 'Edit', path.join(root, 'src', 'a.js')).code, 2, 'control: a source edit is denied in this state');
  assert.equal(decide(REAL, root, 'Write', path.join(root, 'src', 'new.js')).code, 2, 'control: a source write is denied in this state');
  assert.equal(decide(REAL, root, 'Write', path.join(root, 'agent-docs', 'notes.md')).code, 0, 'control: agent-docs/ is the documented exemption');

  const allowed = probe(REAL, root, inRepo);
  const authoring = expectedAllowed(inRepo);
  const expected = authoring.flatMap((rel: any) => ['Edit', 'Write'].map((tool: any) => `${tool} ${rel} (exit 0)`));
  const unexpected = allowed.filter((entry: any) => !expected.includes(entry));
  const closed = expected.filter((entry: any) => !allowed.includes(entry));
  assert.deepEqual(unexpected, [], 'the gate lets through evidence that is neither an authored artifact nor a KNOWN_GAP: an exemption covers the gate\'s own evidence');
  assert.deepEqual(closed, [], 'the gate now denies a path this guard lists as allowed: remove it from KNOWN_GAPS (a closed gap), or restore authoring of the artifact');
});

HOOK_TEST('KNOWN_GAPS are the git-ignore skip alone: the same paths are denied in a repository that tracks them', { timeout: 240_000 }, () => {
  const root = makeRepo('tracked-repo', 'agent-docs/\n.doflow/\n');
  assert.deepEqual(probe(REAL, root, new Map(KNOWN_GAPS.map((rel: any) => [rel, 'resolver candidate'])), ['Edit', 'Write']), []);
});

HOOK_TEST('the check goes red on a planted exemption for each kind of evidence', { timeout: 240_000 }, () => {
  const root = makeRepo('plant-repo');
  const text = fs.readFileSync(POLICY, 'utf8');
  const anchor = '  case "$file" in *"/agent-docs/"*|agent-docs/*) continue ;; esac\n';
  assert.ok(text.includes(anchor), 'the plant anchors on the gate\'s agent-docs exemption; update the anchor when that line moves');
  const plants: any = [
    ['the readiness store', '  case "$file" in */.doflow/state/readiness/*) continue ;; esac\n', '.doflow/state/readiness/T1.json'],
    ['the run store', '  case "$file" in */.doflow/state/orchestration/*) continue ;; esac\n', '.doflow/state/orchestration/900-demo/T1.json'],
    ['a resolver candidate', '  case "$file" in */.doflow/scripts/*) continue ;; esac\n', '.doflow/scripts/doflow/bash/do-paths.sh'],
    ['the registry', '  case "$file" in */.doflow/runtime/*) continue ;; esac\n', '.doflow/runtime/core/registry/workflows.json'],
    ['a state file by name', '  case "$file" in *.json) continue ;; esac\n', '.doflow/state/readiness/T1.json'],
  ];
  const { inRepo } = enumerate(POLICY);
  plants.forEach(([label, line, rel]: any, index: any) => {
    const planted = install(path.join(scratch.dir, `plant-${index}`), text.replace(anchor, anchor + line));
    const allowed = probe(planted, root, new Map([[rel, inRepo.get(rel)]]), ['Write']);
    assert.deepEqual(allowed, [`Write ${rel} (exit 0)`], `a planted exemption for ${label} must be reported`);
  });
});
