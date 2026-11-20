'use strict';

// Row 134 item 4 (user decision 2026-10-27): a constitution MUST conflict refuses the planning
// stage's exit. A MUST row marked FAIL, or a MUST principle with no row, refuses; a SHOULD FAIL is
// an advisory line; a repo with no tier-2 overlay still checks the base tier. No waiver, no prompt.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadConstitution, constitutionFindings, parsePrinciples, planStageExit, constitutionBaseFile } = require('../../src/runtime/plan-content.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const BASE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

function planWith(rows: string[]) {
  return [
    '# Plan', '',
    '**Task graph:** v1', '',
    '## 2. Constitution Check (GATE)', '',
    '| Principle | Tier | Result | How |',
    '|---|---|---|---|',
    ...rows, '',
    '## 8. Tasks', '',
    '- [ ] A.1 Build', '',
  ].join('\n');
}
const row = (id: string, result = 'PASS', tier = 'MUST') => `| ${id} | ${tier} | ${result} | how |`;
const OVERLAY = [
  '# Repo Constitution', '',
  '## Principles', '',
  '### R1 — Docs first', '**Tier:** SHOULD', 'Write the doc before the code.', '',
  '### R2 — Typed boundaries', 'Every exported function is typed.', '',
  '## Governance', '- amend with /do-constitution', '',
].join('\n');

function checkout(t: any, overlay: string | null = null) {
  const root = tempDir(t, 'doflow-plan-exit-');
  if (overlay !== null) {
    fs.mkdirSync(path.join(root, 'agent-docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agent-docs', 'constitution.md'), overlay);
  }
  return root;
}

test('the base tier: every base principle is MUST, and the base is read with no overlay present', (t) => {
  const loaded = loadConstitution({ checkoutRoot: checkout(t) });
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.principles.map((p: any) => [p.id, p.tier]), BASE_IDS.map((id) => [id, 'MUST']));
});

test('a MUST row marked FAIL refuses exit, at the row line, naming the principle and the unblock', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t) });
  const plan = planWith(BASE_IDS.map((id) => row(id, id === 'P3' ? 'FAIL' : 'PASS')));
  const findings = constitutionFindings({ planText: plan, planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.line, f.id]), [['constitution-must-fail', 'refuses-exit', 11, 'P3']]);
  assert.match(findings[0].message, /P3 .*MUST.*FAIL/);
  assert.match(findings[0].message, /revise the plan/);
  assert.match(findings[0].message, /\/do-constitution/);
});

test('a MUST principle with no row refuses exit, located at the Constitution Check heading', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t) });
  const plan = planWith(BASE_IDS.filter((id) => id !== 'P4').map((id) => row(id)));
  const findings = constitutionFindings({ planText: plan, planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.line, f.id]), [['constitution-must-missing', 'refuses-exit', 5, 'P4']]);
});

test('a plan with no Constitution Check section refuses every MUST principle', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t) });
  const findings = constitutionFindings({ planText: '# Plan\n\n## 8. Tasks\n\n- [ ] A.1 Build\n', planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.line, f.id]), BASE_IDS.map((id) => ['constitution-must-missing', 1, id]));
});

test('a SHOULD row marked FAIL is advisory only; an untiered overlay principle is MUST', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t, OVERLAY) });
  assert.deepEqual(principles.filter((p: any) => p.id.startsWith('R')).map((p: any) => [p.id, p.tier]), [['R1', 'SHOULD'], ['R2', 'MUST']]);
  const plan = planWith([...BASE_IDS.map((id) => row(id)), row('R1', 'FAIL', 'SHOULD'), row('R2')]);
  const findings = constitutionFindings({ planText: plan, planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.id]), [['constitution-should-fail', 'advisory', 'R1']]);
});

test('a tier-2 principle with a base id replaces it, tier included; the plan cannot downgrade a MUST', (t) => {
  const overlay = '# C\n\n## Principles\n\n### P5 — Parallel when it helps\n**Tier:** SHOULD\nbody\n';
  const { principles } = loadConstitution({ checkoutRoot: checkout(t, overlay) });
  assert.equal(principles.find((p: any) => p.id === 'P5').tier, 'SHOULD');
  assert.equal(principles.filter((p: any) => p.id === 'P5').length, 1);
  const plan = planWith(BASE_IDS.map((id) => row(id, id === 'P5' || id === 'P2' ? 'FAIL' : 'PASS', 'SHOULD')));
  const findings = constitutionFindings({ planText: plan, planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.id]), [['constitution-must-fail', 'P2'], ['constitution-should-fail', 'P5']]);
});

test('parsePrinciples ignores headings outside the Principles section and inside fences', () => {
  const text = '## Principles\n\n### A1 — One\n```\n### Z9 — fenced\n```\n## Governance\n\n### G1 — not a principle\n';
  assert.deepEqual(parsePrinciples(text, 'x.md').map((p: any) => p.id), ['A1']);
});

// ── the planning stage exit, through the CLI ─────────────────────────────────────────────────────

const SLUG = '900-gate';
function repo(t: any, planText: string, overlay: string | null = null) {
  const root = tempDir(t, 'doflow-plan-exit-cli-');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(work, 'agent-docs', 'doflow', SLUG), { recursive: true });
  const env: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, FORCE_COLOR: '', DOFLOW_CLI: CLI,
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  git('checkout', '-q', '-b', `feat/${SLUG}`);
  fs.writeFileSync(path.join(work, 'agent-docs', 'doflow', SLUG, 'requirement.md'), '# Requirement\n\nNo open questions.\n');
  fs.writeFileSync(path.join(work, 'agent-docs', 'doflow', SLUG, 'design.md'), '# Design\n');
  fs.writeFileSync(path.join(work, 'agent-docs', 'doflow', SLUG, 'plan.md'), planText);
  if (overlay !== null) fs.writeFileSync(path.join(work, 'agent-docs', 'constitution.md'), overlay);
  const doflow = (args: string[]) => spawnSync(process.execPath, [CLI, 'orchestrate', ...args, '--json'], { cwd: work, env, encoding: 'utf8', input: '' });
  // Walk the run to the planning stage the way the chain e2e tests do: catch-up imports the earlier
  // stages, and gate-0 is approved on the way.
  const catchUp = () => doflow(['--action', 'catch-up', '--task-id', SLUG, '--task-class', 'feature', '--stage', 'planning']);
  let snapshot = JSON.parse(catchUp().stdout);
  for (let step = 0; step < 4 && !(snapshot.current && snapshot.current.id === 'planning'); step += 1) {
    assert.ok(snapshot.awaitingGate, JSON.stringify(snapshot));
    assert.equal(doflow(['--action', 'decide-gate', '--task-id', SLUG, '--gate', snapshot.awaitingGate.gateId, '--decision', 'approve', '--note', 'test']).status, 0);
    snapshot = JSON.parse(catchUp().stdout);
  }
  assert.equal(snapshot.current.id, 'planning');
  const handoff = () => doflow(['--action', 'handoff', '--task-id', SLUG, '--task-class', 'feature', '--calling-skill', 'do-plan', '--note', 'plan written']);
  // Catch-up naming a later stage backfills planning on the way (gate-a stops it after that).
  const backfill = () => doflow(['--action', 'catch-up', '--task-id', SLUG, '--task-class', 'feature', '--stage', 'implementation']);
  const journal = () => JSON.parse(fs.readFileSync(path.join(work, '.doflow', 'state', 'orchestration', `${SLUG}.json`), 'utf8'));
  return { work, handoff, backfill, journal };
}

test('handoff of the planning stage is refused for a MUST FAIL, with no prompt and nothing recorded', (t) => {
  const r = repo(t, planWith(BASE_IDS.map((id) => row(id, id === 'P1' ? 'FAIL' : 'PASS'))));
  const res = r.handoff();
  assert.notEqual(res.status, 0, res.stdout);
  const said = res.stdout + res.stderr;
  assert.match(said, /planning/);
  assert.match(said, /P1 \(MUST\) is marked FAIL/);
  assert.match(said, /\/do-constitution/);
  assert.match(said, /no waiver/);
  const journal = path.join(r.work, '.doflow', 'state', 'orchestration', `${SLUG}.json`);
  if (fs.existsSync(journal)) {
    const run = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.notEqual(run.program.find((n: any) => n.id === 'planning').status, 'completed');
  }
});

test('handoff of the planning stage is refused for a missing MUST row', (t) => {
  const r = repo(t, planWith(BASE_IDS.filter((id) => id !== 'P6').map((id) => row(id))));
  const res = r.handoff();
  assert.notEqual(res.status, 0, res.stdout);
  assert.match(res.stdout + res.stderr, /P6 \(MUST\) has no PASS\/FAIL row/);
});

test('handoff completes with every MUST passing; a SHOULD FAIL prints one advisory line', (t) => {
  const r = repo(t, planWith([...BASE_IDS.map((id) => row(id)), row('R1', 'FAIL', 'SHOULD'), row('R2')]), OVERLAY);
  const res = r.handoff();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).disposition, 'completed', res.stdout);
  const advisories = res.stderr.split('\n').filter((line: string) => /R1 \(SHOULD\) is marked FAIL/.test(line));
  assert.equal(advisories.length, 1, res.stderr);
  assert.match(advisories[0], /advisory/);
});

test('catch-up backfilling the planning stage is refused for a MUST FAIL and leaves the stage open', (t) => {
  const r = repo(t, planWith(BASE_IDS.map((id) => row(id, id === 'P2' ? 'FAIL' : 'PASS'))));
  const res = r.backfill();
  assert.notEqual(res.status, 0, res.stdout);
  assert.match(res.stdout + res.stderr, /Stage 'planning' cannot be completed: .*P2 \(MUST\) is marked FAIL/);
  const planning = r.journal().program.find((n: any) => n.id === 'planning');
  assert.notEqual(planning.status, 'completed');
});

test('catch-up backfills a planning stage whose MUST principles all pass, as before', (t) => {
  const r = repo(t, planWith(BASE_IDS.map((id) => row(id))));
  const res = r.backfill();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const planning = r.journal().program.find((n: any) => n.id === 'planning');
  assert.deepEqual([planning.status, planning.executionStatus], ['completed', 'imported']);
});

// ── Sol review of a0234b53 (row 134): the record and the overlay fail closed ─────────────────────

const PASSING = BASE_IDS.map((id) => row(id));
test('a Constitution Check inside an HTML comment or a fence does not count', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t) });
  const visible = planWith(PASSING);
  for (const [open, close] of [['<!--', '-->'], ['```md', '```']]) {
    const hidden = visible.replace('## 2. Constitution Check (GATE)', `${open}\n## 2. Constitution Check (GATE)`).replace('## 8. Tasks', `${close}\n\n## 8. Tasks`);
    const findings = constitutionFindings({ planText: hidden, planPath: 'plan.md', principles });
    assert.deepEqual(findings.map((f: any) => f.rule), BASE_IDS.map(() => 'constitution-must-missing'), open);
  }
});

test('a Constitution Check table without its separator row is no parseable record, and refuses', (t) => {
  const { principles } = loadConstitution({ checkoutRoot: checkout(t) });
  const plan = planWith(PASSING).replace('|---|---|---|---|\n', '');
  const findings = constitutionFindings({ planText: plan, planPath: 'plan.md', principles });
  assert.deepEqual(findings.map((f: any) => [f.rule, f.severity, f.line]), [['constitution-unparseable', 'refuses-exit', 7]]);
  assert.match(findings[0].message, /no parseable Constitution Check/);
});

test('an overlay with no Principles section is refused, naming the overlay file', (t) => {
  const loaded = loadConstitution({ checkoutRoot: checkout(t, OVERLAY.replace('## Principles', '## Repository principles')) });
  assert.match(loaded.error || '', /agent-docs\/constitution\.md/);
  assert.match(loaded.error || '', /Principles/);
});

test('a duplicate principle id in the overlay is an error naming both lines', (t) => {
  const overlay = '# C\n\n## Principles\n\n### R1 — One\nbody\n\n### R1 — Again\n**Tier:** SHOULD\n';
  const loaded = loadConstitution({ checkoutRoot: checkout(t, overlay) });
  assert.match(loaded.error || '', /agent-docs\/constitution\.md declares R1 twice \(lines 5 and 8\)/);
});

test('an overlay downgrading a base MUST is allowed, and never silent: one advisory names the principle, the file and its version', (t) => {
  const root = checkout(t, '# C\n\n**Version:** 1.4.0\n\n## Principles\n\n### P5 — Parallel when it helps\n**Tier:** SHOULD\nbody\n');
  const loaded = loadConstitution({ checkoutRoot: root });
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.downgrades.map((d: any) => [d.id, d.source, d.line, d.version]), [['P5', 'agent-docs/constitution.md', 7, '1.4.0']]);
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', 'f'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', 'f', 'plan.md'), planWith(BASE_IDS.map((id) => row(id, 'PASS', id === 'P5' ? 'SHOULD' : 'MUST'))));
  const exit = planStageExit({ roots: [root], slug: 'f' });
  assert.deepEqual(exit.refusals, []);
  assert.deepEqual(exit.advisories.map((f: any) => [f.rule, f.path, f.line]), [['constitution-downgrade', 'agent-docs/constitution.md', 7]]);
  assert.match(exit.advisories[0].message, /P5 is MUST in the base constitution and SHOULD in agent-docs\/constitution\.md 1\.4\.0/);
});

test('the base constitution is found beside an installed runtime, and a miss names every path searched', (t) => {
  // The install layout: <config>/runtime holds bin/, src/ and core/registry/; the guidance tree is
  // its sibling <config>/guidance (src/helper/bash-helper.ts resolves the bash helpers the same way).
  const config = tempDir(t, 'doflow-installed-');
  const runtime = path.join(config, 'runtime');
  fs.mkdirSync(path.join(config, 'guidance', 'references'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'core', 'shared', 'guidance', 'references', 'CONSTITUTION_BASE.md'), path.join(config, 'guidance', 'references', 'CONSTITUTION_BASE.md'));
  assert.equal(constitutionBaseFile(runtime), path.join(config, 'guidance', 'references', 'CONSTITUTION_BASE.md'));
  const bare = path.join(tempDir(t, 'doflow-bare-'), 'runtime');
  const loaded = loadConstitution({ checkoutRoot: checkout(t), runtimeRoot: bare });
  assert.match(loaded.error || '', new RegExp(`${path.join(bare, 'core').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${path.join(path.dirname(bare), 'guidance').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('handoff with an overlay that downgrades a base MUST completes and prints one note naming it, the overlay and its version', (t) => {
  const overlay = '# C\n\n**Version:** 1.4.0\n\n## Principles\n\n### P5 — Parallel when it helps\n**Tier:** SHOULD\nbody\n';
  const r = repo(t, planWith(BASE_IDS.map((id) => row(id, id === 'P5' ? 'FAIL' : 'PASS', id === 'P5' ? 'SHOULD' : 'MUST'))), overlay);
  const res = r.handoff();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const notes = res.stderr.split('\n').filter((line: string) => /^orchestrate: note: agent-docs\/constitution\.md:7 P5 is MUST in the base constitution and SHOULD in agent-docs\/constitution\.md 1\.4\.0/.test(line));
  assert.equal(notes.length, 1, res.stderr);
});
