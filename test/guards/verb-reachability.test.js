'use strict';

/**
 * Verb-caller reachability guard (feature 011, plan task C.1, design component C8; FR-008).
 *
 * Asserts that every verb the dispatcher exposes is invoked by at least one skill under
 * core/shared/skills/, or appears in an allowlist carrying an explicit, documented reason.
 *
 * This prevents unwired capabilities from silently accumulating in the runtime (the failure mode
 * where a primitive is built, tested, and registered in the dispatcher but never called by any
 * stage workflow).
 *
 * Static text scanning only, in the same shape as G16 (module-reachability.test.js) — no execution
 * of the code under audit.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS } = require('./_shared');

const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

/**
 * Verbs that are deliberately caller-free today, with the rationale for each exemption.
 *
 * Storing the reason alongside each entry ensures that an exemption is a recorded decision
 * rather than a silent loophole (design R1, plan RK3).
 */
const ALLOWLIST = new Map([
  [
    'review-package',
    'shell helper invoked by subagent/review orchestration scripts, not called directly as a top-level skill command',
  ],
  [
    'retrieval-plan',
    'foundation retrieval planning verb (design C1/R3) built in Phase B; stage retrieval declarations are wired as workflows adopt retrieval plans',
  ],
  [
    'outcome',
    'foundation terminal record verb (design C2/R3) built in Phase B; terminal stage records are wired as workflow terminal stages adopt outcome recording',
  ],
  [
    'stats',
    'CLI-only observability aggregation command (doflow stats) for operator inspection of local run ledger, not invoked by skill workflows',
  ],
  [
    'doctor',
    'CLI-only health diagnostic and smoke check command (doflow doctor) for human operators and environment setup, not invoked by skill workflows',
  ],
]);

/** Parse all shell-backed verbs from shell_helper_for() in doflow-run. */
function parseShellVerbs() {
  const text = fs.readFileSync(DISPATCHER, 'utf8');
  const block = text.match(/shell_helper_for\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'shell_helper_for() must be present and parseable in doflow-run');
  const verbs = [...block[1].matchAll(/^\s*([a-z][a-z-]*)\)\s*printf/gm)].map(([, v]) => v);
  assert.ok(verbs.length > 0, 'expected to parse at least one shell-backed verb');
  return verbs;
}

/** Parse all Node-backed verbs from is_node_verb() in doflow-run. */
function parseNodeVerbs() {
  const text = fs.readFileSync(DISPATCHER, 'utf8');
  const block = text.match(/is_node_verb\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'is_node_verb() must be present and parseable in doflow-run');
  const [, alternation] = block[1].replace(/\\\n/g, '').match(/^\s*([a-z|-]+)\)\s*return 0/m) || [];
  assert.ok(alternation, 'the node verb alternation must be parseable in doflow-run');
  const verbs = alternation.split('|').filter(Boolean);
  assert.ok(verbs.length > 0, 'expected to parse at least one node-backed verb');
  return verbs;
}

/** Returns all markdown files under core/shared/skills/. */
function skillMarkdownFiles() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        files.push({ rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  }(SKILLS));
  return files;
}

/**
 * Extracts verbs invoked in the skill tree.
 * Matches invocations like:
 *   "$DOFLOW" <verb>
 *   $DOFLOW <verb>
 *   doflow-run <verb>
 *   doflow <verb>
 */
function findInvokedVerbs(skillFiles) {
  const INVOCATION = /(?:doflow-run|\$\{?DOFLOW\}?"?|doflow)\s+([a-z][a-z-]*)/g;
  const invoked = new Map();
  for (const { rel, text } of skillFiles) {
    for (const [, verb] of text.matchAll(INVOCATION)) {
      if (!invoked.has(verb)) {
        invoked.set(verb, []);
      }
      invoked.get(verb).push(rel);
    }
  }
  return invoked;
}

test('G17: every verb the dispatcher exposes is invoked by at least one skill or explicitly allowlisted (FR-008)', () => {
  const shellVerbs = parseShellVerbs();
  const nodeVerbs = parseNodeVerbs();
  const allDispatched = [...new Set([...shellVerbs, ...nodeVerbs])].sort();

  const skillFiles = skillMarkdownFiles();
  const invoked = findInvokedVerbs(skillFiles);

  const unwired = [];
  for (const verb of allDispatched) {
    const hasCaller = invoked.has(verb) && invoked.get(verb).length > 0;
    const isAllowlisted = ALLOWLIST.has(verb);
    if (!hasCaller && !isAllowlisted) {
      unwired.push(verb);
    }
  }

  assert.deepEqual(
    unwired,
    [],
    'these verbs are exposed by the dispatcher (doflow-run) but have no callers in core/shared/skills/ '
    + 'and are not declared in ALLOWLIST with a stated rationale (FR-008):\n  '
    + unwired.join('\n  ')
  );
});

test('G17: every ALLOWLIST entry corresponds to an actual dispatcher verb and carries a rationale', () => {
  const shellVerbs = parseShellVerbs();
  const nodeVerbs = parseNodeVerbs();
  const allDispatched = new Set([...shellVerbs, ...nodeVerbs]);

  const stale = [];
  const missingRationale = [];

  for (const [verb, rationale] of ALLOWLIST.entries()) {
    if (!allDispatched.has(verb)) {
      stale.push(verb);
    }
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      missingRationale.push(verb);
    }
  }

  assert.deepEqual(
    stale,
    [],
    `ALLOWLIST contains verbs that do not exist in the dispatcher:\n  ${stale.join('\n  ')}`
  );

  assert.deepEqual(
    missingRationale,
    [],
    `ALLOWLIST entries must carry a non-empty explanation string:\n  ${missingRationale.join('\n  ')}`
  );
});
