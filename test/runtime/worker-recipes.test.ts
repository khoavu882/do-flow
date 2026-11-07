'use strict';
// 142 B.9 (IC-008, IC-009; FR-004, NFR-001): the five recipes of claude, opencode, copilot, kiro and
// pi, read from the real registry and put through the real launch assembly. No case starts a real
// harness and no case makes a model call: `worker --action describe` runs in process on the real
// descriptors with only `cli.binary` pointed at a fake CLI (test/helper/fake-harness-cli.ts) on a
// scratch PATH.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { linkBin, writeScenario } = require('../helper/fake-harness-cli.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { assembleArgv, argvShape } = require('../../src/runtime/worker/launch.ts');
const { probe, describe } = require('../../src/runtime/worker/readiness.ts');

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const REGISTRY = loadRegistry({ repoRoot: path.resolve(__dirname, '..', '..') });
const WORKER: any = Object.fromEntries(REGISTRY.harnesses.map((h: any) => [h.id, h.worker]));
const HARNESSES = ['claude', 'opencode', 'copilot', 'kiro', 'pi'];
const PROMPT = 'summarise the module';

// IC-009, written out by hand: readOnly, spawnDenial, structuredOutput, then oneShot, the prompt last
// in each. Deliberately not derived from the registry, so a changed flag fails here.
const IC009: any = {
  claude: ['--tools', 'Read', '--permission-mode', 'plan', '--strict-mcp-config',
    '--disallowedTools', 'Task', 'Agent',
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '-p', '{prompt}'],
  opencode: ['run', '--agent', 'doflow-worker-ro',
    '--standalone', '--format', 'json',
    '{prompt}'],
  copilot: ['--deny-tool', 'write', '--deny-tool', 'shell',
    '--excluded-tools', 'task',
    '--output-format', 'json',
    '--trust-folder', '--no-ask-user', '-p', '{prompt}'],
  kiro: ['chat', '--no-interactive', '--agent', 'doflow-worker-ro',
    '--trust-tools=read',
    '--output-format', 'stream-json',
    '--trust-workspace', '{prompt}'],
  pi: ['--tools', 'read,grep,find,ls',
    '--no-extensions', '--no-mcp',
    '--mode', 'json',
    '-p', '--no-session', '--thinking', 'off', '--no-skills', '--no-context-files', '--offline', '{prompt}'],
};
const withPrompt = (id: string, prompt: string) => IC009[id].map((el: string) => (el === '{prompt}' ? prompt : el));

for (const id of HARNESSES) {
  test(`${id}: the assembled argv equals the IC-009 argv, and the prompt is one whole element`, () => {
    const argv = assembleArgv(WORKER[id], PROMPT);
    assert.deepEqual(argv, withPrompt(id, PROMPT));
    assert.equal(argv.filter((el: string) => el === PROMPT).length, 1);
    assert.equal(argv.at(-1), PROMPT, 'the prompt is the last element of oneShot');
    assert.equal(WORKER[id].oneShot.promptVia, 'argv');
  });

  test(`${id}: a prompt with spaces and quotes stays one element`, () => {
    const prompt = `say "hi" and 'bye'; echo $HOME && ls  --  two  spaces`;
    const argv = assembleArgv(WORKER[id], prompt);
    assert.deepEqual(argv, withPrompt(id, prompt));
    assert.equal(argv.filter((el: string) => el === prompt).length, 1);
    assert.equal(argv.length, IC009[id].length, 'no word of the prompt becomes its own element');
  });

  test(`${id}: a prompt starting with "-" is still one whole element (known limit: the CLI may read it as a flag)`, () => {
    // IC-009 "Prompt starting with `-`": the assembler passes the element whole and adds no `--`
    // separator, so whether the harness CLI reads it as a flag is not guarded. The launcher puts the
    // launch-emission text before the brief, so a real prompt does not start with `-`.
    const prompt = '--help me with this';
    const argv = assembleArgv(WORKER[id], prompt);
    assert.deepEqual(argv, withPrompt(id, prompt));
    assert.equal(argv.filter((el: string) => el === prompt).length, 1);
    assert.equal(argv.includes('--'), false, 'no end-of-options separator is added');
  });

  test(`${id}: the recipe stays within 32 elements of 200 characters and carries no env or file`, () => {
    const worker = WORKER[id];
    const raw: string[] = ['readOnly', 'spawnDenial', 'structuredOutput', 'oneShot'].flatMap((key) => worker[key].argv);
    assert.deepEqual(raw, IC009[id]);
    assert.ok(raw.length <= 32, `${raw.length} elements`);
    for (const el of raw) assert.ok(el.length <= 200, `${el.length} characters: ${el}`);
    const shape = argvShape(worker, PROMPT);
    assert.ok(shape.length <= 32);
    for (const el of shape) assert.ok(el.length <= 200, el);

    assert.equal(raw.filter((el) => el === '{prompt}').length, 1, '{prompt} appears once');
    assert.deepEqual(worker.oneShot.argv.filter((el: string) => el === '{prompt}'), ['{prompt}'], '{prompt} is in oneShot only');
    for (const key of ['readOnly', 'spawnDenial', 'structuredOutput']) assert.equal(worker[key].argv.includes('{prompt}'), false, key);
    for (const el of raw) assert.doesNotMatch(el, /\{(lastMessageFile|model)\}/, `no output-file or model placeholder: ${el}`);
    for (const key of ['readOnly', 'spawnDenial', 'structuredOutput', 'oneShot']) {
      for (const field of ['env', 'environment', 'file', 'files', 'envVars']) assert.equal(Object.hasOwn(worker[key], field), false, `${key}.${field}`);
    }
    for (const field of ['env', 'environment', 'file', 'files', 'envVars']) assert.equal(Object.hasOwn(worker, field), false, field);
  });
}

test('opencode: the empty spawnDenial argv assembles to the IC-009 argv', () => {
  const worker = WORKER.opencode;
  assert.equal(worker.spawnDenial.status, 'supported');
  assert.deepEqual(worker.spawnDenial.argv, []);
  const argv = assembleArgv(worker, PROMPT);
  assert.deepEqual(argv, ['run', '--agent', 'doflow-worker-ro', '--standalone', '--format', 'json', PROMPT]);
  assert.deepEqual(argvShape(worker, PROMPT).slice(0, 6), argv.slice(0, 6));
});

test('describe: each of the five is eligible on fake facts and antigravity is not', POSIX_ONLY, async (t) => {
  const dir = tempDir(t, 'doflow-recipes-');
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const ids = [...HARNESSES, 'antigravity'];
  // The real descriptors, with only the binary renamed to a fake CLI that exits 0 for version and help.
  const descriptors: any = {};
  for (const id of ids) {
    descriptors[id] = structuredClone(WORKER[id]);
    descriptors[id].cli.binary = `fake-${id}`;
  }
  const env: any = {
    PATH: linkBin(path.join(dir, 'bin'), ids.map((id) => `fake-${id}`)),
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    FAKE_HARNESS_SCENARIO: writeScenario(dir, { version: [{ print: 'fake 1.0' }] }),
    FAKE_HARNESS_LOG: path.join(dir, 'log.jsonl'),
  };
  await probe({ descriptors, coverage: REGISTRY.coverage, env, cwd: root });

  for (const id of HARNESSES) {
    const answer = describe({ descriptors, coverage: REGISTRY.coverage, harness: id, env, cwd: root });
    assert.equal(answer.disposition, 'described', id);
    assert.deepEqual(answer.requirements.filter((r: any) => r.result !== 'met'), [], id);
    assert.equal(answer.eligible, true, id);
  }
  const agy = describe({ descriptors, coverage: REGISTRY.coverage, harness: 'antigravity', env, cwd: root });
  assert.equal(agy.eligible, false);
  assert.ok(agy.requirements.some((r: any) => r.result !== 'met'));
  assert.equal(fs.existsSync(path.join(dir, 'log.jsonl')), true, 'the fake CLI ran; no real binary did');
});
