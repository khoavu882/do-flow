'use strict';

// design.md is journey-first: Components & Boundaries moved from section 3 to section 5. Every reader
// of that section locates it by TITLE, so a design written under the earlier nine-section layout (and
// there are many on disk) must keep parsing next to the new one. These cases pin both layouts through
// the two readers that once found the section by its number: the scaffold parser and the task-brief
// generator.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { parseDesign } = require('../../src/runtime/scaffold/artifacts.ts');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'core', 'shared', 'scripts', 'doflow');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'core', 'shared', 'templates', 'doflow', 'design-template.md'), 'utf8');
const OLD_FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scaffold', '005-evidence-ledger-readiness', 'design.md'), 'utf8');

const scratch = createScratch('doflow-design-layouts-');
after(() => scratch.remove());

test('the shipped template parses: its component row and interface section are found by title', () => {
  const parsed = parseDesign(TEMPLATE);
  assert.deepEqual(parsed.components.get('C1').serves, ['FR-001']);
  assert.deepEqual(parsed.gaps, []);
});

test('a design in the earlier nine-section layout still parses', () => {
  const parsed = parseDesign(OLD_FIXTURE);
  assert.ok(parsed.components.size > 0, 'the frozen old-layout fixture must still yield its component index');
  assert.ok(!parsed.gaps.some((gap: any) => gap.what === 'interface contracts'), JSON.stringify(parsed.gaps));
  const inline = '## 3. Components & Boundaries\n| ID | Component | Kind | Serves | Status |\n|---|---|---|---|---|\n| C1 | a | service | FR-002 | Live |\n## 4. API / Interface Contracts\n';
  assert.deepEqual(parseDesign(inline).components.get('C1').serves, ['FR-002']);
});

// ── do-task-brief.sh finds Components & Boundaries under either numbering ──────────────────────────

const PLAN = '## 1. Approach\nBottom-up.\n## 7. Validation Strategy\n| Requirement | Verified by |\n|---|---|\n| FR-001 | a test |\n## 8. Tasks\n### Phase A — auth\n- [ ] A.1 [US1] build the handler — owner: core-implementer; files: src/auth.js\n';
const REQUIREMENT = '## 2. User Stories\n- **US1 (P1):** As a user, I want to log in.\n## 3. Functional Requirements\n| ID | Requirement | Story | Priority | Status |\n|---|---|---|---|---|\n| FR-001 | login endpoint | US1 | P1 | Live |\n**Detail**\n- **FR-001:** The system MUST accept a POST.\n## 4. Non-Functional Requirements\n## 5. Out of Scope\n';
const components = (n: number, title = 'Components & Boundaries') => `## ${n}. ${title}\n| ID | Component | Kind | Serves | Status |\n|---|---|---|---|---|\n| CMP1 | auth handler | service | FR-001 | Live |\n**Detail**\n- **CMP1** → owns credential verification.\n## ${n + 1}. API / Interface Contracts\n`;
const NEW_DESIGN = '## 1. Architecture Approach\n## 2. System Overview (C4)\n## 3. Concepts\n| ID | Component | Kind | Serves | Status |\n|---|---|---|---|---|\n| C9 | decoy | term | FR-001 | Live |\n**Detail**\n- **C9** → decoy row outside Components\n## 4. Journeys\n' + components(5);
const OLD = '## 1. Architecture Approach\n## 2. System Overview (C4)\n';
const OLD_DESIGN = OLD + components(3);
// Earlier designs titled the section differently; the title only has to start with "Component".
const OLD_MAP = OLD + components(3, 'Component map');
const OLD_CONTRACTS = OLD + components(3, 'Component Contracts & Data Flow');

let counter = 0;
function briefFor(design: string) {
  const dir = path.join(scratch.dir, `case-${counter++}`);
  const bash = path.join(dir, 'tree', 'doflow', 'bash');
  const bin = path.join(dir, 'tree', 'doflow', 'bin');
  const project = path.join(dir, 'project');
  fs.mkdirSync(bash, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  for (const helper of ['do-paths.sh', 'do-exec-paths.sh', 'do-task-brief.sh']) fs.copyFileSync(path.join(SCRIPTS, 'bash', helper), path.join(bash, helper));
  fs.mkdirSync(path.join(dir, 'tree', 'core', 'registry'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'core', 'registry', 'rules.json'), path.join(dir, 'tree', 'core', 'registry', 'rules.json'));
  fs.writeFileSync(path.join(bin, 'doflow-run'), '#!/usr/bin/env bash\necho "fake dispatcher" >&2\nexit 3\n', { mode: 0o755 });
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: project, encoding: 'utf8', env: scratch.env() });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feat/001-auth');
  const featureDir = path.join(project, 'agent-docs', 'doflow', '001-auth');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN);
  fs.writeFileSync(path.join(featureDir, 'requirement.md'), REQUIREMENT);
  fs.writeFileSync(path.join(featureDir, 'design.md'), design);
  const res = spawnSync(bashPath(), [path.join(bash, 'do-task-brief.sh'), '--task=A.1', '--slug=001-auth'], { cwd: project, encoding: 'utf8', timeout: 120000, env: scratch.env() });
  assert.equal(res.status, 0, res.stderr);
  return fs.readFileSync(path.join(featureDir, 'exec', 'task-A.1-brief.md'), 'utf8');
}

test('do-task-brief.sh composes the component boundary from the section titled Components, numbered 5 or 3', () => {
  for (const [label, design] of [['new layout (section 5)', NEW_DESIGN], ['old layout (section 3)', OLD_DESIGN], ['old title "Component map"', OLD_MAP], ['old title "Component Contracts & Data Flow"', OLD_CONTRACTS]]) {
    const md = briefFor(design);
    assert.match(md, /^## Component boundary$/m, label);
    assert.match(md, /CMP1\*\* → owns credential verification\./, label);
    assert.doesNotMatch(md, /decoy row/, label);
  }
});
