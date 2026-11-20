'use strict';

// Row 174 R-05: an outcome recorded by a retired source (`classify-verdict`) is not an observation of the pick it names, so
// doctor, the report and `advice-picks` count it in no figure. A counted outcome (`caller`, `brief-record`) still counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../src/runtime/storage/roots.ts');
const { appendPick, appendOutcome } = require('../../../src/runtime/advice/record.ts');
const { buildReport } = require('../../../src/runtime/advice/report.ts');
const { advicePicksBody } = require('../../../src/runtime/advice/picks.ts');
const { buildAdviceDoctor } = require('../../../src/runtime/advice/doctor.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');

function fixture(t: any) {
  const home = fs.realpathSync(tempDir(t, 'doflow-retired-home-'));
  const project = fs.realpathSync(tempDir(t, 'doflow-retired-project-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  const answer = { name: 'tier', type: 'choice', pick: 'frontier', probabilities: { standard: 0.2, frontier: 0.8 }, confidence: 0.8, strength: { word: 'clear', between: null } };
  const question = { name: 'tier', type: 'choice', options: { standard: 's', frontier: 'f' } };
  const written = (minutes: number) => appendPick({ roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000),
    kind: 'tier', answer, question, staticAnswer: 'standard', state: 'state text', caller: 'advise' });
  const first = written(0).pickId;
  const second = written(1).pickId;
  // `first` has only a retired outcome (it would match); `second` has a counted one (it matches too).
  appendOutcome({ roots, now: NOW, pickId: first, actual: 'frontier', source: 'classify-verdict', store: 'project-state' });
  appendOutcome({ roots, now: NOW, pickId: second, actual: 'frontier', source: 'caller', store: 'project-state' });
  return { home, project, env, roots, first, second };
}

test('the report counts no retired-source outcome in its agreement', (t) => {
  const { roots } = fixture(t);
  const tier = buildReport({ roots, kinds: ['tier'], now: NOW }).kinds.tier;
  assert.equal(tier.n.picks, 2);
  assert.deepEqual(tier.agreeOutcome, { n: 1, agree: 1 }, 'only the caller outcome counts');
});

test('advice-picks shows no outcome for a pick whose only outcome has a retired source', (t) => {
  const { project, env, first, second } = fixture(t);
  const { exit, json: body } = advicePicksBody({ cwd: project, env, now: NOW, json: true, flags: ['--json'] });
  assert.equal(exit, 0);
  const byId = new Map<string, any>(body.picks.map((p: any) => [p.pickId, p]));
  assert.equal(byId.get(first).outcome, null);
  assert.equal(byId.get(second).outcome.actual, 'frontier');
});

test('doctor counts no retired-source outcome in withOutcome or matched', async (t) => {
  const { project, env, first } = fixture(t);
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: project, env, now: NOW });
  const tier = report.advice.kinds.find((row: any) => row.kind === 'tier');
  assert.equal(tier.picks, 2);
  assert.equal(tier.withOutcome, 1);
  assert.equal(tier.matched, 1);
  assert.deepEqual(tier.outcomeSources, ['caller']);
  assert.ok(first);
});

// Row 174 R-07: a settings file that still holds a removed key gets one visible diagnostic, on every `advise` response and in doctor.

const { spawnSync } = require('node:child_process');
const { createScratch } = require('../../helper/scratch-env.ts');
const REMOVED_SETTING_KEYS: string[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8')).removedSettings;

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');

function removedFixture(t: any) {
  const scratch = createScratch('doflow-advice-removed-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  const userFile = path.join(scratch.xdg, 'doflow', 'settings.json');
  const projectFile = path.join(project, '.doflow', 'settings.json');
  const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  fs.writeFileSync(userFile, JSON.stringify({ ...user, 'advice.kinds.rerank': 'shadow', 'advice.models.rerank': 'm', 'advice.criteria.rerank': 'c' }));
  fs.writeFileSync(projectFile, JSON.stringify({ schema: 1, 'advice.kinds.followup-triage': 'shadow', 'advice.models.followup-triage': 'm' }));
  const run = (args: string[]) => spawnSync(process.execPath, [BIN, 'advise', ...args], { cwd: project, encoding: 'utf8', env: scratch.env() });
  return { scratch, project, userFile, projectFile, run };
}

test('the removed-key list names exactly the five settings row 174 removed', () => {
  assert.deepEqual([...REMOVED_SETTING_KEYS].sort(), ['advice.criteria.rerank', 'advice.kinds.followup-triage', 'advice.kinds.rerank',
    'advice.models.followup-triage', 'advice.models.rerank']);
});

test('advise --json carries a warning per removed key, naming the key and the file, for ask and report', (t) => {
  const f = removedFixture(t);
  for (const args of [['--action', 'report', '--json'], ['--kind', 'tier', '--state', 'a task', '--json']]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.warnings.length, 5, args.join(' '));
    for (const key of REMOVED_SETTING_KEYS) {
      assert.equal(body.warnings.filter((w: string) => w.includes(`holds ${key},`)).length, 1, key);
    }
    assert.ok(body.warnings.some((w: string) => w.includes(f.userFile)) && body.warnings.some((w: string) => w.includes(f.projectFile)));
    assert.match(body.warnings[0], /ignored since the version after 2\.5\.0/);
    assert.equal(result.stderr, '', 'JSON mode writes the diagnostic into the body only');
  }
});

test('advise text output prints the same diagnostics on stderr and leaves stdout as before', (t) => {
  const f = removedFixture(t);
  const result = f.run(['--kind', 'tier', '--state', 'a task']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim().split('\n').length, 5);
  assert.match(result.stderr, /advise: .*settings\.json holds advice\.kinds\.rerank, a removed setting; it is ignored since the version after 2\.5\.0/);
  assert.doesNotMatch(result.stdout, /removed setting/);
});

test('advise with no removed key adds no warnings field and no stderr', (t) => {
  const f = removedFixture(t);
  fs.writeFileSync(f.userFile, JSON.stringify({ schema: 1 }));
  fs.writeFileSync(f.projectFile, JSON.stringify({ schema: 1 }));
  const result = f.run(['--action', 'report', '--json']);
  assert.equal(result.stderr, '');
  assert.equal('warnings' in JSON.parse(result.stdout), false);
});

test('doctor names each removed key in decisionModel.setting.notes and prints it in text', async (t) => {
  const f = removedFixture(t);
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: f.project, env: f.scratch.env() });
  const notes = report.decisionModel.setting.notes;
  for (const key of REMOVED_SETTING_KEYS) assert.equal(notes.filter((n: string) => n.includes(`holds ${key},`)).length, 1, key);
  const { printAdviceDoctor } = require('../../../src/runtime/advice/doctor.ts');
  const lines: string[] = [];
  const saved = console.log;
  console.log = (line: string) => { lines.push(String(line)); };
  try { printAdviceDoctor(report); } finally { console.log = saved; }
  assert.equal(lines.filter((line) => /a removed setting; it is ignored since the version after 2\.5\.0/.test(line)).length, 5);
});
