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
// Reachability here means: named by a skill or by shipped guidance/docs, or called by another
// script that is itself reachable. A script invoked only by another script is fine — that is
// composition, not orphaning — so the transitive closure is what matters, not direct mention.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const BASH_DIR = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bash');

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

test('G8: every shipped shell script is reachable from a skill, doc, or another reachable script', () => {
  const scripts = scriptTexts();
  const consumers = consumerTexts();
  const namedByDocs = new Set(
    scripts.filter((s) => consumers.some((c) => c.text.includes(s.name))).map((s) => s.name),
  );

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
  assert.deepEqual(orphaned, [], `these scripts ship but nothing invokes them:\n  ${orphaned.join('\n  ')}`);
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
  const broken = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
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
