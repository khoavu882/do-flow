'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { spawnFakeServer } = require('../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { emitDeprecatedNotes } = require('../../src/runtime/advice/cli.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');

function fixture(t: any, { setting = null }: any = {}) {
  const scratch = createScratch('doflow-advice-verb-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const userFile = path.join(scratch.xdg, 'doflow', 'decision-model.json');
  const projectFile = path.join(project, '.doflow', 'decision-model.json');
  const userSettingsFile = path.join(scratch.xdg, 'doflow', 'settings.json');
  const projectSettingsFile = path.join(project, '.doflow', 'settings.json');
  const servers: any = [];
  t.after(async (): Promise<any> => {
    for (const server of servers) await server.close();
    scratch.remove();
  });
  if (setting) writeJson(userFile, setting);
  return {
    scratch, project, userFile, projectFile, userSettingsFile, projectSettingsFile,
    env: () => scratch.env({ DOFLOW_CLI: BIN }),
    run: (args: any, { cwd = project }: any = {}) => spawnSync(bashPath(), [RUN, 'advise', ...args], { cwd, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' }),
    startServer: async (routes: any = {}) => {
      const server = await spawnFakeServer({ routes, dir: scratch.dir });
      servers.push(server);
      return server;
    },
  };
}

function linkProjectWorktree(main: any, worktree: any) {
  const commonGit = path.join(main, '.git');
  const gitdir = path.join(commonGit, 'worktrees', 'linked');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(path.join(worktree, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(commonGit, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(commonGit, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(worktree, '.git')}\n`);
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  return worktree;
}

function writeJson(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function userSetting(endpoint: any, overrides: any = {}) {
  return { schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash', ...overrides };
}
function questionFile(f: any, name: any = 'risk') {
  const file = path.join(f.scratch.dir, 'questions.json');
  writeJson(file, { questions: [{ name, type: 'choice', instructions: 'Choose one.', options: { a: 'A', b: 'B' } }] });
  return file;
}
function assertUsage(f: any, args: any, message: any) {
  const result = f.run(args);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /doflow advise:/);
  if (message) assert.ok(result.stderr.includes(message), result.stderr);
  return result;
}

test('score CLI exposes numeric JSON, human criterion words and exact criterion outcomes', async (t) => {
  const f = fixture(t);
  const server = await f.startServer({ 'POST /v1/systemone': { status: 200, body: { answers: {
    impact: { type: 'score', score: 1.15, legend: { 0: 'Low', 1: 'Medium', 2: 'High' }, probabilities: { 0: 0.25, 1: 0.35, 2: 0.4 }, confidence: 0.7 },
  } } } });
  writeJson(f.userFile, userSetting(server.origin));
  const file = path.join(f.scratch.dir, 'score-questions.json');
  writeJson(file, { questions: [{ name: 'impact', type: 'score', instructions: 'Assess impact.', criteria: ['Low', 'Medium', 'High'] }] });
  const args: any = ['--questions-file', file, '--state', 'Assess task.'];
  const json = f.run([...args, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const answer = JSON.parse(json.stdout).answers[0];
  assert.equal(answer.score, 1.15);
  assert.equal(answer.pickIndex, 2);
  assert.deepEqual(answer.criteria, ['Low', 'Medium', 'High']);
  assert.equal(answer.confidence, 0.7);
  assert.deepEqual(answer.probabilities, { 0: 0.25, 1: 0.35, 2: 0.4 });
  const text = f.run(args);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trim(), 'Advice (adhoc): High, split between High and Medium.');
  assert.doesNotMatch(text.stdout, /\d|%|confidence|probabilit/i);
  for (const actual of ['2', 'high', ' High']) {
    const invalid = f.run(['--action', 'outcome', '--pick-id', answer.pickId, '--actual', actual]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Low, Medium, High/);
  }
  writeJson(f.userFile, userSetting(server.origin, { enabled: false }));
  const outcome = f.run(['--action', 'outcome', '--pick-id', answer.pickId, '--actual', 'Medium', '--json']);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(JSON.parse(outcome.stdout).actual, 'Medium');
});

 test('IC-008 ask supports a named kind, state-file, server, questions-file and JSON/text output', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  writeJson(f.userFile, userSetting(server.origin));

  const json = f.run(['--action', 'ask', '--kind', 'tier', '--state', 'Choose a tier.', '--static', 'standard', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.status, 'answered');
  assert.equal(result.answers[0].kind, 'tier');
  assert.equal(result.answers[0].pick, 'light');
  assert.equal(result.answers[0].staticAnswer, 'standard');
  assert.equal(result.answers[0].agrees, false);
  assert.match(result.answers[0].pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);

  const text = f.run(['--action', 'ask', '--kind', 'tier', '--state-file', path.join(f.scratch.dir, 'state.txt')]);
  // A missing state file is a usage error; create the file and prove the accepted spelling below.
  assert.equal(text.status, 2);
  fs.writeFileSync(path.join(f.scratch.dir, 'state.txt'), 'state from a file');
  const fileResult = f.run(['--action', 'ask', '--kind', 'tier', '--state-file', path.join(f.scratch.dir, 'state.txt')]);
  assert.equal(fileResult.status, 0, fileResult.stderr);
  assert.match(fileResult.stdout, /^Advice \(tier\): light, clear\./);
  assert.doesNotMatch(fileResult.stdout, /\d/);

  const adhoc = f.run(['--action', 'ask', '--questions-file', questionFile(f), '--state', 'Ad hoc state.', '--json']);
  assert.equal(adhoc.status, 0, adhoc.stderr);
  assert.equal(JSON.parse(adhoc.stdout).answers[0].kind, 'adhoc');

  const mcp = f.run(['--action', 'ask', '--kind', 'mcp-need', '--server', 'context7', '--state', 'Stage task text.', '--json']);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).answers[0].kind, 'mcp-need');
});

test('IC-008 usage errors cover kind/question selection, state, files, server, static and limits', (t) => {
  const f: any = fixture(t, { setting: userSetting('http://127.0.0.1:9') });
  const missingQuestions = path.join(f.scratch.dir, 'missing-questions.json');
  const missingState = path.join(f.scratch.dir, 'missing-state.txt');
  assertUsage(f, ['--action', 'ask', '--state', 'x'], '--kind or --questions-file');
  assertUsage(f, ['--action', 'ask', '--kind', 'unknown-kind', '--state', 'x'], 'unknown kind');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--questions-file', questionFile(f), '--state', 'x'], 'exactly one');
  assertUsage(f, ['--action', 'ask', '--state', 'x'], 'exactly one');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier'], '--state or --state-file');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--state-file', missingState], 'cannot read');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--state', 'x', '--state-file', missingState], 'exactly one');
  assertUsage(f, ['--action', 'ask', '--questions-file', missingQuestions, '--state', 'x'], 'cannot read');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--server', 'context7', '--state', 'x'], '--server');
  assertUsage(f, ['--action', 'ask', '--kind', 'mcp-need', '--server', 'absent', '--state', 'x'], 'server');
  assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--static', 'not-a-tier', '--state', 'x'], 'static');

  const oversized = path.join(f.scratch.dir, 'oversized-state.txt');
  fs.writeFileSync(oversized, 'x'.repeat(51200));
  const tooLarge = assertUsage(f, ['--action', 'ask', '--kind', 'tier', '--state-file', oversized], 'limits.maxStateBytes');
  assert.match(tooLarge.stderr, /49152/);
});

test('IC-008 off and unavailable both print the none line and exit zero', (t) => {
  const off = fixture(t);
  const offResult = off.run(['--action', 'ask', '--kind', 'tier', '--state', 'state']);
  assert.equal(offResult.status, 0, offResult.stderr);
  assert.match(offResult.stdout, /Advice \(tier\): none; the static answer stands\./);
  const offJson = off.run(['--action', 'ask', '--kind', 'tier', '--state', 'state', '--json']);
  assert.equal(JSON.parse(offJson.stdout).status, 'off');

  const unavailable: any = fixture(t, { setting: userSetting('http://127.0.0.1:9') });
  const unavailableResult = unavailable.run(['--action', 'ask', '--kind', 'tier', '--state', 'state']);
  assert.equal(unavailableResult.status, 0, unavailableResult.stderr);
  assert.match(unavailableResult.stdout, /Advice \(tier\): none; the static answer stands\./);
  const unavailableJson = unavailable.run(['--action', 'ask', '--kind', 'tier', '--state', 'state', '--json']);
  assert.equal(JSON.parse(unavailableJson.stdout).status, 'unavailable');
  assert.equal(JSON.parse(unavailableJson.stdout).reason, 'unreachable');
});

test('IC-009 outcome appends to the pick store and works while the feature is off', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  writeJson(f.userFile, userSetting(server.origin));
  const answered = f.run(['--action', 'ask', '--kind', 'tier', '--state', 'state', '--json']);
  assert.equal(answered.status, 0, answered.stderr);
  const pickId = JSON.parse(answered.stdout).answers[0].pickId;
  writeJson(f.userFile, userSetting(server.origin, { enabled: false }));
  const outcome = f.run(['--action', 'outcome', '--pick-id', pickId, '--actual', 'light', '--json']);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(JSON.parse(outcome.stdout), { pickId, actual: 'light', recorded: true, file: path.join(f.project, '.doflow/state/advice/picks', `${new Date().toISOString().slice(0, 10)}.jsonl`) });
  const line = fs.readFileSync(JSON.parse(outcome.stdout).file, 'utf8');
  assert.match(line, /"type":"outcome"/);
  assert.match(line, /"source":"caller"/);
  assert.equal(f.run(['--action', 'outcome', '--pick-id', 'adv-1780279200000-abcdef', '--actual', 'yes']).status, 1);
  const invalid = f.run(['--action', 'outcome', '--pick-id', pickId, '--actual', 'nope']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /light, standard, frontier/);
});

test('IC-021 configure writes user/project forms and off performs no server check', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  const configured = f.run(['--action', 'configure', '--model', 'clef-flash', '--endpoint', server.origin, '--json']);
  assert.equal(configured.status, 0, configured.stderr);
  const json = JSON.parse(configured.stdout);
  assert.equal(json.setting.state, 'on');
  assert.equal(json.written, f.userSettingsFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.userSettingsFile, 'utf8')), {
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  });

  // A closed endpoint makes accidental inspection fail; --off must succeed without opening a socket.
  writeJson(f.userSettingsFile, {
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama',
    'advice.endpoint': 'http://127.0.0.1:9', 'advice.model': 'clef-flash',
  });
  const off = f.run(['--action', 'configure', '--off', '--json']);
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.userSettingsFile, 'utf8')), {
    schema: 1, 'advice.enabled': false, 'advice.provider': 'ollama',
    'advice.endpoint': 'http://127.0.0.1:9', 'advice.model': 'clef-flash',
  });

  const reenabled = f.run(['--action', 'configure', '--model', 'clef-flash', '--endpoint', server.origin, '--json']);
  assert.equal(reenabled.status, 0, reenabled.stderr);
  const projectOn = f.run(['--action', 'configure', '--project', '--model', 'clef-flash', '--json']);
  assert.equal(projectOn.status, 0, projectOn.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectSettingsFile, 'utf8')), { schema: 1, 'advice.model': 'clef-flash' });
  const projectOff = f.run(['--action', 'configure', '--project', '--off', '--json']);
  assert.equal(projectOff.status, 0, projectOff.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectSettingsFile, 'utf8')), {
    schema: 1, 'advice.enabled': false, 'advice.model': 'clef-flash',
  });

  const userOff = f.run(['--action', 'configure', '--off']);
  assert.equal(userOff.status, 0, userOff.stderr);
  const projectWhileOff = f.run(['--action', 'configure', '--project', '--model', 'clef-flash']);
  assert.equal(projectWhileOff.status, 1);
  assert.match(projectWhileOff.stderr, /turn the decision model on at user level first/);
});

test('project configure in an inheriting worktree writes the main layer and keeps its disable', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  const worktree = linkProjectWorktree(f.project, path.join(f.scratch.dir, 'linked'));
  writeJson(f.userFile, userSetting(server.origin));
  writeJson(f.projectSettingsFile, { schema: 1, 'advice.enabled': false });

  const configured = f.run(['--action', 'configure', '--project', '--model', 'clef-flash', '--json'], { cwd: worktree });
  assert.equal(configured.status, 0, `${configured.stderr}\n${configured.stdout}`);
  assert.match(configured.stderr, /decision-model\.json is deprecated; set "advice\.enabled"/);
  const json = JSON.parse(configured.stdout);
  assert.equal(json.written, f.projectSettingsFile);
  assert.equal(json.inheritedFromMainCheckout, true);
  assert.equal(json.setting.state, 'off');
  assert.equal(json.setting.reason, 'project-disabled');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectSettingsFile, 'utf8')),
    { schema: 1, 'advice.enabled': false, 'advice.model': 'clef-flash' });
  assert.equal(fs.existsSync(path.join(worktree, '.doflow', 'settings.json')), false);

  const text = f.run(['--action', 'configure', '--project', '--model', 'clef-flash'], { cwd: worktree });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(`wrote ${f.projectSettingsFile} (inherited from the main checkout)`), text.stdout);
});

test('advise writes a legacy deprecation note to stderr without changing JSON stdout', async (t) => {
  const legacy = fixture(t);
  const server = await legacy.startServer();
  writeJson(legacy.userFile, userSetting(server.origin));
  const advised = legacy.run(['--action', 'ask', '--kind', 'tier', '--state', 'Choose a tier.', '--json']);
  assert.equal(advised.status, 0, advised.stderr);
  assert.equal(JSON.parse(advised.stdout).status, 'answered');
  assert.match(advised.stderr, /note: .*decision-model\.json is deprecated; set "advice\.enabled" in .*settings\.json \(read through 2\.x\)/);
  assert.doesNotMatch(advised.stdout, /decision-model\.json is deprecated/);

  const current = fixture(t);
  writeJson(current.userSettingsFile, {
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama',
    'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  });
  const clean = current.run(['--action', 'ask', '--kind', 'tier', '--state', 'Choose a tier.', '--json']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, '', 'control: a current settings file has no deprecation note');
});

test('advise keeps a deprecated note when its wording changes', (): any => {
  const source = '/tmp/doflow-advice-note/decision-model.json';
  const output: any = [];
  const originalError = console.error;
  console.error = (line) => output.push(String(line));
  try {
    emitDeprecatedNotes({
      adviceRegistry: {},
      roots: { 'config-home': '/tmp/doflow-advice-note/doflow', 'project-doflow': null },
    }, () => ({
      files: [{ path: source, layer: 'user' }],
      notes: [{ code: 'deprecated', key: 'advice.enabled', source, text: 'Legacy settings remain supported.' }],
      get: () => ({ value: true, state: 'ok', origin: { via: null, legacy: true, source } }),
    }));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(output, ['note: Legacy settings remain supported.']);
});

test('configure at user level with no config home exits 2 naming HOME or XDG_CONFIG_HOME, writes nothing and throws no TypeError (086 DD-7)', (t) => {
  const f = fixture(t);
  const tree = (dir: any) => fs.readdirSync(dir, { recursive: true }).sort();
  for (const [name, extra] of [['HOME and XDG unset', {}], ['relative HOME and XDG', { HOME: 'rel-home', XDG_CONFIG_HOME: 'rel-xdg' }]]) {
    for (const args of [['--off'], ['--model', 'clef-flash']]) {
      const env = f.env();
      delete env.HOME;
      delete env.XDG_CONFIG_HOME;
      Object.assign(env, extra);
      const before = tree(f.scratch.dir);
      const r = spawnSync(process.execPath, [BIN, 'advise', '--action', 'configure', ...args], { cwd: f.project, env, encoding: 'utf8' });
      const label = `${name} ${args.join(' ')}`;
      assert.equal(r.status, 2, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /doflow advise:.*an absolute HOME or XDG_CONFIG_HOME/, label);
      assert.doesNotMatch(r.stderr, /TypeError/, label);
      assert.deepEqual(tree(f.scratch.dir), before, `${label}: nothing was written`);
    }
  }
  // control: with a config home the same command writes as before
  const ok = f.run(['--action', 'configure', '--off']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.existsSync(f.userSettingsFile), true);
});

for (const failure of [
  { name: 'endpoint refusal', endpoint: 'http://192.0.2.1:11434', args: [], expected: 'only loopback addresses are allowed' },
  { name: 'unreachable endpoint', endpoint: 'http://127.0.0.1:9', routes: null, args: [], expected: 'Ollama did not answer at http://127.0.0.1:9; start it yourself and re-run. Nothing was written.' },
  { name: 'old version', endpoint: 'server', routes: { 'GET /api/version': { status: 200, body: { version: '0.30.0' } } }, args: [], expected: 'Ollama 0.30.0' },
  { name: 'model missing', endpoint: 'server', routes: { 'GET /api/tags': { status: 200, body: { models: [{ name: 'other:latest', capabilities: ['decision'] }] } } }, model: 'missing-model', args: [], expected: "model missing-model is not installed; run 'ollama pull missing-model' yourself. Nothing was written." },
  { name: 'model not decision capable', endpoint: 'server', routes: { 'GET /api/tags': { status: 200, body: { models: [{ name: 'clef-flash:latest', capabilities: ['completion'] }] } } }, args: [], expected: 'decision-capable here: none. Nothing was written.' },
]) {
  test(`IC-021 configure checks ${failure.name} before writing`, async (t) => {
    const f = fixture(t);
    let endpoint = failure.endpoint;
    if (endpoint === 'server') endpoint = (await f.startServer(failure.routes || {})).origin;
    const model = failure.model || 'clef-flash';
    const result = f.run(['--action', 'configure', '--model', model, '--endpoint', endpoint, ...failure.args]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(failure.expected), result.stderr);
    assert.equal(fs.existsSync(f.userFile), false, 'failed configuration must not write');
  });
}

test('IC-021 usage rejects ambiguous forms, project endpoint and project outside a root', (t) => {
  const f: any = fixture(t, { setting: userSetting('http://127.0.0.1:9') });
  assertUsage(f, ['--action', 'configure'], '--model or --off');
  assertUsage(f, ['--action', 'configure', '--model', 'clef-flash', '--off', '--endpoint', 'http://127.0.0.1:9'], 'cannot combine');
  assertUsage(f, ['--action', 'configure', '--project', '--model', 'clef-flash', '--endpoint', 'http://127.0.0.1:9'], '--endpoint');
  assertUsage(f, ['--action', 'configure', '--off', '--endpoint', 'http://127.0.0.1:9'], '--endpoint');
  assertUsage(f, ['--action', 'configure', '--project', '--off', '--global'], 'project root');
});
