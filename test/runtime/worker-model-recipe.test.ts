'use strict';

// 120 IC-011: optional model recipes, whole-element substitution and free-check evidence.
// C controls pin the pre-existing unbound recipe behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { withPiReadOnly } = require('../helper/pi-read-only.ts');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const {
  assembleArgv, argvShape, launchRecord, mainArgv, RECIPE_ORDER, EDIT_RECIPE_ORDER,
} = require('../../src/runtime/worker/launch.ts');
const { recordCliChecks } = require('../../src/runtime/worker/evidence.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const REPO = path.resolve(__dirname, '../..');
const DATE = '2026-10-24';
const BINDING = { model: 'gpt-x', flag: 'supported' };
const TAIL = [
  '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
  '--json', '-o', '/tmp/lm', '--ephemeral', '-',
];

/** IC-011: a fresh shipped descriptor for each recipe mutation. */
function workerOf(id = 'codex') {
  const worker = structuredClone(loadRegistry({ repoRoot: REPO }).harnesses.find((h: any) => h.id === id).worker);
  // 178 G-1: the shipped pi has `readOnly` and `spawnDenial` unknown; its recipe shape is tried on the fixture a live run would restore.
  return id === 'pi' ? withPiReadOnly(worker) : worker;
}

/** IC-011: a supported entry whose evidence content is irrelevant to schema-only validation. */
function supported(argv: any) {
  return { status: 'supported', evidence: ['x'], verification: 'v', verifiedOn: DATE, argv };
}

/** IC-011: validate a scratch registry without touching its source file. */
function mutated(mutate: any) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses.find((h: any) => h.id === 'claude').worker);
  return validateRegistry(registry, { repoRoot: REPO });
}

/** IC-011: require the named validator message, including its worker-entry prefix. */
function refused(mutate: any, key: any, message: any) {
  const result = mutated(mutate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes(`harness 'claude' worker '${key}': ${message}`), result.errors.join('\n'));
}

test('IC-011: model is second in both recipe orders', () => {
  assert.deepEqual(RECIPE_ORDER, ['readOnly', 'model', 'spawnDenial', 'structuredOutput', 'oneShot']);
  assert.deepEqual(EDIT_RECIPE_ORDER, ['isolatedEdit', 'model', 'spawnDenial', 'structuredOutput', 'oneShot']);
});

test('IC-011: a supported binding inserts a whole model element in both orders; shapes preserve it', () => {
  const recipe = workerOf();
  recipe.model = supported(['-m', '{model}']);
  for (const edit of [false, true]) {
    const first = ['exec', '-s', edit ? 'workspace-write' : 'read-only'];
    assert.deepEqual(assembleArgv(recipe, 'p', edit, '/tmp/lm', BINDING), [
      ...first, '-m', 'gpt-x', ...TAIL,
    ]);
    const shape = argvShape(recipe, 'p', edit, BINDING);
    assert.deepEqual(shape, [
      ...first, '-m', '{model}', ...TAIL.map((value) => value === '/tmp/lm' ? '<last-message-file>' : value),
    ]);
    assert.ok(!shape.includes('gpt-x'));
    const record = launchRecord(recipe, { run: 'r', lineage: 'l', attempt: '1', runSource: 'claim' }, 'p', edit, BINDING);
    assert.deepEqual(record.recipe.argvShape, shape);
    assert.ok(!JSON.stringify(record).includes('gpt-x'));
  }
});

test('IC-011 C control: inactive and absent bindings keep the codex argv byte-identical', () => {
  const recipe = workerOf();
  const base = ['exec', '-s', 'read-only', ...TAIL];
  assert.deepEqual(assembleArgv(recipe, 'p', false, '/tmp/lm'), base);
  for (const binding of [null, { model: 'm', flag: 'unevidenced' }, { model: 'm', flag: 'n/a' }]) {
    assert.deepEqual(assembleArgv(recipe, 'p', false, '/tmp/lm', binding), base);
  }
});

test('IC-011: a supported binding needs a non-empty model in argv and shape assembly', () => {
  const recipe = workerOf();
  recipe.model = supported(['-m', '{model}']);
  for (const model of [null, '']) {
    const binding = { model, flag: 'supported' };
    assert.throws(() => assembleArgv(recipe, 'p', false, '/tmp/lm', binding), { code: 'model-invalid' });
    assert.throws(() => argvShape(recipe, 'p', false, binding), { code: 'model-invalid' });
  }
});

test('IC-011: a supported binding requires a supported model recipe with an argv', () => {
  const recipe = workerOf();
  const incomplete = [
    { status: 'unknown', evidence: [], verification: 'v', verifiedOn: DATE, reason: 'unverified' },
    { status: 'supported', evidence: ['x'], verification: 'v', verifiedOn: DATE },
  ];
  for (const entry of incomplete) {
    recipe.model = entry;
    assert.throws(() => assembleArgv(recipe, 'p', false, '/tmp/lm', BINDING), {
      code: 'recipe-incomplete',
      message: "assembleArgv: worker 'model' is not supported with an argv",
    });
  }
});

test('IC-011 C control: all seven harnesses keep plain group concatenation without an applied binding', () => {
  const fixture = DESCRIPTORS.claude;
  const prompt = 'p';
  const hash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const promptShape = `<prompt sha256:${hash} bytes:1>`;
  const harnesses = loadRegistry({ repoRoot: REPO }).harnesses;
  assert.equal(harnesses.length, 7);
  for (const harness of harnesses) {
    const recipe = structuredClone(harness.worker);
    for (const key of ['readOnly', 'spawnDenial', 'structuredOutput', 'oneShot']) {
      recipe[key] = structuredClone(fixture[key]);
    }
    recipe.isolatedEdit = structuredClone(fixture.readOnly);
    for (const edit of [false, true]) {
      const order = [edit ? 'isolatedEdit' : 'readOnly', 'spawnDenial', 'structuredOutput', 'oneShot'];
      const plain = order.flatMap((key) => recipe[key].argv);
      const expected = plain.map((value) => value === '{prompt}' ? prompt : value);
      const shape = plain.map((value) => value === '{prompt}' ? promptShape : value);
      assert.deepEqual(assembleArgv(recipe, prompt, edit), expected, `${harness.id} absent binding`);
      assert.deepEqual(argvShape(recipe, prompt, edit), shape, `${harness.id} absent shape binding`);
      for (const binding of [null, { model: 'm', flag: 'unevidenced' }]) {
        assert.deepEqual(assembleArgv(recipe, prompt, edit, undefined, binding), expected, harness.id);
        assert.deepEqual(argvShape(recipe, prompt, edit, binding), shape, harness.id);
      }
    }
  }
});

test('IC-011: supported model argv accepts short and long flags with one whole placeholder', () => {
  for (const argv of [['-m', '{model}'], ['--model', '{model}']]) {
    const result = mutated((worker: any) => { worker.model = supported(argv); });
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
});

test('IC-011: model argv refuses partial, duplicate and missing placeholders', () => {
  for (const argv of [
    ['-m', 'x{model}'],
    ['--model={model}'],
    ['{model}', '{model}'],
    ['-m', 'x'],
    ['{model}', 'x{model}'],
  ]) {
    refused((worker: any) => { worker.model = supported(argv); }, 'model',
      "argv must contain the element '{model}' exactly once, as a whole element");
  }
});

test('IC-011: every other entry argv and versionArgv refuse even a partial model placeholder', () => {
  for (const element of ['{model}', 'x{model}']) {
    refused((worker: any) => { worker.readOnly = supported(['--read-only', element]); }, 'readOnly',
      "argv must not contain '{model}' outside model.argv");
    refused((worker: any) => { worker.cli.versionArgv = ['--version', element]; }, 'cli',
      "versionArgv must not contain '{model}' outside model.argv");
  }
});

test('IC-011: modelChecks argv refuses whole and partial model placeholders', () => {
  for (const element of ['{model}', 'x{model}']) {
    refused((worker: any) => {
      worker.modelChecks = [{
        id: 'c', argv: ['x', element], establishes: ['hooksLoaded'], estimateTokens: 1, timeoutSeconds: 1,
      }];
    }, 'modelChecks[0]', "argv must not contain '{model}' outside model.argv");
  }
});

test('IC-011: an unknown model entry may not carry argv', () => {
  refused((worker: any) => {
    worker.model = {
      status: 'unknown', evidence: [], verification: 'v', verifiedOn: DATE, reason: 'unverified',
      argv: ['-m', '{model}'],
    };
  }, 'model', "recipe field 'argv' is allowed only when status is supported");
});

test('IC-011: codex and the six harnesses with a recorded --model help line declare it supported', () => {
  const harnesses = loadRegistry({ repoRoot: REPO }).harnesses;
  assert.equal(harnesses.length, 7);
  for (const harness of harnesses) {
    const entry = harness.worker.model;
    assert.ok(entry, `${harness.id} declares model`);
    assert.equal(Object.keys(harness.worker).indexOf('model'), Object.keys(harness.worker).indexOf('isolatedEdit') + 1);
    if (harness.id === 'codex') {
      assert.equal(entry.verifiedOn, DATE);
      assert.equal(entry.status, 'supported', harness.id);
      assert.deepEqual(entry.argv, ['-m', '{model}']);
      assert.deepEqual(entry.evidence, ['core/worker-evidence/codex/2026-10-24-cli-check.json']);
    } else if (harness.id === 'antigravity') {
      // agy prints --help on stderr; the evidence check reads stdout and stderr, and its 2026-11-07 record passes help-model.
      assert.equal(entry.status, 'supported', harness.id);
      assert.deepEqual(entry.argv, ['--model', '{model}']);
      assert.deepEqual(entry.evidence, ['core/worker-evidence/antigravity/2026-11-07-cli-check.json']);
      assert.equal(entry.verifiedOn, '2026-11-07');
    } else if (['claude', 'copilot', 'pi', 'opencode', 'kiro'].includes(harness.id)) {
      // 146: the `--model <id>` flag each CLI lists in --help, recorded by the help-model free check.
      assert.equal(entry.status, 'supported', harness.id);
      assert.deepEqual(entry.argv, ['--model', '{model}']);
      // copilot's checks.json changed again in 147, so its one record is the later cli-check made with it.
      assert.deepEqual(entry.evidence, [harness.id === 'copilot' ? 'core/worker-evidence/copilot/2026-11-07-cli-check-available-tools.json' : `core/worker-evidence/${harness.id}/2026-11-07-cli-check-model.json`]);
      assert.equal(entry.verifiedOn, '2026-11-07');
    } else {
      assert.fail(`unexpected harness ${harness.id}`);
    }
  }
  assert.equal(harnesses.find((h: any) => h.id === 'antigravity').worker.oneShot.status, 'unknown');
});

test('IC-011: codex declares the free exec-model check', () => {
  const checks = JSON.parse(fs.readFileSync(path.join(REPO, 'core/worker-evidence/codex/checks.json'), 'utf8'));
  assert.deepEqual(checks.checks.find((check: any) => check.id === 'exec-model'), {
    id: 'exec-model',
    argv: ['exec', '--help'],
    expect: ['^\\s+-m, --model <MODEL>$'],
    establishes: ['model'],
  });
});

test('IC-011: antigravity free evidence establishes model only when its help line matches', (t) => {
  for (const [label, help, expected] of [
    ['pass', '  --model   Select a model\n', ['model']],
    ['fail', 'Usage: agy [options]\n', []],
  ]) {
    const dir = tempDir(t, 'doflow-worker-model-check-');
    const bin = path.join(dir, 'bin');
    const config = path.join(dir, 'config');
    fs.mkdirSync(bin);
    fs.mkdirSync(config);
    const binary = path.join(bin, 'agy');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const env = { HOME: dir, XDG_CONFIG_HOME: config, PATH: bin };
    const calls: any[] = [];
    const out = path.join(dir, 'record.json');
    const result = recordCliChecks({
      checksFile: path.join(REPO, 'core/worker-evidence/antigravity/checks.json'),
      harness: 'antigravity',
      worker: workerOf('antigravity'),
      out,
      cwd: dir,
      env,
      platform: 'linux',
      now: () => new Date('2026-10-24T00:00:00.000Z'),
      spawnSyncImpl(command: any, argv: any[], options: any) {
        assert.equal(command, binary);
        assert.equal(options.env, env);
        assert.equal(options.cwd, dir);
        assert.equal(options.shell, false);
        calls.push([...argv]);
        assert.ok(argv.length === 1 && ['--version', '--help'].includes(argv[0]));
        return { status: 0, stdout: Buffer.from(argv[0] === '--version' ? '1.4.6\n' : help) };
      },
    });
    // 165 review B-2 added the widening-flags check: a sixth --help.
    assert.deepEqual(calls, [['--version'], ['--help'], ['--help'], ['--help'], ['--help'], ['--help'], ['--help']]);
    assert.deepEqual(result.establishes, expected, label);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(record.cliVersion, '1.4.6');
    assert.deepEqual(record.establishes, expected, label);
    const modelCheck = record.checks.find((c: any) => c.id === 'help-model');
    assert.ok(modelCheck);
    assert.equal(modelCheck.id, 'help-model');
    assert.equal(modelCheck.result, label);
    assert.deepEqual(modelCheck.establishes, ['model']);
    assert.deepEqual(modelCheck.matched, label === 'pass' ? [(help as string).trimEnd()] : []);
  }
});

// ---- 169 T4: provider and effort reach the argv through composeModelPart ---------------------------------------------

const ENTRY = { evidence: ['x'], verification: 'v', verifiedOn: DATE };
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** The shipped Pi worker block plus the Pi shape of design §8: an id-prefix provider and a `--thinking {effort}` flag effort. */
function piShaped(extra: any = {}) {
  const worker = workerOf('pi');
  worker.provider = { status: 'supported', ...ENTRY, via: 'id-prefix', separator: '/' };
  worker.effort = { status: 'supported', ...ENTRY, via: 'flag', argv: ['--thinking', '{effort}'], levels: LEVELS, offLevel: 'off', mayLower: true };
  return Object.assign(worker, extra);
}
const PI_BASE = () => assembleArgv(workerOf('pi'), 'p', false);

test('169 R-4: with no effort bound the Pi-shaped argv is byte for byte the shipped one, and carries no `--thinking`', () => {
  const shaped = piShaped();
  const plain = { model: 'm1', flag: 'supported' };
  const withNulls = { model: 'm1', provider: null, effort: null, flag: 'supported' };
  const shipped = assembleArgv(workerOf('pi'), 'p', false, undefined, plain);
  assert.deepEqual(assembleArgv(shaped, 'p', false, undefined, plain), shipped);
  assert.deepEqual(assembleArgv(shaped, 'p', false, undefined, withNulls), shipped);
  assert.deepEqual(argvShape(shaped, 'p', false, withNulls), argvShape(workerOf('pi'), 'p', false, plain));
  assert.deepEqual(assembleArgv(shaped, 'p', false), PI_BASE());
  assert.equal(shipped.includes('--thinking'), false);
});

test('169: a bound effort puts `--thinking <level>` in the argv once', () => {
  const argv = assembleArgv(piShaped(), 'p', false, undefined, { model: 'm1', provider: null, effort: 'high', flag: 'supported' });
  assert.equal(argv.filter((item: string) => item === '--thinking').length, 1);
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'high');
  assert.equal(argv.includes('off'), false);
  assert.deepEqual(argv.slice(2, 4), ['--model', 'm1']);
  const editable = piShaped({ isolatedEdit: { status: 'supported', ...ENTRY, argv: ['--tools', 'read,edit'] } });
  const edit = assembleArgv(editable, 'p', true, undefined, { model: 'm1', provider: null, effort: 'high', flag: 'supported' }).join(' ');
  assert.equal(edit.includes('--thinking high'), true);
});

test('169: the stored shape holds {model}, {provider} and {effort}, never a bound value', () => {
  const binding = { model: 'secretish-model', provider: 'prov-x', effort: 'xhigh', flag: 'supported' };
  const shape = argvShape(piShaped(), 'p', false, binding);
  assert.equal(shape[shape.indexOf('--thinking') + 1], '{effort}');
  assert.deepEqual(shape.slice(2, 4), ['--model', '{provider}/{model}']);
  const record = launchRecord(piShaped(), { run: 'r', lineage: 'l', attempt: '1', runSource: 'claim' }, 'p', false, binding);
  assert.deepEqual(record.recipe.argvShape, shape);
  const text = JSON.stringify(record);
  for (const value of ['secretish-model', 'prov-x', 'xhigh']) assert.equal(text.includes(value), false, value);
});

test('169: a provider composes through its transport: id-prefix into the id, flag as a pair that replaces a fixed copy', () => {
  const prefixed = assembleArgv(piShaped(), 'p', false, undefined, { model: 'm1', provider: 'openai', effort: null, flag: 'supported' });
  assert.deepEqual(prefixed.slice(2, 4), ['--model', 'openai/m1']);
  const flagged = piShaped({ provider: { status: 'supported', ...ENTRY, via: 'flag', argv: ['--provider', '{provider}'] } });
  flagged.oneShot.argv = ['--provider=fixed', ...flagged.oneShot.argv];
  const argv = assembleArgv(flagged, 'p', false, undefined, { model: 'm1', provider: 'openai', effort: null, flag: 'supported' });
  assert.deepEqual(argv.slice(2, 6), ['--model', 'm1', '--provider', 'openai']);
  assert.equal(argv.filter((item: string) => item.startsWith('--provider')).length, 1);
});

test('169: a safety piece keeps its flags; only oneShot, structuredOutput and mainSession lose a fixed copy of the provider flag', () => {
  const worker = piShaped({ provider: { status: 'supported', ...ENTRY, via: 'flag', argv: ['--provider', '{provider}'] } });
  worker.structuredOutput.argv = ['--provider', 'fixed', ...worker.structuredOutput.argv];
  worker.readOnly.argv = ['--provider', 'kept', ...worker.readOnly.argv];
  const argv = assembleArgv(worker, 'p', false, undefined, { model: 'm1', provider: 'openai', effort: null, flag: 'supported' });
  assert.deepEqual(argv.filter((item: string, i: number) => argv[i - 1] === '--provider'), ['kept', 'openai']);
  assert.equal(argv.includes('fixed'), false);
});

test('169: a part the descriptor cannot take is refused with its reason, a value outside its pattern too', () => {
  const unknown = piShaped({ effort: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: DATE, reason: 'no evidence' } });
  assert.throws(() => assembleArgv(unknown, 'p', false, undefined, { model: 'm1', provider: null, effort: 'high', flag: 'supported' }), { code: 'model-part-unsupported' });
  assert.throws(() => assembleArgv(piShaped(), 'p', false, undefined, { model: 'm1', provider: null, effort: 'turbo', flag: 'supported' }), { code: 'model-part-invalid' });
  assert.throws(() => argvShape(unknown, 'p', false, { model: 'm1', provider: null, effort: 'high', flag: 'supported' }), { code: 'model-part-unsupported' });
});

// ---- 169 review A-01: a keyed provider transport strips only its own key ----------------------------------------------

/** The reviewer's case: codex-shaped, provider carried by `-c model_provider={provider}`, other fixed `-c k=v` pairs around it. */
function keyedProvider() {
  const worker = workerOf('codex');
  worker.provider = { status: 'supported', ...ENTRY, via: 'flag', argv: ['-c', 'model_provider={provider}'] };
  worker.oneShot.argv = ['-c', 'hide_agent_reasoning=true', '-c', 'file_opener=none', '-c', 'model_provider=old', '-'];
  worker.structuredOutput.argv = ['--json', '-c', 'hide_agent_reasoning=true', '-c=model_provider=older', '-o', '{lastMessageFile}'];
  worker.mainSession.argv = ['exec', '-c', 'file_opener=none', '-c', 'model_provider=old', '--json', '-o', '{lastMessageFile}', '-'];
  return worker;
}
const PAIRS = (argv: string[]) => argv.flatMap((item: string, i: number) => (item === '-c' ? [`${item} ${argv[i + 1]}`] : []));

test('169 A-01: a keyed provider transport drops only its own `-c <key>=...` pair; every other fixed pair survives', () => {
  const bound = { model: 'm1', provider: 'acme', effort: null, flag: 'supported' };
  const argv = assembleArgv(keyedProvider(), 'p', false, '/tmp/lm', bound);
  for (const pair of ['-c hide_agent_reasoning=true', '-c file_opener=none']) assert.ok(PAIRS(argv).includes(pair), pair);
  assert.equal(PAIRS(argv).filter((pair: string) => pair.startsWith('-c model_provider=')).length, 1);
  assert.equal(argv.includes('-c=model_provider=older'), false, 'the `F=key=...` token of the same key is dropped too');
  assert.equal(argv.filter((item: string) => item === 'hide_agent_reasoning=true').length, 2, 'both pieces keep their pair');
  const main = mainArgv(keyedProvider(), 'p', '/tmp/lm', { model: 'm1', provider: 'acme', effort: null });
  assert.ok(main.includes('file_opener=none'));
  assert.equal(PAIRS(main).filter((pair: string) => pair.startsWith('-c model_provider=')).length, 1);
  assert.ok(main.includes('model_provider=acme'));
});

test('169 A-01: a bare provider value (no key) drops every `F v` pair of its flag', () => {
  const worker = piShaped({ provider: { status: 'supported', ...ENTRY, via: 'flag', argv: ['--provider', '{provider}'] } });
  worker.oneShot.argv = ['--provider', 'fixed', ...worker.oneShot.argv];
  const argv = assembleArgv(worker, 'p', false, undefined, { model: 'm1', provider: 'acme', effort: null, flag: 'supported' });
  assert.equal(argv.includes('fixed'), false);
});

// ---- 169 review A-06: the launcher runs the secret check on the final argv ---------------------------------------------

test('169 A-06: a bound value that forms a secret-printing command in the final argv is refused, in the worker and the main-session argv', () => {
  const worker = piShaped({ provider: { status: 'supported', ...ENTRY, via: 'flag', argv: ['--provider', '{provider}'] } });
  const bound = (provider: string) => ({ model: 'm1', provider, effort: null, flag: 'supported' });
  for (const [label, run] of [
    ['one-shot', () => assembleArgv(worker, 'p', false, undefined, bound('print-api-key'))],
    ['main session', () => mainArgv(worker, 'p', undefined, { model: 'm1', provider: 'print-api-key', effort: null })],
  ] as const) {
    assert.throws(run, { code: 'secret-flag', message: /print-api-key/ }, label);
  }
  // A model id counts too, and so does a command the worker declares in its own `secretFlags`.
  assert.throws(() => assembleArgv(workerOf('pi'), 'p', false, undefined, { model: 'print-bearer-token', flag: 'supported' }), { code: 'secret-flag' });
  const declared = piShaped({ secretFlags: [{ command: ['leak-me'] }] });
  assert.throws(() => assembleArgv(declared, 'p', false, undefined, { model: 'leak-me', provider: null, effort: null, flag: 'supported' }), { code: 'secret-flag' });
  // A harmless value and an unbound launch are untouched.
  assert.doesNotThrow(() => assembleArgv(worker, 'p', false, undefined, bound('openai')));
  assert.doesNotThrow(() => assembleArgv(declared, 'p', false));
});
