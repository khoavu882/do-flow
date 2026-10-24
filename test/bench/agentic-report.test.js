'use strict';

/**
 * Feature 097 review fixes on the band and the report (C-8, C-10, C-12, N-5): iterations are built by
 * hand (iteration.json, launch.json, transcript.jsonl, last-message.txt, run_status.json, timing.json,
 * grading.json from gradeIteration), so no executor, harness or network is involved. The git cases
 * build a tiny repository and pass it as repoRoot.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { gradeIteration, loadPathInfo } = require('../../bench/agentic/grade.ts');
const { loadTaskSet, buildPrompt, promptSha256, UsageError } = require('../../bench/agentic/tasks.ts');
const report = require('../../bench/agentic/report.ts');
const { loadNoiseConfig } = require('../../bench/noise.ts');
const { tempDir } = require('../helper/tmp.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'agentic', 'runs');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'agentic', 'config.json'), 'utf8'));
const noiseConfig = loadNoiseConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'config.json'), 'utf8')));
const pathInfo = loadPathInfo();
const DC011 = loadTaskSet().tasks.find((t) => t.id === 'DC-011');
const taskSet = { tasks: [DC011] };

const FULL = '{"files":["test/helper/tmp.js"]}';
const NONE = 'I could not find a single answer.';
const SHA_A = 'a'.repeat(40);
const CAPTURE = 'c'.repeat(64);
const N_NAMES = ['n-r1', 'n-r2', 'n-r3'];

/** One graded iteration of `arm` under `runRoot`; `meta` overrides iteration.json fields. */
function makeIteration(runRoot, name, { arm, answer = FULL, meta = {} }) {
  const dir = path.join(runRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'iteration.json'), JSON.stringify({
    arm, model: config.model.label, sourceAt: SHA_A, snapshot: 'snap', harness: 'h', harnessVersion: '1.0.0', startedAt: 't', captureSha256: CAPTURE, ...meta,
  }));
  for (const task of taskSet.tasks) {
    const runDir = path.join(dir, task.id);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'launch.json'), JSON.stringify({
      key: task.key, arm, promptSha256: promptSha256(buildPrompt(task, config.arms[arm].paragraph)), workspaceRoot: '/ws', profileRoot: '/profile',
    }));
    fs.copyFileSync(path.join(FIXTURES, 'full-answer', 'transcript.jsonl'), path.join(runDir, 'transcript.jsonl'));
    fs.writeFileSync(path.join(runDir, 'last-message.txt'), answer);
    fs.writeFileSync(path.join(runDir, 'run_status.json'), JSON.stringify({ status: 'completed', exitCode: 0, signal: null }));
    fs.writeFileSync(path.join(runDir, 'timing.json'), JSON.stringify({ total_tokens: 1000, duration_ms: 1, usage: 'reported' }));
  }
  gradeIteration({ iterationDir: dir, taskSet, config, pathInfo });
  return dir;
}

/** A run root holding the three arm N band iterations, with the band artifact written to `noisePath`. */
function withBand(t, nMeta = {}) {
  const runRoot = tempDir(t, 'doflow-agentic-report-');
  for (const name of N_NAMES) makeIteration(runRoot, name, { arm: 'N', meta: nMeta });
  const { artifact } = report.noiseOf({ runRoot, iterations: N_NAMES.join(','), taskSet, config, noiseConfig, pathInfo });
  const noisePath = path.join(runRoot, 'noise.json');
  fs.writeFileSync(noisePath, JSON.stringify(artifact));
  return { runRoot, noisePath };
}

const reportOf = (over) => report.reportOf({ taskSet, config, noiseConfig, pathInfo, explicitNoise: true, iterations: 'd-r1', ...over });
const refused = (reason, ...words) => (e) => e instanceof UsageError && e.reason === reason && words.every((w) => e.message.includes(w));

// ---------------------------------------------------------------------------
// C-10: report regrades arm D

test('C-10: report scores arm D from a fresh grading and reports a stale stored grading.json', (t) => {
  const { runRoot, noisePath } = withBand(t);
  const d = makeIteration(runRoot, 'd-r1', { arm: 'D', answer: NONE });
  const file = path.join(d, 'DC-011', 'grading.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.pass_rate, 0);
  fs.writeFileSync(file, `${JSON.stringify({ ...stored, pass_rate: 1, metrics: { fileRecallAt10: 1 } }, null, 2)}\n`);

  const result = reportOf({ runRoot, noisePath, repoRoot: runRoot });
  const [pair] = result.decision.corpus.cases;
  assert.equal(pair.key, DC011.key);
  assert.equal(pair.candidate, 0, 'the fresh grading (0) is the score, not the edited stored 1');
  assert.equal(pair.baseline, 1);
  assert.deepEqual(result.graderRerun, { runs: 1, differing: [], stale: ['d-r1/DC-011'] });
  const lines = report.reportLines(result);
  assert.ok(lines.some((l) => /^warning: grader re-run/.test(l) && l.includes('1 stale') && l.includes('d-r1/DC-011')), lines.join('\n'));
});

test('C-10: an unchanged grading is neither stale nor differing and prints no warning', (t) => {
  const { runRoot, noisePath } = withBand(t);
  makeIteration(runRoot, 'd-r1', { arm: 'D' });
  const result = reportOf({ runRoot, noisePath, repoRoot: runRoot });
  assert.deepEqual(result.graderRerun, { runs: 1, differing: [], stale: [] });
  assert.equal(result.decision.corpus.cases[0].candidate, 1);
  assert.equal(report.reportLines(result).some((l) => l.startsWith('warning:')), false);
});

// ---------------------------------------------------------------------------
// C-8: noise and report refuse a run graded as another task or prompt

test('C-8: report and noise refuse a run whose launch key differs, or that has no launch.json', (t) => {
  const { runRoot, noisePath } = withBand(t);
  const d = makeIteration(runRoot, 'd-r1', { arm: 'D' });
  const launchFile = path.join(d, 'DC-011', 'launch.json');
  const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));

  fs.writeFileSync(launchFile, JSON.stringify({ ...launch, key: 'agentic/DC-011@00000000' }));
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: runRoot }), refused('capture-stale', 'd-r1/DC-011', 'key'));
  fs.writeFileSync(launchFile, JSON.stringify({ ...launch, promptSha256: '0'.repeat(64) }));
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: runRoot }), refused('capture-stale', 'd-r1/DC-011', 'promptSha256'));
  fs.rmSync(launchFile);
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: runRoot }), refused('launch-missing', 'd-r1/DC-011'));

  const nLaunch = path.join(runRoot, 'n-r2', 'DC-011', 'launch.json');
  fs.writeFileSync(nLaunch, JSON.stringify({ ...JSON.parse(fs.readFileSync(nLaunch, 'utf8')), key: 'agentic/DC-011@00000000' }));
  assert.throws(() => report.noiseOf({ runRoot, iterations: N_NAMES.join(','), taskSet, config, noiseConfig, pathInfo }), refused('capture-stale', 'n-r2/DC-011', 'key'));
  fs.rmSync(nLaunch);
  assert.throws(() => report.noiseOf({ runRoot, iterations: N_NAMES.join(','), taskSet, config, noiseConfig, pathInfo }), refused('launch-missing', 'n-r2/DC-011'));
});

// ---------------------------------------------------------------------------
// C-12: the band and the candidate must come from the same capture inputs

function gitRepo(t) {
  const dir = tempDir(t, 'doflow-agentic-git-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write('bench/agentic/tasks.ts', 'one\n');
  write('bench/agentic/results/noise.json', '{}\n');
  write('agent-docs/notes.md', 'a\n');
  const A = commit('a');
  write('bench/agentic/results/noise.json', '{"band":1}\n');
  write('agent-docs/notes.md', 'b\n');
  write('CHANGELOG.md', 'x\n');
  const B = commit('record only');
  write('bench/agentic/tasks.ts', 'two\n');
  const C = commit('input change');
  return { dir, A, B, C };
}

test('C-12: report refuses when the band and arm D differ in captureSha256, harnessVersion, snapshot, harness or model', (t) => {
  for (const [field, value] of [['captureSha256', 'd'.repeat(64)], ['harnessVersion', '1.0.1'], ['snapshot', 'other'], ['harness', 'h2'], ['model', 'codex:other:medium']]) {
    const { runRoot, noisePath } = withBand(t);
    makeIteration(runRoot, 'd-r1', { arm: 'D', meta: { [field]: value } });
    assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: runRoot }), refused('capture-mismatch', field), field);
  }
});

test('C-12: a sourceAt change that only touches records passes; one that changes inputs, or cannot be compared, refuses', (t) => {
  const repo = gitRepo(t);
  const { runRoot, noisePath } = withBand(t, { sourceAt: repo.A });

  makeIteration(runRoot, 'd-ok', { arm: 'D', meta: { sourceAt: repo.B } });
  const ok = reportOf({ runRoot, noisePath, repoRoot: repo.dir, iterations: 'd-ok' });
  assert.equal(ok.exit, 0);
  assert.equal(ok.decision.precondition, null);

  makeIteration(runRoot, 'd-same', { arm: 'D', meta: { sourceAt: repo.A } });
  assert.equal(reportOf({ runRoot, noisePath, repoRoot: path.join(runRoot, 'not-a-repo'), iterations: 'd-same' }).exit, 0, 'equal sourceAt skips git');

  makeIteration(runRoot, 'd-input', { arm: 'D', meta: { sourceAt: repo.C } });
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: repo.dir, iterations: 'd-input' }), refused('capture-mismatch', 'sourceAt', 'd-input'));

  makeIteration(runRoot, 'd-unknown', { arm: 'D', meta: { sourceAt: 'f'.repeat(40) } });
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: repo.dir, iterations: 'd-unknown' }), refused('capture-mismatch', 'sourceAt'));
});

test('C-12: report refuses when an iteration the band names is not under the run root', (t) => {
  const { runRoot, noisePath } = withBand(t);
  makeIteration(runRoot, 'd-r1', { arm: 'D' });
  fs.rmSync(path.join(runRoot, 'n-r3'), { recursive: true });
  assert.throws(() => reportOf({ runRoot, noisePath, repoRoot: runRoot }), (e) => e instanceof UsageError && e.message.includes('n-r3'));
});

// ---------------------------------------------------------------------------
// N-5: the no-band hint names the agentic noise command

test('N-5: without a noise band, reportLines prints the agentic noise command, not 096\'s', (t) => {
  const runRoot = tempDir(t, 'doflow-agentic-report-');
  makeIteration(runRoot, 'd-r1', { arm: 'D' });
  const result = reportOf({ runRoot, noisePath: path.join(runRoot, 'none.json'), explicitNoise: false, repoRoot: runRoot });
  assert.equal(result.decision.corpus.reason, 'no-noise-band');
  const lines = report.reportLines(result);
  assert.ok(lines.includes('no noise band: run `npm run bench -- agentic noise --iterations <n-r1,n-r2,n-r3> --out bench/agentic/results/noise.json` over the arm N repeats first'), lines.join('\n'));
  assert.equal(lines.some((l) => l.includes('bench/baseline/noise.json')), false);

  const { runRoot: banded, noisePath } = withBand(t);
  makeIteration(banded, 'd-r1', { arm: 'D' });
  assert.equal(report.reportLines(reportOf({ runRoot: banded, noisePath, repoRoot: banded })).some((l) => l.startsWith('no noise band')), false, 'with a band: no hint');
});
