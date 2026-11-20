'use strict';

// 175 IC-001 / O-3: the effective bars of a kind. The package registry holds the defaults; the user's own override file
// `<config home>/advice-bars.json` may replace them. The reader fails closed on an invalid file, validates every block with
// the registry's own rules, and never reads a project file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../helper/tmp.ts');
const { loadAdviceRegistry } = require('../../../../src/runtime/advice/registry.ts');
const { effectiveBars } = require('../../../../src/runtime/advice/replay/bars.ts');

const REPO = path.resolve(__dirname, '../../../..');
const KIND = 'claim-support';

const registry = () => loadAdviceRegistry({ repoRoot: REPO }).registry;
/** A full block that differs from the package bars by `tag` in minCases (the show bar), so each level is told apart. */
const block = (tag: number) => {
  const bars = JSON.parse(JSON.stringify(registry().bars));
  bars.show.minCases = tag;
  bars.act.minCases = 1000;
  return bars;
};

function setup(t: any, override?: unknown) {
  const configHome = tempDir(t, 'doflow-bars-config-');
  if (override !== undefined) fs.writeFileSync(path.join(configHome, 'advice-bars.json'), typeof override === 'string' ? override : JSON.stringify(override));
  const reads: string[] = [];
  const fsImpl = { ...fs, readFileSync: (file: any, ...rest: any[]) => { reads.push(String(file)); return (fs.readFileSync as any)(file, ...rest); } };
  return { configHome, reads, roots: { 'config-home': configHome }, fsImpl };
}

function withKindBars(bars: unknown) {
  const reg = registry();
  reg.kinds.find((kind: any) => kind.id === KIND).bars = bars;
  return reg;
}

test('175 O-3 (d): no override file gives the package bars', (t) => {
  const f = setup(t);
  const result = effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'package');
  assert.deepEqual(result.bars, registry().bars);
});

test('175 O-3 (d): a root that does not resolve, like an absent file, gives the package bars and reads nothing', (t) => {
  const f = setup(t);
  const result = effectiveBars({ registry: registry(), kind: KIND, roots: { 'config-home': null }, fsImpl: f.fsImpl });
  assert.deepEqual([result.ok, result.source], [true, 'package']);
  assert.deepEqual(f.reads, []);
});

test('175 O-3 (d): each level of the precedence wins alone', (t) => {
  const own = (result: any) => [result.ok, result.source, result.bars?.show.minCases];
  // override.bars alone
  let f = setup(t, { schema: 1, bars: block(41) });
  assert.deepEqual(own(effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl })), [true, 'override', 41]);
  // kind.bars alone
  f = setup(t);
  assert.deepEqual(own(effectiveBars({ registry: withKindBars(block(42)), kind: KIND, roots: f.roots, fsImpl: f.fsImpl })), [true, 'kind', 42]);
  // override.kinds[k] alone
  f = setup(t, { schema: 1, kinds: { [KIND]: block(43) } });
  assert.deepEqual(own(effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl })), [true, 'override-kind', 43]);
});

test('175 O-3 (d): override.kinds[k] beats kind.bars beats override.bars beats the package bars', (t) => {
  const all = { schema: 1, bars: block(41), kinds: { [KIND]: block(43) } };
  let f = setup(t, all);
  assert.equal(effectiveBars({ registry: withKindBars(block(42)), kind: KIND, roots: f.roots, fsImpl: f.fsImpl }).bars.show.minCases, 43);
  f = setup(t, { schema: 1, bars: block(41) });
  assert.equal(effectiveBars({ registry: withKindBars(block(42)), kind: KIND, roots: f.roots, fsImpl: f.fsImpl }).bars.show.minCases, 42);
  assert.equal(effectiveBars({ registry: withKindBars(null), kind: KIND, roots: f.roots, fsImpl: f.fsImpl }).bars.show.minCases, 41);
  // an override block for another kind does not apply to this one
  f = setup(t, { schema: 1, kinds: { tier: block(44) } });
  const other = effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl });
  assert.deepEqual([other.ok, other.source], [true, 'package']);
  assert.equal(effectiveBars({ registry: registry(), kind: 'tier', roots: f.roots, fsImpl: f.fsImpl }).source, 'override-kind');
});

const invalid: Array<[string, unknown, RegExp]> = [
  ['a file that is not JSON', '{ nope', /advice-bars\.json/],
  ['a file that is not an object', '[]', /advice-bars\.json/],
  ['a wrong schema', { schema: 2 }, /schema/],
  ['an unknown top-level key', { schema: 1, extra: 1 }, /extra/],
  ['an unknown kind id', { schema: 1, kinds: { 'no-such-kind': {} } }, /kinds\.no-such-kind/],
  ['a partial default block', { schema: 1, bars: { version: 1, statistics: { confidence: 0.9, resamples: 5000, seed: 1 } } }, /bars\.show/],
  ['a partial kind block', { schema: 1, kinds: { [KIND]: { version: 1 } } }, /kinds\.claim-support\.statistics/],
  ['a block that breaks a rule', { schema: 1, bars: { ...block(30), act: { ...block(30).act, minCases: 5 } } }, /bars\.act\.minCases/],
  ['an unknown key in a block', { schema: 1, bars: { ...block(30), extra: true } }, /bars\.extra/],
];
for (const [name, override, pattern] of invalid) {
  test(`175 O-3 (d): ${name} is reported invalid, never replaced by the package bars`, (t) => {
    const f = setup(t, override);
    const result = effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bars-override-invalid');
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.match(result.errors.join('; '), pattern);
    assert.equal(Object.hasOwn(result, 'bars'), false);
  });
}

test('175 O-3 (d): a file that exists but cannot be read is invalid, not absent', (t) => {
  const f = setup(t, { schema: 1 });
  const fsImpl = { ...fs, readFileSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } };
  const result = effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl });
  assert.deepEqual([result.ok, result.reason], [false, 'bars-override-invalid']);
  assert.match(result.errors.join('; '), /permission denied/);
});

test('175 O-3 (d): a bars file planted under the project is never read; only the config home file is', (t) => {
  const project = tempDir(t, 'doflow-bars-project-');
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(project, '.doflow', 'advice-bars.json'), JSON.stringify({ schema: 1, bars: block(99) }));
  const f = setup(t, { schema: 1, bars: block(41) });
  const previous = process.cwd();
  process.chdir(project);
  try {
    const result = effectiveBars({ registry: registry(), kind: KIND, roots: f.roots, fsImpl: f.fsImpl });
    assert.equal(result.bars.show.minCases, 41);
  } finally { process.chdir(previous); }
  assert.deepEqual(f.reads, [path.join(f.configHome, 'advice-bars.json')]);
});
