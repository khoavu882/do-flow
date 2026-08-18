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
const path = require('node:path');
const { REPO } = require('./_shared');

const BASH_DIR = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

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

/** Verbs a consumer actually invokes — `doflow-run <verb>`, however the locator path is spelled. */
function verbsNamedBy(consumers) {
  const named = new Set();
  for (const { text } of consumers) {
    for (const [, verb] of text.matchAll(/doflow-run\s+([a-z][a-z-]*)/g)) named.add(verb);
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
    for (const [, verb] of consumer.matchAll(/doflow-run\s+([a-z][a-z-]*)/g)) {
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
