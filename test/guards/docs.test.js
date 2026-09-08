'use strict';

// G6 — documented inventory matches reality. Not in the original plan: added after this feature's
// own review found that deleting a skill left it listed in docs/reference.md and counted in
// README.md. CLAUDE.md already warns these counts "drift silently"; a scan is cheaper than the
// discipline of remembering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS, AGENT_SPECS } = require('./_shared');

const skillNames = () => fs.readdirSync(SKILLS).filter((n) => fs.existsSync(path.join(SKILLS, n, 'SKILL.md'))).sort();
const agentNames = () => fs.readdirSync(AGENT_SPECS).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).sort();

test('G6: the skill list in docs/reference.md matches the installed skill set', () => {
  const line = fs.readFileSync(path.join(REPO, 'docs/reference.md'), 'utf8')
    .split('\n').find((l) => l.includes('full installed skill set'));
  assert.ok(line, 'docs/reference.md must still enumerate the installed skill set');
  const listed = [...line.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, skillNames(), 'documented skill list has drifted from core/shared/skills/');
});

test('G6: skill and agent counts quoted in README.md are accurate', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const [label, actual] of [['skills', skillNames().length], ['agents', agentNames().length]]) {
    for (const [, quoted] of readme.matchAll(new RegExp(`(\\d+)\\s+${label}\\b`, 'g'))) {
      assert.equal(Number(quoted), actual, `README.md claims ${quoted} ${label}; there are ${actual}`);
    }
  }
});

test('G6: no doc references a skill or agent that does not exist', () => {
  const known = new Set([...skillNames(), ...agentNames()]);
  const dangling = [];
  for (const rel of ['docs/reference.md', 'README.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const [, name] of text.matchAll(/`\/?(do-[a-z-]+|token-efficiency|confidence-check|parallel-agents)`/g)) {
      if (!known.has(name)) dangling.push(`${rel} -> ${name}`);
    }
  }
  assert.deepEqual(dangling, [], `docs reference skills that do not exist:\n  ${dangling.join('\n  ')}`);
});

test('G6: requirement-template.md provides hierarchical stories and BDD scenario scaffolding', () => {
  const reqTmpl = fs.readFileSync(path.join(REPO, 'core/shared/templates/doflow/requirement-template.md'), 'utf8');
  assert.ok(reqTmpl.includes('### Story 1: [Story Title] (P1)'), 'requirement template must scaffold story headings');
  assert.ok(reqTmpl.includes('**Scenario: [Scenario Title]**'), 'requirement template must scaffold BDD scenario headers');
  assert.ok(reqTmpl.includes('- **Given**'), 'requirement template must scaffold Given clause');
  assert.ok(reqTmpl.includes('- **When**'), 'requirement template must scaffold When clause');
  assert.ok(reqTmpl.includes('- **Then**'), 'requirement template must scaffold Then clause');
});

test('G6: specs-template.md provides technical scaffolding for endpoints and repositories', () => {
  // Moved here from design-template.md by feature 023-structured-feature-trail: design.md's own
  // §4/§5 are now a one-line pointer to specs.md, which carries this scaffolding instead. Further
  // split by feature 027-design-artifact-restructure: the schema/ER/UX scaffolding below moved out
  // of specs-template.md §2 into its own data-model-template.md, checked separately below.
  const specsTmpl = fs.readFileSync(path.join(REPO, 'core/shared/templates/doflow/specs-template.md'), 'utf8');
  assert.ok(specsTmpl.includes('endpoint / cli-verb / schema / file-format'), 'specs template must scaffold the endpoint/cli-verb/schema Kind vocabulary');
  assert.ok(specsTmpl.includes('repository/service interface'), 'specs template must scaffold Repository/service interfaces');
});

test('G6: data-model-template.md provides technical scaffolding for schemas and UX', () => {
  // Split out of specs-template.md §2 by feature 027-design-artifact-restructure; see the comment
  // above the specs-template.md scaffolding test.
  const dataModelTmpl = fs.readFileSync(path.join(REPO, 'core/shared/templates/doflow/data-model-template.md'), 'utf8');
  assert.ok(dataModelTmpl.includes('### Database Schemas'), 'data-model template must scaffold Database Schemas');
  assert.ok(dataModelTmpl.includes('erDiagram'), 'data-model template must scaffold relational ER diagram');
  assert.ok(dataModelTmpl.includes('### UX / UI Specifications'), 'data-model template must scaffold UX/UI specifications');
});

test('G6: design-template.md points §4 at specs.md and §5/§6 at data-model.md instead of duplicating their content', () => {
  const dsgTmpl = fs.readFileSync(path.join(REPO, 'core/shared/templates/doflow/design-template.md'), 'utf8');
  assert.ok(!dsgTmpl.includes('### Endpoints'), 'design template must not re-duplicate API Endpoints scaffolding now owned by specs.md');
  assert.ok(!dsgTmpl.includes('### Repository & Service Interfaces'), 'design template must not re-duplicate Repository interfaces scaffolding now owned by specs.md');
  assert.ok(dsgTmpl.includes('specs.md'), 'design template §4 must point at specs.md');
  assert.ok(dsgTmpl.includes('data-model.md'), 'design template §5/§6 must point at data-model.md');
});

