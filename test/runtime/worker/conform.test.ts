'use strict';

// Row 171 T6 (FR-011..FR-013, FR-016, NFR-003, NFR-004, AC-3; design §6): `worker --action conform`.
//
// Conform checks a worker descriptor against a fake binary in a fresh OS-temp scratch directory and names
// each part that fails. Every case runs the fake, never a real harness: the fake is the only executable on
// the child's PATH and is spawned by absolute path. Broken descriptors come through an injected registry
// object (a clone of the loaded registry with one worker changed), never by editing harnesses.json. The
// package view is injected empty, so no case reads the developer's installed packages. POSIX only (DEC-008).

const { withPiReadOnly } = require('../../helper/pi-read-only.ts');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../../helper/tmp.ts');
const { createScratch, childEnv } = require('../../helper/scratch-env.ts');

const REPO = path.join(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src', 'runtime', 'worker');
const { executeWorkerCommand } = require(path.join(SRC, 'command.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
/** Required on use, so the first case fails on its assertion, not on a missing module. */
const conformModule = () => require(path.join(SRC, 'conform.ts'));

const POSIX: any = { skip: process.platform === 'win32' && 'conform is unsupported on win32 (DEC-008)' };
const EMPTY_VIEW = Object.freeze({ packages: [], stateRead: { state: { removed: [] } }, grants: { grants: [] } });
const PARTS = ['binary', 'one-shot', 'prompt-transport', 'model-flag', 'provider', 'effort', 'main-session', 'control-channel', 'stream', 'login'];
/** The variables the system adds itself, never copied from conform's caller: a POSIX `#!/bin/sh` sets PWD (the
 * scratch home conform chose as cwd) and SHLVL (its own counter) before it execs, and macOS adds
 * __CF_USER_TEXT_ENCODING (the uid's text encoding) to every process it starts. */
const SYSTEM_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

let base: any = null;
/** A deep clone of the loaded registry with `mutate(worker)` applied to harness `id`'s worker. */
function registryWith(id: string, mutate: (worker: any) => void): any {
  base ??= loadRegistry({ repoRoot: REPO });
  const reg = structuredClone(base);
  const worker = reg.harnesses.find((h: any) => h.id === id).worker;
  if (id === 'pi') withPiReadOnly(worker); // 178 G-1: the shipped pi has no readOnly or spawnDenial recipe
  mutate(worker);
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
    binary: 'passed', 'one-shot': 'passed', 'prompt-transport': 'passed', 'model-flag': 'passed', provider: 'unchecked', effort: 'unchecked',
    'main-session': 'passed', 'control-channel': 'unchecked', stream: 'passed', login: 'unchecked',
  });
  assert.equal(partOf(body, 'login').reason, 'not-declared');
  assert.equal(partOf(body, 'control-channel').reason, 'not-declared');
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

test('B2: a mainSession parser that launchMainSession refuses fails main-session by name', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => { w.mainSession.parser = 'missing-stream-v1'; });
  const outcome = await conformVia(t, 'codex', reg);
  assertFailsPart(outcome, 'main-session', /parser 'missing-stream-v1' is not in core PARSERS/);
  assert.deepEqual(outcome.body.failed, ['main-session']);
});

test('B4: a completed rule with compatible equals and in on one path gets an event that meets both, and passes', POSIX, async (t) => {
  const reg = registryWith('codex', (w) => {
    const map = structuredClone(w.structuredOutput.fieldMap);
    map.id = 'conform-equals-in-v1';
    const completed = map.rules.find((rule: any) => rule.then.terminal?.outcome === 'completed');
    completed.when.push({ path: ['type'], in: ['noise', 'turn.completed'] });
    w.structuredOutput = { ...w.structuredOutput, parser: map.id, fieldMap: map };
  });
  const { exit, body } = await conformVia(t, 'codex', reg);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'stream').result, 'passed');
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

// Row 172 T4 (design §8): scratch copies of design §3.3's two recipes, the claude one with LD-1's caveat. Injected
// through `registryWith`, so the registry validator (L3 would refuse a shadowed rule) does not see them: the cases
// below test conform's own dynamic checks.
const EVIDENCE = { evidence: ['scratch'], verification: 'Scratch.', verifiedOn: '2026-11-16' };
const CLAUDE_RECIPE = {
  ...EVIDENCE, status: 'supported', argv: ['auth', 'status', '--json'], output: 'json',
  answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }],
  billing: { path: ['authMethod'], values: {
    'claude.ai': { mode: 'subscription', billing: 'free' }, oauth_token: { mode: 'subscription', billing: 'free' },
    api_key: { mode: 'api-key', billing: 'metered' }, api_key_helper: { mode: 'api-key', billing: 'metered' } } },
  expiry: 'not-seen', hint: 'claude auth login', caveat: 'its help and docs do not show that this check runs offline',
};
const PI_RECIPE = {
  ...EVIDENCE, status: 'supported', argv: ['auth', 'check', '--provider', '{provider}', '--json', '--no-refresh'], output: 'json',
  providers: { argv: ['--list-models', '--offline'], parse: 'table-column:provider', emptyMeans: 'logged-out', max: 8 },
  answers: [
    { exit: 0, state: 'logged-in' },
    { exit: 1, when: [{ path: ['reason'], equals: 'provider_not_found' }], state: 'unknown', reason: 'provider-not-found' },
    { exit: 1, when: [{ path: ['status'], equals: 'not_ready' }], state: 'logged-out' },
    { exit: 2, state: 'unknown', reason: 'invalid' }],
  billing: { path: ['authType'], values: { oauth: { mode: 'subscription', billing: 'unknown' }, api_key: { mode: 'api-key', billing: 'metered' } } },
  expiry: 'not-seen',
  expirySigns: { signs: ['OAuth refresh failed for {provider}', 'OAuth refresh returned a token that expires too soon for {provider}'],
    basis: 'source', evidence: ['<Pi 1.5.2 pi-ai dist/auth/resolve.js:81,114>'] },
  hint: 'pi auth login <provider>',
};
const withRecipe = (id: string, recipe: any, change: (probe: any) => void = () => {}) => registryWith(id, (w) => {
  w.loginProbe = structuredClone(recipe);
  change(w.loginProbe);
});

test('a scratch descriptor whose answers[1] is shadowed fails the login part naming answers[1]', POSIX, async (t) => {
  // An exit-0 rule with a test, placed after the exit-0 rule with none: answers[0] takes every exit 0 first.
  const reg = withRecipe('pi', PI_RECIPE, (probe) => {
    probe.answers.splice(1, 0, { exit: 0, when: [{ path: ['status'], equals: 'expired' }], state: 'expired', reason: 'token-expired' });
  });
  const outcome = await conformVia(t, 'pi', reg);
  assertFailsPart(outcome, 'login', /^answers\[1\] is shadowed by answers\[0\]$/);
  assert.deepEqual(outcome.body.failed, ['login']);
});

test('a scratch copy of the pi recipe passes the login part: 4 answers, 2 signs, providers yes', POSIX, async (t) => {
  const outcome = await conformVia(t, 'pi', withRecipe('pi', PI_RECIPE));
  assert.equal(outcome.exit, 0, JSON.stringify(outcome.body));
  assert.deepEqual(partOf(outcome.body, 'login'), { part: 'login', result: 'passed', reason: '4 answers, 2 signs, providers yes' });
});

test('a scratch copy of the claude recipe, with its caveat, passes the login part: 2 answers, 0 signs, providers no', POSIX, async (t) => {
  const outcome = await conformVia(t, 'claude', withRecipe('claude', CLAUDE_RECIPE));
  assert.equal(outcome.exit, 0, JSON.stringify(outcome.body));
  assert.deepEqual(partOf(outcome.body, 'login'), { part: 'login', result: 'passed', reason: '2 answers, 0 signs, providers no' });
});

test('a rule its own case does not answer fails as answers[i] reads <state>', POSIX, async (t) => {
  // output none: no stdout is parsed, so the provider_not_found case reads `unknown unparseable-output`.
  const reg = withRecipe('pi', PI_RECIPE, (probe) => { probe.output = 'none'; delete probe.billing; });
  const outcome = await conformVia(t, 'pi', reg);
  assertFailsPart(outcome, 'login', /answers\[1\] reads unknown unparseable-output, want unknown provider-not-found/);
});

test('an expiry sign that its own sample cannot match fails the login part naming the sign', POSIX, async (t) => {
  const reg = withRecipe('pi', PI_RECIPE, (probe) => { probe.expirySigns.signs = ['OAuth refresh failed for {provider}', 'OAuth refresh failed for {provider} again']; });
  const outcome = await conformVia(t, 'pi', reg);
  assertFailsPart(outcome, 'login', /expirySigns\.signs\[1\] is matched as signs\[0\]/);
  assert.deepEqual(outcome.body.failed, ['login']);
});

test('a recipe argv holding a secret flag or a widening flag fails the login part by name', POSIX, async (t) => {
  const secret = await conformVia(t, 'claude', withRecipe('claude', CLAUDE_RECIPE, (probe) => { probe.argv.push('--show-token'); }));
  assertFailsPart(secret, 'login', /secret flag '--show-token'/);
  assert.deepEqual(secret.body.failed, ['login']);
  const listing = await conformVia(t, 'pi', withRecipe('pi', PI_RECIPE, (probe) => { probe.providers.argv.push('--credentials', 'x'); }));
  assertFailsPart(listing, 'login', /providers argv holds the secret flag '--credentials'/);
  const widening = await conformVia(t, 'codex', withRecipe('codex', CLAUDE_RECIPE, (probe) => { probe.argv.push('--dangerously-bypass-approvals-and-sandbox'); }));
  assertFailsPart(widening, 'login', /widening flag '--dangerously-bypass-approvals-and-sandbox'/);
});

test('an unknown or unsupported loginProbe leaves the login part unchecked not-declared', POSIX, async (t) => {
  for (const status of ['unknown', 'unsupported']) {
    const reg = registryWith('pi', (w) => { w.loginProbe = { ...EVIDENCE, status, reason: 'scratch' }; });
    const outcome = await conformVia(t, 'pi', reg);
    assert.equal(outcome.exit, 0, JSON.stringify(outcome.body));
    assert.deepEqual(partOf(outcome.body, 'login'), { part: 'login', result: 'unchecked', reason: 'not-declared' });
  }
});

test("the login part's slow-fake case reads unknown timeout within 1 s", POSIX, async () => {
  // The slow case is the part's last: its listing is the last listing logged, then one check that sleeps past the
  // part's 300 ms bound. The part fails unless that check reads `unknown timeout`, so a pass is that reading.
  let listed = 0;
  const onLog = (log: any) => { if (JSON.stringify(log.argv) === JSON.stringify(PI_RECIPE.providers.argv)) listed = Date.now(); };
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: withRecipe('pi', PI_RECIPE), view: EMPTY_VIEW, onLog });
  const ended = Date.now();
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'login').result, 'passed');
  assert.ok(listed > 0, 'the listing ran');
  assert.ok(ended - listed < 1000, `the slow check ended ${ended - listed} ms after its listing, want under 1000`);
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

/** Names, contents, mtime and inode of every entry under `root` (absent: null). */
function treeSnapshot(root: string) {
  if (!fs.existsSync(root)) return null;
  const entries: any = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const base = { mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
      const rel = path.relative(root, file);
      if (info.isDirectory()) { entries[rel] = { type: 'dir', ...base }; visit(file); }
      else if (info.isFile()) entries[rel] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...base };
      else entries[rel] = { type: 'other', ...base };
    }
  };
  visit(root);
  return entries;
}

test('B1: conform through bin/doflow.js, upkeep and telemetry left on, changes no byte under the state roots and adds no file', POSIX, (t) => {
  const scratch = createScratch('doflow-conform-state-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'proj');
  // An upkeep-due marker in both state roots: upkeep, if it ran, would consume or rewrite it and write `.gitignore`.
  for (const dir of [path.join(project, '.doflow', 'state'), path.join(scratch.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  const tmp = tempDir(t, 'doflow-conform-statetmp-');
  const trees = [project, scratch.home, scratch.xdg];
  const before = trees.map(treeSnapshot);
  const env = childEnv(scratch, { TMPDIR: tmp, DOFLOW_TELEMETRY: null, DOFLOW_UPKEEP: null });
  for (const args of [['--harness', 'codex', '--json'], ['--harness', 'codex'], ['--harness', 'no-such-harness', '--json']]) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), 'worker', '--action', 'conform', ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 120000,
    });
    assert.ok([0, 2].includes(r.status as number), `${args.join(' ')}: ${r.status} ${r.stderr}`);
  }
  assert.deepEqual(trees.map(treeSnapshot), before);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the scratch dir is gone');
});

/** A child node runs conform on codex with `tmpDir`; on the fake's first log line it prints `ready` and holds 1 s. */
const HELD_CHILD = `
const { conform } = require(${JSON.stringify(path.join(SRC, 'conform.ts'))});
let held = false;
const view = { packages: [], stateRead: { state: { removed: [] } }, grants: { grants: [] } };
conform({ harness: 'codex', view, tmpDir: process.env.CONFORM_TMP, onLog: () => {
  if (held) return;
  held = true;
  process.stdout.write('ready ' + require('node:fs').readdirSync(process.env.CONFORM_TMP).join(',') + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
} }).then(() => process.stdout.write('finished\\n'));
`;

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`B5: ${signal} while the fake runs removes the scratch, and the signal still ends conform`, POSIX, async (t) => {
    const scratch = createScratch('doflow-conform-signal-');
    t.after(() => scratch.remove());
    const tmp = tempDir(t, 'doflow-conform-sigtmp-');
    const child = spawn(process.execPath, ['-e', HELD_CHILD], { cwd: scratch.dir, env: childEnv(scratch, { CONFORM_TMP: tmp }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    const ended: Promise<any[]> = new Promise((resolve) => child.on('close', (code: any, sig: any) => resolve([code, sig])));
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk;
      if (out.startsWith('ready') && out.includes('\n')) child.kill(signal);
    });
    const [code, sig] = await ended;
    assert.match(out, /^ready doflow-conform-\S+\n$/, `the scratch existed when the signal was sent: ${out} ${err}`);
    assert.deepEqual([code, sig], [null, signal], `the child ended by ${signal}: ${err}`);
    assert.deepEqual(fs.readdirSync(tmp), [], 'no doflow-conform-* is left');
  });
}

test('B5: conform leaves no SIGINT or SIGTERM listener behind, on success and on failure', POSIX, async () => {
  const counts = () => ['SIGINT', 'SIGTERM'].map((signal) => (process as any).listenerCount(signal));
  const before = counts();
  let during: number[] = [];
  const ok = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, onLog: () => { during = counts(); } });
  assert.equal(ok.exit, 0);
  assert.deepEqual(during, before.map((n) => n + 1), 'one handler per signal while conform runs');
  assert.deepEqual(counts(), before);
  const failing = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, registry: registryWith('codex', (w) => { w.model.argv = ['-m']; }) });
  assert.equal(failing.exit, 1);
  assert.deepEqual(counts(), before);
});

/** The bytes handleWorkerCommand prints for `outcome`: the --json body, and the text lines (or the exit-2 line). */
function printedBytes(outcome: any) {
  const json = Buffer.byteLength(`${JSON.stringify(outcome.body, null, 2)}\n`);
  const text = outcome.exit === 2
    ? Buffer.byteLength(`doflow worker: ${outcome.body.message}\n`)
    : Buffer.byteLength(`${conformModule().conformLines(outcome.body).join('\n')}\n`);
  return { json, text };
}

test('B6: every answer, each error included, is at most 4096 bytes as --json and as text', async (t) => {
  const outcomes: any = {
    'unknown-harness 5000 x': await conformVia(t, 'x'.repeat(5000)),
    'unknown-harness 5000 control characters': await conformVia(t, '\u0001'.repeat(5000)),
    'unknown-harness 5000 CJK characters': await conformVia(t, '漢'.repeat(5000)),
    usage: await executeWorkerCommand({ action: 'conform', view: EMPTY_VIEW }),
    'platform-unsupported': await executeWorkerCommand({ action: 'conform', harness: 'codex', view: EMPTY_VIEW, platform: 'win32' }),
  };
  if (process.platform !== 'win32') {
    const deep = path.join(tempDir(t, 'doflow-conform-deep-'), ...Array.from({ length: 40 }, () => '\u0001'.repeat(120)));
    outcomes['scratch-failed'] = await conformModule().conform({ harness: 'codex', view: EMPTY_VIEW, tmpDir: deep });
    assert.equal(outcomes['scratch-failed'].body.error, 'scratch-failed');
    // A code parser id of 5000 control characters, unknown to PARSERS, for both structuredOutput and mainSession.
    const id = '\u0001'.repeat(5000);
    outcomes['failed parts'] = await conformVia(t, 'codex', registryWith('codex', (w) => {
      w.structuredOutput = { ...w.structuredOutput, parser: id };
      delete w.structuredOutput.fieldMap;
      w.mainSession.parser = id;
    }));
    assert.ok(outcomes['failed parts'].body.failed.includes('stream'));
  }
  for (const [name, outcome] of Object.entries(outcomes) as any) {
    assert.equal(outcome.body.ok, false, name);
    const { json, text } = printedBytes(outcome);
    assert.ok(json <= 4096 && text <= 4096, `${name}: --json ${json} B, text ${text} B`);
  }
  assert.match(outcomes['unknown-harness 5000 x'].body.message, /^unknown harness 'x{64}'; known: /);
});

test('B6: an over-long harness name through bin/doflow.js prints at most 4096 bytes, --json and text', POSIX, (t) => {
  const scratch = createScratch('doflow-conform-long-');
  t.after(() => scratch.remove());
  for (const json of [true, false]) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), 'worker', '--action', 'conform', '--harness', 'x'.repeat(5000), ...(json ? ['--json'] : [])], {
      cwd: scratch.dir, env: childEnv(scratch), encoding: 'utf8', timeout: 120000,
    });
    assert.equal(r.status, 2, r.stderr);
    const bytes = Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
    assert.ok(bytes > 0 && bytes <= 4096, `${json ? '--json' : 'text'} is ${bytes} bytes`);
  }
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

// ---- 169 T4: the provider and effort parts ---------------------------------------------------------------------------

const PART = { evidence: ['x'], verification: 'v', verifiedOn: '2026-11-16' };
const piWith = (mutate: (worker: any) => void = () => {}) => registryWith('pi', (worker) => {
  worker.provider = { status: 'supported', ...PART, via: 'id-prefix', separator: '/' };
  worker.effort = { status: 'supported', ...PART, via: 'flag', argv: ['--thinking', '{effort}'], levels: ['low', 'high'] };
  mutate(worker);
});

test('169: a worker that declares provider and effort passes both parts on the composed argv', POSIX, async (t) => {
  const { exit, body } = await conformVia(t, 'pi', piWith());
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'provider').result, 'passed', JSON.stringify(partOf(body, 'provider')));
  assert.equal(partOf(body, 'provider').reason, 'conform-provider-1/conform-model-1 once, via one-shot');
  assert.equal(partOf(body, 'effort').result, 'passed', JSON.stringify(partOf(body, 'effort')));
  assert.equal(partOf(body, 'effort').reason, '--thinking low once, via one-shot');
  assert.deepEqual(body.parts.map((p: any) => p.part), PARTS);
});

test('169: a per-model effort binds conform-effort-1; an id-suffix transport checks the composed id once', POSIX, async (t) => {
  const registry = piWith((worker) => { worker.effort = { status: 'supported', ...PART, via: 'id-suffix', separator: '#', levels: 'per-model' }; });
  const { exit, body } = await conformVia(t, 'pi', registry);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'effort').reason, 'conform-model-1#conform-effort-1 once, via one-shot');
});

test('169: the effort part fails when the fake sees the transport flag twice, and a part not declared is unchecked', POSIX, async (t) => {
  const twice = piWith((worker) => { worker.readOnly.argv = [...worker.readOnly.argv, '--thinking', 'off']; });
  assertFailsPart(await conformVia(t, 'pi', twice), 'effort', /--thinking appears 2 times/);
  // The shipped data (169 T6): claude declares no provider, opencode declares no effort; each part is then unchecked, not failed.
  const claude = await conformVia(t, 'claude');
  assert.equal(partOf(claude.body, 'provider').result, 'unchecked');
  assert.equal(partOf(claude.body, 'provider').reason, 'not-declared');
  assert.equal(partOf((await conformVia(t, 'opencode')).body, 'effort').reason, 'not-declared');
});

test('169: a main-session-only worker checks the provider part through mainArgv', POSIX, async (t) => {
  const registry = piWith((worker) => { worker.oneShot = { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-16', reason: 'none' }; });
  const { body } = await conformVia(t, 'pi', registry);
  assert.equal(partOf(body, 'provider').result, 'passed', JSON.stringify(partOf(body, 'provider')));
  assert.match(partOf(body, 'provider').reason, /via main-session$/);
});

// ---- 169 review A-01 / A-07: the transport count is by key, and by whole composed id ---------------------------------

test('169 A-01: a keyed effort transport counts only its own `-c <key>=` pair; a fixed `-c other=v` pair stays and passes', POSIX, async (t) => {
  const registry = piWith((worker) => {
    worker.effort = { status: 'supported', ...PART, via: 'flag', argv: ['-c', 'reasoning={effort}'], levels: ['low', 'high'] };
    worker.readOnly.argv = [...worker.readOnly.argv, '-c', 'fixed_note=1'];
  });
  const { exit, body } = await conformVia(t, 'pi', registry);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'effort').result, 'passed', JSON.stringify(partOf(body, 'effort')));
  assert.equal(partOf(body, 'effort').reason, '-c reasoning=low once, via one-shot');
  const twice = piWith((worker) => {
    worker.effort = { status: 'supported', ...PART, via: 'flag', argv: ['-c', 'reasoning={effort}'], levels: ['low', 'high'] };
    worker.readOnly.argv = [...worker.readOnly.argv, '-c', 'reasoning=off'];
  });
  assertFailsPart(await conformVia(t, 'pi', twice), 'effort', /-c reasoning appears 2 times/);
});

test('169 A-07: an id transport counts argv elements equal to the composed id, not elements that merely contain the value', POSIX, async (t) => {
  const registry = piWith((worker) => { worker.readOnly.argv = [...worker.readOnly.argv, '--note', 'about-conform-provider-1-here']; });
  const { exit, body } = await conformVia(t, 'pi', registry);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'provider').result, 'passed', JSON.stringify(partOf(body, 'provider')));
  assert.equal(partOf(body, 'provider').reason, 'conform-provider-1/conform-model-1 once, via one-shot');
});

// ---- the control-channel part (row 170 T6, IC-007) -----------------------------------------------------------

/** A Pi-shaped channel (design 170 section 11) as a fixture, with a short grace and its own unverified list. */
const piChannel = (extra: any = {}) => ({
  status: 'supported', evidence: [], verification: 'fixture', verifiedOn: '2026-11-17',
  argv: ['--mode', 'rpc', '--no-approve'], framing: 'jsonl-lf', parser: 'pi-json-v1', commandPrefix: '/',
  messages: {
    followUp: { type: 'prompt', message: '{text}', streamingBehavior: 'followUp', id: '{id}' },
    steer: { type: 'prompt', message: '{text}', streamingBehavior: 'steer', id: '{id}' },
    stop: { type: 'abort', id: '{id}' },
  },
  turn: { working: [{ path: ['type'], equals: 'agent_start' }], settled: [{ path: ['type'], equals: 'agent_settled' }] },
  answer: {
    id: ['id'],
    accepted: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: true }],
    refused: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: false }],
  },
  close: { stdinEof: 'exits', graceSeconds: 1 },
  unverified: ['turn events in rpc mode'],
  ...extra,
});
const withChannel = (extra?: any, edit?: (entry: any) => void) => registryWith('pi', (w) => {
  w.controlChannel = piChannel(extra);
  edit?.(w.controlChannel);
});
const CHANNEL_TEXT = 'Conform message: \'single\' "double" $HOME \\back\\slash\nsecond line, é 漢字';
/** The prompt frame a follow-up or a steer sends (row 173 §6.7), written out so a change to it is seen here. */
const messageFrame = (body: string, outcome: string) => [
  '<input>', '<document id="message">', body, '</document>', '</input>', '',
  '<instructions>', outcome, '', '## Stop rule', 'Stop when the request is met or you need the person.', '</instructions>', '',
  '<output_format>', 'The person who started this session reads this reply; put the conclusion first.', '</output_format>', '',
].join('\n');
const FOLLOW_UP = 'Continue this session with the person\'s message in input.';
const STEER = 'Change course as the person\'s message in input asks, then continue.';
const pidGone = (pid: number) => {
  try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === 'ESRCH'; }
};

test('a fake with a Pi-shaped channel passes control-channel, which sits right after main-session, with the exact framed bytes', POSIX, async (t) => {
  const logs: any[] = [];
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: withChannel(), view: EMPTY_VIEW, onLog: (log: any) => logs.push(log) });
  assert.equal(exit, 0, JSON.stringify(body));
  const names = body.parts.map((p: any) => p.part);
  assert.equal(names[names.indexOf('main-session') + 1], 'control-channel');
  assert.deepEqual(names, PARTS);
  assert.deepEqual(partOf(body, 'control-channel'), {
    part: 'control-channel', result: 'passed', reason: '3 records byte for byte, turn working then waiting, answers by id, exit after stdin closed',
  });
  const channel = logs.find((log) => Array.isArray(log.received));
  assert.deepEqual(channel.argv, ['--mode', 'rpc', '--no-approve']);
  assert.deepEqual(channel.received, [
    `${JSON.stringify({ type: 'prompt', message: messageFrame(CHANNEL_TEXT, FOLLOW_UP), streamingBehavior: 'followUp', id: 'd-1' })}\n`,
    `${JSON.stringify({ type: 'prompt', message: messageFrame(CHANNEL_TEXT, STEER), streamingBehavior: 'steer', id: 'd-2' })}\n`,
    `${JSON.stringify({ type: 'abort', id: 'd-3' })}\n`,
  ]);
  assert.ok(pidGone(channel.pid), 'the fake has ended');
});

test('a channel with no steer template and no answer sends two records and passes', POSIX, async (t) => {
  const reg = withChannel({}, (entry) => {
    delete entry.messages.steer;
    delete entry.answer;
    entry.messages.followUp = { type: 'prompt', message: '{text}' };
    entry.messages.stop = { type: 'abort' };
  });
  const logs: any[] = [];
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: reg, view: EMPTY_VIEW, onLog: (log: any) => logs.push(log) });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(partOf(body, 'control-channel').reason, '2 records byte for byte, turn working then waiting, exit after stdin closed');
  assert.deepEqual(logs.find((log) => Array.isArray(log.received)).received, [
    `${JSON.stringify({ type: 'prompt', message: messageFrame(CHANNEL_TEXT, FOLLOW_UP) })}\n`, `${JSON.stringify({ type: 'abort' })}\n`,
  ]);
});

test('a fake that receives a record with an extra key fails control-channel by name', POSIX, async () => {
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: withChannel(), view: EMPTY_VIEW, channelFake: 'extra-key' });
  assertFailsPart({ exit, body }, 'control-channel', /did not take record 1: followUp: record holds the key 'id' the template does not/);
  assert.deepEqual(body.failed, ['control-channel']);
});

test('a fake that ignores stdin EOF fails "did not exit within graceSeconds after stdin closed" and none of it remains', POSIX, async () => {
  const logs: any[] = [];
  const started = Date.now();
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: withChannel(), view: EMPTY_VIEW, channelFake: 'ignore-eof', onLog: (log: any) => logs.push(log) });
  assertFailsPart({ exit, body }, 'control-channel', /did not exit within graceSeconds after stdin closed \(1 s\)/);
  assert.ok(Date.now() - started < 8000, 'the wait is the descriptor\'s graceSeconds, not conform\'s 10 s spawn bound');
  const pid = logs.find((log) => log.pid)?.pid;
  assert.ok(Number.isInteger(pid), 'the fake logged its pid');
  for (let i = 0; i < 50 && !pidGone(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(pidGone(pid), `the ignore-eof fake ${pid} is gone`);
});

test('a harness without a supported channel reports control-channel unchecked: not-declared', POSIX, async (t) => {
  // claude ships its channel as unknown (design 170 section 11); pi's is supported since T9a.
  const { exit, body } = await conformVia(t, 'claude');
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual(partOf(body, 'control-channel'), { part: 'control-channel', result: 'unchecked', reason: 'not-declared' });
});

test('a channel entry that fails its own validation fails control-channel, naming nothing else', POSIX, async () => {
  const reg = withChannel({}, (entry) => { entry.turn.settled = entry.turn.working; });
  const { exit, body } = await conformModule().conform({ harness: 'pi', registry: reg, view: EMPTY_VIEW });
  assertFailsPart({ exit, body }, 'control-channel', /does not pass its own validation/);
});
