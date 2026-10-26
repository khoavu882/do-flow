'use strict';

// 119 IC-010, FR-013, NFR-005: `doflow config validate --prepared-run <file>`. Each case runs the CLI
// against a scratch HOME / XDG_CONFIG_HOME and a scratch project (test/helper/settings-fixtures.js)
// with PATH holding only the directory of this Node binary, so no harness, git or other tool is
// reachable, and checks nothing is written anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));
const HARNESS_REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8'));
const WORKERS = HARNESS_REGISTRY.harnesses.filter((item: any) => item.worker);
const SUPPORTED = WORKERS.find((item: any) => item.worker.model?.status === 'supported')?.id;
const UNSUPPORTED = WORKERS.find((item: any) => item.worker.model?.status !== 'supported')?.id;
const BARE_PATH: any = { PATH: path.dirname(process.execPath) };

/** A fixture plus a `validate(file-content | object, extraArgs)` runner that writes the prepared run outside project and HOME. */
function setup(t: any) {
  const f = createSettingsEnv(t);
  let n = 0;
  const prepared = (content: any) => {
    n += 1;
    const file = path.join(f.dir, `prepared-${n}.json`);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const validate = (content: any, args: any = ['--json']) =>
    f.run(['config', 'validate', '--prepared-run', prepared(content), ...args], { env: BARE_PATH });
  return { f, prepared, validate };
}

const VALID = () => ({
  schema: 1, taskClass: 'feature', settings: { 'review.rounds': 3 },
  presets: { review: 'review-deep', debate: 'debate-3' },
});

/** Every file and folder under the roots, as a sorted list with sizes, to compare before and after. */
function listing(...roots: any[]): any {
  const out: any = [];
  const walk = (p: any) => {
    const stat = fs.lstatSync(p);
    out.push(`${p}:${stat.isDirectory() ? 'dir' : stat.size}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  for (const root of roots) walk(root);
  return out.sort();
}

function entryFor(result: any, key: any) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, false);
  const found = result.json.errors.filter((e: any) => e.key === key);
  assert.equal(found.length, 1, JSON.stringify(result.json.errors));
  const [entry] = found;
  assert.equal(entry.ok, false);
  assert.deepEqual(Object.keys(entry).sort(), ['allowed', 'code', 'key', 'layer', 'message', 'ok']);
  assert.ok(entry.message && !entry.message.includes('\n'));
  return entry;
}

test('a valid prepared run exits 0 with { ok: true, errors: [] } and writes nothing', (t) => {
  const { f, validate } = setup(t);
  const before = listing(f.project, f.home, f.xdg);
  const result = validate(VALID());
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.json, { ok: true, errors: [] });
  assert.deepEqual(listing(f.project, f.home, f.xdg), before);
});

test('the text form prints prepared run: valid (<file>), or one <key>: <message> line per entry', (t) => {
  const { f, prepared } = setup(t);
  const good = prepared(VALID());
  const ok = f.run(['config', 'validate', '--prepared-run', good], { env: BARE_PATH });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), `prepared run: valid (${good})`);
  const bad = prepared({ schema: 1, taskClass: 'nope', workers: [] });
  const refused = f.run(['config', 'validate', '--prepared-run', bad], { env: BARE_PATH });
  assert.equal(refused.status, 1);
  const lines = refused.stderr.trim().split('\n');
  assert.equal(lines.length, 2, refused.stderr);
  assert.ok(lines[0].startsWith('taskClass: '), lines[0]);
  assert.ok(lines[1].startsWith('workers: '), lines[1]);
});

test('an unknown task class is refused as taskClass enum, listing the registry classes', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({ ...VALID(), taskClass: 'not-a-class' }), 'taskClass');
  assert.equal(entry.code, 'enum');
  assert.equal(entry.layer, null);
  assert.ok(Array.isArray(entry.allowed) && entry.allowed.includes('feature') && entry.allowed.includes('bug'), JSON.stringify(entry.allowed));
});

test('presets.review review-single for taskClass feature is below the gate-b seat floor: not-narrower naming the floor', (t) => {
  // maint-thin: the floor binds only an unattended gate-b, that is while autopilot is on
  const { f, validate } = setup(t);
  f.writeUserSettings({ schema: 1, 'autopilot.enabled': 'on' });
  const entry = entryFor(validate({ ...VALID(), presets: { review: 'review-single' } }), 'presets.review');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, null);
  assert.match(entry.message, /\b2\b/, entry.message);
  assert.match(entry.message, /seat/, entry.message);
});

test('maint-thin: presets.review review-single for taskClass feature passes while autopilot is off (a person reads the review)', (t) => {
  const { validate } = setup(t);
  const result = validate({ ...VALID(), presets: { review: 'review-single' } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('presets.review review-single passes for a class with no seat floor', (t) => {
  const { validate } = setup(t);
  const result = validate({ ...VALID(), taskClass: 'bug', presets: { review: 'review-single' } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('presets.review looser than the file\'s own settings["review.preset"] is not-narrower', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({
    schema: 1, taskClass: 'bug', settings: { 'review.preset': 'review-deep' }, presets: { review: 'review-single' },
  }), 'presets.review');
  assert.equal(entry.code, 'not-narrower');
  assert.match(entry.message, /review-deep/, entry.message);
});

test('C-3: a project .doflow/settings.json review.preset stricter than presets.review is not-narrower', (t) => {
  const { f, validate } = setup(t);
  f.writeProjectSettings({ schema: 1, 'review.preset': 'review-deep' });
  const entry = entryFor(validate({ schema: 1, taskClass: 'bug', presets: { review: 'review-single' } }), 'presets.review');
  assert.equal(entry.code, 'not-narrower');
  assert.match(entry.message, /review\.preset/, entry.message);
  assert.match(entry.message, /review-deep/, entry.message);
  assert.match(entry.message, /project/, entry.message);
});

test('C-3: a user settings debate.preset stricter than presets.debate is not-narrower, also with no taskClass', (t) => {
  const { f, validate } = setup(t);
  f.writeUserSettings({ schema: 1, 'debate.preset': 'debate-3' });
  const entry = entryFor(validate({ schema: 1, taskClass: 'bug', presets: { debate: 'debate-2' } }), 'presets.debate');
  assert.equal(entry.code, 'not-narrower');
  assert.match(entry.message, /debate\.preset/, entry.message);
  assert.match(entry.message, /debate-3/, entry.message);
  assert.match(entry.message, /user/, entry.message);
  const noClass = validate({ schema: 1, presets: { debate: 'debate-2' } });
  assert.equal(noClass.status, 1, `${noClass.stdout}${noClass.stderr}`);
  assert.equal(noClass.json.errors.filter((e: any) => e.key === 'presets.debate').length, 1, JSON.stringify(noClass.json.errors));
});

test('C-3: presets equal to or stricter than the effective settings pass', (t) => {
  const { f, validate } = setup(t);
  f.writeProjectSettings({ schema: 1, 'review.preset': 'review-deep' });
  f.writeUserSettings({ schema: 1, 'debate.preset': 'debate-3' });
  const result = validate({ schema: 1, taskClass: 'bug', presets: { review: 'review-deep', debate: 'debate-3' } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('presets.review that is not a review preset, and presets.debate that is not a debate preset, are enum', (t) => {
  const { validate } = setup(t);
  const result = validate({ ...VALID(), presets: { review: 'debate-3', debate: 'review-deep' } });
  assert.equal(entryFor(result, 'presets.review').code, 'enum');
  const debate = entryFor(result, 'presets.debate');
  assert.equal(debate.code, 'enum');
  assert.deepEqual(debate.allowed, ['debate-3', 'debate-2']);
});

test('a settings entry is judged as config validate <key> <value> --layer project: range at settings.<key>', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({ ...VALID(), settings: { 'review.rounds': 9 } }), 'settings.review.rounds');
  assert.equal(entry.code, 'range');
  assert.equal(entry.layer, 'project');
  assert.deepEqual(entry.allowed, { min: 1, max: 3 });
});

test('C-8: settings review.rounds below the rounds.min of the review.preset in the same settings is not-narrower', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({ schema: 1, taskClass: 'feature', settings: { 'review.preset': 'review-deep', 'review.rounds': 1 } }), 'settings.review.rounds');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, 'project');
  assert.match(entry.message, /review\.rounds 1 is below review-deep rounds\.min 2/);
  const ok = validate({ schema: 1, taskClass: 'feature', settings: { 'review.preset': 'review-deep', 'review.rounds': 2 } });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.deepEqual(ok.json, { ok: true, errors: [] });
});

test('settings entries: unknown key, security-relevant key and a key not settable at the project layer', (t) => {
  const { validate } = setup(t);
  const security = Object.entries(REGISTRY.keys).find(([, spec]: any) => spec.securityRelevant)![0];
  const global = Object.entries(REGISTRY.keys).find(([, spec]: any) => spec.scope === 'global-only' && !spec.securityRelevant)![0];
  const result = validate({ ...VALID(), settings: { 'no.such.key': 1, [security]: 'x', [global]: 'x' } });
  assert.equal(result.status, 1);
  const codes = Object.fromEntries(result.json.errors.map((e: any) => [e.key, e.code]));
  assert.deepEqual(codes, { 'settings.no.such.key': 'unknown-key', [`settings.${security}`]: 'security', [`settings.${global}`]: 'scope' });
});

test('primary fields use project-layer config validation', (t) => {
  const { validate } = setup(t);
  const harness = validate({ ...VALID(), primary: { harness: 'nope' } });
  assert.equal(harness.json.errors.length, 1);
  const harnessEntry = entryFor(harness, 'primary.harness');
  assert.equal(harnessEntry.code, 'enum');
  assert.equal(harnessEntry.layer, 'project');

  const model = validate({ ...VALID(), primary: { model: '-x' } });
  assert.equal(model.json.errors.length, 1);
  const modelEntry = entryFor(model, 'primary.model');
  assert.equal(modelEntry.code, 'type');
  assert.equal(modelEntry.layer, 'project');

  const valid = validate({ ...VALID(), primary: { harness: 'codex', model: 'gpt-6-luna' } });
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
  assert.deepEqual(valid.json, { ok: true, errors: [] });
});

test('primary accepts an empty object, rejects unknown fields and non-objects', (t) => {
  const { validate } = setup(t);
  const empty = validate({ ...VALID(), primary: {} });
  assert.equal(empty.status, 0, `${empty.stdout}${empty.stderr}`);
  assert.deepEqual(empty.json, { ok: true, errors: [] });

  const unknown = validate({ ...VALID(), primary: { harness: 'codex', bogus: 1 } });
  assert.equal(unknown.json.errors.length, 1);
  const unknownEntry = entryFor(unknown, 'primary.bogus');
  assert.equal(unknownEntry.code, 'unknown-key');
  assert.equal(unknownEntry.layer, null);

  const array = validate({ ...VALID(), primary: [] });
  assert.equal(array.json.errors.length, 1);
  const arrayEntry = entryFor(array, 'primary');
  assert.equal(arrayEntry.code, 'type');
  assert.equal(arrayEntry.layer, null);
});

test('primary and settings entries for the same key are judged independently', (t) => {
  const { validate } = setup(t);
  const result = validate({
    ...VALID(),
    primary: { harness: 'codex' },
    settings: { 'primary.harness': 'nope' },
  });
  assert.equal(result.json.errors.length, 1);
  const entry = entryFor(result, 'settings.primary.harness');
  assert.equal(entry.code, 'enum');
  assert.equal(entry.layer, 'project');
});

test('no top-level word is reserved; workers is recognized and other unknown keys remain unknown-key', (t) => {
  const { validate } = setup(t);
  const result = validate({ ...VALID(), primary: {}, workers: {}, bogus: 1 });
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.errors.map((e: any) => [e.key, e.code, e.layer]), [['bogus', 'unknown-key', null]]);
  assert.doesNotMatch(entryFor(result, 'bogus').message, /reserved/);
});

test('three faults in one file are three entries, all reported', (t) => {
  const { validate } = setup(t);
  const result = validate({ schema: 1, taskClass: 'nope', settings: { 'review.rounds': 9 }, workers: [] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.errors.map((e: any) => `${e.key}:${e.code}`).sort(),
    ['settings.review.rounds:range', 'taskClass:enum', 'workers:type']);
});

test('workers shape is checked independently from primary and settings', (t) => {
  const { f, validate } = setup(t);
  f.writeUserSettings({ schema: 1, 'workers.enabled': ['codex', 'antigravity', 'primary'] });
  const array = entryFor(validate({ ...VALID(), workers: [] }), 'workers');
  assert.equal(array.code, 'type');
  assert.equal(array.layer, null);
  assert.match(array.message, /object with enabled and models/);
  assert.equal(entryFor(validate({ ...VALID(), workers: { bogus: 1 } }), 'workers.bogus').code, 'unknown-key');

  const both = validate({ ...VALID(), primary: { harness: 'nope' }, workers: { enabled: ['codex', 'claude'] } });
  assert.equal(both.json.errors.some((e: any) => e.key === 'primary.harness'), true);
  assert.equal(both.json.errors.some((e: any) => e.key === 'workers.enabled[1]'), true);
  assert.equal(both.json.errors.some((e: any) => e.key === 'workers.enabled[1]' && e.code === 'not-narrower'), true);
});

test('workers.enabled applies project narrowing and reports shape faults at the first item', (t) => {
  const { f, validate } = setup(t);
  f.writeUserSettings({ schema: 1, 'workers.enabled': ['codex', 'antigravity', 'primary'] });
  const wider = entryFor(validate({ ...VALID(), workers: { enabled: ['codex', 'claude'] } }), 'workers.enabled[1]');
  assert.equal(wider.code, 'not-narrower');
  assert.equal(wider.layer, 'project');
  assert.match(wider.message, /'claude' is not in the value below/);

  const narrowed = validate({ ...VALID(), workers: { enabled: ['codex'] } });
  assert.equal(narrowed.status, 0, `${narrowed.stdout}${narrowed.stderr}`);
  assert.deepEqual(narrowed.json, { ok: true, errors: [] });

  const reordered = validate({ ...VALID(), workers: { enabled: ['antigravity', 'codex'] } });
  assert.equal(reordered.status, 0, `${reordered.stdout}${reordered.stderr}`);
  assert.ok(reordered.json.notes.some((note: string) => note.includes('order is ignored')));

  for (const [value, key, code] of [
    [['codex', 'codex'], 'workers.enabled[1]', 'items'],
    [['codex', 5], 'workers.enabled[1]', 'type'],
    [['codex', 'primary', 'antigravity'], 'workers.enabled[2]', 'items'],
    [['codex', 'auto'], 'workers.enabled[1]', 'reserved'],
    [[], 'workers.enabled', 'items'],
    ['codex', 'workers.enabled', 'type'],
    [null, 'workers.enabled', 'type'],
  ] as any[]) {
    const fault = entryFor(validate({ ...VALID(), workers: { enabled: value } }), key);
    assert.equal(fault.code, code, `${key} for ${JSON.stringify(value)}`);
  }

  const dangling = validate({ ...VALID(), workers: { enabled: ['codex', 'zzz-nope'] } });
  assert.equal(dangling.status, 0, `${dangling.stdout}${dangling.stderr}`);
  assert.ok(dangling.json.notes.some((note: string) => note.includes("worker 'zzz-nope' is not installed")));
});

test('workers.models validates bindings and reports unevidenced flags without exposing model names', (t) => {
  const { validate } = setup(t);
  assert.ok(SUPPORTED, 'registry includes a supported model flag');
  assert.ok(UNSUPPORTED, 'registry includes a worker without a supported model flag');

  const unsupported = validate({ ...VALID(), workers: { models: { [UNSUPPORTED]: { standard: 'secret-model', frontier: 'other-model' }, [SUPPORTED]: { frontier: 'gpt-X' } } } });
  assert.equal(unsupported.status, 1);
  assert.deepEqual(unsupported.json.errors.map((e: any) => [e.key, e.code, e.layer]), [
    [`workers.models.${UNSUPPORTED}.standard`, 'model-flag-unevidenced', null],
    [`workers.models.${UNSUPPORTED}.frontier`, 'model-flag-unevidenced', null],
  ]);
  assert.ok(unsupported.json.errors.every((e: any) => !e.message.includes('secret-model') && !e.message.includes('other-model')));

  const supported = validate({ ...VALID(), workers: { models: { [SUPPORTED]: { frontier: 'gpt-X' } } } });
  assert.equal(supported.status, 0, `${supported.stdout}${supported.stderr}`);
  assert.deepEqual(supported.json, { ok: true, errors: [] });

  for (const [value, code] of [
    [{ [SUPPORTED]: { huge: 'x' } }, 'enum'],
    [{ [SUPPORTED]: { standard: '-x' } }, 'type'],
    [{ primary: { standard: 'x' } }, 'reserved'],
    [null, 'type'],
  ] as any[]) {
    assert.equal(entryFor(validate({ ...VALID(), workers: { models: value } }), 'workers.models').code, code);
  }

  const dangling = validate({ ...VALID(), workers: { models: { 'zzz-nope': { standard: 'gpt-X' } } } });
  assert.equal(dangling.status, 0, `${dangling.stdout}${dangling.stderr}`);
  assert.ok(dangling.json.notes.some((note: string) => note.includes("worker 'zzz-nope' is not installed")));
});

test('workers prepared-run validation has no side effects and omits notes when none exist', (t) => {
  const { f, validate } = setup(t);
  const before = listing(f.project, f.home, f.xdg);
  const result = validate({ ...VALID(), workers: { enabled: ['codex'], models: { [SUPPORTED]: { frontier: 'gpt-X' } } } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.json, { ok: true, errors: [] });
  assert.deepEqual(listing(f.project, f.home, f.xdg), before);
});

test('prepared-run notes are printed after the valid text result', (t) => {
  const { f, validate } = setup(t);
  f.writeUserSettings({ schema: 1, 'workers.enabled': ['codex', 'antigravity', 'primary'] });
  const result = validate({ ...VALID(), workers: { enabled: ['antigravity', 'codex'] } }, []);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /^prepared run: valid \(/);
  assert.match(lines[1], /order is ignored at the project layer/);
});

test('bindingKey formats built-in and qualified worker ids', () => {
  const { bindingKey } = require('../../src/runtime/settings/prepared-run.ts');
  assert.equal(bindingKey('acme.coder', 'standard'), 'workers.models["acme.coder"].standard');
  assert.equal(bindingKey('codex', 'light'), 'workers.models.codex.light');
});

test('schema must be 1, taskClass is required, settings and presets must be objects', (t) => {
  const { validate } = setup(t);
  assert.equal(entryFor(validate({ schema: 2, taskClass: 'feature' }), 'schema').code, 'enum');
  assert.equal(entryFor(validate({ taskClass: 'feature' }), 'schema').code, 'type');
  assert.equal(entryFor(validate({ schema: 1 }), 'taskClass').code, 'type');
  assert.equal(entryFor(validate({ schema: 1, taskClass: 7 }), 'taskClass').code, 'type');
  assert.equal(entryFor(validate({ schema: 1, taskClass: 'feature', settings: [] }), 'settings').code, 'type');
  assert.equal(entryFor(validate({ schema: 1, taskClass: 'feature', presets: 'x' }), 'presets').code, 'type');
});

test('a file that is not JSON, or not an object, is one entry with key $ and code type', (t) => {
  const { validate } = setup(t);
  for (const content of ['{ nope', '[]', '"text"', 'null']) {
    const result = validate(content);
    assert.equal(result.status, 1, content);
    assert.equal(result.json.errors.length, 1);
    assert.equal(result.json.errors[0].key, '$');
    assert.equal(result.json.errors[0].code, 'type');
  }
});

test('usage faults exit 2: no path, an unreadable file (named, never its content), a positional, --layer', (t) => {
  const { f, prepared } = setup(t);
  assert.equal(f.run(['config', 'validate', '--prepared-run'], { env: BARE_PATH }).status, 2);
  const missing = path.join(f.dir, 'absent.json');
  const gone = f.run(['config', 'validate', '--prepared-run', missing, '--json'], { env: BARE_PATH });
  assert.equal(gone.status, 2);
  assert.match(gone.json.summary, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const dir = f.run(['config', 'validate', '--prepared-run', f.dir, '--json'], { env: BARE_PATH });
  assert.equal(dir.status, 2);
  const file = prepared(VALID());
  assert.equal(f.run(['config', 'validate', 'review.rounds', '--prepared-run', file], { env: BARE_PATH }).status, 2);
  assert.equal(f.run(['config', 'validate', '--prepared-run', file, '--layer', 'project'], { env: BARE_PATH }).status, 2);
  assert.equal(f.run(['config', 'set', '--prepared-run', file], { env: BARE_PATH }).status, 2);
});

test('a failing run writes nothing under the project, HOME or XDG_CONFIG_HOME either', (t) => {
  const { f, validate } = setup(t);
  f.writeProjectSettings({ schema: 1, 'review.rounds': 2 });
  const before = listing(f.project, f.home, f.xdg);
  const result = validate({ schema: 1, taskClass: 'nope', settings: { 'review.rounds': 9 }, primary: {} });
  assert.equal(result.status, 1);
  assert.deepEqual(listing(f.project, f.home, f.xdg), before);
});
