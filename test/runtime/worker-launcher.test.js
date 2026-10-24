'use strict';

// 081 B.4 (IC-024, IC-023; DEC-014, DEC-030): the scenarios of test/hooks/context-authority.test.js
// that call the 078 stand-in's launch() (test/helper/launcher-stand-in.js), re-run through the real
// launcher, launchWorker (IC-012), and the fake CLI (IC-029). The fake's `frontDoors` step runs the
// install mirror's session-start.sh and user-prompt-submit.sh with the environment the launcher gave
// it, so the first prompt is the one the launched worker itself takes. Each case asserts what its
// stand-in version asserts, then the IC-023 forwarding observation. Two more cases: a fake that
// removes every DOFLOW_* before its front doors (forwarding `no`) and one that skips them
// (`hooksLoaded` `no`).
//
// The CLI grant case (context-authority.test.js "an over-budget context-grant exits 3 through
// doflow-run") spawns the dispatcher's context-grant verb and calls no launcher, so it is outside
// IC-024's rule (RK12) and is not re-run here.
//
// NFR-002: the launcher spawns `fake-claude`, a link to test/helper/fake-harness-cli.js in a scratch
// bin/. The child PATH is that bin/ plus the directory of process.execPath. The front doors are bash
// scripts that call POSIX tools, jq and git, so the same bin/ also links those named tools (TOOLS);
// no harness binary is reachable. Every caller env is built from nothing and deletes the five DOFLOW_*
// identity variables, so the launcher alone sets them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const { FAKE_CLI, IDENTITY_VARS, linkBin, writeScenario, readLog } = require('../helper/fake-harness-cli.ts');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');
const { launchEnv, launchWorker } = require('../../src/runtime/worker/launch.ts');
const { observeForwarding } = require('../../src/runtime/worker/readiness.ts');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { stateDir } = require('../../src/runtime/context/identity.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the fake CLI and the front doors are POSIX scripts' };
const REPO = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');
const NUDGE = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).promptNudge.message;
const CODE_CHANGE = 'add a retry to the upload client in src/upload.js';
const PACK_END = '[end of pack]';
const BOOTSTRAP = [/Git context/, /Not a git repository/, /\[Prior session summary/, /UNCOMMITTED-WARNING/];
const BRIEF = 'BRIEF: the task';
const RUN_ID = 'w-0123456789ab';
const HASH = 'abcdef0123456789';
/** The tools the front doors call; each is linked into the scratch bin/ from the system dirs. */
const TOOLS = ['bash', 'sh', 'awk', 'basename', 'cat', 'cp', 'cut', 'date', 'dirname', 'env', 'git', 'grep', 'head', 'jq', 'ln', 'ls',
  'mkdir', 'mktemp', 'mv', 'printf', 'rm', 'sed', 'sha256sum', 'shasum', 'sleep', 'sort', 'stat', 'tail', 'touch', 'tr', 'uname', 'wc'];
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

let mirror;
test.before(() => {
  mirror = buildInstallMirror(path.join(suiteTempDir('doflow-worker-launcher-mirror-'), 'mirror'));
  // The registry beside the mirrored policies (078 IC-006 candidate 1), so the nudge can be earned.
  const target = path.join(mirror, '.doflow', 'runtime', 'core', 'registry', 'workflows.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(REGISTRY, target);
});

/** A copy of a fake descriptor, so a case may change its recipe. */
function recipeOf(harness, binary) {
  const recipe = structuredClone(DESCRIPTORS[harness]);
  if (binary) recipe.cli.binary = binary;
  return recipe;
}

/** The scratch bin/: the fake CLI under `names`, then the named system tools. Returns the child PATH. */
function scratchBin(dir, names) {
  const bin = path.join(dir, 'bin');
  const childPath = linkBin(bin, names);
  for (const tool of TOOLS) {
    const found = SYSTEM_DIRS.map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
    if (found && !fs.existsSync(path.join(bin, tool))) fs.symlinkSync(found, path.join(bin, tool));
  }
  // The control's fake: the fake CLI with DOFLOW_RUN_ID removed from its environment.
  fs.writeFileSync(path.join(bin, 'fake-claude-norun'), `#!/bin/bash\nunset DOFLOW_RUN_ID\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`, { mode: 0o755 });
  return childPath;
}

/** A git repository on `main` with one commit, a store and a caller env built from nothing. */
function world(t) {
  const dir = tempDir(t, 'doflow-worker-launcher-');
  const w = { dir, repo: path.join(dir, 'repo'), home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), log: path.join(dir, 'log.jsonl'), seq: 0 };
  for (const d of [w.repo, w.home, w.xdg]) fs.mkdirSync(d, { recursive: true });
  const childPath = scratchBin(dir, ['fake-claude']);
  w.env = {
    PATH: childPath,
    HOME: w.home,
    XDG_CONFIG_HOME: w.xdg,
    TMPDIR: process.env.TMPDIR || '/tmp',
    GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_PROJECT_DIR: '',
    DOFLOW_AGENT: '',
    CLAUDE_CONFIG_DIR: '',
    CLAUDE_PROJECT_DIR: '',
    CODEX_HOME: '',
    FAKE_HARNESS_LOG: w.log,
  };
  for (const key of IDENTITY_VARS) delete w.env[key];
  const git = (...args) => {
    const r = spawnSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: { ...w.env, PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  w.store = path.join(w.xdg, 'doflow', 'session-env');
  return w;
}

/** A pending summary in (worktree, run, lineage), written by the store itself. */
function pending(w, body, { run = 'local', lineage = 'main' } = {}) {
  const made = writeSummary({ worktree: w.repo, run, lineage, compactedAt: '2026-10-14T10:00:00Z', sessionId: 'owner', branch: 'main', body, env: w.env });
  assert.ok(made, 'the summary is written');
  return made;
}

const ledgerOf = (store, unit) => {
  try { return fs.readFileSync(path.join(store, 'sessions', unit, 'emitted'), 'utf8'); } catch { return ''; }
};

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

/** One front door's result, parsed as the stand-in's firstPrompt() parses it. */
function parsed(door) {
  assert.equal(door.status, 0, 'hooks always exit 0');
  const out = door.stdout.trim() === '' ? {} : JSON.parse(door.stdout);
  return { stdout: door.stdout, additionalContext: out.additionalContext ?? out.hookSpecificOutput?.additionalContext ?? '' };
}

/** A scenario whose run step takes the first prompt through `harness`'s front doors. */
function doorsScenario(w, harness, { prompt = 'continue', stripEnv = false } = {}) {
  const sub = path.join(w.dir, `launch-${w.seq++}`);
  fs.mkdirSync(sub);
  const out = path.join(sub, 'doors.json');
  const sessionId = `launched-${harness}-${w.seq}`;
  return { out, file: writeScenario(sub, { run: [{ frontDoors: { mirror, harness, out, sessionId, prompt, ...(stripEnv ? { stripEnv: true } : {}) } }] }) };
}

/**
 * Launches a worker for the claim run key `<HASH>/<run>/<lineage>` through launchWorker with the
 * fake's front doors for `harness`, waits for its exit and observes forwarding (IC-023).
 * The recipe is the argv-mode claude fake, so the prompt the worker got is readable from the log.
 */
async function launchVia(w, { harness = 'claude', run, lineage, env = w.env, prompt, stripEnv, grant, recipe = recipeOf('claude') } = {}) {
  const scenario = doorsScenario(w, harness, { prompt, stripEnv });
  const caller = { ...env, FAKE_HARNESS_SCENARIO: scenario.file };
  const { identity } = launchEnv({ env: caller, runKey: `${HASH}/${run}/${lineage}`, token: 1, execWorktree: w.repo, runId: RUN_ID });
  const startedAtMs = Date.now();
  const before = readLog(w.log).length;
  const result = await launchWorker({ recipe, prompt: BRIEF, identity, execWorktree: w.repo, env: caller, ...(grant ? { grant } : {}) });
  assert.deepEqual(await exited(result.child), { code: 0, signal: null });
  const lines = readLog(w.log).slice(before);
  assert.equal(lines.length, 1, 'one worker invocation');
  const delivered = lines[0].argv.at(-1);
  assert.ok(delivered.endsWith(BRIEF), 'the brief is the end of the prompt');
  const text = delivered === BRIEF ? '' : delivered.slice(0, -(BRIEF.length + 2));
  const doors = fs.existsSync(scenario.out) ? JSON.parse(fs.readFileSync(scenario.out, 'utf8')) : null;
  const forwarding = observeForwarding({ env: result.env, identity, attempt: identity.attempt, cwd: w.repo, startedAtMs, at: new Date().toISOString() });
  return { launched: result.launched, identity, env: result.env, delivered, text, doors, forwarding, invocation: lines[0] };
}

/** The forwarding observation of a launched worker whose front doors ran with its identity. */
function forwarded(forwarding) {
  assert.deepEqual([forwarding.hooksLoaded.state, forwarding.hooksLoaded.reason], ['yes', 'unit-binding-observed']);
  assert.deepEqual([forwarding.identityForwarded.state, forwarding.identityForwarded.reason], ['yes', 'unit-binding-observed']);
}

// ── FR-013 (context-authority.test.js:199): launch, then the first prompt ─────────────────────

for (const harness of ['claude', 'codex']) {
  test(`IC-024 FR-013 (${harness}): the real launch then the worker's first prompt delivers the bootstrap exactly once`, POSIX_ONLY, async (t) => {
    const w = world(t);
    pending(w, 'LAUNCH-SUMMARY', { run: 'r9', lineage: 'm9' });
    const r = await launchVia(w, { harness, run: 'r9', lineage: 'm9' });
    assert.equal(r.launched.reason, 'emit');
    assert.ok(r.text.includes(PACK_END), 'the launch delivers the pack');
    assert.match(r.text, /LAUNCH-SUMMARY/, 'and the scoped summary');
    assert.equal(r.launched.bytes, Buffer.byteLength(r.text), 'the bytes reported are the text delivered');
    assert.equal(r.doors.sessionStart.status, 0);
    const prompt = parsed(r.doors.userPromptSubmit);
    for (const segment of BOOTSTRAP) assert.doesNotMatch(prompt.additionalContext, segment, 'the first prompt repeats no bootstrap segment');
    assert.deepEqual(JSON.parse(prompt.stdout), {}, 'the first prompt after a launch is silent');
    forwarded(r.forwarding);
  });
}

// ── context-authority.test.js:220: a worker gets no nudge and no git summary ─────────────────

test('IC-024 a launched worker gets no nudge and no git context; a main session in the same repository gets both', POSIX_ONLY, async (t) => {
  const w = world(t);
  for (const harness of ['claude', 'codex']) {
    const r = await launchVia(w, { harness, run: 'r3', lineage: `w3${harness}`, prompt: CODE_CHANGE });
    assert.equal(r.launched.reason, 'emit');
    assert.doesNotMatch(r.text, /Git context/, `${harness}: the launch has no git segment`);
    assert.equal(r.text.includes(NUDGE), false, `${harness}: or nudge`);
    const worker = parsed(r.doors.userPromptSubmit);
    assert.doesNotMatch(worker.additionalContext, /Git context/, `${harness}: no git context`);
    assert.equal(worker.additionalContext.includes(NUDGE), false, `${harness}: no nudge`);
    assert.deepEqual(JSON.parse(worker.stdout), {});
    forwarded(r.forwarding);

    // The control: the same prompt through the same fake with no identity, a main session, earns both.
    const main = doorsScenario(w, harness, { prompt: CODE_CHANGE });
    const s = spawnSync(path.join(w.dir, 'bin', 'fake-claude'), ['run'], { cwd: w.repo, env: { ...w.env, FAKE_HARNESS_SCENARIO: main.file }, encoding: 'utf8' });
    assert.equal(s.status, 0, s.stderr);
    const prompt = parsed(JSON.parse(fs.readFileSync(main.out, 'utf8')).userPromptSubmit);
    assert.match(prompt.additionalContext, /^Git context — branch: main/, `${harness}: main gets git context`);
    assert.ok(prompt.additionalContext.endsWith(NUDGE), `${harness}: main gets the nudge`);
  }
});

// ── context-authority.test.js:240: a grant above the budget gives the pointer, never a cut ────

/** The 078 FR-004 world: a budget the pack alone fits plus room for the pointer, and a pending body above it. */
function overBudget(w) {
  const fits = (bytes) => {
    const { env } = launchEnv({ env: { ...w.env, DOFLOW_CONTEXT_MAX_BYTES: String(bytes) }, runKey: `${HASH}/probe/p1`, token: 1, execWorktree: w.repo, runId: RUN_ID });
    return emitContext({ event: 'launch', cwd: w.repo, peek: true, env }).decision.reason === 'emit';
  };
  let floor = 1024;
  while (!fits(floor)) { floor += 256; assert.ok(floor < 65536, 'the pack fits some budget'); }
  const max = String(floor + 600);
  const body = `GRANT-HEAD-${'g'.repeat(Number(max) + 1000)}`;
  return { max, body, made: pending(w, body) };
}

const GRANT = (w) => ({ summary: 'pending', fromWorktree: w.repo, fromRun: 'local', fromLineage: 'main', maxBytes: 65536 });

test('IC-024 FR-004: a grant above DOFLOW_CONTEXT_MAX_BYTES is refused at the real launch, never cut, and not repeated', POSIX_ONLY, async (t) => {
  const w = world(t);
  const { max, made } = overBudget(w);
  const env = { ...w.env, DOFLOW_CONTEXT_MAX_BYTES: max };
  const r = await launchVia(w, { env, run: 'r4', lineage: 'w4', grant: GRANT(w) });
  const grantFile = path.join(stateDir(env), 'grants', 'r4', 'w4', `${made.summaryId}.md`);

  assert.equal(r.launched.reason, 'refused:mandatory-over-budget');
  assert.equal(fs.existsSync(grantFile), true, 'the grant of the pending summary is written and not consumed');
  assert.doesNotMatch(r.delivered, /GRANT-HEAD|ggggg/, 'no part of the body is cut into the worker prompt');
  assert.match(ledgerOf(w.store, 'L.r4.w4.1'), new RegExp(`\\tgrant\\t${made.summaryId}\\trefused:mandatory-over-budget\\tlauncher\\n`));

  const prompt = parsed(r.doors.userPromptSubmit);
  assert.doesNotMatch(prompt.additionalContext, /GRANT-HEAD|ggggg/, 'the first prompt cuts nothing in either');
  assert.doesNotMatch(prompt.additionalContext, /withheld/, 'and does not repeat the pointer');
  assert.equal(fs.existsSync(grantFile), true);
  forwarded(r.forwarding);
});

// DEC-052: the stand-in's launch() returns the refused emission's text, and the 078 case asserts that
// text carries the pack and the pointer. launchWorker delivers any returned text, a refusal's included.
test('IC-024 FR-004: the refused launch delivers the pack and the pointer to the worker (078 stand-in assertion)', POSIX_ONLY, async (t) => {
  const w = world(t);
  const { max, body, made } = overBudget(w);
  const r = await launchVia(w, { env: { ...w.env, DOFLOW_CONTEXT_MAX_BYTES: max }, run: 'r4', lineage: 'w4', grant: GRANT(w) });
  assert.ok(r.text.includes(PACK_END), 'the pack is delivered');
  assert.ok(r.text.includes(`[Granted summary ${made.summaryId} withheld: ${Buffer.byteLength(body)} bytes exceed the`), 'the pointer is delivered');
});

// ── IC-023: forwarding `no` and hooks not loaded ──────────────────────────────────────────────

test('IC-024 a fake that removes every DOFLOW_* before its front doors: hooks loaded, identity not forwarded', POSIX_ONLY, async (t) => {
  const w = world(t);
  const r = await launchVia(w, { run: 'r6', lineage: 'w6', stripEnv: true });
  assert.equal(r.invocation.doflowEnv.DOFLOW_RUN_ID, 'r6', 'the launcher set the identity; the fake removed it');
  assert.equal(r.doors.sessionStart.status, 0);
  assert.deepEqual([r.forwarding.hooksLoaded.state, r.forwarding.hooksLoaded.reason], ['yes', 'session-start-logged']);
  assert.deepEqual([r.forwarding.identityForwarded.state, r.forwarding.identityForwarded.reason], ['no', 'no-unit-binding']);
});

test('IC-024 a fake that skips its front doors: hooks not loaded, forwarding unknown', POSIX_ONLY, async (t) => {
  const w = world(t);
  const recipe = recipeOf('claude');
  recipe.oneShot.argv = ['run', '--skip-front-doors', '{prompt}'];
  const r = await launchVia(w, { run: 'r7', lineage: 'w7', recipe });
  assert.ok(r.invocation.argv.includes('--skip-front-doors'));
  assert.equal(r.doors, null, 'no front door ran');
  assert.deepEqual([r.forwarding.hooksLoaded.state, r.forwarding.hooksLoaded.reason], ['no', 'no-session-start-observed']);
  assert.deepEqual([r.forwarding.identityForwarded.state, r.forwarding.identityForwarded.reason], ['unknown', 'hooks-not-loaded']);
});

test('negative control: the forwarding case with a fake that removes DOFLOW_RUN_ID reports forwarding not observed', POSIX_ONLY, async (t) => {
  const w = world(t);
  const r = await launchVia(w, { run: 'r8', lineage: 'w8', recipe: recipeOf('claude', 'fake-claude-norun') });
  assert.equal(r.invocation.doflowEnv.DOFLOW_RUN_ID, null, 'the fake ran without DOFLOW_RUN_ID');
  assert.equal(r.invocation.doflowEnv.DOFLOW_LINEAGE_ID, 'w8');
  assert.notEqual(r.forwarding.identityForwarded.state, 'yes', 'forwarding is not observed');
  assert.notEqual(r.forwarding.identityForwarded.reason, 'unit-binding-observed');
  assert.throws(() => forwarded(r.forwarding), { name: 'AssertionError' });
});
