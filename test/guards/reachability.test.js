'use strict';

// G8 — every executable surface DoFlow ships is reachable from something that ships with it.
//
// G3 already asserts this for documentation ("every mode and reference file has at least one skill
// or rule consumer"). Nothing asserted it for *executables*, and that is precisely the hole three
// features fell through: 723732a consolidated 28 skills into 12 and deleted subagent-driven/,
// do-select-tool/, and confidence-check/ — the sole callers of feature 003's dispatch scripts, 004's
// capability router, and 005's readiness engine. Every engine kept working and every test kept
// passing, because unit tests exercise engines directly and never through the skill layer that is
// supposed to invoke them. The features were simply unreachable by any documented interface.
//
// Reachability here means: named by a skill or by shipped guidance/docs, named *through the
// dispatcher's verb table* by one of those, or called by another script that is itself reachable.
// A script invoked only by another script is fine — that is composition, not orphaning — so the
// transitive closure is what matters, not direct mention.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');

const BASH_DIR = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SKILLS_DIR = path.join(REPO, 'core', 'shared', 'skills');

/** Everything that ships and could plausibly name an executable: skills, guidance, and user docs. */
function consumerTexts() {
  const out = [];
  const roots = [
    path.join(REPO, 'core', 'shared', 'skills'),
    path.join(REPO, 'core', 'shared', 'guidance'),
    path.join(REPO, 'docs'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(md|json|toml|yaml)$/.test(entry.name)) continue;
        out.push({ rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
      }
    }(root));
  }
  out.push({ rel: 'README.md', text: fs.readFileSync(path.join(REPO, 'README.md'), 'utf8') });
  return out;
}

function scriptTexts() {
  return fs.readdirSync(BASH_DIR)
    .filter((n) => n.endsWith('.sh'))
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(BASH_DIR, n), 'utf8') }));
}

/**
 * verb -> helper, parsed out of the dispatcher's own `shell_helper_for()` case block.
 *
 * Since feature 008 a skill no longer names a helper: it calls `../../bin/doflow-run <verb>` and
 * the dispatcher decides which helper serves that verb (design.md §4.2, FR-003/FR-004). Naming the
 * helper is now the wrong thing for a skill to do, so requiring a direct mention would have turned
 * this guard into pressure to re-inline the very paths that change removed. The indirection is
 * real reachability and is modelled as such — but only as an *edge*, not as an amnesty: a helper
 * still has to be reached, now by a consumer naming the verb that serves it.
 *
 * Parsed rather than restated so a verb added tomorrow is covered without editing this file.
 */
function verbTable() {
  const text = fs.readFileSync(DISPATCHER, 'utf8');
  const block = text.match(/shell_helper_for\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'shell_helper_for() is the dispatcher verb table and must be parseable');
  const table = new Map([...block[1].matchAll(/^\s*([a-z][a-z-]*)\)\s*printf '([^']+)'/gm)]
    .map(([, verb, helper]) => [verb, helper]));
  assert.ok(table.size > 0, 'expected to parse at least one shell-backed verb from the dispatcher');
  return table;
}

/**
 * Every way a consumer can spell an invocation of the seam:
 *   - `doflow-run <verb>`      — the dispatcher or a locator named by path
 *   - `"$DOFLOW" <verb>`       — the resolved-once handle a skill reuses for its later verbs
 * The second form exists because a skill resolves the runtime once in step 1 and keeps the result;
 * without it, every verb a chain skill calls after the first would read as uninvoked here.
 */
const INVOCATION = /(?:doflow-run|\$\{?DOFLOW\}?"?)\s+([a-z][a-z-]*)/g;

/** Verbs a consumer actually invokes — `doflow-run <verb>`, however the seam is spelled. */
function verbsNamedBy(consumers) {
  const named = new Set();
  for (const { text } of consumers) {
    for (const [, verb] of text.matchAll(INVOCATION)) named.add(verb);
  }
  return named;
}

test('G8: every shipped shell script is reachable from a skill, doc, or another reachable script', () => {
  const scripts = scriptTexts();
  const consumers = consumerTexts();
  const table = verbTable();
  const invokedVerbs = verbsNamedBy(consumers);

  const namedByDocs = new Set(
    scripts.filter((s) => consumers.some((c) => c.text.includes(s.name))).map((s) => s.name),
  );
  // A helper whose verb a consumer invokes is named by that consumer, one indirection removed.
  for (const [verb, helper] of table) {
    if (invokedVerbs.has(verb)) namedByDocs.add(helper);
  }

  // Transitive closure: a script called by an already-reachable script is reachable too.
  const reachable = new Set(namedByDocs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const caller of scripts) {
      if (!reachable.has(caller.name)) continue;
      for (const callee of scripts) {
        if (reachable.has(callee.name) || callee.name === caller.name) continue;
        if (caller.text.includes(callee.name)) { reachable.add(callee.name); grew = true; }
      }
    }
  }

  const orphaned = scripts.map((s) => s.name).filter((n) => !reachable.has(n)).sort();
  assert.deepEqual(orphaned, [],
    'these scripts ship but nothing invokes them — directly, through a dispatcher verb a skill or '
    + `doc calls, or from another reachable script:\n  ${orphaned.join('\n  ')}`);
});

test('G8: every verb a skill or doc invokes is a verb the dispatcher actually dispatches', () => {
  // The other half of the indirection. Once reachability can be earned by naming a verb, a
  // misspelled verb stops being a broken command a guard catches and becomes an unreachable helper
  // instead — the failure surfaces as an unrelated orphan, or not at all if something else happens
  // to reach the same helper. Checking the call side directly keeps the diagnosis at the typo.
  const text = fs.readFileSync(DISPATCHER, 'utf8');
  const nodeBlock = text.match(/is_node_verb\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(nodeBlock, 'is_node_verb() is the node arm of the verb table and must be parseable');
  const [, alternation] = nodeBlock[1].replace(/\\\n/g, '').match(/^\s*([a-z|-]+)\)\s*return 0/m) || [];
  assert.ok(alternation, 'the node verb alternation must be parseable');

  // `--help`/`help` are the dispatcher's own arguments, not verbs, and answer before the table.
  const dispatched = new Set([...verbTable().keys(), ...alternation.split('|'), 'help']);
  const unknown = [];
  for (const { rel, text: consumer } of consumerTexts()) {
    for (const [, verb] of consumer.matchAll(INVOCATION)) {
      if (!dispatched.has(verb)) unknown.push(`${rel} -> doflow-run ${verb}`);
    }
  }
  const unique = [...new Set(unknown)].sort();
  assert.deepEqual(unique, [],
    `these calls would exit 2 with "unknown verb":\n  ${unique.join('\n  ')}`);
});

test('G8: every runtime CLI command is named by a skill or doc', () => {
  // Parsed from the dispatch switch rather than hardcoded, so a new command is covered the moment
  // it is wired up — the guard should not need editing to start guarding.
  const cli = fs.readFileSync(path.join(REPO, 'bin', 'doflow.js'), 'utf8');
  const commands = [...cli.matchAll(/case '([a-z-]+)': return handle[A-Za-z]+Command/g)].map((m) => m[1]);
  assert.ok(commands.length > 0, 'expected to find runtime command handlers in bin/doflow.js');

  const consumers = consumerTexts();
  const orphaned = commands
    .filter((cmd) => !consumers.some((c) => c.text.includes(`doflow ${cmd}`)))
    .sort();
  assert.deepEqual(
    orphaned,
    [],
    `these runtime commands ship but no skill or doc tells anyone to run them:\n  ${orphaned.join('\n  ')}`,
  );
});

test('G8: every flag docs/reference.md documents for a skill exists in that skill', () => {
  // A v1 re-review of reference.md found four factual errors: /do-constitution documented a
  // --init flag that has never existed, /do-plan advertised a `enterprise` strategy it does not
  // accept, and --focus was written `perf` where the skill takes `performance`. Nothing checked
  // this: G4 verifies FLAGS.md against core/, but docs/ was outside every guard, so the user-facing
  // reference could describe a CLI surface that was never built.
  const skillsRoot = path.join(REPO, 'core', 'shared', 'skills');
  const ref = fs.readFileSync(path.join(REPO, 'docs', 'reference.md'), 'utf8');
  const flagsOf = (text) => new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));

  const mismatches = [];
  for (const [, skill, args] of ref.matchAll(/^\| `\/(do[a-z-]*)((?:[^|`]|\\\|)*)`/gm)) {
    const skillMd = path.join(skillsRoot, skill, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;                       // G6 already guards skill existence
    const hint = fs.readFileSync(skillMd, 'utf8').match(/^argument-hint:\s*"?(.*?)"?\s*$/m)?.[1];
    if (!hint) continue;                                          // no declared surface to check against
    const declared = flagsOf(hint);
    for (const flag of flagsOf(args)) {
      if (!declared.has(flag)) mismatches.push(`${skill}: docs say ${flag}, argument-hint does not`);
    }
  }
  assert.deepEqual(mismatches, [], `docs/reference.md documents flags that do not exist:\n  ${mismatches.join('\n  ')}`);
});

test('G8: every repo path a doc names in backticks exists', () => {
  // architecture.md's structure table listed `bin/doflow`; the file is bin/doflow.js. Harmless to
  // read, wrong to copy — and the same class of error as a moved directory silently outliving its
  // documentation. Only backticked paths rooted at a known top-level directory are checked, so
  // prose and command examples are unaffected.
  const roots = 'core|src|bin|test|docs';
  const missing = [];
  for (const { rel, text } of consumerTexts()) {
    for (const [, p] of text.matchAll(new RegExp(`\`((?:${roots})/[A-Za-z0-9_./-]*)\``, 'g'))) {
      const clean = p.replace(/\/$/, '');
      if (!fs.existsSync(path.join(REPO, clean))) missing.push(`${rel} -> ${p}`);
    }
  }
  const unique = [...new Set(missing)].sort();
  assert.deepEqual(unique, [], `these documented paths do not exist:\n  ${unique.join('\n  ')}`);
});

test('G8: the capability matrix in docs matches the registry it claims to be generated from', () => {
  // Both matrices in capability-map.md were hand-maintained and had drifted: the capability table
  // claimed Hooks "Supported" for OpenCode and MCP "Supported" for Pi where the registry says
  // "different", and pointed Pi's settings at config.json instead of settings.json. A table that
  // says it is generated from the registry has to actually agree with it, or it is just a second
  // source of truth wearing the first one's name.
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.yaml'), 'utf8'));
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'capability-map.md'), 'utf8');
  const LABELS = { Instructions: 'instructions', Skills: 'skills', Agents: 'agents', Scripts: 'scripts', Templates: 'templates', Modes: 'modes', Settings: 'settings', Hooks: 'hooks', MCP: 'mcp', 'Plugin / extension': 'plugin' };
  const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const mismatches = [];
  for (const [label, cap] of Object.entries(LABELS)) {
    const row = doc.split('\n').find((l) => l.startsWith(`| ${label} |`));
    if (!row) { mismatches.push(`missing row: ${label}`); continue; }
    const cells = row.split('|').slice(2, -1).map((c) => c.trim());
    reg.harnesses.forEach((h, i) => {
      const expected = title(h.capabilities[cap]?.status ?? '—');
      if (!cells[i]?.startsWith(expected)) {
        mismatches.push(`${label}/${h.id}: doc says "${cells[i]}", registry says "${expected}"`);
      }
    });
  }
  assert.deepEqual(mismatches, [], `capability-map.md has drifted from the registry:\n  ${mismatches.join('\n  ')}`);
});

test('G8: every docs page is reachable from the mkdocs nav', () => {
  // capability-map.md shipped for several releases absent from nav, so it never appeared in the
  // built site even though README linked to it — a page that exists but cannot be navigated to.
  const nav = fs.readFileSync(path.join(REPO, 'mkdocs.yml'), 'utf8');
  const pages = fs.readdirSync(path.join(REPO, 'docs')).filter((n) => n.endsWith('.md'));
  const missing = pages.filter((p) => !nav.includes(p)).sort();
  assert.deepEqual(missing, [], `these docs pages are not in the mkdocs nav:\n  ${missing.join('\n  ')}`);
});

test('G8: no doc claims a capability the registry does not declare', () => {
  // tool_matrix.md was a hand-copied snapshot of the router and had drifted: it documented
  // `docs.lookup` and `reasoning.structured`, both of which raise "Unknown capability". A table
  // that names capabilities the router cannot resolve sends the model after tools that do not
  // exist, which is worse than having no table.
  const declared = new Set(Object.keys(
    JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'capabilities.yaml'), 'utf8')).capabilities,
  ));
  const phantom = [];
  for (const { rel, text } of consumerTexts()) {
    // Capability ids are dotted lowercase tokens; only inspect backticked ones so prose is safe.
    for (const [, id] of text.matchAll(/`([a-z]+\.[a-z-]+)`/g)) {
      // Restrict to namespaces the registry actually owns, so unrelated dotted tokens
      // (file.ext, package.json) are not mistaken for capability references.
      if (!/^(code|history|behavior|command)\./.test(id)) continue;
      if (!declared.has(id)) phantom.push(`${rel} -> ${id}`);
    }
  }
  assert.deepEqual(
    [...new Set(phantom)],
    [],
    `these docs name capabilities the registry does not declare:\n  ${[...new Set(phantom)].join('\n  ')}`,
  );
});

test('G8: a `references/…` pointer resolves against one of the two roots that string can mean', () => {
  // G3 checks a referenced file exists *somewhere* in the tree, which is weaker than it looks: it
  // let parallel_dispatch.md point at `modes/MODE_Task_Management.md`, a real file living under the
  // guidance tree rather than beside the skill reference that named it.
  //
  // `references/X.md` is genuinely overloaded in this repo — it means a sibling directory in
  // do/references/tool_matrix.md, and the shared guidance tree in do-plan's
  // references/DOFLOW_CHAIN.md. Both are established conventions, so both are accepted here; what
  // this catches is a pointer resolving against *neither*, which is always a typo or a moved file.
  // Paths like ./requirement.md are deliberately out of scope: those name feature artifacts created
  // at runtime, not files that ship.
  const skillsRoot = path.join(REPO, 'core', 'shared', 'skills');
  const guidanceRefs = path.join(REPO, 'core', 'shared', 'guidance');
  // do-code-review's assets/expected_outputs dirs intentionally hold malformed regression
  // fixtures (deliberately dangling references included) to exercise its own checkers — not real
  // prose, so they are excluded the same way consumers.test.js (G3) excludes them.
  const FIXTURE_DIRS = new Set(['assets', 'expected_outputs']);
  const broken = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!FIXTURE_DIRS.has(entry.name)) walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [, ref] of text.matchAll(/`(references\/[A-Za-z0-9_.-]+\.md)`/g)) {
        const asSibling = path.resolve(path.dirname(full), ref);
        const asGuidance = path.resolve(guidanceRefs, ref);
        if (!fs.existsSync(asSibling) && !fs.existsSync(asGuidance)) {
          broken.push(`${path.relative(REPO, full)} -> ${ref}`);
        }
      }
    }
  }(skillsRoot));
  assert.deepEqual(broken, [], `these references resolve against neither root:\n  ${broken.join('\n  ')}`);
});

// ---------------------------------------------------------------------------------------------
// The resolution snippets skills tell the model to run.
//
// C.4 (08bddf6) replaced six inlined resolvers with `../../bin/doflow-run <verb>` and claimed the
// path resolved "relative to this skill's own directory". It does not: a relative path in a shell
// command resolves against the *working directory*, and a skill runs with CWD at the user's project
// root — so every one of those 27 call-sites resolved to <grandparent-of-project>/bin/doflow-run and
// died with "No such file or directory". The task's own verification passed because it `cd`'d into
// the skill directory first, which is the one place the caller never stands.
//
// So the guard's whole point is the working directory: it performs a real install and executes each
// documented snippet with CWD at the project root and at a nested subdirectory, never in the skill
// directory. A check that only read the text could not have caught this — the text was plausible.
// ---------------------------------------------------------------------------------------------

// Any bash block naming the seam by path. Deliberately wider than "blocks containing the *correct*
// installed path": the broken relative form is `../../bin/doflow-run`, and a predicate that only
// recognised the correct path would stop collecting a snippet at the moment it regressed — the
// regression would read as "one fewer snippet" instead of "this snippet does not run".
const SEAM_MARK = 'doflow-run';
const INSTALLED_DISPATCHER = '.doflow/scripts/doflow/bin/doflow-run';

/** Strip the list-item indentation a fenced block carries inside a numbered step. */
function dedent(code) {
  const lines = code.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join('\n');
}

/**
 * Every fenced bash block in the skill tree that reaches the runtime by path. Discovered rather than
 * listed, so a snippet added to a new skill tomorrow is executed by this guard without editing it.
 * Blocks that only use an already-resolved `"$DOFLOW"` are out of scope here — they carry no path of
 * their own, and their handle is set up by a block this does collect.
 */
function resolutionSnippets() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [, block] of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
        if (block.includes(SEAM_MARK)) out.push({ rel: path.relative(REPO, full), code: dedent(block) });
      }
    }
  }(SKILLS_DIR));
  return out;
}

test('G8: every documented runtime-resolution snippet resolves with CWD at the project root', () => {
  const snippets = resolutionSnippets();
  // The six chain skills plus parallel_dispatch.md. A floor, not an equality: the point is that the
  // set is non-trivial, so an accidental change to RESOLVER_MARK cannot quietly test nothing.
  assert.ok(snippets.length >= 7,
    `expected the chain skills to document a resolution snippet each, found ${snippets.length}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-resolve-'));
  try {
    // $HOME is scratch too: a global install of the developer's own must not be what makes this
    // pass, and the not-installed branch must be reachable.
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const install = spawnSync(
      'node',
      [path.join(REPO, 'bin', 'doflow.js'), 'install', root, '-f', '--no-backup', '-t', 'claude'],
      { encoding: 'utf8', input: '\n', env: { ...process.env, HOME: home } },
    );
    assert.equal(install.status, 0, `installer failed: ${install.stderr}`);
    assert.ok(fs.existsSync(path.join(root, INSTALLED_DISPATCHER)), 'install did not place the dispatcher');

    // Project root is where a skill actually runs; the subdirectory pins the walk-up, which is the
    // second way the broken form failed.
    const deep = path.join(root, 'src', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });

    const failures = [];
    for (const { rel, code } of snippets) {
      for (const cwd of [root, deep]) {
        const where = path.relative(root, cwd) || '<project root>';
        const run = spawnSync('bash', ['-c', code], {
          cwd,
          encoding: 'utf8',
          // A developer's exported override would resolve the runtime for reasons the snippet does
          // not own, hiding exactly the defect under test.
          env: { ...process.env, HOME: home, DOFLOW_CONFIG_DIR: undefined },
        });
        if (run.status !== 0) {
          failures.push(`${rel} (cwd=${where}): exit ${run.status} — ${(run.stderr || '').trim().split('\n')[0]}`);
          continue;
        }
        if (code.includes('paths --json')) {
          let parsed;
          try { parsed = JSON.parse(run.stdout); } catch {
            failures.push(`${rel} (cwd=${where}): resolved but 'paths --json' emitted non-JSON`);
            continue;
          }
          if (!parsed.repo_root) failures.push(`${rel} (cwd=${where}): 'paths --json' returned no repo_root`);
        }
      }
    }
    assert.deepEqual(failures, [],
      'these documented snippets do not work from the directory a skill actually runs in:\n  '
      + `${failures.join('\n  ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G8: no skill documents the known-broken `../../bin/doflow-run` relative call', () => {
  // Belt to the execution test's braces, and a far better error message: this one names the file and
  // line rather than reporting a bash exit code. The form is not merely discouraged, it cannot work
  // from any directory a skill is invoked from, so its presence is always a defect.
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('../../bin/doflow-run')) offenders.push(`${path.relative(REPO, full)}:${i + 1}`);
      });
    }
  }(SKILLS_DIR));
  assert.deepEqual(offenders, [],
    'a relative path resolves against the working directory (the project root), not the skill '
    + 'directory, so this call always fails. Inline the walk-up resolver instead:\n  '
    + `${offenders.join('\n  ')}`);
});
