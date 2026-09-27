'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveShadowVerdict } = require('../../src/runtime/inventory/precedence');

// Fixtures below are the actual `scopePrecedence` blocks recorded on `core/registry/harnesses.json`
// for the named harness, trimmed to the fields this module reads (`mode`, `order`). Recorded there
// under task A.2; reproduced here as literals rather than loaded from the registry, so this test
// stays a pure unit test of the resolver and does not also assert the registry's current contents.
const CLAUDE = { status: 'established', order: ['user', 'project'], mode: 'first-wins' };
const CODEX = { status: 'established', order: ['user', 'project'], mode: 'last-wins' };
const GEMINI = { status: 'established', order: ['user', 'project'], mode: 'unestablished' };
const OPENCODE = { status: 'established', order: ['project', 'user'], mode: 'first-wins' };
// PI and ANTIGRAVITY carry no `order` key at all in the registry — the absence is the fixture's
// point, not an omission from trimming.
const PI = { status: 'unestablished', mode: 'unestablished' };
const COPILOT = { status: 'established', order: ['project', 'user'], mode: 'last-wins' };
const KIRO = { status: 'established', order: ['project', 'user'], mode: 'first-wins' };
const ANTIGRAVITY = { status: 'unestablished', mode: 'unestablished' };

test('claude: order=[user,project], first-wins -> winner is user (first)', () => {
  const verdict = resolveShadowVerdict(['user', 'project'], CLAUDE);
  assert.deepEqual(verdict, {
    presentAt: ['user', 'project'],
    shadowed: true,
    winner: 'user',
    withheldReason: null,
  });
});

test('copilot: order=[project,user], last-wins -> winner is user (last), opposite order convention from claude', () => {
  const verdict = resolveShadowVerdict(['project', 'user'], COPILOT);
  assert.equal(verdict.winner, 'user');
  assert.equal(verdict.shadowed, true);
  assert.equal(verdict.withheldReason, null);
});

test('claude and copilot both resolve to the user scope despite opposite order conventions', () => {
  const claudeVerdict = resolveShadowVerdict(['user', 'project'], CLAUDE);
  const copilotVerdict = resolveShadowVerdict(['project', 'user'], COPILOT);
  assert.equal(claudeVerdict.winner, 'user');
  assert.equal(copilotVerdict.winner, 'user');
});

test('codex: order=[user,project], last-wins -> winner is project, which a first-match reading would get wrong', () => {
  const verdict = resolveShadowVerdict(['user', 'project'], CODEX);
  assert.equal(verdict.winner, 'project');
  assert.equal(verdict.shadowed, true);
  assert.equal(verdict.withheldReason, null);
});

test('opencode and kiro: order=[project,user], first-wins -> winner is project', () => {
  assert.equal(resolveShadowVerdict(['project', 'user'], OPENCODE).winner, 'project');
  assert.equal(resolveShadowVerdict(['project', 'user'], KIRO).winner, 'project');
});

test('gemini: order established but mode unestablished -> withheld, and the reason says the order IS established', () => {
  const verdict = resolveShadowVerdict(['user', 'project'], GEMINI);
  assert.equal(verdict.shadowed, true);
  assert.equal(verdict.winner, null);
  assert.match(verdict.withheldReason, /consultation order is established/);
  assert.match(verdict.withheldReason, /user then project/,
    "the reason names the order it does know, since that is what distinguishes gemini's state");
  assert.doesNotMatch(verdict.withheldReason, /order is unestablished/,
    "gemini's order is documented; reporting it as unestablished collapses IC-003's second state "
    + 'into its third');
});

test('pi and antigravity: no order recorded at all, mode unestablished -> withheld, reason says the ORDER is unestablished', () => {
  const piVerdict = resolveShadowVerdict(['project', 'user'], PI);
  const antigravityVerdict = resolveShadowVerdict(['project', 'user'], ANTIGRAVITY);
  for (const verdict of [piVerdict, antigravityVerdict]) {
    assert.equal(verdict.shadowed, true);
    assert.equal(verdict.winner, null);
    assert.match(verdict.withheldReason, /scope-resolution order is unestablished/);
  }
});

// IC-003 §1: "Five states are distinguishable and all five are meaningful ... None of these may
// collapse into another." gemini (order established, mode explicitly unestablished) and pi (order
// sought and found undocumented) are the second and third of those states. Both withhold, both
// name no winner — the reason is the only field left to tell them apart, so it must.
test('gemini and pi both withhold but do not report identically — IC-003 states two and three stay distinct', () => {
  const geminiVerdict = resolveShadowVerdict(['user', 'project'], GEMINI);
  const piVerdict = resolveShadowVerdict(['user', 'project'], PI);

  assert.notEqual(geminiVerdict.withheldReason, piVerdict.withheldReason,
    'a documented order with an undocumented winner must not read the same as an undocumented order');

  for (const verdict of [geminiVerdict, piVerdict]) {
    assert.equal(verdict.winner, null, 'neither state names a winner');
    assert.equal(verdict.shadowed, true);
    assert.deepEqual(verdict.presentAt, ['user', 'project']);
    assert.equal(typeof verdict.withheldReason, 'string');
  }
});

test('every withheld branch produces its own reason — no two of them are the same string', () => {
  const reasons = [
    resolveShadowVerdict(['user', 'project'], undefined).withheldReason, // no block recorded
    resolveShadowVerdict(['user', 'project'], GEMINI).withheldReason, // order yes, mode no
    resolveShadowVerdict(['user', 'project'], PI).withheldReason, // order no, mode no
    resolveShadowVerdict(['user', 'project'], { status: 'established', order: ['user', 'project'], mode: 'merged' }).withheldReason,
    resolveShadowVerdict(['user', 'project'], { mode: 'first-wins' }).withheldReason, // mode, no order
    resolveShadowVerdict(['user', 'project'], { order: ['user', 'project'] }).withheldReason, // order, no mode
  ];
  assert.equal(new Set(reasons).size, reasons.length,
    `expected ${reasons.length} distinct withheld reasons, got ${new Set(reasons).size}: `
    + JSON.stringify(reasons, null, 2));
  for (const reason of reasons) assert.equal(typeof reason, 'string');
});

test('merged mode -> withheld, no winner named (no recorded harness currently uses this mode; a synthetic fixture exercises it)', () => {
  const merged = { status: 'established', order: ['user', 'project'], mode: 'merged' };
  const verdict = resolveShadowVerdict(['user', 'project'], merged);
  assert.equal(verdict.shadowed, true);
  assert.equal(verdict.winner, null);
  assert.equal(verdict.withheldReason,
    'the harness merges copies from every scope rather than choosing between them',
    'the merged reason is already distinct and correct — it is held fixed here');
});

test('a single-scope asset has no shadow and no withheld verdict, regardless of the precedence block', () => {
  const withPrecedence = resolveShadowVerdict(['project'], CLAUDE);
  assert.deepEqual(withPrecedence, {
    presentAt: ['project'],
    shadowed: false,
    winner: 'project',
    withheldReason: null,
  });

  const withoutPrecedence = resolveShadowVerdict(['user'], undefined);
  assert.deepEqual(withoutPrecedence, {
    presentAt: ['user'],
    shadowed: false,
    winner: 'user',
    withheldReason: null,
  });
});

test('a harness with no precedence block at all, asset present at more than one scope -> withheld', () => {
  assert.equal(resolveShadowVerdict(['user', 'project'], undefined).winner, null);
  assert.equal(resolveShadowVerdict(['user', 'project'], null).winner, null);
  const verdict = resolveShadowVerdict(['user', 'project'], null);
  assert.equal(verdict.shadowed, true);
  assert.match(verdict.withheldReason, /no scope-precedence is recorded/);
});

test('an unrecognized or missing mode is never guessed at, even with an order present', () => {
  const noMode = { order: ['user', 'project'] };
  const verdict = resolveShadowVerdict(['user', 'project'], noMode);
  assert.equal(verdict.winner, null);
  assert.match(verdict.withheldReason, /no usable resolution mode/);

  const weirdMode = { order: ['user', 'project'], mode: 'something-else' };
  assert.equal(resolveShadowVerdict(['user', 'project'], weirdMode).winner, null);
});

test('first-wins or last-wins with no order recorded withholds rather than guessing', () => {
  const verdict = resolveShadowVerdict(['user', 'project'], { mode: 'first-wins' });
  assert.equal(verdict.winner, null);
  assert.match(verdict.withheldReason, /no consultation order/);
});

test('presentScopes is deduplicated and malformed entries are dropped', () => {
  const verdict = resolveShadowVerdict(['project', 'project', '', null, 'user'], CLAUDE);
  assert.deepEqual(verdict.presentAt, ['project', 'user']);
  assert.equal(verdict.shadowed, true);
});

test('an empty or entirely-malformed presentScopes returns null rather than a verdict', () => {
  assert.equal(resolveShadowVerdict([], CLAUDE), null);
  assert.equal(resolveShadowVerdict(['', null, undefined], CLAUDE), null);
  assert.equal(resolveShadowVerdict(null, CLAUDE), null);
  assert.equal(resolveShadowVerdict(undefined, CLAUDE), null);
});
