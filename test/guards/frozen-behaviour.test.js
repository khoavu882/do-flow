'use strict';

/**
 * Frozen-behaviour regression assertions (feature 011, plan task C.2, design component CH9; FR-009, FR-012).
 *
 * Pins the two behaviours this feature explicitly promises NOT to change:
 *
 *   1. FR-009: Capability routing is frozen at its current callers.
 *      No skill that does not already resolve information needs through the capability router
 *      gains that behaviour in this feature. The router's current reach is treated as a
 *      deliberate posture pending measurement, not an incomplete rollout.
 *
 *   2. FR-012: The pre-implement-gate hook's behaviour and scope is unchanged.
 *      Readiness evaluation inside skills and file-existence checking inside the hook are two
 *      independent layers: the hook must remain a fast, fail-open file-presence gate on
 *      requirement.md, design.md, and plan.md, and must never depend on readiness or runtime
 *      evidence state.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS } = require('./_shared');

/**
 * The exact set of skills authorized to resolve information needs through the capability router (FR-009).
 * Any addition or removal requires deliberate review and measurement (requirement.md §5).
 */
const FROZEN_ROUTER_CALLER_SKILLS = new Set([
  'do',
  'do-diagnose',
  'do-execute-plan',
]);

/** Returns all markdown files grouped by their owning skill directory. */
function skillFilesBySkill() {
  const bySkill = new Map();
  for (const entry of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const files = [];
    const skillDir = path.join(SKILLS, skillName);
    (function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
        } else if (item.name.endsWith('.md')) {
          files.push({ rel: path.relative(REPO, full), text: fs.readFileSync(full, 'utf8') });
        }
      }
    }(skillDir));
    bySkill.set(skillName, files);
  }
  return bySkill;
}

test('FR-009: capability router invocations are frozen to the pinned set of skills', () => {
  const bySkill = skillFilesBySkill();
  const ROUTE_INVOCATION = /(?:doflow-run|\$\{?DOFLOW\}?"?|doflow)\s+route\b/g;

  const actualCallerSkills = new Set();
  for (const [skillName, files] of bySkill.entries()) {
    for (const { text } of files) {
      if (ROUTE_INVOCATION.test(text)) {
        actualCallerSkills.add(skillName);
        break;
      }
    }
  }

  const actual = [...actualCallerSkills].sort();
  const expected = [...FROZEN_ROUTER_CALLER_SKILLS].sort();

  assert.deepEqual(
    actual,
    expected,
    `the set of skills invoking the capability router ('doflow route') has changed (FR-009).\n`
    + `Expected frozen set: ${expected.join(', ')}\n`
    + `Actual caller set:   ${actual.join(', ')}`
  );
});

test('FR-012: pre-implement-gate hook scripts remain purely file-existence gates independent of readiness', () => {
  const hookPaths = [
    path.join(REPO, 'core', 'harnesses', 'claude', 'hooks', 'pre-implement-gate.sh'),
    path.join(REPO, 'core', 'harnesses', 'kiro', 'hooks', 'pre-implement-gate.sh'),
  ];

  for (const hookFile of hookPaths) {
    assert.ok(fs.existsSync(hookFile), `pre-implement-gate hook must exist at ${hookFile}`);
    const content = fs.readFileSync(hookFile, 'utf8');

    // 1. Must check requirement.md, design.md, and plan.md presence
    assert.ok(
      content.includes('has_requirement') && content.includes('has_design') && content.includes('has_plan'),
      `${path.basename(hookFile)} must check has_requirement, has_design, and has_plan`
    );

    // 2. Must allow edits under agent-docs/ unconditionally
    assert.ok(
      content.includes('agent-docs'),
      `${path.basename(hookFile)} must allow edits targeting agent-docs/`
    );

    // 3. Must not invoke readiness.js, evidence ledger, or outcome modules (FR-012 independence)
    const forbiddenPatterns = [
      /\breadiness\b/i,
      /\bevidence-ledger\b/i,
      /\bretrieval-plan\b/i,
      /\boutcome\b/i,
      /\bcontext-pack\b/i,
    ];
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !pattern.test(content),
        `${path.basename(hookFile)} must not reference or invoke runtime module/verb ${pattern} (FR-012)`
      );
    }
  }
});
