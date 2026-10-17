'use strict';

// Feature 086, task A.1: the 2.0 compatibility goldens, rows C1 to C23 and W1 of the matrix in
// design/data-model.md section 5. Every row runs through today's public functions and CLI exit
// codes (resolveSetting, readPruneSetting, retentionWindow, captureSwitch/captureIsOff, the
// storage, failure and followup verbs) and pins the 2.0 result. They stay green unchanged through the
// settings-layering work, except the rows named `2.0-pin:` below, which flip on purpose.
//
// Negative controls: each row group ends with a `control` test that changes the fixture so the
// 2.0 behaviour differs (the other layer, the other file content, the other env value) and shows
// the assertion's observable changes; a golden that cannot fail would pin nothing.
//
// Isolation: every test builds its own temp HOME, XDG_CONFIG_HOME and project (settings-fixtures);
// the cases that unset or relativise HOME or XDG run in a subprocess whose cwd is the temp folder,
// and the HOME-unset case asserts a computed path only (Node would otherwise name the real home).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, userDecision, writeSettledFollowup, write, REPO } = require('../helper/settings-fixtures');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots, readPruneSetting } = require('../../src/runtime/storage/roots.ts');
const { resolveSetting } = require('../../src/runtime/advice/config.ts');
const { retentionWindow } = require('../../src/runtime/lifecycle/retention.ts');
const { failureHome, captureSwitch, captureIsOff } = require('../../src/runtime/failure/home.ts');
const { EVENTS_REL } = require('../../src/runtime/lifecycle/event-store.ts');

const ADVICE = loadAdviceRegistry({ repoRoot: REPO }).registry;
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const POSIX = process.platform !== 'win32';
const HOUR = 3600000;
const PROJECT_NOTE = 'a project cannot enable the decision model or choose its endpoint';

function fx(t, options) { return createSettingsEnv(t, options); }
function rootsOf(f, { projectRoot = f.project, global = false, env = f.env() } = {}) {
  return resolveRoots({ registry: STORAGE, projectRoot, global, env });
}
function advice(f, extra = {}) {
  return resolveSetting({ adviceRegistry: ADVICE, roots: rootsOf(f), ...extra });
}
function prune(f, rootId, options) {
  return readPruneSetting({ registry: STORAGE, roots: rootsOf(f, options), rootId });
}
function window(f, extraEnv = {}, projectRoot = f.project) {
  return retentionWindow({ env: f.env(extraEnv), projectRoot });
}
const eventsDir = (root) => path.join(root, EVENTS_REL);
const eventFiles = (root) => (fs.existsSync(eventsDir(root)) ? fs.readdirSync(eventsDir(root)).sort() : []);

// ── advice: C1-C8 (resolveSetting) ────────────────────────────────────────────────────────────

test('C1: no advice file is off not-configured and nothing decided', (t) => {
  const f = fx(t);
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'not-configured');
  assert.deepEqual(result.decidedBy, { user: null, project: null });
  assert.equal(result.modelFrom, null);
  assert.deepEqual(result.notes, []);
});

test('C2: a user file {schema:1,enabled:true,model} is on with provider ollama and its default endpoint', (t) => {
  const f = fx(t);
  f.writeUserDecision({ schema: 1, enabled: true, model: 'm' });
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.reason, null);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.equal(result.model, 'm');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: null });
});

test('C3: C2 plus a project {enabled:false} is off project-disabled, decided by the project file', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  f.writeProjectDecision({ schema: 1, enabled: false });
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'project-disabled');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: f.projectFile('decision-model.json') });
  assert.equal(result.model, 'clef-flash', 'an off result still carries the user model');
});

test('C4: C2 plus a project {model:p} is on with model p and modelFrom project', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  f.writeProjectDecision({ schema: 1, model: 'p' });
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'p');
  assert.equal(result.modelFrom, 'project');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: f.projectFile('decision-model.json') });
});

test('C5: a project {enabled:true,endpoint,provider} is on with the user values and exactly three notes', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  f.writeProjectDecision({ schema: 1, enabled: true, endpoint: 'http://example.invalid', provider: 'other' });
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.provider, 'ollama');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.notes, [
    `project key 'enabled' ignored: ${PROJECT_NOTE}`,
    `project key 'endpoint' ignored: ${PROJECT_NOTE}`,
    `project key 'provider' ignored: ${PROJECT_NOTE}`,
  ]);
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: null });
});

test('C6: a user {enabled:false} is off user-disabled and the project file is never read, even an invalid one', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision({ enabled: false }));
  f.writeProjectDecision('{this is not json');
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'user-disabled');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: null });
  assert.deepEqual(result.notes, [], 'no project note: the project file was not read');
  // The same disabled project file under an enabled user file is read: it appears as a note.
  f.writeUserDecision(userDecision());
  assert.ok(advice(f).notes.some((note) => note.startsWith(`project setting at ${f.projectFile('decision-model.json')} ignored:`)));
});

const C7_CASES = [
  ['a', 'unparseable JSON', '{not json'],
  ['b', 'not a JSON object', '[]'],
  ['c', 'schema other than 1', userDecision({ schema: 2 })],
  ['d', 'enabled not a boolean', userDecision({ enabled: 'yes' })],
  ['e', 'provider not in advice.json', userDecision({ provider: 'nope' })],
  ['f', 'enabled true without a model', userDecision({ model: undefined })],
];
for (const [letter, label, content] of C7_CASES) {
  test(`C7${letter}: an invalid user file (${label}) is off config-invalid and the error names the file`, (t) => {
    const f = fx(t);
    const file = f.writeUserDecision(content);
    const result = advice(f);
    assert.equal(result.state, 'off');
    assert.equal(result.reason, 'config-invalid');
    assert.deepEqual(result.decidedBy, { user: file, project: null });
    assert.equal(result.model, null);
    assert.equal(result.notes.length, 1);
    assert.ok(result.notes[0].includes(file), `the note names the file: ${result.notes[0]}`);
  });
}

test('C8: C2 plus an invalid project file is on with the user values and an ignored-project note', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  const projectFile = f.writeProjectDecision('{not json');
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: null });
  assert.equal(result.notes.length, 1);
  assert.ok(result.notes[0].startsWith(`project setting at ${projectFile} ignored:`));
});

test('control C1-C8: the layer that decides changes the result when its file changes', (t) => {
  const f = fx(t);
  assert.equal(advice(f).reason, 'not-configured');                       // C1 differs once a user file exists
  f.writeUserDecision(userDecision());
  assert.equal(advice(f).state, 'on');
  f.writeProjectDecision({ schema: 1, enabled: false });
  assert.equal(advice(f).reason, 'project-disabled');                      // C3 differs from C2
  f.writeProjectDecision({ schema: 1, model: 'p' });
  assert.equal(advice(f).modelFrom, 'project');                            // C4 differs from C3
  f.writeUserDecision(userDecision({ enabled: false }));
  assert.equal(advice(f).reason, 'user-disabled');                         // C6: the user layer outranks the project one
  f.writeUserDecision('{not json');
  assert.equal(advice(f).reason, 'config-invalid');                        // C7 differs from C2
  f.writeUserDecision(userDecision());
  f.remove(f.projectFile('decision-model.json'));
  assert.deepEqual(advice(f).notes, []);                                   // C8's note is the invalid project file's
});

// ── storage.prune: C9-C13 (readPruneSetting) ──────────────────────────────────────────────────

test('C9: no prune file is on and nothing decided, for every root', (t) => {
  const f = fx(t);
  for (const rootId of ['project-doflow', 'project-state', 'user-state', 'config-home']) {
    assert.deepEqual(prune(f, rootId), { setting: 'on', decidedBy: null }, rootId);
  }
});

test('C10: a user prune=off is off for every root; the storage verb reports pruning off and exits 0', (t) => {
  const f = fx(t);
  const userFile = f.writeUserPrune('off\n');
  for (const rootId of ['project-doflow', 'project-state', 'user-state', 'config-home']) {
    assert.deepEqual(prune(f, rootId), { setting: 'off', decidedBy: userFile }, rootId);
  }
  const r = f.run(['storage', '--action', 'prune']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `storage: pruning is off (${userFile}); nothing removed`);
});

test('C11: user off with project on is on for project roots (project file) and off for user roots', (t) => {
  const f = fx(t);
  const userFile = f.writeUserPrune('off\n');
  const projectFile = f.writeProjectPrune('on\n');
  assert.deepEqual(prune(f, 'project-state'), { setting: 'on', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'project-doflow'), { setting: 'on', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'user-state'), { setting: 'off', decidedBy: userFile });
  assert.deepEqual(prune(f, 'config-home'), { setting: 'off', decidedBy: userFile });
});

test('C12: project off with no user file is off for project roots and on for user roots', (t) => {
  const f = fx(t);
  const projectFile = f.writeProjectPrune('off\n');
  assert.deepEqual(prune(f, 'project-state'), { setting: 'off', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'user-state'), { setting: 'on', decidedBy: null });
  assert.deepEqual(prune(f, 'config-home'), { setting: 'on', decidedBy: null });
});

test('C13: a prune file that is empty, unreadable or anything else decides off', (t) => {
  const f = fx(t);
  const userFile = f.userFile('prune');
  for (const content of ['', 'maybe\n', 'on yes\n', '\n']) {
    f.writeUserPrune(content);
    assert.deepEqual(prune(f, 'user-state'), { setting: 'off', decidedBy: userFile }, JSON.stringify(content));
  }
  f.remove(userFile);
  fs.mkdirSync(userFile);                                   // exists but cannot be read as a file
  assert.deepEqual(prune(f, 'user-state'), { setting: 'off', decidedBy: userFile }, 'unreadable');
  f.remove(userFile);
  f.writeUserPrune('  ON  \r\nsecond line ignored\n');       // first line, trimmed, any case
  assert.deepEqual(prune(f, 'user-state'), { setting: 'on', decidedBy: userFile }, 'first line only');
});

test('control C9-C13: the file content and the root decide the result', (t) => {
  const f = fx(t);
  assert.equal(prune(f, 'user-state').decidedBy, null);                    // C9 differs once a file exists
  f.writeUserPrune('off\n');
  assert.equal(prune(f, 'user-state').setting, 'off');
  f.writeProjectPrune('on\n');
  assert.equal(prune(f, 'project-state').setting, 'on');                   // C11: project outranks user for project roots ...
  assert.equal(prune(f, 'user-state').setting, 'off');                     // ... and only for them
  f.writeProjectPrune('off\n');
  f.remove(f.userFile('prune'));
  assert.equal(prune(f, 'project-state').setting, 'off');                  // C12 differs from C11
  assert.equal(prune(f, 'user-state').setting, 'on');
  f.writeProjectPrune('banana\n');
  assert.equal(prune(f, 'project-state').setting, 'off');                  // C13 other content: off, not the default
  f.writeProjectPrune('on\n');
  assert.equal(prune(f, 'project-state').setting, 'on');
});

// ── storage.retentionHours: C14-C16 (retentionWindow, followup/storage verbs) ──────────────────

test('C14: retention env unset with prune on is the 4320-hour default; with prune off it is off', (t) => {
  const f = fx(t);
  assert.deepEqual(window(f), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' }, 'no prune file is on');
  f.writeProjectPrune('on\n');
  assert.deepEqual(window(f), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' });
  f.writeProjectPrune('off\n');
  assert.deepEqual(window(f), { state: 'off' });
  f.writeUserPrune('off\n');
  f.remove(f.projectFile('prune'));
  assert.deepEqual(window(f), { state: 'off' }, 'the user prune file decides when the project has none');
});

test('C15: DOFLOW_RETENTION_HOURS=48 with prune off removes settled events older than 48 hours and keeps newer ones', (t) => {
  const f = fx(t);
  f.writeUserPrune('off\n');
  assert.deepEqual(window(f, { DOFLOW_RETENTION_HOURS: '48' }), { state: 'on', hours: 48, ms: 48 * HOUR, source: 'env' });
  const old = writeSettledFollowup(eventsDir(f.project), 'FU-aaaaaa', 100);
  const recent = writeSettledFollowup(eventsDir(f.project), 'FU-bbbbbb', 1);
  const r = f.run(['followup', '--action', 'list', '--state', 'all', '--json'], { env: { DOFLOW_RETENTION_HOURS: '48' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.items.map((item) => item.id), ['FU-bbbbbb']);
  assert.deepEqual(eventFiles(f.project), recent.sort());
  assert.ok(old.every((name) => !eventFiles(f.project).includes(name)));
});

test('C16: DOFLOW_RETENTION_HOURS=abc is {state:invalid}, warns, removes nothing and the verb exits 0', (t) => {
  const f = fx(t);
  f.writeUserPrune('on\n');
  assert.deepEqual(window(f, { DOFLOW_RETENTION_HOURS: 'abc' }), { state: 'invalid', raw: 'abc' });
  const files = writeSettledFollowup(eventsDir(f.project), 'FU-aaaaaa', 100000);
  const r = f.run(['followup', '--action', 'list', '--state', 'all', '--json'], { env: { DOFLOW_RETENTION_HOURS: 'abc' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DOFLOW_RETENTION_HOURS/);
  assert.deepEqual(r.json.items.map((item) => item.id), ['FU-aaaaaa']);
  assert.deepEqual(eventFiles(f.project), files.sort());
});

test('control C14-C16: the env value and the prune file change the window and what is removed', (t) => {
  const f = fx(t);
  f.writeUserPrune('off\n');
  const files = writeSettledFollowup(eventsDir(f.project), 'FU-aaaaaa', 100);
  // unset and prune off: nothing is removed (C14 differs from C15)
  let r = f.run(['followup', '--action', 'list', '--state', 'all', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(eventFiles(f.project), files.sort());
  // 48 removes the same events (C15) ...
  r = f.run(['followup', '--action', 'list', '--state', 'all', '--json'], { env: { DOFLOW_RETENTION_HOURS: '48' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(eventFiles(f.project), []);
  // ... and the invalid value differs from both
  assert.notDeepEqual(window(f, { DOFLOW_RETENTION_HOURS: 'abc' }), window(f, { DOFLOW_RETENTION_HOURS: '48' }));
  assert.notDeepEqual(window(f), window(f, { DOFLOW_RETENTION_HOURS: '48' }));
});

// ── failure.capture: C17-C20 (captureSwitch, captureIsOff, the failure verb) ───────────────────

test('C17: no sentinel and env unset is capture on, through both readers and the verb', (t) => {
  const f = fx(t);
  const env = f.env();
  const home = failureHome(env);
  assert.equal(home, f.failuresDir);
  assert.deepEqual(captureSwitch(home, env), { effective: 'on', sentinel: false, env: null });
  assert.equal(captureIsOff(home, env), false);
  const r = f.run(['failure', '--action', 'capture']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture on');
});

test('C18: a failures/off sentinel is off whatever the env says', (t) => {
  const f = fx(t);
  f.writeSentinel();
  for (const value of [undefined, 'on', '1', 'true', 'off']) {
    const env = f.env(value === undefined ? {} : { DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.equal(captureSwitch(home, env).effective, 'off', String(value));
    assert.equal(captureSwitch(home, env).sentinel, true, String(value));
    assert.equal(captureIsOff(home, env), true, String(value));
  }
  const r = f.run(['failure', '--action', 'capture'], { env: { DOFLOW_FAILURE_CAPTURE: 'on' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture off (switched off on this machine) (DOFLOW_FAILURE_CAPTURE=on)');
});

test('C19: env off, 0, false or no in any case and padded is capture off with no sentinel', (t) => {
  const f = fx(t);
  for (const value of ['off', '0', 'false', 'no', 'OFF', 'False', ' No ', '  0\t']) {
    const env = f.env({ DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.deepEqual(captureSwitch(home, env), { effective: 'off', sentinel: false, env: value }, JSON.stringify(value));
    assert.equal(captureIsOff(home, env), true, JSON.stringify(value));
  }
  const r = f.run(['failure', '--action', 'capture'], { env: { DOFLOW_FAILURE_CAPTURE: 'false' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture off (DOFLOW_FAILURE_CAPTURE=false)');
});

test('C20: env on or any other word with no sentinel is capture on; the env cannot turn a sentinel off', (t) => {
  const f = fx(t);
  for (const value of ['on', '1', 'true', 'yes', 'banana', 'offf']) {
    const env = f.env({ DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.deepEqual(captureSwitch(home, env), { effective: 'on', sentinel: false, env: value }, value);
    assert.equal(captureIsOff(home, env), false, value);
  }
  f.writeSentinel();
  const env = f.env({ DOFLOW_FAILURE_CAPTURE: 'on' });
  assert.equal(captureSwitch(failureHome(env), env).effective, 'off');
  const bad = f.run(['failure', '--action', 'capture', '--set', 'maybe']);
  assert.equal(bad.status, 2, 'a usage error exits 2');
});

test('control C17-C20: the sentinel and the env word each flip the result', (t) => {
  const f = fx(t);
  const on = f.env();
  const off = f.env({ DOFLOW_FAILURE_CAPTURE: 'off' });
  assert.equal(captureIsOff(failureHome(on), on), false);
  assert.equal(captureIsOff(failureHome(off), off), true);                 // C19 differs from C17
  assert.equal(captureIsOff(failureHome(f.env({ DOFLOW_FAILURE_CAPTURE: 'banana' })), f.env({ DOFLOW_FAILURE_CAPTURE: 'banana' })), false);
  f.writeSentinel();
  assert.equal(captureIsOff(failureHome(on), on), true);                   // C18 differs from C17
  f.remove(path.join(f.failuresDir, 'off'));
  assert.equal(captureIsOff(failureHome(on), on), false);
  fs.mkdirSync(path.join(f.failuresDir, 'off'), { recursive: true });
  assert.equal(captureIsOff(failureHome(on), on), false, 'a folder named off is not a sentinel (isFile)');
});

// ── config home: C21 (absolute XDG), C22, C23 and W1 (2.0 pins that flip) ───────────────────────

test('C21: an absolute XDG_CONFIG_HOME is the config home in the roots, the advice reader and the failure home', (t) => {
  const f = fx(t);
  const roots = rootsOf(f);
  assert.equal(roots['config-home'], path.join(f.xdg, 'doflow'));
  assert.equal(failureHome(f.env()), path.join(f.xdg, 'doflow', 'failures'));
  f.writeUserDecision(userDecision());
  assert.equal(advice(f).state, 'on');
  assert.equal(advice(f).decidedBy.user, path.join(f.xdg, 'doflow', 'decision-model.json'));
});

test('control C21: XDG unset falls back to $HOME/.config and a different XDG does not see the file', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  const noXdg = f.env({ XDG_CONFIG_HOME: undefined });
  assert.equal(rootsOf(f, { env: noXdg })['config-home'], path.join(f.home, '.config', 'doflow'));
  assert.equal(failureHome(noXdg), path.join(f.home, '.config', 'doflow', 'failures'));
  assert.equal(resolveSetting({ adviceRegistry: ADVICE, roots: rootsOf(f, { env: noXdg }) }).reason, 'not-configured');
  const other = f.env({ XDG_CONFIG_HOME: path.join(f.dir, 'other-xdg') });
  assert.equal(resolveSetting({ adviceRegistry: ADVICE, roots: rootsOf(f, { env: other }) }).reason, 'not-configured');
});

const NODE_PROBE = `
  const os = require('node:os');
  const repo = ${JSON.stringify(REPO)};
  const { loadStorageRegistry } = require(repo + '/src/runtime/storage/registry.ts');
  const { loadAdviceRegistry } = require(repo + '/src/runtime/advice/registry.ts');
  const { resolveRoots, readPruneSetting } = require(repo + '/src/runtime/storage/roots.ts');
  const { resolveSetting } = require(repo + '/src/runtime/advice/config.ts');
  const { failureHome, captureSwitch } = require(repo + '/src/runtime/failure/home.ts');
  const registry = loadStorageRegistry({ repoRoot: repo });
  const roots = resolveRoots({ registry, projectRoot: process.cwd(), env: process.env });
  const home = failureHome(process.env);
  const out = { homedir: os.homedir(), configHome: roots['config-home'], failureHome: home, switch: captureSwitch(home, process.env) };
  if (process.env.PROBE_READ === '1') {
    out.advice = resolveSetting({ adviceRegistry: loadAdviceRegistry({ repoRoot: repo }).registry, roots });
    out.prune = readPruneSetting({ registry, roots, rootId: 'user-state' });
  }
  process.stdout.write(JSON.stringify(out));
`;

// flips in B.1/C.5 (086)
test('2.0-pin: C22 (HOME unset, XDG unset): the config home is the account home path, capture is skipped', { skip: !POSIX }, (t) => {
  const f = fx(t);
  // HOME is unset, so Node names the real account home: compute and compare paths, read nothing.
  const out = f.node(NODE_PROBE, { env: { HOME: undefined, XDG_CONFIG_HOME: undefined } });
  assert.equal(path.isAbsolute(out.homedir), true);
  assert.equal(out.configHome, path.join(out.homedir, '.config', 'doflow'));
  assert.equal(out.failureHome, null);
  assert.deepEqual(out.switch, { effective: 'on', sentinel: false, env: null }, 'captureSwitch(null) reads on; the failure verb maps a null home to off');
});

// flips in B.1/C.5 (086)
test('2.0-pin: C22 (HOME relative, XDG unset): user advice and prune files are read from <cwd>/<HOME>/.config/doflow', { skip: !POSIX }, (t) => {
  const f = fx(t);
  const configDir = path.join(f.project, 'rel-home', '.config', 'doflow');
  write(path.join(configDir, 'decision-model.json'), userDecision());
  write(path.join(configDir, 'prune'), 'off\n');
  const out = f.node(NODE_PROBE, { env: { HOME: 'rel-home', XDG_CONFIG_HOME: undefined, PROBE_READ: '1' } });
  assert.equal(out.configHome, path.join('rel-home', '.config', 'doflow'), 'a relative path, resolved against the cwd');
  assert.equal(out.advice.state, 'on');
  assert.equal(out.advice.decidedBy.user, path.join('rel-home', '.config', 'doflow', 'decision-model.json'));
  assert.equal(out.prune.setting, 'off');
  assert.equal(out.failureHome, null);
  // control: with an absolute HOME that holds no such files the same probe finds nothing
  const clean = f.node(NODE_PROBE, { env: { PROBE_READ: '1' } });
  assert.equal(clean.advice.reason, 'not-configured');
  assert.equal(clean.prune.setting, 'on');
});

// flips in B.1/C.5 (086)
test('2.0-pin: C23 (XDG relative): Node has no config home, advice is not-configured and capture is skipped', { skip: !POSIX }, (t) => {
  const f = fx(t);
  const relDir = path.join(f.project, 'rel-xdg', 'doflow');
  write(path.join(relDir, 'decision-model.json'), userDecision());
  write(path.join(relDir, 'prune'), 'off\n');
  const out = f.node(NODE_PROBE, { env: { XDG_CONFIG_HOME: 'rel-xdg', PROBE_READ: '1' } });
  assert.equal(out.configHome, null);
  assert.equal(out.failureHome, null);
  assert.equal(out.advice.reason, 'not-configured', 'the file exists at the relative path and is still not read');
  assert.equal(out.prune.setting, 'on');
  assert.equal(out.prune.decidedBy, null);
  const r = f.run(['failure', '--action', 'capture'], { env: { XDG_CONFIG_HOME: 'rel-xdg' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'home: none (capture skipped)\ncapture: off\n');
  // control: the same files under an absolute XDG are read
  write(path.join(f.xdg, 'doflow', 'decision-model.json'), userDecision());
  assert.equal(f.node(NODE_PROBE, { env: { PROBE_READ: '1' } }).advice.state, 'on');
});

// flips in B.1/C.5 (086)
test('2.0-pin: W1: a linked worktree reads only its own .doflow, never the main checkout\'s', (t) => {
  const f = fx(t, { worktree: true });
  f.writeUserDecision(userDecision());
  f.writeProjectPrune('off\n');                                            // main checkout
  f.writeProjectDecision({ schema: 1, enabled: false });                  // main checkout
  const roots = rootsOf(f, { projectRoot: f.worktree });
  assert.equal(roots['project-doflow'], path.join(f.worktree, '.doflow'));
  assert.deepEqual(prune(f, 'project-state', { projectRoot: f.worktree }), { setting: 'on', decidedBy: null });
  const result = resolveSetting({ adviceRegistry: ADVICE, roots });
  assert.equal(result.state, 'on');
  assert.deepEqual(result.decidedBy, { user: f.userFile('decision-model.json'), project: null });
  assert.deepEqual(retentionWindow({ env: f.env(), projectRoot: f.worktree }), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' });
  // control: the main checkout itself does read its own files
  assert.equal(prune(f, 'project-state').setting, 'off');
  assert.equal(advice(f).reason, 'project-disabled');
  // control: a file in the worktree's own .doflow is read
  const own = f.writeProjectPrune('off\n', f.worktree);
  assert.deepEqual(prune(f, 'project-state', { projectRoot: f.worktree }), { setting: 'off', decidedBy: own });
});
