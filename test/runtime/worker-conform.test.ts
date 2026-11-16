'use strict';

// Row 171 T6 (FR-011..FR-013, FR-016, NFR-003, NFR-004, AC-3; design §6): `worker --action conform`.
//
// Conform checks a worker descriptor against a fake binary in a fresh OS-temp scratch directory and names
// each part that fails. Every case runs the fake, never a real harness: the fake is the only executable on
// the child's PATH and is spawned by absolute path. Broken descriptors come through an injected registry
// object (a clone of the loaded registry with one worker changed), never by editing harnesses.json. The
// package view is injected empty, so no case reads the developer's installed packages. POSIX only (DEC-008).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'src', 'runtime', 'worker');
const { executeWorkerCommand } = require(path.join(SRC, 'command.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
/** Required on use, so the first case fails on its assertion, not on a missing module. */
const conformModule = () => require(path.join(SRC, 'conform.ts'));

const POSIX: any = { skip: process.platform === 'win32' && 'conform is unsupported on win32 (DEC-008)' };
const EMPTY_VIEW = Object.freeze({ packages: [], stateRead: { state: { removed: [] } }, grants: { grants: [] } });
const PARTS = ['binary', 'one-shot', 'prompt-transport', 'model-flag', 'main-session', 'stream', 'login'];
/** The variables the system adds itself, never copied from conform's caller: a POSIX `#!/bin/sh` sets PWD (the
 * scratch home conform chose as cwd) and SHLVL (its own counter) before it execs, and macOS adds
 * __CF_USER_TEXT_ENCODING (the uid's text encoding) to every process it starts. */
const SYSTEM_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

let base: any = null;
/** A deep clone of the loaded registry with `mutate(worker)` applied to harness `id`'s worker. */
function registryWith(id: string, mutate: (worker: any) => void): any {
  base ??= loadRegistry({ repoRoot: REPO });
  const reg = structuredClone(base);
  mutate(reg.harnesses.find((h: any) => h.id === id).worker);
  return reg;
}

async function conformVia(t: any, harness: string, registry?: any) {
  return executeWorkerCommand({ action: 'conform', harness, registry, view: EMPTY_VIEW, cwd: tempDir(t, 'doflow-conform-cwd-') });
}

const partOf = (body: any, name: string) => body.parts.find((p: any) => p.part === name);
const resultsOf = (body: any) => Object.fromEntries(body.parts.map((p: any) => [p.part, p.result]));

/** A broken descriptor fails exactly the named part, by name, with exit 1. */
function assertFailsPart(outcome: any, name: string, reason: RegExp) {
  assert.equal(outcome.exit, 1, JSON.stringify(outcome.body));
  assert.equal(outcome.body.ok, false);
  assert.ok(outcome.body.failed.includes(name), `${name} is named failed: ${outcome.body.failed}`);
  assert.equal(partOf(outcome.body, name).result, 'failed');
  assert.match(partOf(outcome.body, name).reason, reason);
  for (const p of outcome.body.parts) assert.ok(p.reason.length <= 160, `${p.part} reason is at most 160 characters`);
}

test('conform --harness codex exits 0 and every supported part passes', POSIX, async (t) => {
  const { exit, body } = await conformVia(t, 'codex');
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.harness, 'codex');
  assert.equal(body.origin, 'builtin');
  assert.deepEqual(body.parser, { id: 'codex-exec-json-v1', kind: 'field-map' });
  assert.deepEqual(body.parts.map((p: any) => p.part), PARTS);
  assert.deepEqual(resultsOf(body), {
    binary: 'passed', 'one-shot': 'passed', 'prompt-transport': 'passed', 'model-flag': 'passed',
    'main-session': 'passed', stream: 'passed', login: 'unchecked',
  });
  assert.equal(partOf(body, 'login').reason, 'not-declared');
  assert.deepEqual(body.failed, []);
});

test('a code parser leaves stream unchecked, and an undeclared entry is unchecked not-declared', POSIX, async (t) => {
  const opencode = await conformVia(t, 'opencode');
  assert.equal(opencode.exit, 0, JSON.stringify(opencode.body));
  assert.deepEqual(partOf(opencode.body, 'stream'), { part: 'stream', result: 'unchecked', reason: 'code-parser' });
  assert.equal(opencode.body.parser.kind, 'code');
  const claude = await conformVia(t, 'claude');
  assert.equal(claude.exit, 0, JSON.stringify(claude.body));
  assert.equal(partOf(claude.body, 'one-shot').reason, 'not-declared');
  assert.equal(partOf(claude.body, 'model-flag').result, 'passed', 'model-flag goes through mainArgv when one-shot is not declared');
  assert.equal(partOf(claude.body, 'main-session').result, 'passed');
});

test('a scratch descriptor whose oneShot argv lacks the prompt slot fails one-shot by name with exit 1', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.oneShot.argv = ['--ephemeral']; w.oneShot.promptVia = 'argv'; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'one-shot', /\{prompt\}/);
  assert.equal(partOf(outcome.body, 'prompt-transport').reason, 'depends-on one-shot');
  assert.deepEqual(outcome.body.failed, ['one-shot']);
});

test('a stdin oneShot whose argv also holds the prompt slot fails prompt-transport by name', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.oneShot.argv = ['--ephemeral', '-', '{prompt}']; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'prompt-transport', /stdin/);
  assert.equal(partOf(outcome.body, 'one-shot').result, 'passed');
});

test('a model argv without the model slot fails model-flag by name', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.model.argv = ['-m']; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'model-flag', /conform-model-1 .*0 times/);
  assert.deepEqual(outcome.body.failed, ['model-flag']);
});

test('a mainSession argv that disagrees with its promptVia fails main-session by name', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.mainSession.argv = ['exec', '--json', '-o', '{lastMessageFile}']; w.mainSession.promptVia = 'argv'; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'main-session', /promptVia/);
  assert.deepEqual(outcome.body.failed, ['main-session']);
});

test('a field map whose earlier rule shadows a later one fails stream as shadowed by rules[i]', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => {
    const map = structuredClone(w.structuredOutput.fieldMap);
    map.id = 'conform-shadow-v1';
    map.rules.unshift({ when: [{ path: ['type'], equals: 'turn.failed' }], then: { terminal: { outcome: 'completed' } } });
    w.structuredOutput = { ...w.structuredOutput, parser: map.id, fieldMap: map };
  });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'stream', /shadowed by rules\[0\]/);
  assert.deepEqual(outcome.body.parser, { id: 'conform-shadow-v1', kind: 'field-map' });
  assert.deepEqual(outcome.body.failed, ['stream']);
});

test('a declared loginProbe passes on exit 0 yes and exit 1 no, and one holding a widening flag fails login by name', POSIX, async (t) => {
  const login = (argv: string[]) => registryWith('codex', (w) => { w.loginProbe = { status: 'supported', argv }; });
  const good = await conformVia(t, 'codex', login(['login', 'status']));
  assert.equal(good.exit, 0, JSON.stringify(good.body));
  assert.equal(partOf(good.body, 'login').result, 'passed');
  const bad = await conformVia(t, 'codex', login(['login', 'status', '--dangerously-bypass-approvals-and-sandbox']));
  assertFailsPart(bad, 'login', /widening/);
  assert.deepEqual(bad.body.failed, ['login']);
});

test('the fake logged only PATH, HOME, LANG and DOFLOW_CONFORM_* env keys', POSIX, async (t) => {
  const planted = 'CONFORM_PLANTED_API_TOKEN';
  process.env[planted] = 'sk-conform-planted-0123456789';
  t.after(() => { delete process.env[planted]; });
  const logs: any[] = [];
  const { exit } = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, onLog: (log: any) => logs.push(log) });
  assert.equal(exit, 0);
  assert.ok(logs.length >= 5, `every part's spawn logged (${logs.length})`);
  for (const log of logs) {
    const keys = log.env.filter((key: string) => !SYSTEM_OWN.has(key));
    assert.ok(!log.env.includes(planted), 'the planted secret never reaches the child');
    assert.deepEqual(keys.filter((key: string) => !key.startsWith('DOFLOW_CONFORM_')).sort(), ['HOME', 'LANG', 'PATH']);
    assert.deepEqual(keys.filter((key: string) => key.startsWith('DOFLOW_CONFORM_')).sort(),
      ['DOFLOW_CONFORM_EXIT', 'DOFLOW_CONFORM_FAKE', 'DOFLOW_CONFORM_LOG', 'DOFLOW_CONFORM_NODE', 'DOFLOW_CONFORM_SCRIPT']);
  }
});

test('the scratch dir is gone after exit', POSIX, async (t) => {
  const tmp = tempDir(t, 'doflow-conform-tmp-');
  const during: string[][] = [];
  const { exit } = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, tmpDir: tmp, onLog: () => during.push(fs.readdirSync(tmp)) });
  assert.equal(exit, 0);
  assert.ok(during.length > 0 && during.every((names) => names.length === 1 && names[0].startsWith('doflow-conform-')), 'the scratch dir existed while the fake ran');
  assert.deepEqual(fs.readdirSync(tmp), []);
  const failing = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, tmpDir: tmp, registry: registryWith('codex', (w) => { w.model.argv = ['-m']; }) });
  assert.equal(failing.exit, 1);
  assert.deepEqual(fs.readdirSync(tmp), [], 'a failing run removes it too');
});

test('--json is at most 4096 bytes, through bin/doflow.js', POSIX, (t) => {
  const scratch = createScratch('doflow-conform-cli-');
  t.after(() => scratch.remove());
  const tmp = tempDir(t, 'doflow-conform-clitmp-');
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), 'worker', '--action', 'conform', '--harness', 'codex', '--json'], {
    cwd: scratch.dir, env: scratch.env({ TMPDIR: tmp }), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(Buffer.byteLength(r.stdout) <= 4096, `--json is ${Buffer.byteLength(r.stdout)} bytes`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.parts.map((p: any) => p.part), PARTS);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the CLI run removed its scratch dir');
  const text = spawnSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), 'worker', '--action', 'conform', '--harness', 'codex'], {
    cwd: scratch.dir, env: scratch.env({ TMPDIR: tmp }), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trim().split('\n');
  assert.deepEqual(lines.map((line: string) => line.split('  ')[0]), [...PARTS, 'conform: codex ok']);
  assert.match(lines[0], /^binary {2}passed {2}\S/);
});

test('every reason is cut to 160 characters, so a failing --json stays within 4096 bytes', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.cli.binary = `../${'x'.repeat(300)}`; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'binary', /bare command name/);
  assert.equal(partOf(outcome.body, 'binary').reason.length, 160);
  assert.ok(Buffer.byteLength(JSON.stringify(outcome.body, null, 2)) <= 4096);
  for (const name of PARTS.slice(1)) assert.match(partOf(outcome.body, name).reason, /^(depends-on binary|not-declared)$/);
});

test('unknown harness exits 2, and so do a missing --harness, win32 and a scratch that cannot be made', async (t) => {
  const unknown = await conformVia(t, 'no-such-harness');
  assert.equal(unknown.exit, 2);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error, 'unknown-harness');
  const missing = await executeWorkerCommand({ action: 'conform', view: EMPTY_VIEW });
  assert.equal(missing.exit, 2);
  assert.equal(missing.body.error, 'usage');
  const win = await executeWorkerCommand({ action: 'conform', harness: 'codex', view: EMPTY_VIEW, platform: 'win32' });
  assert.equal(win.exit, 2);
  assert.equal(win.body.error, 'platform-unsupported');
  if (process.platform !== 'win32') {
    const noTmp = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, tmpDir: path.join(tempDir(t, 'doflow-conform-gone-'), 'absent') });
    assert.equal(noTmp.exit, 2);
    assert.equal(noTmp.body.error, 'scratch-failed');
  }
});

test('a ninth harness described by a field map, in a scratch copy of the registry, passes conform (FR-016)', POSIX, async (t) => {
  const root = tempDir(t, 'doflow-conform-ninth-');
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  const file = path.join(root, 'core', 'registry', 'harnesses.json');
  const harnesses = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The G83.5 fixture shape: the first harness's worker with a field-map structuredOutput in place of a parser.
  const ninth = structuredClone(harnesses.harnesses[0]);
  ninth.id = 'ninth';
  ninth.displayName = 'Ninth';
  const { parser: _parser, ...rest } = ninth.worker.structuredOutput;
  ninth.worker.structuredOutput = {
    ...rest, status: 'supported', argv: ['--json'], evidence: ['core/registry/harnesses.json'], verification: 'Scratch.', verifiedOn: '2026-11-16',
    fieldMap: {
      id: 'ninth-run-v1', format: 'jsonl-field-map-v1', eventType: ['type'], missingTerminal: 'no-end',
      rules: [
        { when: [{ path: ['type'], equals: 'msg' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
        { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' } } },
      ],
    },
  };
  harnesses.harnesses.push(ninth);
  fs.writeFileSync(file, JSON.stringify(harnesses));
  base ??= loadRegistry({ repoRoot: REPO });
  const registry = { ...base, harnesses: JSON.parse(fs.readFileSync(file, 'utf8')).harnesses };
  const { exit, body } = await conformVia(t, 'ninth', registry);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual(body.parser, { id: 'ninth-run-v1', kind: 'field-map' });
  assert.equal(partOf(body, 'stream').result, 'passed');
  assert.deepEqual(body.failed, []);
});
