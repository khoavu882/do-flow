'use strict';

// 119 IC-010, FR-013, NFR-005: `doflow config validate --prepared-run <file>`. Each case runs the CLI
// against a scratch HOME / XDG_CONFIG_HOME and a scratch project (test/helper/settings-fixtures.js)
// with PATH holding only the directory of this Node binary, so no harness, git or other tool is
// reachable, and checks nothing is written anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));
const BARE_PATH = { PATH: path.dirname(process.execPath) };

/** A fixture plus a `validate(file-content | object, extraArgs)` runner that writes the prepared run outside project and HOME. */
function setup(t) {
  const f = createSettingsEnv(t);
  let n = 0;
  const prepared = (content) => {
    n += 1;
    const file = path.join(f.dir, `prepared-${n}.json`);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const validate = (content, args = ['--json']) =>
    f.run(['config', 'validate', '--prepared-run', prepared(content), ...args], { env: BARE_PATH });
  return { f, prepared, validate };
}

const VALID = () => ({
  schema: 1, taskClass: 'feature', settings: { 'review.rounds': 3 },
  presets: { review: 'review-deep', debate: 'debate-3' },
});

/** Every file and folder under the roots, as a sorted list with sizes, to compare before and after. */
function listing(...roots) {
  const out = [];
  const walk = (p) => {
    const stat = fs.lstatSync(p);
    out.push(`${p}:${stat.isDirectory() ? 'dir' : stat.size}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  for (const root of roots) walk(root);
  return out.sort();
}

function entryFor(result, key) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, false);
  const found = result.json.errors.filter((e) => e.key === key);
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
  const bad = prepared({ schema: 1, taskClass: 'nope', primary: {} });
  const refused = f.run(['config', 'validate', '--prepared-run', bad], { env: BARE_PATH });
  assert.equal(refused.status, 1);
  const lines = refused.stderr.trim().split('\n');
  assert.equal(lines.length, 2, refused.stderr);
  assert.ok(lines[0].startsWith('taskClass: '), lines[0]);
  assert.ok(lines[1].startsWith('primary: '), lines[1]);
});

test('an unknown task class is refused as taskClass enum, listing the registry classes', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({ ...VALID(), taskClass: 'not-a-class' }), 'taskClass');
  assert.equal(entry.code, 'enum');
  assert.equal(entry.layer, null);
  assert.ok(Array.isArray(entry.allowed) && entry.allowed.includes('feature') && entry.allowed.includes('bug'), JSON.stringify(entry.allowed));
});

test('presets.review review-single for taskClass feature is below the gate-b seat floor: not-narrower naming the floor', (t) => {
  const { validate } = setup(t);
  const entry = entryFor(validate({ ...VALID(), presets: { review: 'review-single' } }), 'presets.review');
  assert.equal(entry.code, 'not-narrower');
  assert.equal(entry.layer, null);
  assert.match(entry.message, /\b2\b/, entry.message);
  assert.match(entry.message, /seat/, entry.message);
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

test('settings entries: unknown key, security-relevant key and a key not settable at the project layer', (t) => {
  const { validate } = setup(t);
  const security = Object.entries(REGISTRY.keys).find(([, spec]) => spec.securityRelevant)[0];
  const global = Object.entries(REGISTRY.keys).find(([, spec]) => spec.scope === 'global-only' && !spec.securityRelevant)[0];
  const result = validate({ ...VALID(), settings: { 'no.such.key': 1, [security]: 'x', [global]: 'x' } });
  assert.equal(result.status, 1);
  const codes = Object.fromEntries(result.json.errors.map((e) => [e.key, e.code]));
  assert.deepEqual(codes, { 'settings.no.such.key': 'unknown-key', [`settings.${security}`]: 'security', [`settings.${global}`]: 'scope' });
});

test('primary and workers are reserved for a later release; any other top-level key is unknown-key', (t) => {
  const { validate } = setup(t);
  const result = validate({ ...VALID(), primary: {}, workers: [], bogus: 1 });
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.errors.map((e) => [e.key, e.code, e.layer]),
    [['primary', 'unknown-key', null], ['workers', 'unknown-key', null], ['bogus', 'unknown-key', null]]);
  assert.match(entryFor(result, 'primary').message, /reserved for a later release/);
  assert.match(entryFor(result, 'workers').message, /reserved for a later release/);
  assert.doesNotMatch(entryFor(result, 'bogus').message, /reserved/);
});

test('three faults in one file are three entries, all reported', (t) => {
  const { validate } = setup(t);
  const result = validate({ schema: 1, taskClass: 'nope', settings: { 'review.rounds': 9 }, primary: {} });
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.errors.map((e) => `${e.key}:${e.code}`).sort(),
    ['primary:unknown-key', 'settings.review.rounds:range', 'taskClass:enum']);
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
