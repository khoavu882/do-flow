'use strict';

// 120 IC-011: optional model recipes, whole-element substitution and free-check evidence.
// C controls pin the pre-existing unbound recipe behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const {
  assembleArgv, argvShape, launchRecord, RECIPE_ORDER, EDIT_RECIPE_ORDER,
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
  return structuredClone(loadRegistry({ repoRoot: REPO }).harnesses.find((h) => h.id === id).worker);
}

/** IC-011: a supported entry whose evidence content is irrelevant to schema-only validation. */
function supported(argv) {
  return { status: 'supported', evidence: ['x'], verification: 'v', verifiedOn: DATE, argv };
}

/** IC-011: validate a scratch registry without touching its source file. */
function mutated(mutate) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses.find((h) => h.id === 'claude').worker);
  return validateRegistry(registry, { repoRoot: REPO });
}

/** IC-011: require the named validator message, including its worker-entry prefix. */
function refused(mutate, key, message) {
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

test('IC-011 C control: all eight harnesses keep plain group concatenation without an applied binding', () => {
  const fixture = DESCRIPTORS.claude;
  const prompt = 'p';
  const hash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const promptShape = `<prompt sha256:${hash} bytes:1>`;
  const harnesses = loadRegistry({ repoRoot: REPO }).harnesses;
  assert.equal(harnesses.length, 8);
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
    const result = mutated((worker) => { worker.model = supported(argv); });
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
    refused((worker) => { worker.model = supported(argv); }, 'model',
      "argv must contain the element '{model}' exactly once, as a whole element");
  }
});

test('IC-011: every other entry argv and versionArgv refuse even a partial model placeholder', () => {
  for (const element of ['{model}', 'x{model}']) {
    refused((worker) => { worker.readOnly = supported(['--read-only', element]); }, 'readOnly',
      "argv must not contain '{model}' outside model.argv");
    refused((worker) => { worker.cli.versionArgv = ['--version', element]; }, 'cli',
      "versionArgv must not contain '{model}' outside model.argv");
  }
});

test('IC-011: modelChecks argv refuses whole and partial model placeholders', () => {
  for (const element of ['{model}', 'x{model}']) {
    refused((worker) => {
      worker.modelChecks = [{
        id: 'c', argv: ['x', element], establishes: ['hooksLoaded'], estimateTokens: 1, timeoutSeconds: 1,
      }];
    }, 'modelChecks[0]', "argv must not contain '{model}' outside model.argv");
  }
});

test('IC-011: an unknown model entry may not carry argv', () => {
  refused((worker) => {
    worker.model = {
      status: 'unknown', evidence: [], verification: 'v', verifiedOn: DATE, reason: 'unverified',
      argv: ['-m', '{model}'],
    };
  }, 'model', "recipe field 'argv' is allowed only when status is supported");
});

test('IC-011: seven shipped harnesses declare unknown model without argv; only codex is supported', () => {
  const harnesses = loadRegistry({ repoRoot: REPO }).harnesses;
  assert.equal(harnesses.length, 8);
  for (const harness of harnesses) {
    const entry = harness.worker.model;
    assert.ok(entry, `${harness.id} declares model`);
    assert.equal(entry.verifiedOn, DATE);
    assert.equal(Object.keys(harness.worker).indexOf('model'), Object.keys(harness.worker).indexOf('isolatedEdit') + 1);
    if (harness.id === 'codex') {
      assert.equal(entry.status, 'supported', harness.id);
      assert.deepEqual(entry.argv, ['-m', '{model}']);
      assert.deepEqual(entry.evidence, ['core/worker-evidence/codex/2026-10-24-cli-check.json']);
    } else {
      const binary = harness.worker.cli.binary;
      assert.deepEqual(entry, {
        status: 'unknown',
        evidence: [],
        verification: harness.id === 'antigravity'
          ? 'Run `agy --help` and read the `--model` line; record it with `node bin/doflow.js worker --action evidence --harness antigravity --checks core/worker-evidence/antigravity/checks.json --out <new cli-check path>` (check help-model)'
          : `Read ${harness.id}'s headless CLI documentation and \`${binary} --help\`; record the flag that selects the model and its source`,
        verifiedOn: DATE,
        reason: harness.id === 'antigravity'
          ? 'declared: agy --help lists --model on stderr, but the free check help-model reads stdout only and fails; supported only after a recorded cli-check passes'
          : `no recorded evidence for ${binary}: no free check shows a flag that selects the model`,
      });
      assert.ok(!Object.hasOwn(entry, 'argv'));
    }
  }
  assert.equal(harnesses.find((h) => h.id === 'antigravity').worker.oneShot.status, 'unknown');
});

test('IC-011: codex declares the free exec-model check', () => {
  const checks = JSON.parse(fs.readFileSync(path.join(REPO, 'core/worker-evidence/codex/checks.json'), 'utf8'));
  assert.deepEqual(checks.checks.find((check) => check.id === 'exec-model'), {
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
    const calls = [];
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
      spawnSyncImpl(command, argv, options) {
        assert.equal(command, binary);
        assert.equal(options.env, env);
        assert.equal(options.cwd, dir);
        assert.equal(options.shell, false);
        calls.push([...argv]);
        assert.ok(argv.length === 1 && ['--version', '--help'].includes(argv[0]));
        return { status: 0, stdout: Buffer.from(argv[0] === '--version' ? '1.4.6\n' : help) };
      },
    });
    assert.deepEqual(calls, [['--version'], ['--help']]);
    assert.deepEqual(result.establishes, expected, label);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(record.cliVersion, '1.4.6');
    assert.deepEqual(record.establishes, expected, label);
    assert.equal(record.checks[0].id, 'help-model');
    assert.equal(record.checks[0].result, label);
    assert.deepEqual(record.checks[0].establishes, ['model']);
    assert.deepEqual(record.checks[0].matched, label === 'pass' ? [help.trimEnd()] : []);
  }
});
