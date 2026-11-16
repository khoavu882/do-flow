'use strict';
// 169 design §4.4 (T1): the `worker.provider`, `worker.effort` and `worker.modelList.columns` / `providerInId`
// grammar, one refusal per rule, and the two valid shapes of design §8 (Pi, OpenCode). Descriptors are built from an
// in-memory copy of the shipped pi / opencode worker blocks, so the shipped file is never edited here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const parts = require('../../src/registry/model-parts.ts');

const REPO = path.resolve(__dirname, '../..');
const REGISTRY = loadRegistry({ repoRoot: REPO });
const shipped = (id: string) => JSON.parse(JSON.stringify(REGISTRY.harnesses.find((h: any) => h.id === id).worker));

const entry = (extra: any, status = 'supported') => ({
  status, evidence: ['core/worker-evidence/pi/2026-11-07-cli-check-model.json'],
  verification: 'Read the matched help line.', verifiedOn: '2026-11-16', ...extra,
});
const piProvider = () => entry({ via: 'id-prefix', separator: '/' });
const piEffort = () => entry({
  via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  offLevel: 'off', mayLower: true,
});
const piColumns = () => ({ provider: 'provider', contextTokens: 'context', maxOutputTokens: 'max-out', reasoning: 'thinking', imageInput: 'images' });
const pi = () => {
  const w = shipped('pi');
  w.provider = entry({ via: 'flag', argv: ['--provider', '{provider}'] });
  w.effort = piEffort();
  w.modelList = { ...w.modelList, columns: piColumns() };
  return w;
};
const opencode = () => {
  const w = shipped('opencode');
  w.provider = piProvider();
  w.effort = entry({ via: 'id-suffix', separator: '#', levels: 'per-model' });
  w.modelList = { ...w.modelList, providerInId: true };
  return w;
};
const errorsOf = (w: any) => {
  const errors: string[] = [];
  validateWorker(w, "harness 'x'", errors);
  return errors;
};
const refused = (w: any, pattern: RegExp) => {
  const errors = errorsOf(w);
  assert.ok(errors.some((line) => pattern.test(line)), `expected ${pattern} in:\n${errors.join('\n')}`);
  for (const line of errors) assert.ok(line.startsWith("harness 'x' worker '"), `message names harness and worker: ${line}`);
};

test('the shipped pi and opencode blocks still validate (the baseline the cases below edit)', () => {
  assert.deepEqual(errorsOf(shipped('pi')), []);
  assert.deepEqual(errorsOf(shipped('opencode')), []);
});

test('the Pi shape of design §8 is accepted (id-prefix provider, flag effort with offLevel and mayLower, columns)', () => {
  const w = pi();
  w.provider = piProvider();
  assert.deepEqual(errorsOf(w), []);
  assert.equal(w.effort.argv[0], '--thinking');
  assert.ok(w.oneShot.argv.includes('--thinking'), "Pi's fixed one-shot `--thinking off` stays; rule 3 accepts a fixed value");
});

test('a flag provider [--provider, {provider}] is accepted', () => {
  assert.deepEqual(errorsOf(pi()), []);
});

test('the OpenCode shape of design §8 is accepted (id-prefix provider, id-suffix per-model effort, providerInId on lines)', () => {
  assert.deepEqual(errorsOf(opencode()), []);
});

test('the key= effort form [--flag, key={effort}] is accepted for a harmless key', () => {
  const w = pi();
  w.effort = entry({ via: 'flag', argv: ['--variant', 'reasoning_effort={effort}'], levels: ['low', 'high'] });
  assert.deepEqual(errorsOf(w), []);
});

test('rule 1: provider or effort supported requires model supported', () => {
  for (const key of ['provider', 'effort']) {
    const w = opencode();
    w.model = { status: 'unknown', evidence: [], verification: 'x', verifiedOn: '2026-11-16', reason: 'no listing' };
    refused(w, new RegExp(`worker '${key}': requires worker 'model' to be supported`));
  }
});

test('rule 2: via is closed and its fields are exact', () => {
  let w = pi();
  w.provider = entry({ via: 'argv' });
  refused(w, /worker 'provider': via must be flag or id-prefix/);
  w = pi();
  w.provider = entry({ via: 'flag', argv: ['--provider', 'fixed'] });
  refused(w, /worker 'provider': .*\[<flag>, "\{provider\}"\]/);
  w = pi();
  w.provider = entry({ via: 'flag', argv: ['--provider', '{provider}'], separator: '/' });
  refused(w, /worker 'provider': via flag takes no 'separator'/);
  w = pi();
  w.provider = entry({ via: 'id-prefix' });
  refused(w, /worker 'provider': via id-prefix requires 'separator'/);
  w = pi();
  w.provider = entry({ via: 'id-prefix', separator: '|' });
  refused(w, /worker 'provider': separator must be one of/);
  w = pi();
  w.provider = entry({ via: 'id-prefix', separator: '/', argv: ['--provider', '{provider}'] });
  refused(w, /worker 'provider': via id-prefix takes no 'argv'/);
  w = pi();
  w.effort = entry({ via: 'id-suffix', levels: 'per-model' });
  refused(w, /worker 'effort': via id-suffix requires 'separator'/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['thinking', '{effort}'], levels: ['low'] });
  refused(w, /worker 'effort': .*\[<flag>, "\{effort\}"\]/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['--thinking', '{effort}'], levels: ['low'], mayLower: 'yes' });
  refused(w, /worker 'effort': mayLower must be a boolean/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['--thinking', 'bad key={effort}'], levels: ['low'] });
  refused(w, /worker 'effort': .*\[<flag>, "\{effort\}"\]/);
});

test('rule 2: levels are 1 to 16 distinct names or per-model; offLevel is one of a list', () => {
  const effortWith = (extra: any) => { const w = pi(); w.effort = entry({ via: 'flag', argv: ['--thinking', '{effort}'], ...extra }); return w; };
  refused(effortWith({ levels: [] }), /worker 'effort': levels must be 1 to 16 distinct names or "per-model"/);
  refused(effortWith({ levels: ['low', 'low'] }), /worker 'effort': levels must be 1 to 16 distinct names or "per-model"/);
  refused(effortWith({ levels: ['-low'] }), /worker 'effort': levels must be 1 to 16 distinct names or "per-model"/);
  refused(effortWith({ levels: Array.from({ length: 17 }, (_, i) => `l${i}`) }), /worker 'effort': levels must be 1 to 16/);
  refused(effortWith({ levels: 'every' }), /worker 'effort': levels must be 1 to 16 distinct names or "per-model"/);
  refused(effortWith({ levels: ['low', 'high'], offLevel: 'off' }), /worker 'effort': offLevel must be one of levels/);
  refused(effortWith({ levels: 'per-model', offLevel: 'off' }), /worker 'effort': offLevel is allowed only with a list of levels/);
  assert.deepEqual(errorsOf(effortWith({ levels: 'per-model' })).filter((line) => line.includes("worker 'effort'")), []);
});

test('rule 3: a transport flag may not be a flag of readOnly, spawnDenial or isolatedEdit', () => {
  for (const key of ['readOnly', 'spawnDenial']) {
    const w = pi();
    w[key] = { ...w[key], argv: [...w[key].argv, '--thinking', 'low'] };
    refused(w, new RegExp(`worker 'effort': transport flag '--thinking' must not appear in ${key}`));
  }
  const w = pi();
  w.isolatedEdit = entry({ argv: ['--thinking=low'] });
  refused(w, /worker 'effort': transport flag '--thinking' must not appear in isolatedEdit/);
});

test('rule 3: in oneShot, structuredOutput and mainSession the transport flag carries a fixed value', () => {
  let w = pi();
  w.oneShot = { ...w.oneShot, argv: ['-p', '--thinking', '{prompt}'] };
  refused(w, /worker 'effort': transport flag '--thinking' in oneShot must be followed by a fixed value/);
  w = pi();
  w.structuredOutput = { ...w.structuredOutput, argv: ['--mode', 'json', '--thinking'] };
  refused(w, /worker 'effort': transport flag '--thinking' in structuredOutput must be followed by a fixed value/);
  w = pi();
  w.oneShot = { ...w.oneShot, argv: ['-p', '--thinking={model}', '{prompt}'] };
  refused(w, /worker 'effort': transport flag '--thinking' in oneShot must be followed by a fixed value/);
  w = pi();
  w.oneShot = { ...w.oneShot, argv: ['-p', '--thinking=off', '{prompt}'] };
  assert.deepEqual(errorsOf(w), []);
});

test('rule 4: a widening or secret value among the levels, or a widening key=, is refused', () => {
  let w = pi();
  w.effort = entry({ via: 'flag', argv: ['--sandbox', '{effort}'], levels: ['low', 'danger-full-access'] });
  refused(w, /worker 'effort': levels value 'danger-full-access' makes the transport argv contain the widening flag/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['--config', 'sandbox_mode={effort}'], levels: ['danger-full-access'] });
  refused(w, /worker 'effort': levels value 'danger-full-access' makes the transport argv contain the widening flag/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['--config', 'sandbox_permissions={effort}'], levels: 'per-model' });
  refused(w, /worker 'effort': sample value .* makes the transport argv contain the widening flag/);
  w = pi();
  w.effort = entry({ via: 'flag', argv: ['--yolo', '{effort}'], levels: ['low'] });
  refused(w, /worker 'effort': .*contain the widening flag/);
  w = pi();
  w.provider = entry({ via: 'flag', argv: ['--allow-all-tools', '{provider}'] });
  refused(w, /worker 'provider': .*contain the widening flag/);
});

test('rule 5: provider columns and providerInId need provider supported; providerInId needs id-prefix', () => {
  let w = pi();
  w.provider = entry({}, 'unknown');
  w.provider.reason = 'no evidence';
  refused(w, /worker 'modelList': columns\.provider requires worker 'provider' to be supported/);
  w = opencode();
  w.provider = entry({}, 'unknown');
  w.provider.reason = 'no evidence';
  refused(w, /worker 'modelList': providerInId requires worker 'provider' to be supported/);
  w = opencode();
  w.provider = entry({ via: 'flag', argv: ['--provider', '{provider}'] });
  refused(w, /worker 'modelList': providerInId requires worker 'provider' via id-prefix/);
});

test('rule 6: columns need table-column:<name>; effortLevels and reasoning need effort supported', () => {
  let w = pi();
  w.modelList = { ...w.modelList, parse: 'lines' };
  refused(w, /worker 'modelList': columns requires parse table-column:<name>/);
  w = pi();
  w.effort = entry({}, 'unknown');
  w.effort.reason = 'no evidence';
  refused(w, /worker 'modelList': columns\.reasoning requires worker 'effort' to be supported/);
  w = pi();
  w.modelList.columns = { effortLevels: 'levels' };
  w.effort = entry({}, 'unknown');
  w.effort.reason = 'no evidence';
  refused(w, /worker 'modelList': columns\.effortLevels requires worker 'effort' to be supported/);
});

test('columns: object of known targets to distinct lowercase headers that are not the id column', () => {
  const colsWith = (columns: any) => { const w = pi(); w.modelList.columns = columns; return w; };
  refused(colsWith([]), /worker 'modelList': columns must be an object/);
  refused(colsWith({}), /worker 'modelList': columns must name at least one target/);
  refused(colsWith({ colour: 'colour' }), /worker 'modelList': columns has unknown target 'colour'/);
  refused(colsWith({ provider: 'Provider' }), /worker 'modelList': columns\.provider header must match/);
  refused(colsWith({ provider: 'a', displayName: 'a' }), /worker 'modelList': columns headers must be distinct/);
  refused(colsWith({ provider: 'model' }), /worker 'modelList': columns\.provider header must not be the id column 'model'/);
  const w = pi();
  w.modelList.columns = { displayName: 'name', effortLevels: 'levels' };
  assert.deepEqual(errorsOf(w), []);
  const none = shipped('claude');
  none.modelList = { status: 'none-recorded', reason: 'x', columns: { provider: 'p' } };
  refused(none, /worker 'modelList': has unknown field 'columns' for status none-recorded/);
});

test('providerInId is true or absent', () => {
  const w = opencode();
  w.modelList.providerInId = false;
  refused(w, /worker 'modelList': providerInId must be true/);
});

test('rule 7: a provider or effort entry over 2 KiB serialized is refused', () => {
  const w = pi();
  w.effort.evidence = Array.from({ length: 30 }, (_, i) => `core/worker-evidence/pi/${'x'.repeat(80)}-${i}.json`);
  refused(w, /worker 'effort': entry is .* bytes serialized; the limit is 2048/);
});

test('mayLower is a recipe field of a supported effort entry only', () => {
  const w = pi();
  w.effort = entry({ mayLower: true }, 'unknown');
  w.effort.reason = 'no evidence';
  refused(w, /worker 'effort': recipe field 'mayLower' is allowed only when status is supported/);
  const p = pi();
  p.provider = entry({ via: 'id-prefix', separator: '/', mayLower: true });
  refused(p, /worker 'provider': has unknown field 'mayLower'/);
});

test('the constants later tasks import are exported once', () => {
  assert.deepEqual([...parts.TRANSPORT_KINDS], ['flag', 'id-prefix', 'id-suffix']);
  assert.deepEqual([...parts.SEPARATORS], ['/', ':', '#', '@']);
  assert.ok(parts.PROVIDER_RE.test('openai') && !parts.PROVIDER_RE.test('-x') && !parts.PROVIDER_RE.test('a'.repeat(65)));
  assert.ok(parts.EFFORT_RE.test('xhigh') && !parts.EFFORT_RE.test('a'.repeat(33)));
  assert.deepEqual(Object.keys(parts.COLUMN_TARGETS), ['provider', 'displayName', 'contextTokens', 'maxOutputTokens', 'reasoning', 'imageInput', 'effortLevels']);
  assert.equal(parts.COLUMN_TARGETS.contextTokens, 'size');
  assert.equal(parts.COLUMN_TARGETS.reasoning, 'yes-no');
});

test('the shipped registry still loads', () => {
  assert.equal(REGISTRY.validation.ok, true, REGISTRY.validation.errors.join('\n'));
});
