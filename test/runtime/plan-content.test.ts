'use strict';

// Row 134 item 2: plan-check's content findings — requirement-id coverage and the placeholder
// scan — each with a path:line locator, beside the unchanged task-graph verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { placeholderFindings, coverageFindings } = require('../../src/runtime/plan-content.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');

const REQUIREMENT = [
  '# Requirement', '',
  '## 2. User Stories', '',
  '- **US1 (P1):** As a user, I want A.',
  '- **US2 (P2):** As a user, I want B.', '',
  '## 3. Functional Requirements', '',
  '| ID | Summary | Story | Priority | Status |',
  '|---|---|---|---|---|',
  '| FR-001 | A | US1 | P1 | Live |',
  '| FR-002 | B | US2 | P2 | Superseded → FR-003 |',
  '| FR-003 | B again | US2 | P2 | Live |', '',
  '## 9. History', '',
  '- **US9 (P3):** an old story, superseded.', '',
].join('\n');

const PLAN = (tasks: string[]) => ['# Plan', '', '**Task graph:** v1', '', '## 8. Tasks', '', ...tasks, ''].join('\n');

test('coverage: a requirement story id the plan never names is a finding at its requirement line', () => {
  const plan = PLAN(['- [ ] A.1 [US1] Build A — acceptance: FR-001, FR-003']);
  const findings = coverageFindings(plan, 'plan.md', REQUIREMENT, 'requirement.md');
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.path, f.line, f.id]), [
    ['coverage', 'fix', 'requirement.md', 6, 'US2'],
  ]);
  assert.match(findings[0].message, /US2 .*not traced/);
});

test('coverage: a superseded row and an id under History are not required', () => {
  const plan = PLAN(['- [ ] A.1 [US1] [US2] Build — acceptance: FR-001, FR-003']);
  assert.deepEqual(coverageFindings(plan, 'plan.md', REQUIREMENT, 'requirement.md'), []);
});

test('placeholder: TBD, TODO and a deferred "later" line are findings at their plan line; code and comments are not', () => {
  const plan = [
    '# Plan', '',
    '## 1. Approach', '',
    'The storage engine is TBD.',
    'We scan for `TBD` markers in code spans, which is fine.',
    '<!-- TODO in a comment is template guidance -->',
    '```', 'TODO inside a fence', '```',
    'Error handling: fill in later.',
    'The index is added in Phase B, later than A.', '',
  ].join('\n');
  const findings = placeholderFindings(plan, 'plan.md');
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.path, f.line]), [
    ['placeholder', 'fix', 'plan.md', 5],
    ['placeholder', 'fix', 'plan.md', 11],
  ]);
});

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-plan-content-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, FORCE_COLOR: '', DOFLOW_CLI: CLI,
  };
  const cli = (args: any) => spawnSync(process.execPath, [CLI, 'plan-check', ...args], { cwd, env, encoding: 'utf8' });
  return { cwd, cli };
}

test('plan-check reports a missing story id and a TBD as findings with path:line; the task-graph exit is unchanged', (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.cwd, 'requirement.md'), REQUIREMENT);
  fs.writeFileSync(path.join(s.cwd, 'plan.md'), PLAN(['- [ ] A.1 [US1] Build A, owner TBD — acceptance: FR-001, FR-003']));
  const json = s.cli(['plan.md', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.problems, []);
  const mine = body.findings.filter((f: any) => f.rule === 'coverage' || f.rule === 'placeholder');
  assert.deepEqual(mine.map((f: any) => `${f.rule} ${f.path}:${f.line}`), ['placeholder plan.md:7', 'coverage requirement.md:6']);
  const text = s.cli(['plan.md']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /findings: placeholder plan\.md:7, coverage requirement\.md:6/);
});

test('plan-check reads requirement.md from intention/ under the structured layout', (t) => {
  const s = scratch(t);
  fs.mkdirSync(path.join(s.cwd, 'intention'));
  fs.writeFileSync(path.join(s.cwd, 'intention', 'requirement.md'), REQUIREMENT);
  fs.writeFileSync(path.join(s.cwd, 'plan.md'), PLAN(['- [ ] A.1 [US1] Build — acceptance: FR-001, FR-003']));
  const body = JSON.parse(s.cli(['plan.md', '--json']).stdout);
  assert.deepEqual(body.findings.filter((f: any) => f.rule === 'coverage').map((f: any) => `${f.path}:${f.line} ${f.id}`),
    [`${path.join('intention', 'requirement.md')}:6 US2`]);
});

// ── Sol review of a0234b53 (row 134): visible Markdown only, fences, "later" ───────────────────────

test('placeholder: a fence closes only on the same character and a run at least as long as its opener', () => {
  const plan = ['````md', '```', 'TODO in code', '```', '````', 'After the fence: TBD.', ''].join('\n');
  assert.deepEqual(placeholderFindings(plan, 'plan.md').map((f: any) => f.line), [6]);
  const tilde = ['~~~', '```', 'TODO inside a tilde fence', '~~~', ''].join('\n');
  assert.deepEqual(placeholderFindings(tilde, 'plan.md'), []);
});

test('placeholder: "later" counts only in a placeholder phrasing, not in prose', () => {
  const plan = [
    'Users can add filters later without changing the schema.',
    '- [ ] A.1 Define later phases in the scheduler.',
    'Error handling: fill in later.',
    '| Owner | later |',
    'The ownership is to be decided.',
  ].join('\n');
  assert.deepEqual(placeholderFindings(plan, 'plan.md').map((f: any) => f.line), [3, 4, 5]);
});

test('coverage: an id named only inside an HTML comment or a fence is not traced', () => {
  const plan = ['# Plan', '<!-- US1 -->', '```', 'US2', '```', '- [ ] A.1 Build — FR-001, FR-003', ''].join('\n');
  assert.deepEqual(coverageFindings(plan, 'plan.md', REQUIREMENT, 'requirement.md').map((f: any) => f.id), ['US1', 'US2']);
});
