'use strict';

// First coverage for `src/runtime/task-classifier.js`, and specifically for the fit check — the
// riskiest thing in it, because every wrong answer it can give is a *confident* one.
//
// The finding it exists to prevent: a diagnosis classified as `research` was ACCEPTED, and the
// `research` workflow is `scoping:do → synthesis:do-document`. It has no analysis stage, so a model
// doing exactly what its skill said would have run under a workflow with nowhere to put its work.
// Membership held; fit was never asked. These tests assert that fit is now asked, *and* — the other
// half, and the easier one to lose — that when fit cannot be judged the decision says so by name
// rather than passing quietly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { TaskClassifier } = require('../../src/runtime/task-classifier');
const { WorkflowEngine } = require('../../src/runtime/workflow-engine');
const { parseYamlFile } = require('../../src/runtime/capability-router');

const REPO = path.resolve(__dirname, "../..");

/** Against the shipped registry, deliberately: the fit relation is a fact about the real stage
 * lists, and a synthetic registry would test the algorithm while proving nothing about the tree. */
function classifier() {
  return new TaskClassifier({ repoRoot: REPO });
}

// ------------------------------------------------------------------- the reproduction, and its fix

test('a diagnosis proposed under research is rejected: research has no stage for do-diagnose', () => {
  const decision = classifier().classify({ taskClass: 'research', callingSkill: 'do-diagnose' });

  assert.equal(decision.outcome, 'REJECTED',
    'the class exists, so membership passes; accepting on that alone is the defect');
  assert.equal(decision.reason, 'caller-not-a-stage');
  assert.equal(decision.fit.state, 'NOT_HOSTED');
  assert.equal(decision.taskClass, null, 'a fit rejection selects nothing, like every other rejection');
  assert.equal(decision.workflow, null);

  const hosting = Object.fromEntries(
    decision.fit.hostingClasses.map(({ taskClass, stageIds }) => [taskClass, stageIds]),
  );
  assert.deepEqual(hosting, {
    bug: ['root-cause'],
    refactor: ['architecture-mapping'],
    'dependency-change': ['usage-impact'],
  }, 'the rejection has to name where the work *can* go, or it is a stop rather than a fix');
  for (const taskClass of Object.keys(hosting)) {
    assert.match(decision.message, new RegExp(taskClass),
      'the hosting classes must reach the model through the message, not only through the JSON');
  }
});

test('the same skill under a class that does name it is accepted and reports the stage', () => {
  const decision = classifier().classify({ taskClass: 'refactor', callingSkill: 'do-diagnose' });

  assert.equal(decision.outcome, 'ACCEPTED');
  assert.equal(decision.fit.state, 'HOSTED');
  assert.equal(decision.fit.reason, null);
  assert.deepEqual(decision.fit.hostedStageIds, ['architecture-mapping']);
  assert.equal(decision.fit.callerRole, 'stage');
});

// ------------------------------------------------------------------------- the router exemption

test('a router occupies no stage, so fit does not apply to it', () => {
  const decision = classifier().classify({ taskClass: 'research', callingSkill: 'do' });

  assert.equal(decision.outcome, 'ACCEPTED');
  assert.equal(decision.fit.state, 'NOT_APPLICABLE');
  assert.equal(decision.fit.reason, 'caller-is-a-router');
  assert.equal(decision.fit.callerRole, 'router');
});

test('the router exemption is a property of the caller, not of the class it proposes', () => {
  // `do-flow` sequences whatever class it selected. If the exemption were keyed on the class, it
  // would hold for the classes a router happens to appear in and fail for the rest.
  const decision = classifier().classify({ taskClass: 'bug', callingSkill: 'do-flow' });

  assert.equal(decision.outcome, 'ACCEPTED');
  assert.equal(decision.fit.state, 'NOT_APPLICABLE');
  assert.equal(decision.fit.reason, 'caller-is-a-router');
});

// --------------------------------------------------------------------- callers outside routing

test('a standalone caller is rejected for every class, with the registry\'s own reason', () => {
  const decision = classifier().classify({ taskClass: 'bug', callingSkill: 'do-constitution' });

  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'caller-outside-workflows');
  assert.equal(decision.fit.state, 'NOT_HOSTED');
  assert.match(decision.message, /No workflow declares a governance stage/,
    'the declared exemption reason is what makes the rejection actionable rather than flat');
});

// -------------------------------------------------------------- an unknown caller is not "no caller"

test('an unrecognised caller id is rejected, never treated as no caller supplied', () => {
  const decision = classifier().classify({ taskClass: 'bug', callingSkill: 'do-diagnos' });

  // The tempting implementation reads an unknown id as absent and falls through to the back-compat
  // ACCEPTED. That would let a one-character typo switch the gate off, silently.
  assert.notEqual(decision.outcome, 'ACCEPTED');
  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'unknown-calling-skill');
  assert.equal(decision.fit.state, 'NOT_EVALUATED');
  assert.ok(decision.callerSuggestions.includes('do-diagnose'));
  assert.deepEqual(decision.suggestions, [],
    'skill ids must not leak into `suggestions`, which skills present as the class options');
});

// ------------------------------------------------------------- the back-compat path, stated out loud

test('no calling skill: still ACCEPTED, and the message says fit was not evaluated', () => {
  const decision = classifier().classify({ taskClass: 'bug' });

  assert.equal(decision.outcome, 'ACCEPTED', 'skills installed before the flag must keep working');
  assert.equal(decision.fit.state, 'NOT_EVALUATED');
  assert.equal(decision.fit.reason, 'no-calling-skill-supplied');
  assert.equal(decision.callingSkill, null);
  // Asserted on the message, not only the field: the message is what a model reads, and a blind
  // spot recorded only in JSON nobody prints is a blind spot the reader never learns about.
  assert.match(decision.message, /Fit was NOT evaluated/);
  assert.match(decision.message, /--calling-skill/);
});

test('the string form of a proposal behaves identically', () => {
  const fromString = classifier().classify('bug');
  const fromObject = classifier().classify({ taskClass: 'bug' });

  assert.equal(fromString.outcome, 'ACCEPTED');
  assert.equal(fromString.fit.state, 'NOT_EVALUATED');
  assert.equal(fromString.fit.reason, 'no-calling-skill-supplied');
  assert.equal(fromString.message, fromObject.message);
});

test('a near-miss caller key is reported as a near miss, not read and not ignored', () => {
  const decision = classifier().classify({ taskClass: 'bug', caller: 'do-implement' });

  assert.equal(decision.outcome, 'ACCEPTED');
  assert.equal(decision.fit.state, 'NOT_EVALUATED');
  assert.equal(decision.fit.reason, 'caller-key-near-miss');
  assert.match(decision.message, /'caller'/,
    'the key that was found has to be named, or the caller cannot tell what to rename');
  assert.match(decision.message, /Fit was NOT evaluated/);
});

// ------------------------------------------------------------------- fit against a class that isn't

test('an unknown class rejects as before, and reports fit as unjudgeable rather than absent', () => {
  const decision = classifier().classify({ taskClass: 'nope', callingSkill: 'do-diagnose' });

  assert.equal(decision.outcome, 'REJECTED');
  assert.equal(decision.reason, 'unknown-class', 'the existing rejection is unchanged');
  assert.equal(decision.fit.state, 'NOT_EVALUATED');
  assert.equal(decision.fit.reason, 'class-not-resolved',
    'there is nothing to fit against when the class does not resolve, and that is the honest answer');
});

test('every decision carries a fit object, including the two pre-existing rejections', () => {
  const decisions = [
    classifier().classify(null),
    classifier().classify({ taskClass: 'nope' }),
    classifier().classify({ taskClass: 'bug' }),
    classifier().classify({ taskClass: 'bug', callingSkill: 'do-diagnose' }),
  ];
  for (const decision of decisions) {
    assert.ok(decision.fit, `fit is missing from a ${decision.outcome}/${decision.reason} decision`);
    assert.deepEqual(Object.keys(decision.fit).sort(), [
      'callerRole', 'callerSuggestions', 'callingSkill', 'hostedStageIds', 'hostingClasses',
      'reason', 'state',
    ], 'fit is never absent and never implied, so its shape is the same on every decision');
    assert.ok(Array.isArray(decision.callerSuggestions));
  }
});

// ------------------------------------------------------- the registry cannot ship without callers

test('a registry with no `callers` map fails at load, not at the gate', () => {
  // `callers` is required rather than optional-with-a-degradation-path on purpose: a degradation
  // path means the fit gate can be off while the system runs, which is the defect family, not the
  // remedy. The engine's existing contract is that an invalid registry throws at construction.
  const document = JSON.parse(JSON.stringify(
    parseYamlFile(path.join(REPO, 'core', 'registry', 'workflows.yaml'), fs),
  ));
  delete document.callers;

  assert.throws(
    () => new WorkflowEngine({ workflows: document, readinessTemplates: false }),
    /`callers` must be a non-empty object/,
    'a registry the classifier cannot judge fit against must be refused by name, not accepted and '
    + 'then quietly unable to answer',
  );
});
