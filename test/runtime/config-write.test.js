'use strict';

// 119 IC-007, IC-008, IC-009 (D-2): `doflow config schema|validate|set|unset`. Every case runs the CLI
// against a scratch HOME / XDG_CONFIG_HOME and a scratch project (test/helper/settings-fixtures.js),
// so nothing here reads or writes the real config home or the live repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));
const PROTOCOLS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/protocols.json'), 'utf8'));
const STORAGE = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/storage.json'), 'utf8'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The single IC-009 entry of a refused `--json` call, with the call's shape checked on the way. */
function refusal(result, key) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.errors.length, 1, JSON.stringify(result.json.errors));
  const [entry] = result.json.errors;
  assert.equal(entry.key, key);
  assert.equal(entry.ok, false);
  assert.deepEqual(Object.keys(entry).sort(), ['allowed', 'code', 'key', 'layer', 'message', 'ok']);
  assert.equal(typeof entry.message, 'string');
  assert.ok(entry.message && !entry.message.includes('\n'));
  return entry;
}

// ── set: the success path ─────────────────────────────────────────────────────────────────────────

test('set review.rounds 3 --layer project writes a valid 0600 file and reports origin project', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  const result = f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.errors, []);
  assert.equal(result.json.key, 'review.rounds');
  assert.equal(result.json.layer, 'project');
  assert.equal(result.json.file, file);
  assert.equal(result.json.value, 3);
  assert.equal(result.json.origin.layer, 'project');
  assert.equal(result.json.origin.source, file);
  assert.deepEqual(readJson(file), { schema: 1, 'review.rounds': 3 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('set text form prints key, value and origin; a later set keeps the other keys', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off' });
  const result = f.run(['config', 'set', 'review.rounds', '2', '--layer', 'project']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `review.rounds = 2  (project: ${f.projectFile('settings.json')})`);
  assert.deepEqual(readJson(f.projectFile('settings.json')), { schema: 1, 'storage.prune': 'off', 'review.rounds': 2 });
});

test('set at the local and user layers writes settings.local.json and the config home file', (t) => {
  const f = createSettingsEnv(t);
  assert.equal(f.run(['config', 'set', 'review.sameFamily', '"refuse"', '--layer', 'local']).status, 0);
  assert.deepEqual(readJson(f.projectFile('settings.local.json')), { schema: 1, 'review.sameFamily': 'refuse' });
  const user = f.run(['config', 'set', 'review.rounds', '2', '--layer', 'user', '--json']);
  assert.equal(user.status, 0, user.stderr);
  assert.equal(user.json.file, f.userFile('settings.json'));
  assert.deepEqual(readJson(f.userFile('settings.json')), { schema: 1, 'review.rounds': 2 });
});

test('set from a linked worktree writes the main checkout settings, as config list reads them', (t) => {
  const f = createSettingsEnv(t, { worktree: true });
  const result = f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project', '--json'], { cwd: f.worktree });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.file, f.projectFile('settings.json'));
  assert.deepEqual(readJson(f.projectFile('settings.json')), { schema: 1, 'review.rounds': 3 });
});

test('set of a string-list key adds items; a repeated item is refused with code items', (t) => {
  const f = createSettingsEnv(t);
  const ok = f.run(['config', 'set', 'review.extraLenses', '["correctness"]', '--layer', 'project', '--json']);
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.deepEqual(ok.json.value, ['correctness']);
  const dup = refusal(f.run(['config', 'set', 'review.extraLenses', '["correctness","correctness"]', '--layer', 'project', '--json']), 'review.extraLenses');
  assert.equal(dup.code, 'items');
  const wrong = refusal(f.run(['config', 'set', 'review.extraLenses', '["nope"]', '--layer', 'project', '--json']), 'review.extraLenses');
  assert.equal(wrong.code, 'enum');
  assert.deepEqual(wrong.allowed, PROTOCOLS.lenses.map((lens) => lens.id));
});

// ── set: D-2, locked and unknown keys ─────────────────────────────────────────────────────────────

test('set refuses autopilot.enabled as security and writes nothing', (t) => {
  const f = createSettingsEnv(t);
  const entry = refusal(f.run(['config', 'set', 'autopilot.enabled', '"on"', '--layer', 'user', '--json']), 'autopilot.enabled');
  assert.equal(entry.code, 'security');
  assert.equal(entry.layer, 'user');
  assert.equal(entry.allowed, null);
  assert.equal(fs.existsSync(f.userFile('settings.json')), false);
  assert.equal(fs.existsSync(f.configDir), false, 'no config home was created');
});

test('set refuses advice.model (D-2), verify.reuse and workers.billing as security, with no directory created', (t) => {
  const f = createSettingsEnv(t);
  for (const [key, value] of [['advice.model', '"x"'], ['verify.reuse', '"on"'], ['workers.billing', '{}'], ['advice.enabled', 'true']]) {
    const entry = refusal(f.run(['config', 'set', key, value, '--layer', 'user', '--json']), key);
    assert.equal(entry.code, 'security', key);
  }
  assert.equal(fs.existsSync(f.configDir), false, 'no config home was created');
  const project = refusal(f.run(['config', 'set', 'advice.model', '"x"', '--layer', 'project', '--json']), 'advice.model');
  assert.equal(project.code, 'security');
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('set and unset refuse guard.workerDropDatabases as security (C-1) and write nothing', (t) => {
  const f = createSettingsEnv(t);
  const set = refusal(f.run(['config', 'set', 'guard.workerDropDatabases', '"scratch_db"', '--layer', 'project', '--json']), 'guard.workerDropDatabases');
  assert.equal(set.code, 'security');
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
  f.writeProjectSettings({ schema: 1, 'guard.workerDropDatabases': 'kept_db' });
  const before = fs.readFileSync(f.projectFile('settings.json'), 'utf8');
  const unset = refusal(f.run(['config', 'unset', 'guard.workerDropDatabases', '--layer', 'project', '--json']), 'guard.workerDropDatabases');
  assert.equal(unset.code, 'security');
  assert.equal(fs.readFileSync(f.projectFile('settings.json'), 'utf8'), before);
});

test('set refuses an invariant.* key as locked and names the invariant', (t) => {
  const f = createSettingsEnv(t);
  const entry = refusal(f.run(['config', 'set', 'invariant.INV-1', 'false', '--layer', 'project', '--json']), 'invariant.INV-1');
  assert.equal(entry.code, 'locked');
  assert.match(entry.message, /INV-1/);
  assert.match(entry.message, /core\/registry\/protocols\.json/);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('set refuses an unregistered key as unknown-key', (t) => {
  const f = createSettingsEnv(t);
  const entry = refusal(f.run(['config', 'set', 'nope.key', '1', '--layer', 'user', '--json']), 'nope.key');
  assert.equal(entry.code, 'unknown-key');
  assert.equal(fs.existsSync(f.configDir), false);
});

test('set text refusal is one line per error: config set: <key>: <code>: <message>', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'set', 'autopilot.enabled', '"on"', '--layer', 'user']);
  assert.equal(result.status, 1);
  const lines = `${result.stdout}${result.stderr}`.trim().split('\n');
  assert.equal(lines.length, 1, lines.join('|'));
  assert.match(lines[0], /^config set: autopilot\.enabled: security: .+/);
});

// ── set: value, scope and narrowing refusals ──────────────────────────────────────────────────────

test('set refuses a wider narrow-only value than the layers below, whichever layer holds the lower value', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'review.rounds': 2 });
  const rounds = refusal(f.run(['config', 'set', 'review.rounds', '1', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(rounds.code, 'not-narrower');
  assert.equal(rounds.layer, 'project');
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
  // the default `auto` is already below review-single in the preset order
  const preset = refusal(f.run(['config', 'set', 'review.preset', '"review-single"', '--layer', 'project', '--json']), 'review.preset');
  assert.equal(preset.code, 'not-narrower');
  // an equal or narrower value is accepted
  assert.equal(f.run(['config', 'set', 'review.rounds', '2', '--layer', 'project']).status, 0);
  assert.equal(f.run(['config', 'set', 'review.preset', '"review-deep"', '--layer', 'project']).status, 0);
});

// C-8: review.rounds below the rounds.min of the preset in force is a value the resolver would ignore.
const DEEP_MIN = PROTOCOLS.presets['review-deep'].rounds.min;
const NOTE = (n) => `note: review.rounds ${n} is below review-deep rounds.min ${DEEP_MIN}; the resolver ignores it when the risk rule picks review-deep`;

test('set review.rounds below the project review-deep rounds.min is refused naming the floor; the floor itself is written', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  f.writeProjectSettings({ schema: 1, 'review.preset': 'review-deep' });
  const before = fs.readFileSync(file, 'utf8');
  const entry = refusal(f.run(['config', 'set', 'review.rounds', '1', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, 'project');
  assert.equal(entry.message, `review.rounds 1 is below review-deep rounds.min ${DEEP_MIN}`);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const validated = refusal(f.run(['config', 'validate', 'review.rounds', '1', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(validated.code, 'not-narrower');
  const ok = f.run(['config', 'set', 'review.rounds', String(DEEP_MIN), '--layer', 'project', '--json']);
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.equal(ok.json.notes, undefined);
  assert.deepEqual(readJson(file), { schema: 1, 'review.preset': 'review-deep', 'review.rounds': DEEP_MIN });
});

test('set review.rounds is judged against the preset of a lower layer too, at the local layer', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'review.preset': 'review-deep' });
  const entry = refusal(f.run(['config', 'set', 'review.rounds', '1', '--layer', 'local', '--json']), 'review.rounds');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, 'local');
  assert.equal(fs.existsSync(f.projectFile('settings.local.json')), false);
});

test('set review.rounds under preset auto is written with an advisory note in text and --json', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  const text = f.run(['config', 'set', 'review.rounds', '1', '--layer', 'project']);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trim().split('\n'), [`review.rounds = 1  (project: ${file})`, NOTE(1)]);
  assert.equal(readJson(file)['review.rounds'], 1);
  const json = f.run(['config', 'set', 'review.rounds', '1', '--layer', 'project', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(json.json.notes, [NOTE(1)]);
  assert.deepEqual(json.json.errors, []);
  const validated = f.run(['config', 'validate', 'review.rounds', '1', '--layer', 'project', '--json']);
  assert.deepEqual(validated.json, { ok: true, errors: [], notes: [NOTE(1)] });
  // no note when the value meets the strictest floor
  assert.equal(f.run(['config', 'set', 'review.rounds', '2', '--layer', 'project', '--json']).json.notes, undefined);
});

test('layerEntry judges review.rounds with the sibling review.preset of the same change (a prepared run\'s settings)', (t) => {
  const f = createSettingsEnv(t);
  const { layerEntry, layerFile } = require('../../src/runtime/settings/config-write.ts');
  const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
  const loaded = loadSettingsRegistry({});
  const { file } = layerFile('project', f.env(), f.project, fs);
  const judge = (value, siblings) => layerEntry(loaded.registry, 'review.rounds', 'project', file, { ok: true, value },
    { env: f.env(), projectRoot: f.project, fsImpl: fs, siblings });
  assert.equal(judge(1, { 'review.preset': 'review-deep' })?.code, 'not-narrower');
  assert.equal(judge(2, { 'review.preset': 'review-deep' }), null);
  assert.equal(judge(1, {}), null);
});

test('set at the local layer is checked against the project layer below it', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'review.rounds': 3 });
  const entry = refusal(f.run(['config', 'set', 'review.rounds', '2', '--layer', 'local', '--json']), 'review.rounds');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, 'local');
});

test('set refuses a bad enum with the allowed values, and a bad integer with {min,max}', (t) => {
  const f = createSettingsEnv(t);
  const enumEntry = refusal(f.run(['config', 'set', 'storage.prune', '"maybe"', '--layer', 'project', '--json']), 'storage.prune');
  assert.equal(enumEntry.code, 'enum');
  assert.deepEqual(enumEntry.allowed, ['off', 'on']);
  const range = refusal(f.run(['config', 'set', 'review.rounds', '9', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(range.code, 'range');
  assert.deepEqual(range.allowed, { min: 1, max: 3 });
  const retention = refusal(f.run(['config', 'set', 'storage.retentionHours', '0', '--layer', 'project', '--json']), 'storage.retentionHours');
  assert.equal(retention.code, 'range');
  assert.deepEqual(retention.allowed, { min: 1, max: null });
  const type = refusal(f.run(['config', 'set', 'review.rounds', '"two"', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(type.code, 'type');
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('set refuses a global-only key at a project layer as scope', (t) => {
  const f = createSettingsEnv(t);
  const globalOnly = refusal(f.run(['config', 'set', 'failure.capture', '"off"', '--layer', 'project', '--json']), 'failure.capture');
  assert.equal(globalOnly.code, 'scope');
  assert.equal(f.run(['config', 'set', 'failure.capture', '"off"', '--layer', 'user']).status, 0, 'the allowed layer still accepts it');
});

test('a value that is not JSON is a type error that says to quote strings, not a usage error', (t) => {
  const f = createSettingsEnv(t);
  const entry = refusal(f.run(['config', 'set', 'storage.prune', 'off', '--layer', 'project', '--json']), 'storage.prune');
  assert.equal(entry.code, 'type');
  assert.match(entry.message, /quote/i);
  assert.deepEqual(entry.allowed, ['off', 'on']);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('set refuses to write over a layer file that is not a valid settings file', (t) => {
  const f = createSettingsEnv(t);
  fs.writeFileSync(f.projectFile('settings.json'), '{ not json');
  const entry = refusal(f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(entry.code, 'layer-invalid');
  assert.equal(fs.readFileSync(f.projectFile('settings.json'), 'utf8'), '{ not json');
});

test('a value that fits compact JSON but not the file as written is refused too-large by validate and set (C-13)', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  const { MAX_BYTES } = require('../../src/runtime/settings/files.ts');
  const clauses = Array.from({ length: 8 }, (_, i) => `clause ${i} ${'c'.repeat(190)}`);
  // Compact, the layer with the new value is exactly the reader's limit; written pretty, it is over it.
  const pad = 'p'.repeat(MAX_BYTES - JSON.stringify({ schema: 1, 'x.pad': '', 'review.blockerClauses': clauses }).length);
  const full = { schema: 1, 'x.pad': pad, 'review.blockerClauses': clauses };
  assert.equal(JSON.stringify(full).length, MAX_BYTES);
  assert.ok(JSON.stringify(full, null, 2).length + 1 > MAX_BYTES);
  f.writeProjectSettings({ schema: 1, 'x.pad': pad });
  const before = fs.readFileSync(file);
  const value = JSON.stringify(clauses);
  for (const action of ['validate', 'set']) {
    const entry = refusal(f.run(['config', action, 'review.blockerClauses', value, '--layer', 'project', '--json']), 'review.blockerClauses');
    assert.equal(entry.code, 'too-large', action);
    assert.match(entry.message, new RegExp(`${MAX_BYTES}-byte limit`));
    assert.deepEqual(fs.readFileSync(file), before, `${action} leaves the file unchanged`);
  }
});

// ── advice.model is security-relevant now (D-2) ───────────────────────────────────────────────────

test('an invalid advice.model at a layer that may widen it trips advice.enabled and config list exits 1', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'advice.model': 7 });
  const listed = f.run(['config', 'list', '--json']);
  assert.equal(listed.status, 1, listed.stderr);
  assert.equal(listed.json.keys['advice.enabled'].origin.via, 'fail-safe');
  assert.equal(listed.json.keys['advice.model'].meta.securityRelevant, true);
});

test('advise --action configure still writes advice.model (a person command, not config set)', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'advice.model': 'clef-flash' });
  const listed = f.run(['config', 'list', '-g', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.keys['advice.model'].value, 'clef-flash');
});

// ── validate ──────────────────────────────────────────────────────────────────────────────────────

test('validate --json with a bad value returns one IC-009 entry and exits 1, and writes nothing', (t) => {
  const f = createSettingsEnv(t);
  const entry = refusal(f.run(['config', 'validate', 'review.rounds', '9', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(entry.code, 'range');
  assert.deepEqual(entry.allowed, { min: 1, max: 3 });
  const bare = refusal(f.run(['config', 'validate', 'review.rounds', '9', '--json']), 'review.rounds');
  assert.equal(bare.layer, null);
  assert.equal(bare.code, 'range');
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('validate accepts a good value (exit 0, ok true) and runs no layer checks without --layer', (t) => {
  const f = createSettingsEnv(t);
  const good = f.run(['config', 'validate', 'review.rounds', '2', '--layer', 'project', '--json']);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(good.json, { ok: true, errors: [] });
  // no layer: scope, security and narrowing are not decided
  f.writeUserSettings({ schema: 1, 'review.rounds': 3 });
  assert.equal(f.run(['config', 'validate', 'review.rounds', '1', '--json']).status, 0);
  assert.equal(f.run(['config', 'validate', 'failure.capture', '"off"', '--json']).status, 0);
  assert.equal(refusal(f.run(['config', 'validate', 'review.rounds', '1', '--layer', 'project', '--json']), 'review.rounds').code, 'not-narrower');
  assert.equal(refusal(f.run(['config', 'validate', 'invariant.INV-2', 'true', '--json']), 'invariant.INV-2').code, 'locked');
  assert.equal(refusal(f.run(['config', 'validate', 'nope.key', '1', '--json']), 'nope.key').code, 'unknown-key');
});

test('validate text form prints the message and exits 1 on a refusal', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'validate', 'storage.prune', '"maybe"', '--layer', 'project']);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /storage\.prune: enum: must be one of: off, on/);
});

// ── unset ─────────────────────────────────────────────────────────────────────────────────────────

test('unset removes the key from the layer file and keeps the others', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'review.rounds': 3, 'storage.prune': 'off' });
  const result = f.run(['config', 'unset', 'review.rounds', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.deepEqual(readJson(f.projectFile('settings.json')), { schema: 1, 'storage.prune': 'off' });
});

test('set and unset keep the bytes they replace in one <file>.config.bak (C-10); a first write needs none', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  const backup = `${file}.config.bak`;
  const backups = () => fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.bak')).sort();
  assert.equal(f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project']).status, 0);
  assert.deepEqual(backups(), [], 'a new file has nothing to keep');

  fs.writeFileSync(`${file}.bak`, 'preserved malformed settings\n');
  const first = fs.readFileSync(file);
  assert.equal(f.run(['config', 'set', 'storage.prune', '"off"', '--layer', 'project']).status, 0);
  assert.deepEqual(fs.readFileSync(backup), first, 'the backup holds the previous bytes');
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);

  const second = fs.readFileSync(file);
  assert.equal(f.run(['config', 'set', 'review.rounds', '2', '--layer', 'project']).status, 0);
  assert.deepEqual(fs.readFileSync(backup), second, 'each write replaces the one backup');
  const third = fs.readFileSync(file);
  assert.equal(f.run(['config', 'set', 'review.rounds', '2', '--layer', 'project']).status, 0);
  assert.deepEqual(fs.readFileSync(backup), second, 'a set that changes nothing writes nothing');
  assert.equal(f.run(['config', 'unset', 'review.rounds', '--layer', 'project']).status, 0);
  assert.deepEqual(fs.readFileSync(backup), third, 'unset keeps the bytes it replaces');
  assert.deepEqual(backups(), ['settings.json.bak', 'settings.json.config.bak'], 'one backup however many writes');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'preserved malformed settings\n', 'a preserved .bak is never overwritten');
});

test('unset of an absent key or an absent file is ok and creates nothing', (t) => {
  const f = createSettingsEnv(t);
  const absentFile = f.run(['config', 'unset', 'review.rounds', '--layer', 'project', '--json']);
  assert.equal(absentFile.status, 0, `${absentFile.stdout}${absentFile.stderr}`);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
  const userAbsent = f.run(['config', 'unset', 'review.rounds', '--layer', 'user']);
  assert.equal(userAbsent.status, 0, userAbsent.stderr);
  assert.equal(fs.existsSync(f.configDir), false, 'no config home was created');
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off' });
  const before = fs.readFileSync(f.projectFile('settings.json'), 'utf8');
  assert.equal(f.run(['config', 'unset', 'review.rounds', '--layer', 'project']).status, 0);
  assert.equal(fs.readFileSync(f.projectFile('settings.json'), 'utf8'), before, 'an absent key leaves the bytes alone');
});

test('unset refuses locked, unknown and security keys', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'autopilot.enabled': 'on' });
  const before = fs.readFileSync(f.userFile('settings.json'), 'utf8');
  assert.equal(refusal(f.run(['config', 'unset', 'invariant.INV-3', '--layer', 'project', '--json']), 'invariant.INV-3').code, 'locked');
  assert.equal(refusal(f.run(['config', 'unset', 'nope.key', '--layer', 'project', '--json']), 'nope.key').code, 'unknown-key');
  assert.equal(refusal(f.run(['config', 'unset', 'autopilot.enabled', '--layer', 'user', '--json']), 'autopilot.enabled').code, 'security');
  assert.equal(fs.readFileSync(f.userFile('settings.json'), 'utf8'), before);
});

// ── concurrent writers (C-7) ──────────────────────────────────────────────────────────────────────

/**
 * Runs `config <action>` in this process against fixture `f` through `fsImpl`, and returns the exit
 * code and the parsed `--json` output. process.exitCode is put back, so the test runner's is untouched.
 */
function runIn(f, fsImpl, action, key, valueText) {
  const { handleConfigAction } = require('../../src/runtime/settings/config-write.ts');
  const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
  const { registry } = loadSettingsRegistry({ repoRoot: REPO });
  const out = [];
  const saved = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (line) => out.push(line);
  console.error = (line) => out.push(line);
  try {
    const status = handleConfigAction({
      action, key, valueText, layer: 'project', json: true, registry, repoRoot: REPO, projectRoot: f.project, env: f.env(), fsImpl,
    });
    return { status, json: JSON.parse(out.join('\n')) };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.exitCode = saved.exitCode;
  }
}

test('two config set calls interleaved inside the write never drop a key: the loser refuses locked and writes nothing', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  f.writeProjectSettings({ schema: 1 });
  let started = false;
  let second = null;
  const fsImpl = Object.create(fs);
  // A has read the layer and written its temporary file; B runs to the end before A renames.
  fsImpl.writeFileSync = (target, ...args) => {
    const result = fs.writeFileSync(target, ...args);
    if (!started && /^\.settings\.json\..*\.tmp$/.test(path.basename(String(target)))) {
      started = true;
      second = runIn(f, fsImpl, 'set', 'storage.prune', '"off"');
    }
    return result;
  };
  const first = runIn(f, fsImpl, 'set', 'review.rounds', '3');
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.ok(second, 'the second writer ran inside the first write');
  const stored = readJson(file);
  if (second.status === 0) {
    assert.deepEqual(stored, { schema: 1, 'review.rounds': 3, 'storage.prune': 'off' }, 'a reported write is never lost');
  } else {
    assert.equal(second.status, 1, JSON.stringify(second.json));
    assert.equal(second.json.errors[0].code, 'locked');
    assert.deepEqual(stored, { schema: 1, 'review.rounds': 3 });
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json', 'settings.json.config.bak'], 'no lock or temporary file is left');
});

test('a write between the check and the write is seen: the set is checked again and both keys are kept', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  f.writeProjectSettings({ schema: 1 });
  let started = false;
  let second = null;
  const fsImpl = Object.create(fs);
  // B runs to the end right after A first reads the layer (A's check), before A takes the lock.
  fsImpl.readFileSync = (target, ...args) => {
    const result = fs.readFileSync(target, ...args);
    if (!started && target === file) {
      started = true;
      second = runIn(f, fsImpl, 'set', 'storage.prune', '"off"');
    }
    return result;
  };
  const first = runIn(f, fsImpl, 'set', 'review.rounds', '3');
  assert.equal(second.status, 0, JSON.stringify(second.json));
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.deepEqual(readJson(file), { schema: 1, 'review.rounds': 3, 'storage.prune': 'off' });
});

test('a held lock of any age makes set refuse with code locked, naming the lock and its age; it is never removed (N-1); with no lock set writes', (t) => {
  const f = createSettingsEnv(t);
  const file = f.projectFile('settings.json');
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off' });
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.lock`, 'held by a writer\n');
  const started = Date.now();
  const held = refusal(f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project', '--json']), 'review.rounds');
  assert.equal(held.code, 'locked');
  assert.match(held.message, /settings\.json\.lock \(\d+ s old\)/);
  assert.match(held.message, /remove that lock file/);
  assert.ok(Date.now() - started < 10000, 'the wait is bounded');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was written');

  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  for (const args of [['set', 'review.rounds', '3'], ['unset', 'storage.prune']]) {
    const aged = f.run(['config', ...args, '--layer', 'project', '--json']);
    assert.equal(aged.status, 1, `${args[0]}: ${aged.stdout}${aged.stderr}`);
    const entry = refusal(aged, args[1]);
    assert.equal(entry.code, 'locked');
    assert.match(entry.message, /settings\.json\.lock \((6\d|[7-9]\d) s old\)/, 'the aged lock is named with its age');
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${args[0]}: the file is unchanged`);
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'held by a writer\n', `${args[0]}: the aged lock is left alone`);
  }

  fs.rmSync(`${file}.lock`);
  const result = f.run(['config', 'set', 'review.rounds', '3', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(readJson(file), { schema: 1, 'storage.prune': 'off', 'review.rounds': 3 });
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

// ── schema ────────────────────────────────────────────────────────────────────────────────────────

test('schema --json lists every registry key with the IC-007 fields, and the invariants as locked', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'schema', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const { schema, keys, invariants, presets } = result.json;
  assert.equal(schema, 1);
  assert.deepEqual(keys.map((k) => k.key), Object.keys(REGISTRY.keys), 'registry order');
  for (const entry of keys) {
    assert.deepEqual(Object.keys(entry).sort(), ['combine', 'default', 'description', 'key', 'locked', 'max', 'maxItems', 'maxLength', 'min', 'order', 'scope', 'securityRelevant', 'type', 'values', 'writable']);
    const spec = REGISTRY.keys[entry.key];
    assert.equal(entry.type, spec.type);
    assert.equal(entry.scope, spec.scope);
    assert.equal(entry.combine, spec.combine);
    assert.equal(entry.description, spec.description);
    assert.equal(entry.securityRelevant, spec.securityRelevant);
    assert.equal(entry.writable, !spec.securityRelevant);
    assert.equal(entry.locked, false);
  }
  const byKey = Object.fromEntries(keys.map((k) => [k.key, k]));
  for (const key of ['advice.enabled', 'advice.provider', 'advice.endpoint', 'advice.model', 'verify.reuse', 'autopilot.enabled', 'workers.billing', 'guard.workerDropDatabases']) {
    assert.equal(byKey[key].writable, false, key);
  }
  assert.equal(byKey['review.rounds'].writable, true);
  assert.equal(byKey['review.rounds'].min, 1);
  assert.equal(byKey['review.rounds'].max, 3);
  assert.equal(byKey['review.rounds'].order, 'descending');
  assert.equal(byKey['review.rounds'].default, null);
  assert.deepEqual(byKey['review.preset'].values, ['auto', ...PROTOCOLS.order.review]);
  assert.deepEqual(byKey['review.extraLenses'].values, PROTOCOLS.lenses.map((l) => l.id));
  assert.equal(byKey['review.extraLenses'].maxItems, 4);
  assert.equal(byKey['review.extraLenses'].maxLength, 40);
  assert.deepEqual(byKey['review.extraLenses'].default, []);
  assert.equal(byKey['advice.endpoint'].default, 'http://127.0.0.1:11434', 'a defaultRef is resolved');
  assert.equal(byKey['storage.retentionHours'].default, STORAGE.stores.find((store) => store.id === 'lifecycle-events').bound.defaultHours, 'a defaultRef with no dependency is resolved');
  assert.deepEqual(invariants.map((i) => i.key), PROTOCOLS.invariants.map((i) => `invariant.${i.id}`));
  assert.equal(invariants.length, 7);
  for (const inv of invariants) {
    assert.equal(inv.locked, true);
    assert.equal(inv.writable, false);
    assert.equal(typeof inv.statement, 'string');
    assert.equal(typeof inv.enforcedBy, 'string');
  }
  assert.deepEqual(presets.map((p) => p.id), [...PROTOCOLS.order.review, ...PROTOCOLS.order.debate]);
  const deep = presets.find((p) => p.id === 'review-deep');
  assert.equal(deep.kind, 'review');
  assert.equal(deep.depth, 'deep');
  assert.equal(deep.seats, 2);
  assert.equal(deep.rounds, 2);
  assert.equal(deep.summary, '2 seats, 2 rounds, synthesizer separate, decider gate');
  assert.equal('depth' in presets.find((p) => p.id === 'debate-2'), false);
});

test('schema text is one line per key, invariant and preset, exit 0, and writes nothing', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'schema']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  const total = Object.keys(REGISTRY.keys).length + PROTOCOLS.invariants.length + Object.keys(PROTOCOLS.presets).length;
  assert.equal(lines.length, total);
  assert.ok(lines.includes('review.rounds integer default=null scope=narrow-only writable=true'));
  assert.ok(lines.includes('autopilot.enabled enum default="off" scope=global-only writable=false'));
  assert.ok(lines.some((line) => /^invariant\.INV-1 locked: /.test(line)));
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

// ── usage (exit 2) ────────────────────────────────────────────────────────────────────────────────

test('usage mistakes exit 2 and write nothing', (t) => {
  const f = createSettingsEnv(t);
  const usage = [
    ['config', 'bogus'],
    ['config', 'set'],
    ['config', 'set', 'review.rounds', '--layer', 'project'],
    ['config', 'set', 'review.rounds', '3'],
    ['config', 'set', 'review.rounds', '3', '--layer', 'galaxy'],
    ['config', 'set', 'review.rounds', '3', 'extra', '--layer', 'project'],
    ['config', 'set', 'advice.enabled=true'],
    ['config', 'unset', '--layer', 'project'],
    ['config', 'unset', 'review.rounds'],
    ['config', 'unset', 'review.rounds', 'more', '--layer', 'project'],
    ['config', 'validate'],
    ['config', 'validate', 'review.rounds'],
    ['config', 'validate', 'review.rounds', '1', '--layer', 'galaxy'],
    ['config', 'validate', 'review.rounds', '1', 'extra'],
    ['config', 'set', 'review.rounds', '3', '--layer', 'project', '-g'],
    ['config', 'unset', 'review.rounds', '--layer', 'project', '-g'],
    ['config', 'validate', 'review.rounds', '1', '-g'],
    ['config', 'schema', '-g'],
    ['config', 'schema', 'extra'],
    ['config', 'schema', '--layer', 'project'],
    ['config', 'list', '--layer', 'project'],
    ['config', 'set', 'review.rounds', '3', '--layer', 'project', '--show-origin'],
    ['config', 'schema', '--show-origin'],
    ['config', '--layer', 'user'],
  ];
  for (const args of usage) {
    const result = f.run(args);
    assert.equal(result.status, 2, `${args.join(' ')} -> ${result.status}\n${result.stdout}${result.stderr}`);
  }
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
  assert.equal(fs.existsSync(f.configDir), false);
});

test('the user layer with no config home is a usage error', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'set', 'review.rounds', '2', '--layer', 'user'], { env: { HOME: undefined, XDG_CONFIG_HOME: undefined } });
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /no config home/);
});

test('config [list] [project path] still reads as before', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'review.rounds': 3 });
  const listed = f.run(['config', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.keys['review.rounds'].value, 3);
  const bare = f.run(['config', '--json']);
  assert.equal(bare.json.keys['review.rounds'].value, 3);
  const elsewhere = f.run(['config', 'list', f.project, '--json'], { cwd: f.dir });
  assert.equal(elsewhere.json.keys['review.rounds'].value, 3);
});
