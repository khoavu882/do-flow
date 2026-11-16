'use strict';

// Feature 086, task A.1: the compatibility goldens, rows C1 to C23 and W1 of the matrix in
// design/data-model.md section 5. Every row runs through today's public functions and CLI exit
// codes (resolveSetting, readPruneSetting, retentionWindow, captureSwitch/captureIsOff, the
// storage, failure and followup verbs). The 2.0 file formats (decision-model.json, the one-line
// prune files, the failures/off sentinel) are no longer read, so every row now sets its value in
// settings.json; the rows that pinned how those formats were parsed (the prune file's first line, the
// sentinel) are gone, and the failures/off rows now pin that the file is not read.
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
const { createSettingsEnv, userAdvice, writeSettledFollowup, write, REPO }: any = require('../helper/settings-fixtures.ts');
const { loadAdviceRegistry }: any = require('../../src/runtime/advice/registry.ts');
const { loadStorageRegistry }: any = require('../../src/runtime/storage/registry.ts');
const { resolveRoots, readPruneSetting }: any = require('../../src/runtime/storage/roots.ts');
const { resolveSetting }: any = require('../../src/runtime/advice/config.ts');
const { retentionWindow }: any = require('../../src/runtime/lifecycle/retention.ts');
const { failureHome, captureSwitch, captureIsOff }: any = require('../../src/runtime/failure/home.ts');
const { EVENTS_REL }: any = require('../../src/runtime/lifecycle/event-store.ts');

const ADVICE = loadAdviceRegistry({ repoRoot: REPO }).registry;
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const POSIX = process.platform !== 'win32';
const HOUR = 3600000;
const SETTINGS = 'settings.json';
/** A settings.json document of `advice.*` and other flat keys; `fields` are written as given. */
const doc = (fields: any = {}) => ({ schema: 1, ...fields });

function fx(t: any, options?: any) { return createSettingsEnv(t, options); }
function rootsOf(f: any, { projectRoot = f.project, global = false, env = f.env() } = {}) {
  return resolveRoots({ registry: STORAGE, projectRoot, global, env });
}
function advice(f: any, extra = {}) {
  return resolveSetting({ adviceRegistry: ADVICE, roots: rootsOf(f), ...extra });
}
function prune(f: any, rootId: any, options?: any) {
  return readPruneSetting({ registry: STORAGE, roots: rootsOf(f, options), rootId });
}
function window(f: any, extraEnv = {}, projectRoot = f.project) {
  return retentionWindow({ env: f.env(extraEnv), projectRoot });
}
const eventsDir = (root: any) => path.join(root, EVENTS_REL);
const eventFiles = (root: any) => (fs.existsSync(eventsDir(root)) ? fs.readdirSync(eventsDir(root)).sort() : []);

// ── advice: C1-C8 (resolveSetting) ────────────────────────────────────────────────────────────

test('C1: no advice file is off not-configured and nothing decided', (t: any) => {
  const f = fx(t);
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'not-configured');
  assert.deepEqual(result.decidedBy, { user: null, project: null });
  assert.equal(result.modelFrom, null);
  assert.deepEqual(result.notes, []);
});

test('C2: a user file {advice.enabled:true,advice.model} is on with provider ollama and its default endpoint', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(doc({ 'advice.enabled': true, 'advice.model': 'm' }));
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.reason, null);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.equal(result.model, 'm');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: null });
});

test('C3: C2 plus a project {advice.enabled:false} is off project-disabled, decided by the project file', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice());
  f.writeProjectSettings(doc({ 'advice.enabled': false }));
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'project-disabled');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: f.projectFile(SETTINGS) });
  assert.equal(result.model, 'clef-flash', 'an off result still carries the user model');
});

test('C4: C2 plus a project {advice.model:p} is on with model p and modelFrom project', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice());
  f.writeProjectSettings(doc({ 'advice.model': 'p' }));
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'p');
  assert.equal(result.modelFrom, 'project');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: f.projectFile(SETTINGS) });
});

test('C5: a project {advice.enabled:true,endpoint,provider} is on with the user values; the project cannot enable or choose the endpoint', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice());
  f.writeProjectSettings(doc({ 'advice.enabled': true, 'advice.endpoint': 'http://example.invalid', 'advice.provider': 'other' }));
  const result = advice(f);
  assert.equal(result.state, 'on');
  assert.equal(result.provider, 'ollama');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: null });
});

test('C6: a user {advice.enabled:false} is off user-disabled and the project file is never read, even an invalid one', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice({ enabled: false }));
  f.writeProjectSettings('{this is not json');
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'user-disabled');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: null });
  assert.deepEqual(result.notes, [], 'no project note: the project file was not read');
  // The same malformed project file under an enabled user file is read: it appears as a note, and advice is
  // off (119 phase-BC item 6: advice.model is security-relevant, so a malformed project file turns advice off).
  f.writeUserSettings(userAdvice());
  const enabled = advice(f);
  assert.equal(enabled.state, 'off');
  assert.equal(enabled.reason, 'config-invalid');
  assert.ok(enabled.notes.some((note: any) => note.startsWith(`project setting at ${f.projectFile(SETTINGS)} is invalid:`) && note.endsWith('; advice is off')));
});

const C7_CASES = [
  ['a', 'unparseable JSON', '{not json'],
  ['b', 'not a JSON object', '[]'],
  ['c', 'schema other than 1', userAdvice({ schema: 2 })],
  ['d', 'enabled not a boolean', userAdvice({ enabled: 'yes' })],
];
for (const [letter, label, content] of C7_CASES) {
  test(`C7${letter}: an invalid user file (${label}) is off config-invalid and the error names the file`, (t: any) => {
    const f = fx(t);
    const file = f.writeUserSettings(content);
    const result = advice(f);
    assert.equal(result.state, 'off');
    assert.equal(result.reason, 'config-invalid');
    assert.deepEqual(result.decidedBy, { user: file, project: null });
    assert.equal(result.model, null);
    // settings.json is one file read once per advice key, so a broken file is reported once per key
    assert.ok(result.notes.length >= 1);
    assert.ok(result.notes.every((note: any) => note.includes(file)), `every note names the file: ${result.notes}`);
  });
}

// 119 phase-BC item 6 (advice.model security-relevant, fail-safe gate advice.enabled): a malformed project
// settings.json leaves no advice on with the user values; it turns advice off and the note says so.
test('C8: C2 plus an invalid project file is off config-invalid with the user values kept and a note naming the project file', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice());
  const projectFile = f.writeProjectSettings('{not json');
  const result = advice(f);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: projectFile });
  assert.ok(result.notes.length >= 1);
  assert.ok(result.notes.every((note: any) => note.startsWith(`project setting at ${projectFile} is invalid:`) && note.endsWith('; advice is off')), `${result.notes}`);
});

test('control C1-C8: the layer that decides changes the result when its file changes', (t: any) => {
  const f = fx(t);
  assert.equal(advice(f).reason, 'not-configured');                       // C1 differs once a user file exists
  f.writeUserSettings(userAdvice());
  assert.equal(advice(f).state, 'on');
  f.writeProjectSettings(doc({ 'advice.enabled': false }));
  assert.equal(advice(f).reason, 'project-disabled');                      // C3 differs from C2
  f.writeProjectSettings(doc({ 'advice.model': 'p' }));
  assert.equal(advice(f).modelFrom, 'project');                            // C4 differs from C3
  f.writeUserSettings(userAdvice({ enabled: false }));
  assert.equal(advice(f).reason, 'user-disabled');                         // C6: the user layer outranks the project one
  f.writeUserSettings('{not json');
  assert.equal(advice(f).reason, 'config-invalid');                        // C7 differs from C2
  f.writeUserSettings(userAdvice());
  f.remove(f.projectFile(SETTINGS));
  assert.deepEqual(advice(f).notes, []);                                   // C8's note is the invalid project file's
});

// ── storage.prune: C9-C13 (readPruneSetting) ──────────────────────────────────────────────────

test('C9: no storage.prune setting is on and nothing decided, for every root', (t: any) => {
  const f = fx(t);
  for (const rootId of ['project-doflow', 'project-state', 'user-state', 'config-home']) {
    assert.deepEqual(prune(f, rootId), { setting: 'on', decidedBy: null }, rootId);
  }
});

const PRUNE_OFF = doc({ 'storage.prune': 'off' });
const PRUNE_ON = doc({ 'storage.prune': 'on' });

test('C10: a user storage.prune=off is off for every root; the storage verb reports pruning off and exits 0', (t: any) => {
  const f = fx(t);
  const userFile = f.writeUserSettings(PRUNE_OFF);
  for (const rootId of ['project-doflow', 'project-state', 'user-state', 'config-home']) {
    assert.deepEqual(prune(f, rootId), { setting: 'off', decidedBy: userFile }, rootId);
  }
  const r = f.run(['storage', '--action', 'prune']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `storage: pruning is off (${userFile}); nothing removed`);
});

test('C11: user off with project on is on for project roots (project file) and off for user roots', (t: any) => {
  const f = fx(t);
  const userFile = f.writeUserSettings(PRUNE_OFF);
  const projectFile = f.writeProjectSettings(PRUNE_ON);
  assert.deepEqual(prune(f, 'project-state'), { setting: 'on', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'project-doflow'), { setting: 'on', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'user-state'), { setting: 'off', decidedBy: userFile });
  assert.deepEqual(prune(f, 'config-home'), { setting: 'off', decidedBy: userFile });
});

test('C12: project off with no user file is off for project roots and on for user roots', (t: any) => {
  const f = fx(t);
  const projectFile = f.writeProjectSettings(PRUNE_OFF);
  assert.deepEqual(prune(f, 'project-state'), { setting: 'off', decidedBy: projectFile });
  assert.deepEqual(prune(f, 'user-state'), { setting: 'on', decidedBy: null });
  assert.deepEqual(prune(f, 'config-home'), { setting: 'on', decidedBy: null });
});

test('C13: a one-line prune file is not read: only settings.json decides', (t: any) => {
  const f = fx(t);
  write(f.userFile('prune'), 'off\n');
  write(f.projectFile('prune'), 'off\n');
  for (const rootId of ['project-doflow', 'project-state', 'user-state', 'config-home']) {
    assert.deepEqual(prune(f, rootId), { setting: 'on', decidedBy: null }, rootId);
  }
  const userFile = f.writeUserSettings(PRUNE_OFF);
  assert.deepEqual(prune(f, 'user-state'), { setting: 'off', decidedBy: userFile }, 'settings.json decides');
});

test('control C9-C13: the file content and the root decide the result', (t: any) => {
  const f = fx(t);
  assert.equal(prune(f, 'user-state').decidedBy, null);                    // C9 differs once a file exists
  f.writeUserSettings(PRUNE_OFF);
  assert.equal(prune(f, 'user-state').setting, 'off');
  f.writeProjectSettings(PRUNE_ON);
  assert.equal(prune(f, 'project-state').setting, 'on');                   // C11: project outranks user for project roots ...
  assert.equal(prune(f, 'user-state').setting, 'off');                     // ... and only for them
  f.writeProjectSettings(PRUNE_OFF);
  f.remove(f.userFile(SETTINGS));
  assert.equal(prune(f, 'project-state').setting, 'off');                  // C12 differs from C11
  assert.equal(prune(f, 'user-state').setting, 'on');
  f.writeProjectSettings(PRUNE_ON);
  assert.equal(prune(f, 'project-state').setting, 'on');
});

// ── storage.retentionHours: C14-C16 (retentionWindow, followup/storage verbs) ──────────────────

test('C14: retention env unset with prune on is the 4320-hour default; with prune off it is off', (t: any) => {
  const f = fx(t);
  assert.deepEqual(window(f), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' }, 'no storage.prune setting is on');
  f.writeProjectSettings(PRUNE_ON);
  assert.deepEqual(window(f), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' });
  f.writeProjectSettings(PRUNE_OFF);
  assert.deepEqual(window(f), { state: 'off' });
  f.writeUserSettings(PRUNE_OFF);
  f.remove(f.projectFile(SETTINGS));
  assert.deepEqual(window(f), { state: 'off' }, 'the user settings.json decides when the project has none');
});

test('C15: DOFLOW_RETENTION_HOURS=48 with prune off removes settled events older than 48 hours and keeps newer ones', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(PRUNE_OFF);
  assert.deepEqual(window(f, { DOFLOW_RETENTION_HOURS: '48' }), { state: 'on', hours: 48, ms: 48 * HOUR, source: 'env' });
  const old = writeSettledFollowup(eventsDir(f.project), 'FU-aaaaaa', 100);
  const recent = writeSettledFollowup(eventsDir(f.project), 'FU-bbbbbb', 1);
  const r = f.run(['followup', '--action', 'list', '--state', 'all', '--json'], { env: { DOFLOW_RETENTION_HOURS: '48' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.items.map((item: any) => item.id), ['FU-bbbbbb']);
  assert.deepEqual(eventFiles(f.project), recent.sort());
  assert.ok(old.every((name: any) => !eventFiles(f.project).includes(name)));
});

test('C16: DOFLOW_RETENTION_HOURS=abc is {state:invalid}, warns, removes nothing and the verb exits 0', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(PRUNE_ON);
  assert.deepEqual(window(f, { DOFLOW_RETENTION_HOURS: 'abc' }), { state: 'invalid', raw: 'abc' });
  const files = writeSettledFollowup(eventsDir(f.project), 'FU-aaaaaa', 100000);
  const r = f.run(['followup', '--action', 'list', '--state', 'all', '--json'], { env: { DOFLOW_RETENTION_HOURS: 'abc' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DOFLOW_RETENTION_HOURS/);
  assert.deepEqual(r.json.items.map((item: any) => item.id), ['FU-aaaaaa']);
  assert.deepEqual(eventFiles(f.project), files.sort());
});

test('control C14-C16: the env value and storage.prune change the window and what is removed', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(PRUNE_OFF);
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

test('C17: env unset is capture on, through both readers and the verb', (t: any) => {
  const f = fx(t);
  const env = f.env();
  const home = failureHome(env);
  assert.equal(home, f.failuresDir);
  assert.deepEqual(captureSwitch(home, env), { effective: 'on', env: null, settings: null, decidedBy: 'core/registry/settings.json' });
  assert.equal(captureIsOff(home, env), false);
  const r = f.run(['failure', '--action', 'capture']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture on');
});

test('C18: a failures/off file is not read: capture follows the env and settings.json only', (t: any) => {
  const f = fx(t);
  write(path.join(f.failuresDir, 'off'), '');
  for (const value of [undefined, 'on', '1', 'true']) {
    const env = f.env(value === undefined ? {} : { DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.equal(captureSwitch(home, env).effective, 'on', String(value));
    assert.equal(captureIsOff(home, env), false, String(value));
  }
  const env = f.env({ DOFLOW_FAILURE_CAPTURE: 'off' });
  assert.equal(captureIsOff(failureHome(env), env), true, 'the env still turns it off');
  const r = f.run(['failure', '--action', 'capture']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture on');
});

test('C19: env off, 0, false or no in any case and padded is capture off', (t: any) => {
  const f = fx(t);
  for (const value of ['off', '0', 'false', 'no', 'OFF', 'False', ' No ', '  0\t']) {
    const env = f.env({ DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.deepEqual(captureSwitch(home, env), { effective: 'off', env: value, settings: null, decidedBy: 'DOFLOW_FAILURE_CAPTURE' }, JSON.stringify(value));
    assert.equal(captureIsOff(home, env), true, JSON.stringify(value));
  }
  const r = f.run(['failure', '--action', 'capture'], { env: { DOFLOW_FAILURE_CAPTURE: 'false' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'capture off (DOFLOW_FAILURE_CAPTURE=false)');
});

test('C20: env on or any other word is capture on', (t: any) => {
  const f = fx(t);
  for (const value of ['on', '1', 'true', 'yes', 'banana', 'offf']) {
    const env = f.env({ DOFLOW_FAILURE_CAPTURE: value });
    const home = failureHome(env);
    assert.deepEqual(captureSwitch(home, env), { effective: 'on', env: value, settings: null, decidedBy: 'core/registry/settings.json' }, value);
    assert.equal(captureIsOff(home, env), false, value);
  }
  const bad = f.run(['failure', '--action', 'capture', '--set', 'maybe']);
  assert.equal(bad.status, 2, 'a usage error exits 2');
});

test('control C17-C20: the env word flips the result; a failures/off file or folder does not', (t: any) => {
  const f = fx(t);
  const on = f.env();
  const off = f.env({ DOFLOW_FAILURE_CAPTURE: 'off' });
  assert.equal(captureIsOff(failureHome(on), on), false);
  assert.equal(captureIsOff(failureHome(off), off), true);                 // C19 differs from C17
  assert.equal(captureIsOff(failureHome(f.env({ DOFLOW_FAILURE_CAPTURE: 'banana' })), f.env({ DOFLOW_FAILURE_CAPTURE: 'banana' })), false);
  write(path.join(f.failuresDir, 'off'), '');
  assert.equal(captureIsOff(failureHome(on), on), false);                  // C18: the file is not read
  f.remove(path.join(f.failuresDir, 'off'));
  fs.mkdirSync(path.join(f.failuresDir, 'off'), { recursive: true });
  assert.equal(captureIsOff(failureHome(on), on), false);
});

// ── config home: C21 (absolute XDG), C22, C23 and W1 (2.0 pins that flip) ───────────────────────

test('C21: an absolute XDG_CONFIG_HOME is the config home in the roots, the advice reader and the failure home', (t: any) => {
  const f = fx(t);
  const roots = rootsOf(f);
  assert.equal(roots['config-home'], path.join(f.xdg, 'doflow'));
  assert.equal(failureHome(f.env()), path.join(f.xdg, 'doflow', 'failures'));
  f.writeUserSettings(userAdvice());
  assert.equal(advice(f).state, 'on');
  assert.equal(advice(f).decidedBy.user, path.join(f.xdg, 'doflow', 'settings.json'));
});

test('control C21: XDG unset falls back to $HOME/.config and a different XDG does not see the file', (t: any) => {
  const f = fx(t);
  f.writeUserSettings(userAdvice());
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
  const out = { homedir: os.homedir(), configHome: roots['config-home'], userState: roots['user-state'], failureHome: home, switch: captureSwitch(home, process.env) };
  if (process.env.PROBE_READ === '1') {
    out.advice = resolveSetting({ adviceRegistry: loadAdviceRegistry({ repoRoot: repo }).registry, roots });
    out.prune = readPruneSetting({ registry, roots, rootId: 'user-state' });
  }
  process.stdout.write(JSON.stringify(out));
`;

test('C22 (HOME unset, XDG unset), this release: there is no config home, no failure home and no home root; nothing falls back to the account home', { skip: !POSIX }, (t: any) => {
  const f = fx(t);
  // HOME is unset: compute and compare, read nothing (Node would otherwise name the real account home).
  const out = f.node(NODE_PROBE, { env: { HOME: undefined, XDG_CONFIG_HOME: undefined } });
  assert.equal(path.isAbsolute(out.homedir), true, 'the account home exists and is not used');
  assert.equal(out.configHome, null);
  assert.equal(out.userState, null);
  assert.equal(out.failureHome, null);
  assert.deepEqual(out.switch, { effective: 'on', env: null, settings: null, decidedBy: null }, 'captureSwitch(null) reads on; the failure verb maps a null home to off');
});

test('C22 (HOME relative, XDG unset), this release: the relative HOME is ignored; user settings.json is not read from <cwd>/<HOME>', { skip: !POSIX }, (t: any) => {
  const f = fx(t);
  const configDir = path.join(f.project, 'rel-home', '.config', 'doflow');
  write(path.join(configDir, 'settings.json'), { ...userAdvice(), ...PRUNE_OFF });
  const out = f.node(NODE_PROBE, { env: { HOME: 'rel-home', XDG_CONFIG_HOME: undefined, PROBE_READ: '1' } });
  assert.equal(out.configHome, null);
  assert.equal(out.advice.reason, 'not-configured', 'the file exists at the relative path and is still not read');
  assert.equal(out.prune.setting, 'on');
  assert.equal(out.prune.decidedBy, null);
  assert.equal(out.failureHome, null);
  // control: an absolute HOME holding the same files reads them
  write(path.join(f.home, '.config', 'doflow', 'settings.json'), { ...userAdvice(), ...PRUNE_OFF });
  const clean = f.node(NODE_PROBE, { env: { XDG_CONFIG_HOME: undefined, PROBE_READ: '1' } });
  assert.equal(clean.advice.state, 'on');
  assert.equal(clean.prune.setting, 'off');
});

test('C23 (XDG relative, HOME absolute), this release: the relative XDG is ignored and the config home is $HOME/.config/doflow', { skip: !POSIX }, (t: any) => {
  const f = fx(t);
  const relDir = path.join(f.project, 'rel-xdg', 'doflow');
  write(path.join(relDir, 'settings.json'), { ...userAdvice(), ...PRUNE_OFF });
  const home = path.join(f.home, '.config', 'doflow');
  let out = f.node(NODE_PROBE, { env: { XDG_CONFIG_HOME: 'rel-xdg', PROBE_READ: '1' } });
  assert.equal(out.configHome, home);
  assert.equal(out.failureHome, path.join(home, 'failures'));
  assert.equal(out.advice.reason, 'not-configured', 'the file exists at the relative path and is still not read');
  assert.equal(out.prune.setting, 'on');
  assert.equal(out.prune.decidedBy, null);
  // capture is on under $HOME/.config/doflow
  const r = f.run(['failure', '--action', 'capture'], { env: { XDG_CONFIG_HOME: 'rel-xdg' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'capture on\n');
  // control: files under $HOME/.config/doflow are read, the relative ones stay unread
  write(path.join(home, 'settings.json'), { ...userAdvice(), ...PRUNE_OFF });
  out = f.node(NODE_PROBE, { env: { XDG_CONFIG_HOME: 'rel-xdg', PROBE_READ: '1' } });
  assert.equal(out.advice.state, 'on');
  assert.equal(out.advice.decidedBy.user, path.join(home, 'settings.json'));
  assert.equal(out.prune.setting, 'off');
  // control: the same files under an absolute XDG are read
  write(path.join(f.xdg, 'doflow', 'settings.json'), userAdvice());
  assert.equal(f.node(NODE_PROBE, { env: { PROBE_READ: '1' } }).advice.state, 'on');
});

// This release's linked-worktree result is the one declared by FR-012/OI-4.
test('W1: a linked worktree inherits the main checkout project layers; its own layers still win', (t: any) => {
  const f = fx(t, { worktree: true });
  f.writeUserSettings(userAdvice());
  // capture remains global-only: the project's failure.capture is not read
  const main = f.writeProjectSettings(doc({ 'storage.prune': 'off', 'advice.enabled': false, 'failure.capture': 'off' }));
  const mainPrune = main;
  const mainAdvice = main;
  const roots = rootsOf(f, { projectRoot: f.worktree });
  assert.equal(roots['project-doflow'], path.join(f.worktree, '.doflow'));
  assert.deepEqual(prune(f, 'project-state', { projectRoot: f.worktree }), { setting: 'off', decidedBy: mainPrune });
  const result = resolveSetting({ adviceRegistry: ADVICE, roots });
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'project-disabled');
  assert.deepEqual(result.decidedBy, { user: f.userFile(SETTINGS), project: mainAdvice });
  assert.deepEqual(retentionWindow({ env: f.env(), projectRoot: f.worktree }), { state: 'off' });
  assert.deepEqual(captureSwitch(failureHome(f.env()), f.env()), { effective: 'on', env: null, settings: null, decidedBy: 'core/registry/settings.json' });
  // control: the main checkout itself does read its own files
  assert.equal(prune(f, 'project-state').setting, 'off');
  assert.equal(advice(f).reason, 'project-disabled');
  assert.deepEqual(captureSwitch(failureHome(f.env()), f.env()), { effective: 'on', env: null, settings: null, decidedBy: 'core/registry/settings.json' });
  // control: a file in the worktree's own .doflow is read
  const own = f.writeProjectSettings(PRUNE_ON, f.worktree);
  assert.deepEqual(prune(f, 'project-state', { projectRoot: f.worktree }), { setting: 'on', decidedBy: own });
  assert.equal(resolveSetting({ adviceRegistry: ADVICE, roots: rootsOf(f, { projectRoot: f.worktree }) }).state, 'on');
  assert.deepEqual(retentionWindow({ env: f.env(), projectRoot: f.worktree }), { state: 'on', hours: 4320, ms: 4320 * HOUR, source: 'default' });
});
