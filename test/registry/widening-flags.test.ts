'use strict';
// 165 review B-2: the widening-flag deny list is data plus one matcher, run by the registry validator on
// `oneShot.argv` and `mainSession.argv` (built-in and package workers alike) and again at launch on the final
// argv. Seat B's probe (a codex `mainSession.argv` of `exec <extra> --json -o {lastMessageFile} -`) accepted
// every line below; each is now refused.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { WIDENING, wideningProblem } = require('../../src/registry/widening-flags.ts');
const { mainArgv, assembleArgv } = require('../../src/runtime/worker/launch.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');

const registry = loadRegistry({ repoRoot: REPO });
const workerOf = (id: string) => structuredClone(registry.harnesses.find((h: any) => h.id === id).worker);

/** The errors of a codex worker whose `mainSession.argv` (or `oneShot.argv`) holds `extra`. */
function codexErrors(extra: string[], where: 'mainSession' | 'oneShot' = 'mainSession') {
  const w = workerOf('codex');
  if (where === 'mainSession') w.mainSession.argv = ['exec', ...extra, '--json', '-o', '{lastMessageFile}', '-'];
  else w.oneShot.argv = [...extra, '--ephemeral', '-'];
  const errors: string[] = [];
  validateWorker(w, "harness 'codex'", errors);
  return errors;
}

// The probe's lines and the owner's additions (brief B-2), each in the form the brief names.
const PROBE = [
  ['--full-auto'], ['-s', 'danger-full-access'], ['--sandbox', 'danger-full-access'], ['-a', 'never'],
  ['-c', 'sandbox_mode="danger-full-access"'], ['--permission-mode', 'bypassPermissions'], ['--allowedTools', 'Bash'],
  ['--allow-all-tools'], ['--dangerously-skip-permissions'], ['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'],
];

// The probe itself, as a test, is in worker-block.test.ts ('165 review B-2 probe').

test('B-2: the same lines are refused in a oneShot argv', () => {
  assert.deepEqual(codexErrors([], 'oneShot'), []);
  for (const extra of PROBE) assert.match(codexErrors(extra, 'oneShot').join('\n'), /worker 'oneShot': argv must not contain the widening flag '/, JSON.stringify(extra));
});

test('B-2: every form a CLI accepts is matched: --flag=value, two tokens, attached short values, config overrides by key and value', () => {
  const refused = [
    ['--sandbox=danger-full-access'], ['-sdanger-full-access'], ['-s=danger-full-access'], ['-s', "'danger-full-access'"], ['--sandbox', 'DANGER-FULL-ACCESS'],
    ['--ask-for-approval=never'], ['-anever'], ['-a', '"never"'],
    ['--config', 'sandbox_mode=danger-full-access'], ['--config=sandbox_mode=danger-full-access'], ["-c", "sandbox_mode='danger-full-access'"],
    ['-csandbox_mode=danger-full-access'], ['-c', 'sandbox_mode = "danger-full-access"'], ['-c', 'profiles.x.sandbox_mode="danger-full-access"'],
    ['-c', 'approval_policy=never'], ['-c', 'sandbox_workspace_write.network_access=true'], ['-c', 'sandbox_permissions=["disk-full-read-access"]'],
    ['--permission-mode=bypassPermissions'], ['--permission-mode', 'acceptEdits'], ['--allowed-tools=Bash'], ['--allowedTools', 'Bash(git *)'],
    ['--add-dir', '/'], ['--add-dir=/x'], ['--dangerously-anything'], ['--yolo-mode'], ['--allow-all-paths'],
    ['--approve-for-me'], ['--ignore-rules'], ['--ignore-user-config'], ['-C', '/elsewhere'], ['--cd=/elsewhere'], ['--enable', 'x'],
  ];
  for (const extra of refused) assert.equal(codexErrors(extra).length, 1, `${JSON.stringify(extra)} must be refused`);
  const narrow = [
    ['-s', 'read-only'], ['-s', 'workspace-write'], ['--sandbox=read-only'], ['-a', 'on-request'], ['-c', 'model="o3"'], ['--disable', 'multi_agent'],
    ['--config', 'shell_environment_policy.inherit=core'], ['-m', 'gpt-x'],
  ];
  for (const extra of narrow) assert.deepEqual(codexErrors(extra), [], `${JSON.stringify(extra)} is not widening`);
});

test('B-2: short forms belong to their own CLI: -a is widening for pi (trust project files) and codex (approval), not for claude', () => {
  const at = (binary: string, argv: string[]) => wideningProblem(argv, { binary, mainSession: true });
  assert.equal(at('pi', ['-a']), '-a');
  assert.equal(at('pi', ['--approve']), '--approve');
  assert.equal(at('codex', ['-a', 'never']), '-a never');
  assert.equal(at('claude', ['-a']), null);
  // A long flag of any built-in CLI is widening for every binary, a package worker's included.
  assert.equal(at('mycli', ['--permission-mode', 'bypassPermissions']), '--permission-mode bypassPermissions');
  assert.equal(at('mycli', ['--config', 'sandbox_mode=danger-full-access']), '--config sandbox_mode=danger-full-access');
  assert.equal(at('mycli', ['--mode', 'autopilot']), '--mode autopilot');
  assert.equal(at('mycli', ['--mode', 'json']), null, 'pi --mode json is not widening');
  // Placeholders are never values.
  assert.equal(at('codex', ['-s', '{model}']), null);
});

test('B-2: the workspace-trust flags are refused in a main session only (copilot and kiro need them for their one-shot worker runs)', () => {
  for (const flag of ['--trust-folder', '--trust-workspace', '--trust-tools=read']) {
    assert.ok(wideningProblem([flag], { binary: 'copilot', mainSession: true }), flag);
    assert.equal(wideningProblem([flag], { binary: 'copilot', mainSession: false }), null, flag);
  }
  for (const id of ['copilot', 'kiro']) {
    const errors: string[] = [];
    validateWorker(workerOf(id), `harness '${id}'`, errors);
    assert.deepEqual(errors, [], id);
  }
});

test('B-2: a worker block may declare its own wideningFlags; they add to the built-in set and are checked for shape', () => {
  const w = workerOf('codex');
  w.wideningFlags = [{ flag: '--unsafe' }, { flag: '--level', values: ['max'] }, { prefix: '--unsafe-' }, { config: 'trust_level', values: ['all'] }];
  const errorsOf = (argv: string[]) => { const errors: string[] = []; validateWorker({ ...w, mainSession: { ...w.mainSession, argv: ['exec', ...argv, '-'] } }, "harness 'codex'", errors); return errors; };
  assert.deepEqual(errorsOf([]), []);
  for (const argv of [['--unsafe'], ['--level', 'max'], ['--level=max'], ['--unsafe-x'], ['-c', 'trust_level=all']]) assert.equal(errorsOf(argv).length, 1, JSON.stringify(argv));
  assert.deepEqual(errorsOf(['--level', 'low']), []);
  for (const bad of ['--x', [{}], [{ flag: 'x' }], [{ flag: '--x', prefix: '--y' }], [{ config: 'a b' }], [{ flag: '--x', values: [] }], [{ flag: '--x', extra: 1 }]]) {
    const errors: string[] = [];
    validateWorker({ ...workerOf('codex'), wideningFlags: bad }, "harness 'codex'", errors);
    assert.match(errors.join('\n'), /worker 'wideningFlags': /, JSON.stringify(bad));
  }
});

test('B-2: a package worker descriptor is held to the same check', () => {
  const w = workerOf('codex');
  w.mainSession.argv = ['exec', '-s', 'danger-full-access', '-'];
  const errors = POINT_VALIDATORS['worker-v1']('mycli', w, { packageId: 'acme' });
  assert.match(errors.join('\n'), /package 'acme' worker 'mycli' worker 'mainSession': argv must not contain the widening flag '-s danger-full-access'/);
});

test('B-2 launch: the final argv is checked after the model part is spliced in, so a model id cannot smuggle a widening flag', () => {
  const w = workerOf('codex');
  assert.deepEqual(mainArgv(w, 'hi', '/tmp/last', { model: 'gpt-x', provider: null, effort: null }), ['exec', '--json', '-o', '/tmp/last', '-m', 'gpt-x', '-']);
  w.model = { ...w.model, argv: ['-s', '{model}'] };
  assert.throws(() => mainArgv(w, 'hi', '/tmp/last', { model: 'danger-full-access', provider: null, effort: null }), (error: any) => error.code === 'widening-flag' && /-s danger-full-access/.test(error.message));
  const c = workerOf('claude');
  assert.throws(() => mainArgv(c, 'hi', undefined, { model: '--dangerously-skip-permissions', provider: null, effort: null }), (error: any) => error.code === 'widening-flag');
  // The prompt is never read as a flag: it is the user's text, sent whole.
  const o = workerOf('opencode');
  assert.equal(mainArgv(o, 'please use --yolo', undefined, null).at(-1), 'please use --yolo');
  // A worker run too: its one-shot recipe with a bound model.
  assert.throws(() => assembleArgv(workerOf('codex'), 'hi', false, '/tmp/last', { model: '--yolo', flag: 'supported' }), (error: any) => error.code === 'widening-flag');
  assert.ok(Array.isArray(assembleArgv(workerOf('codex'), 'hi', false, '/tmp/last', { model: 'gpt-x', flag: 'supported' })));
});

test('B-2 evidence: every flag sourced from a CLI\'s --help appears in the matched lines of its recorded check', () => {
  assert.deepEqual(Object.keys(WIDENING.binaries).sort(), ['agy', 'claude', 'codex', 'copilot', 'kiro-cli', 'opencode', 'pi']);
  for (const [binary, set] of Object.entries(WIDENING.binaries) as Array<[string, any]>) {
    const record = JSON.parse(fs.readFileSync(path.join(REPO, set.evidence), 'utf8'));
    assert.equal(record.binary, binary, set.evidence);
    const matched = record.checks.flatMap((check: any) => (check.result === 'pass' ? check.matched : [])).join('\n');
    for (const entry of set.entries) {
      for (const name of [entry.flag, entry.short, entry.prefix, entry.configFlag, entry.config].filter(Boolean)) {
        assert.ok(matched.includes(name), `${binary}: '${name}' is in ${set.evidence}`);
      }
      for (const value of entry.values ?? []) assert.ok(matched.includes(value), `${binary}: value '${value}' of ${entry.flag} is in ${set.evidence}`);
    }
  }
});
