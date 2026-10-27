'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 115 B.1 (IC-001): the `plan-check` verb through `bin/doflow.js` and the doflow-run
// dispatcher, in a scratch HOME and a scratch working directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

// Row 134: every base principle passes, so a plan's only content findings are the ones a case plants.
const CONSTITUTION = ['## 2. Constitution Check', '', '| Principle | Tier | Result | How |', '|---|---|---|---|',
  ...['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id) => `| ${id} | MUST | PASS | how |`), ''];

function plan(lines: any, { header = '**Task graph:** v1', tasksSection = true }: any = {}) {
  return [
    '# Plan', '',
    ...(header ? [header, ''] : []),
    ...CONSTITUTION,
    ...(tasksSection ? ['## 8. Tasks', '', ...lines] : ['## Overview', 'No task list.']),
    '',
  ].join('\n');
}

const KINDS: any = [
  { name: 'bad-acceptance', text: plan(['- [ ] A.1 Build — acceptance: FR-001..FR-005']), problem: { kind: 'bad-acceptance', ids: ['A.1'], value: 'FR-001..FR-005' }, tasks: 1 },
  { name: 'bad-dependency', text: plan(['- [ ] A.1 Build; depends-on: A.1 (after review)']), problem: { kind: 'bad-dependency', ids: ['A.1'], value: 'A.1 (after review)' }, tasks: 1 },
  { name: 'unknown-dependency', text: plan(['- [ ] A.1 Build; depends-on: B.1']), problem: { kind: 'unknown-dependency', ids: ['A.1', 'B.1'] }, tasks: 1 },
  { name: 'duplicate-id', text: plan(['- [ ] A.1 Build', '### Completion Criteria', '- [ ] A.1 Build completion criteria']), problem: { kind: 'duplicate-id', ids: ['A.1'] }, tasks: 2 },
  { name: 'bad-budget', text: plan(['- [ ] A.1 Build — budget: attempts=0']), problem: { kind: 'bad-budget', ids: ['A.1'], value: 'attempts=0' }, tasks: 1 },
  { name: 'bad-header', text: plan(['- [ ] A.1 Build'], { header: '**Task graph:** v2' }), problem: { kind: 'bad-header', ids: [], value: 'v2' }, tasks: 1 },
  { name: 'cycle', text: plan(['- [ ] A.1 First; depends-on: A.2', '- [ ] A.2 Second; depends-on: A.1']), problem: { kind: 'cycle', ids: ['A.1', 'A.2'], via: ['A.1->A.2', 'A.2->A.1'] }, tasks: 2 },
  { name: 'no-tasks', text: plan([]), problem: { kind: 'no-tasks', ids: [] }, tasks: 0 },
];

const CLEAN = plan(['- [ ] A.1 First', '- [ ] A.2 Second']);

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-plan-check-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    FORCE_COLOR: '', DOFLOW_CLI: CLI,
  };
  const write = (name: any, text: any) => { fs.writeFileSync(path.join(cwd, name), text); return name; };
  const cli = (args: any) => spawnSync(process.execPath, [CLI, 'plan-check', ...args], { cwd, env, encoding: 'utf8' });
  const dispatcher = (args: any) => spawnSync(bashPath(), [RUN, 'plan-check', ...args], { cwd, env, encoding: 'utf8' });
  return { cwd, home, write, cli, dispatcher };
}

test('a clean plan exits 0 with the one-line text and the verdict JSON', (t) => {
  const s = scratch(t);
  s.write('plan.md', CLEAN);
  const text = s.cli(['plan.md']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, 'plan-check: plan.md: ok, 2 tasks\n');
  const json = s.cli(['plan.md', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, tasks: 2, problems: [], warnings: [], findings: [], file: 'plan.md' });
});

for (const kind of KINDS) {
  test(`plan-check exits 1 with the IC-002 JSON for ${kind.name}`, (t) => {
    const s = scratch(t);
    s.write('plan.md', kind.text);
    const json = s.cli(['plan.md', '--json']);
    assert.equal(json.status, 1, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.tasks, kind.tasks);
    assert.deepEqual(body.problems, [kind.problem]);
    assert.equal(body.file, 'plan.md');
    const text = s.cli(['plan.md']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, new RegExp(`^plan-check: plan\\.md: 1 problem\\(s\\): ${kind.name}`));
  });
}

test('the text line lists each problem and is capped at 200 characters', (t) => {
  const s = scratch(t);
  const lines: any = [];
  for (let i = 1; i <= 30; i += 1) lines.push(`- [ ] A.${i} Build; depends-on: Z.${i}`);
  s.write('plan.md', plan(lines));
  const text = s.cli(['plan.md']);
  assert.equal(text.status, 1);
  const line = text.stdout.replace(/\n$/, '');
  assert.equal(text.stdout.split('\n').length, 2, 'one line plus the trailing newline');
  assert.ok(line.length <= 200, `${line.length} characters`);
  assert.ok(line.endsWith('...'));
  assert.match(line, /^plan-check: plan\.md: 30 problem\(s\): unknown-dependency A\.1,Z\.1; /);
});

test('plan-check exits 2 for a missing path, an extra positional, an unknown flag and an unreadable file', (t) => {
  const s = scratch(t);
  s.write('plan.md', CLEAN);
  for (const args of [[], ['plan.md', 'other.md'], ['plan.md', '--bogus'], ['missing.md'], ['.']]) {
    const text = s.cli(args);
    assert.equal(text.status, 2, JSON.stringify(args));
    assert.equal(text.stdout, '', JSON.stringify(args));
    assert.match(text.stderr, /plan-check/, JSON.stringify(args));
    const json = s.cli([...args, '--json']);
    assert.equal(json.status, 2, JSON.stringify(args));
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.ok(['usage', 'plan-unreadable'].includes(body.error), body.error);
    assert.equal(typeof body.message, 'string');
  }
  assert.equal(JSON.parse(s.cli(['missing.md', '--json']).stdout).error, 'plan-unreadable');
  assert.equal(JSON.parse(s.cli(['--json']).stdout).error, 'usage');
});

test('plan-check resolves the path against the working directory and an absolute path works', (t) => {
  const s = scratch(t);
  fs.mkdirSync(path.join(s.cwd, 'sub'));
  fs.writeFileSync(path.join(s.cwd, 'sub', 'plan.md'), CLEAN);
  assert.equal(s.cli(['sub/plan.md']).status, 0);
  const abs = s.cli([path.join(s.cwd, 'sub', 'plan.md'), '--json']);
  assert.equal(JSON.parse(abs.stdout).file, path.join(s.cwd, 'sub', 'plan.md'));
});

test('plan-check writes nothing to the working directory or the home', (t) => {
  const s = scratch(t);
  s.write('plan.md', KINDS[0].text);
  const listing = (dir: any) => fs.readdirSync(dir, { recursive: true }).sort();
  const cwdBefore = listing(s.cwd);
  const homeBefore = listing(s.home);
  for (const args of [['plan.md'], ['plan.md', '--json'], ['missing.md'], []]) s.cli(args);
  assert.deepEqual(listing(s.cwd), cwdBefore);
  assert.deepEqual(listing(s.home), homeBefore);
  assert.equal(fs.existsSync(path.join(s.cwd, '.doflow')), false);
});

test('the doflow-run dispatcher reaches plan-check and keeps its exit code', (t) => {
  const s = scratch(t);
  s.write('plan.md', CLEAN);
  s.write('bad.md', KINDS[0].text);
  const ok = s.dispatcher(['plan.md', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  assert.equal(s.dispatcher(['bad.md']).status, 1);
  assert.equal(s.dispatcher([]).status, 2);
});

test('plan-check p.md --scope x exits 2 with usage', (t) => {
  const s = scratch(t);
  s.write('plan.md', CLEAN);
  const text = s.cli(['plan.md', '--scope', 'x']);
  assert.equal(text.status, 2, text.stderr);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /unknown flag '--scope'/);
  assert.match(text.stderr, /usage: plan-check <plan path> \[--json\]/);
  const json = s.cli(['plan.md', '--scope', 'x', '--json']);
  assert.equal(json.status, 2, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: false,
    error: 'usage',
    message: "unknown flag '--scope'; usage: plan-check <plan path> [--json]",
  });
});

test('plan-check p.md --json alone exits 0 as before', (t) => {
  const s = scratch(t);
  s.write('plan.md', CLEAN);
  const json = s.cli(['plan.md', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, tasks: 2, problems: [], warnings: [], findings: [], file: 'plan.md' });
});
