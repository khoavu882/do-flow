'use strict';

// G13 — workflow registry integrity (feature 008, design C14 / FR-013, FR-015, FR-022).
//
// `core/registry/workflows.yaml` is the only place that knows what a task class means. Nothing at
// runtime notices when it stops describing reality: `WorkflowEngine` validates the document it is
// handed, but a class naming a skill that does not exist, or a readiness template that was renamed
// out from under it, is *structurally valid* — it fails later, at the stage boundary, as "unknown
// skill" or as a gate that quietly gates nothing. Both are the same defect family C.2 found in the
// verification engine: a check that passes while verifying nothing.
//
// So this guard cross-checks the registry against the two things it names but does not own — the
// shipped skill tree and `readiness-templates.yaml` — and pins the two class shapes FR-015 exists
// to guarantee. A failure here means one of those three files moved without the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, skillFiles } = require('./_shared');
const { WorkflowEngine } = require('../../src/runtime/workflow-engine');
const { parseYamlFile } = require('../../src/runtime/capability-router');

const REGISTRY_DIR = path.join(REPO, 'core', 'registry');
const WORKFLOWS_FILE = path.join(REGISTRY_DIR, 'workflows.yaml');
const TEMPLATES_FILE = path.join(REGISTRY_DIR, 'readiness-templates.yaml');

const workflowDoc = parseYamlFile(WORKFLOWS_FILE, fs);
const templateNames = new Set(Object.keys(parseYamlFile(TEMPLATES_FILE, fs).templates || {}));
const shippedSkills = new Set(skillFiles().map(({ name }) => name));

// The engine over the *shipped* document. Constructed with the cross-check disabled and wrapped,
// so that a registry defect surfaces as the named assertion below rather than as a module-load
// throw that reports every test in this file as "test failed" and names none of them. The
// cross-check itself is not skipped — it is re-run explicitly, against the real template set, by
// the first test.
let engineError = null;
let engineInstance = null;
try {
  engineInstance = new WorkflowEngine({ workflows: workflowDoc, readinessTemplates: false });
} catch (error) {
  engineError = error;
}
function engine() {
  assert.ok(engineInstance,
    "the workflow registry could not be loaded at all, so nothing below could be checked:\n"
    + (engineError && engineError.message));
  return engineInstance;
}

// Classes that declare no readiness template at all. Legitimate only when the class authors no
// source: implementation readiness gates edits, so a workflow that makes none has nothing to gate.
// Each entry carries its own reason, and the reverse check below fails when one goes stale — a
// class that grows an implementation stage must lose its exemption in the same change.
const NO_READINESS_TEMPLATE = new Map([
  ['review', 'reviews and reports; makes no edit, so implementation readiness has nothing to gate'],
  ['research', 'terminates at synthesis and never reaches an edit'],
  ['operations', 'authors no source — it acts on repository state. `readiness-templates.yaml` has no '
    + 'template for it and the class claims none; its equivalent safeguard is the preflight '
    + 'verification stage. Recorded in the class\'s own readinessNote rather than left implicit.'],
]);

// ------------------------------------------------------------------ 1. the registry is coherent

test('G13: the shipped workflow registry validates against the shipped readiness templates', () => {
  // Deliberately re-run with the real template set rather than trusting the constructor: the
  // constructor skips the cross-check whenever a document is injected, so "the engine loaded" is a
  // weaker statement than it looks. This asks the question with both real files in hand.
  const problems = WorkflowEngine.validateRegistry(workflowDoc, { readinessTemplates: templateNames });
  assert.deepEqual(problems, [],
    'core/registry/workflows.yaml no longer describes a valid set of workflows. Every problem is '
    + 'listed rather than the first, so this is the whole picture:\n  ' + problems.join('\n  '));
});

test('G13: every declared class resolves to a workflow with at least one stage', () => {
  const declared = Object.keys(workflowDoc.classes);
  assert.deepEqual(engine().listClasses(), declared,
    'the engine and the registry disagree about which classes exist');

  const broken = [];
  for (const taskClass of declared) {
    try {
      const workflow = engine().resolveWorkflow(taskClass);
      if (!workflow.stages.length) broken.push(`${taskClass}: resolved to zero stages`);
      if (!workflow.terminalStage) broken.push(`${taskClass}: has no terminal stage`);
    } catch (error) {
      broken.push(`${taskClass}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [],
    'a declared class that does not resolve is a class the classifier will accept and the engine '
    + 'will then refuse to run:\n  ' + broken.join('\n  '));
});

// --------------------------------------------------------------- 2. stages name only real skills

// The invariant that stops a stage naming an invented skill. A stage id is free text as far as the
// engine is concerned, so `do-refactor` (which does not exist) would validate, resolve, and be
// handed to the model as the thing to run next. The model would then improvise — the exact
// fabrication failure the chain is built to prevent.
test('G13: every skill named by a workflow stage exists in the shipped skill tree', () => {
  const missing = [];
  for (const taskClass of engine().listClasses()) {
    for (const stage of engine().resolveWorkflow(taskClass).stages) {
      if (!shippedSkills.has(stage.skill)) {
        missing.push(`${taskClass}/${stage.id} -> core/shared/skills/${stage.skill}/ (no such skill)`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'these stages name a skill that does not ship. The engine cannot tell — it treats `skill` as an '
    + 'opaque string — so the failure surfaces as the model being told to run something that is not '
    + `there. Rename the stage or add the skill:\n  ${missing.join('\n  ')}`);
});

// ------------------------------------------------------------------- 3. FR-015's two class shapes

// Asserted directly, by name, rather than derived. FR-015 requires the non-feature classes to have
// a shape appropriate to them, and these two are the load-bearing cases: `review` acquiring an
// implementation stage would mean a review silently edits the code it is reviewing, and `research`
// acquiring implementation readiness would mean a question about the codebase is gated behind
// evidence that only an edit needs. Both are the kind of change that looks like a small registry
// tidy-up and is not.
test('G13: review has no implementation stage (FR-015)', () => {
  const review = engine().resolveWorkflow('review');
  assert.equal(review.hasImplementationStage, false,
    'the review class gained a source-mutating stage. A review that edits is not a review, and the '
    + `stage kinds involved are: ${review.stages.map((s) => `${s.id}:${s.kind}`).join(', ')}`);
  assert.deepEqual(review.implementationStageIds, [],
    'review must resolve to zero implementation stages');
});

test('G13: research requires no implementation readiness (FR-015)', () => {
  const research = engine().resolveWorkflow('research');
  assert.equal(research.requiresImplementationReadiness, false,
    'the research class now demands implementation readiness. Research terminates at synthesis; '
    + 'gating it behind edit-readiness evidence blocks a workflow that never edits. Templates now '
    + `claimed: ${research.readinessTemplates.join(', ') || '(none)'}`);
  assert.equal(research.hasImplementationStage, false,
    'research must not mutate source either — readiness and mutation move together');
});

// --------------------------------------------------------- 4. readiness templates exist, or don't

test('G13: no class declares a readiness template that readiness-templates.yaml does not define', () => {
  const dangling = [];
  for (const taskClass of engine().listClasses()) {
    for (const stage of engine().resolveWorkflow(taskClass).stages) {
      if (stage.readinessTemplate && !templateNames.has(stage.readinessTemplate)) {
        dangling.push(`${taskClass}/${stage.id} -> '${stage.readinessTemplate}'`);
      }
    }
  }
  assert.deepEqual(dangling, [],
    'a stage naming a template that does not exist looks gated and gates nothing — the same defect '
    + 'as a verification check with no command reporting PASS. Known templates: '
    + `${[...templateNames].sort().join(', ')}. Offenders:\n  ${dangling.join('\n  ')}`);
});

test('G13: a class with no readiness template is one of the recorded exemptions', () => {
  const ungated = engine().listClasses()
    .filter((taskClass) => engine().resolveWorkflow(taskClass).readinessTemplates.length === 0);

  const unaccounted = ungated.filter((taskClass) => !NO_READINESS_TEMPLATE.has(taskClass));
  assert.deepEqual(unaccounted, [],
    'these classes run with no readiness contract at any stage and no recorded reason. Either add a '
    + 'template to readiness-templates.yaml and claim it, or add a NO_READINESS_TEMPLATE entry '
    + `stating why the class needs none:\n  ${unaccounted.join('\n  ')}`);

  // Reverse direction, so the exemption list cannot outlive what it exempts. Both failure shapes
  // matter: an entry for a deleted class is dead weight, and an entry for a class that has since
  // gained a template is a stale claim that would hide the next gap.
  const stale = [...NO_READINESS_TEMPLATE.keys()].filter((taskClass) => {
    if (!engine().hasClass(taskClass)) return true;
    return engine().resolveWorkflow(taskClass).readinessTemplates.length > 0;
  });
  assert.deepEqual(stale, [],
    'NO_READINESS_TEMPLATE entries for classes that no longer exist, or that now declare a '
    + `template, must be deleted:\n  ${stale.join('\n  ')}`);
});

test('G13: an exempt class states its own reason in readinessNote', () => {
  // The exemption above lives in the test suite; the registry has to carry the same statement where
  // a reader of the workflow will actually meet it. Otherwise "no gate here" reads as an oversight.
  const silent = [...NO_READINESS_TEMPLATE.keys()]
    .filter((taskClass) => engine().hasClass(taskClass))
    .filter((taskClass) => !/no readiness template/i.test(workflowDoc.classes[taskClass].readinessNote || ''));
  assert.deepEqual(silent, [],
    'a class exempt from readiness must say so in its own `readinessNote`, so the absence reads as a '
    + `decision rather than a gap:\n  ${silent.join('\n  ')}`);
});
