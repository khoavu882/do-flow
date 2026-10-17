'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv } = require('../helper/settings-fixtures');
const { captureSwitch } = require('../../src/runtime/failure/home.ts');
const { ROWS, HOME_ROWS, FILE_ROWS, CORPUS_ROWS, rowEnv } = require('../settings/capture-agreement.test.js');

function snapshot(root) {
  const rows = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file);
      const info = fs.lstatSync(file);
      rows.push(`${relative}\0${info.mode}\0${info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'file'}`);
      if (info.isDirectory()) visit(file);
      else if (info.isFile()) rows.push(fs.readFileSync(file).toString('base64'));
      else if (info.isSymbolicLink()) rows.push(fs.readlinkSync(file));
    }
  }
  visit(root);
  return rows.join('\n');
}

function captureRows() {
  return [...ROWS, ...HOME_ROWS, ...FILE_ROWS, ...CORPUS_ROWS];
}

function captureExtra(row) {
  const extra = {};
  if (row.xdg === 'unset') extra.XDG_CONFIG_HOME = undefined;
  if (row.xdg === 'relative') extra.XDG_CONFIG_HOME = 'rel-xdg';
  if (row.noHome) extra.HOME = undefined;
  if (row.word !== undefined) extra.DOFLOW_FAILURE_CAPTURE = row.word;
  return extra;
}

function captureListCase(t, row, reader = captureSwitch) {
  const setup = rowEnv(t, row);
  const extra = captureExtra(row);
  try {
    const result = setup.f.run(['config', 'list', '--json'], { env: extra });
    assert.ok([0, 1].includes(result.status), `${row.name}: ${result.stderr}`);
    const actual = result.json.keys['failure.capture'].value;
    const expected = setup.home === null ? 'off' : reader(setup.home, setup.env).effective;
    return { actual, expected, name: row.name };
  } finally { setup.done(); }
}

/** Deliberately models a capture switch that never reads settings.json. */
function captureSwitchWithoutLexicalRead(home, env) {
  const raw = env.DOFLOW_FAILURE_CAPTURE;
  const envOff = typeof raw === 'string' && ['off', '0', 'false', 'no'].includes(raw.trim().toLowerCase());
  let sentinel = false;
  if (home) {
    try { sentinel = fs.statSync(path.join(home, 'off')).isFile(); } catch { /* no sentinel */ }
  }
  return { effective: home && !envOff && !sentinel ? 'on' : 'off' };
}

test('config list text names effective settings, origins, candidates, and deprecated files', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserPrune('off\n');
  f.writeProjectPrune('on\n');

  const result = f.run(['config', '--show-origin']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`config home: ${f.xdg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /project: .*\((?:own|main|project)/);
  assert.match(result.stdout, /storage\.prune \[project roots\] = "on"\s+\(project: .*\.doflow\/prune\)/);
  assert.match(result.stdout, /storage\.prune \[user roots\] = "off"\s+\(user: .*\/doflow\/prune\)/);
  assert.match(result.stdout, /    project .*\.doflow\/prune: "on" — decided/);
  assert.match(result.stdout, /note: .*prune is deprecated/);
});

test('config list JSON carries project and global storage views with resolver origins', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserPrune('off\n');
  f.writeProjectPrune('on\n');

  const project = f.run(['config', 'list', '--json']);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(project.json.schema, 1);
  assert.equal(project.json.scope, 'project');
  assert.equal(project.json.keys['storage.prune'].project.value, 'on');
  assert.equal(project.json.keys['storage.prune'].global.value, 'off');
  assert.equal(project.json.keys['storage.prune'].project.origin.layer, 'project');
  assert.equal(project.json.keys['storage.prune'].global.origin.layer, 'user');
  assert.ok(project.json.notes.some((note) => note.code === 'deprecated'));

  const global = f.run(['config', 'list', '-g', '--json']);
  assert.equal(global.status, 0, global.stderr);
  assert.equal(global.json.scope, 'global');
  assert.equal(global.json.keys['storage.prune'].view, 'global');
  assert.equal(global.json.keys['storage.prune'].value, 'off');
  const globalText = f.run(['config', '-g']);
  assert.equal(globalText.status, 0, globalText.stderr);
  assert.match(globalText.stdout, /storage\.prune \[user roots\] = "off"/);
});

test('config list masks credentials in both user and project URL candidates', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserDecision({ schema: 1, enabled: true, provider: 'ollama', endpoint: 'http://tok@h', model: 'clef-flash' });
  f.writeProjectDecision({ schema: 1, enabled: false, provider: 'ollama', endpoint: 'http://u:p@h', model: 'project-model' });

  const result = f.run(['config', 'list', '--show-origin']);
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.match(result.stdout, /http:\/\/\*\*\*@h\//);
  assert.doesNotMatch(result.stdout, /http:\/\/tok@h/);
  assert.doesNotMatch(result.stdout, /http:\/\/u:p@h/);

  const json = f.run(['config', 'list', '--json']);
  assert.ok([0, 1].includes(json.status), json.stderr);
  assert.match(json.stdout, /http:\/\/\*\*\*@h\//);
  assert.doesNotMatch(json.stdout, /http:\/\/tok@h/);
  assert.doesNotMatch(json.stdout, /http:\/\/u:p@h/);
});

test('config list masks query values and opaque URL userinfo in text and JSON', (t) => {
  const cases = [
    ['query values', 'http://h:1/api?token=private-token&key=private-key', /http:\/\/h:1\/api\?token=\*\*\*&key=\*\*\*/],
    ['opaque userinfo', 'ollama-key:private-token@127.0.0.1:11434', /ollama-key:\*\*\*@127\.0\.0\.1:11434/],
  ];
  for (const [name, endpoint, masked] of cases) {
    const f = createSettingsEnv(t);
    f.writeUserSettings({ schema: 1, 'advice.endpoint': endpoint });
    const text = f.run(['config', 'list', '--show-origin']);
    assert.equal(text.status, 0, `${name}: ${text.stderr}`);
    assert.match(text.stdout, masked, name);
    assert.doesNotMatch(text.stdout, /private-token|private-key/, name);

    const json = f.run(['config', 'list', '--json']);
    assert.equal(json.status, 0, `${name}: ${json.stderr}`);
    assert.match(json.stdout, masked, name);
    assert.doesNotMatch(json.stdout, /private-token|private-key/, name);
  }
});

test('config list reports a user failure.capture enum typo as invalid instead of its lexical outcome', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'failure.capture': 'maybe' });

  const json = f.run(['config', 'list', '--show-origin', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const resolution = json.json.keys['failure.capture'];
  assert.equal(resolution.value, 'off');
  assert.ok(resolution.candidates.some((candidate) => candidate.layer === 'user' && candidate.status === 'invalid' && candidate.code === 'enum'));
  assert.ok(json.json.errors.some((error) => error.key === 'failure.capture' && error.code === 'enum'));
});

test('config list reports the ignored relative XDG variable and no-home capture fallback', (t) => {
  const f = createSettingsEnv(t);
  const relative = f.run(['config', 'list'], { env: { XDG_CONFIG_HOME: 'relative/xdg' } });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, /XDG_CONFIG_HOME.*ignored|ignored.*XDG_CONFIG_HOME/);

  const before = snapshot(f.dir);
  const noHome = f.run(['config', 'list'], { env: { HOME: undefined, XDG_CONFIG_HOME: undefined } });
  assert.equal(noHome.status, 0, noHome.stderr);
  assert.match(noHome.stdout, /failure\.capture = "off"\s+\(no config home: capture skipped\)/);
  assert.equal(snapshot(f.dir), before, 'config list must not create settings or storage files');
});

test('no-home config header names ignored variables in the IC-012 form', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'list'], { env: { HOME: undefined, XDG_CONFIG_HOME: 'relative/xdg' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^config home: none \(XDG_CONFIG_HOME ignored\)$/m);
});

test('config list tree snapshot stays unchanged because config skips after-verb upkeep', (t) => {
  const f = createSettingsEnv(t);
  // The runtime dispatch sees `list` as its positional root for this explicit form.
  const projectState = path.join(f.project, 'list', '.doflow', 'state');
  fs.mkdirSync(projectState, { recursive: true });
  assert.equal(fs.statSync(projectState).isDirectory(), true, 'the fixture has a usable project-state root');
  const before = snapshot(f.dir);
  const result = f.run(['config', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(snapshot(f.dir), before, 'config list is read-only and does not run storage upkeep');
});

test('config reports non-security key errors with exit 0 and security fail-safe errors with exit 1', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'storage.retentionHours': 'bad' });
  const ordinary = f.run(['config', 'list', '--json']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.ok(ordinary.json.errors.some((error) => error.key === 'storage.retentionHours'));

  f.writeUserSettings({ schema: 1, 'advice.provider': 'bogus' });
  const security = f.run(['config', 'list', '--json']);
  assert.equal(security.status, 1, security.stderr);
  assert.equal(security.json.keys['advice.enabled'].origin.via, 'fail-safe');
});

test('config set and invalid config syntax exit 2', (t) => {
  const f = createSettingsEnv(t);
  assert.equal(f.run(['config', 'set', 'advice.enabled=true']).status, 2);
  assert.equal(f.run(['config', 'list', 'one', 'two']).status, 2);
});

test('config list identifies main checkout settings when run from a linked worktree', (t) => {
  const f = createSettingsEnv(t, { worktree: true });
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off' });
  const result = f.run(['config', 'list', '--show-origin'], { cwd: f.worktree });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(main\)/);
  assert.ok(result.stdout.includes(path.join(f.project, '.doflow', 'settings.json')));
});

test('config exits 2 when the settings registry cannot be loaded', (t) => {
  const f = createSettingsEnv(t);
  const unusableRepo = path.join(f.dir, 'unusable-repo');
  fs.mkdirSync(unusableRepo);
  const { handleConfigCommand } = require('../../src/runtime/settings/cli.ts');
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const output = [];
  console.log = (line) => output.push(String(line));
  console.error = (line) => output.push(String(line));
  process.exitCode = 0;
  try {
    const code = handleConfigCommand({ repoRoot: unusableRepo, projectRoot: f.project, env: f.env() });
    assert.equal(code, 2);
    assert.equal(process.exitCode, 2);
    assert.match(output.join('\n'), /settings registry unavailable/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});

test('Writers write the new file only: config list shows settings.json deciding', (t) => {
  const f = createSettingsEnv(t);
  const legacyAdvice = f.writeUserDecision({ schema: 1, enabled: true, provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'clef-flash' });
  const legacyAdviceBytes = fs.readFileSync(legacyAdvice);
  const sentinel = path.join(f.failuresDir, 'off');

  const configured = f.run(['advise', '--action', 'configure', '--off', '--json']);
  assert.equal(configured.status, 0, configured.stderr);
  const capture = f.run(['failure', '--action', 'capture', '--set', 'off', '--json']);
  assert.equal(capture.status, 0, capture.stderr);

  const settings = f.userFile('settings.json');
  assert.deepEqual(fs.readFileSync(legacyAdvice), legacyAdviceBytes);
  assert.equal(fs.existsSync(sentinel), false);
  const listed = f.run(['config', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.keys['advice.enabled'].value, false);
  assert.equal(listed.json.keys['advice.enabled'].origin.source, settings);
  assert.equal(listed.json.keys['failure.capture'].value, 'off');
  assert.equal(listed.json.keys['failure.capture'].origin.source, settings);
});

test('config list JSON failure.capture agrees with captureSwitch on C17-C23 and lexical corpus rows', (t) => {
  const mismatches = captureRows().map((row) => captureListCase(t, row)).filter((row) => row.actual !== row.expected);
  assert.deepEqual(mismatches, []);
});

test('negative control: config list capture equality detects a captureSwitch that ignores lexical reads', (t) => {
  const row = FILE_ROWS.find((item) => item.name === 'settings.json off' && item.xdg === 'absolute');
  const result = captureListCase(t, row, captureSwitchWithoutLexicalRead);
  assert.equal(result.actual, 'off');
  assert.equal(result.expected, 'on');
  assert.notEqual(result.actual, result.expected, 'ignoring settings.json must make the equality assertion fail');
});
