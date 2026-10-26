'use strict';

// Feature 095b B.1 (IC-001), 119 A.4 (IC-005): `review --action start`; the depth rule is `resolveProtocol` (review-protocol-resolve.test.js). Every case runs in a
// scratch git repository with a scratch HOME; nothing is written to the real record or advice stores.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const { handleReviewCommand } = require('../../src/runtime/review/command.ts');
const { reviewPrecondition } = require('../../src/runtime/review/start.ts');
const { protocolDigest } = require('../../src/runtime/review/resolve-protocol.ts');
const { storeFileFor } = require('../../src/runtime/dispatch/store.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = '095b-review-depth';
const REGISTRY = loadVerificationRegistry({ repoRoot: REPO_ROOT });
const HEX_A = 'a'.repeat(40);

// maint-thin: the shipped default is review-single and the class seat floor binds only while autopilot is on. Most
// tests here pin the risk rule and the floor, so their user layer opts in: review.preset auto and autopilot on.
// `thin: true` leaves the user layer empty (the shipped default).
const OPT_IN = { schema: 1, 'review.preset': 'auto', 'autopilot.enabled': 'on' };

function envFor(dir: any, { thin = false }: any = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
  if (!thin) fs.writeFileSync(path.join(home, '.config', 'doflow', 'settings.json'), JSON.stringify(OPT_IN));
  return {
    PATH: process.env.PATH,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_TELEMETRY: 'off',
  };
}

function git(cwd: any, env: any, args: any) {
  const res = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function put(root: any, rel: any, text: any) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/**
 * A scratch repository: one base commit, then one commit holding `files`. `.doflow/` is excluded from
 * git, as a real checkout does, so the run and record files do not make the tree dirty.
 */
function repo(t: any, { taskClass = 'feature', files = { 'src/a.ts': 'export {};\n' }, run = true, thin = false }: any = {}) {
  const dir = tempDir(t, 'doflow-review-start-');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  const env = envFor(dir, { thin });
  git(cwd, env, ['init', '-q', '-b', 'main']);
  put(cwd, '.git/info/exclude', '.doflow/\n');
  put(cwd, 'README.md', 'base\n');
  git(cwd, env, ['add', '-A']);
  git(cwd, env, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, env, ['rev-parse', 'HEAD']);
  for (const [rel, text] of Object.entries(files)) put(cwd, rel, text);
  git(cwd, env, ['add', '-A']);
  git(cwd, env, ['commit', '-q', '-m', 'change', '--allow-empty']);
  const head = git(cwd, env, ['rev-parse', 'HEAD']);
  if (run) put(cwd, `.doflow/state/orchestration/${SLUG}.json`, JSON.stringify({ taskId: SLUG, taskClass, state: 'ACTIVE', program: [], history: [] }));
  const lines = (records: any) => put(cwd, `.doflow/state/verification/runs/${SLUG}.jsonl`, records.map((r: any) => `${JSON.stringify(r)}\n`).join(''));
  const line = (extra: any = {}) => ({ schema: 1, taskId: SLUG, head, clean: true, verdict: 'PASS', at: '2026-10-23T00:00:00.000Z', reportSha256: 'x', ...extra });
  const enableAdvice = () => {
    put(env.XDG_CONFIG_HOME, 'doflow/decision-model.json', JSON.stringify({ schema: 1, enabled: true, provider: 'ollama', endpoint: 'http://127.0.0.1:9', model: 'clef-flash' }));
  };
  return { dir, cwd, env, base, head, lines, line, enableAdvice, git: (args: any) => git(cwd, env, args) };
}

/** Runs the verb in-process; the verb reports through `process.exitCode`, which is restored here. */
async function start(r: any, options: any = {}): Promise<any> {
  const out: any = [];
  const saved = process.exitCode;
  const exitCode = await handleReviewCommand({
    action: 'start', slug: SLUG, json: true, cwd: r.cwd, env: r.env,
    resolve: () => ({ error: 'no-active-feature' }), out: (l: any) => out.push(l), ...options,
  });
  process.exitCode = saved;
  return { exitCode, out, json: options.json === false ? null : JSON.parse(out.join('\n')) };
}

function tree(root: any, base: any = root, out: any = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) tree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

// ---- IC-001: the verb --------------------------------------------------------------------------

// maint-thin (user ruling 2026-10-26): with the shipped settings a person-attended feature review of a code change is
// review-single, 1 seat, 1 round, floor 0. Turning autopilot on alone brings back the gate-b floor of 2 seats.
test('maint-thin: the shipped default gives a feature code change 1 seat and 1 round; autopilot on restores the floor', async (t) => {
  const r = repo(t, { thin: true });
  r.lines([r.line()]);
  const thin = await start(r);
  assert.equal(thin.exitCode, 0);
  assert.equal(thin.json.protocol.id, 'review-single');
  assert.equal(thin.json.seats, 1);
  assert.equal(thin.json.protocol.rounds, 1);
  assert.equal(thin.json.depthBasis.floor, 0);
  fs.writeFileSync(path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }));
  const unattended = await start(r);
  assert.equal(unattended.exitCode, 0);
  assert.equal(unattended.json.protocol.id, 'review-deep');
  assert.equal(unattended.json.seats, 2);
  assert.equal(unattended.json.depthBasis.floor, 2);
  assert.equal(unattended.json.depthBasis.raisedBy, 'gate-floor');
  // maint-thin P2: an uncertain switch (a value the settings reader rejects) is unattended, so the floor binds
  fs.writeFileSync(path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'maybe' }));
  const uncertain = await start(r);
  assert.equal(uncertain.exitCode, 0, JSON.stringify(uncertain.json));
  assert.equal(uncertain.json.seats, 2);
  assert.equal(uncertain.json.depthBasis.floor, 2);
  // an explicit process-local DOFLOW_AUTOPILOT_ENABLED=off is attended; gate-b still judges the seats itself
  const local = await start({ ...r, env: { ...r.env, DOFLOW_AUTOPILOT_ENABLED: 'off' } });
  assert.equal(local.exitCode, 0);
  assert.equal(local.json.seats, 1);
  assert.equal(local.json.depthBasis.floor, 0);
  // maint-thin P2: a preset this install does not have blocks the review, never a silent thin run
  fs.writeFileSync(path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'review.preset': 'review-nope' }));
  const missing = await start(r);
  assert.notEqual(missing.exitCode, 0);
  assert.match(JSON.stringify(missing.json), /settings-unavailable/);
});

test('PASS on a clean HEAD: exit 0, deep, 2 seats, risk from the default for a line without risk', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.equal(json.schema, 1);
  assert.equal(json.slug, SLUG);
  assert.equal(json.taskClass, 'feature');
  assert.equal(json.applicable, true);
  assert.equal(json.notApplicable, null);
  assert.equal(json.head, r.head);
  assert.equal(json.clean, true);
  assert.equal(json.ok, true);
  assert.deepEqual(json.reasons, []);
  assert.equal(json.depth, 'deep');
  assert.equal(json.seats, 2);
  assert.equal(json.risk, REGISTRY.policy.defaultRiskLevel);
  assert.equal(json.riskSource, 'default');
  assert.deepEqual(json.advice, { status: 'off', pick: null });
  assert.match(json.protocolDigest, /^[0-9a-f]{64}$/);
  assert.equal(json.protocolDigest, protocolDigest(json.protocol));
  assert.deepEqual(json.protocol.disagreements, []);
  assert.deepEqual(Object.keys(json), ['schema', 'slug', 'taskClass', 'applicable', 'notApplicable', 'head', 'clean', 'ok',
    'reasons', 'depth', 'seats', 'risk', 'riskSource', 'protocol', 'protocolDigest', 'depthBasis', 'advice', 'authors', 'forbidden']);
});

test('the risk of the last clean matching line is used when valid; an invalid one falls back to the default', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'HIGH' }), r.line({ head: HEX_A, risk: 'LOW' }), r.line({ risk: 'LOW' })]);
  const low = await start(r, { base: r.base });
  assert.equal(low.json.risk, 'LOW');
  assert.equal(low.json.riskSource, 'record');
  r.lines([r.line({ risk: 'URGENT' })]);
  const bad = await start(r, { base: r.base });
  assert.equal(bad.json.risk, REGISTRY.policy.defaultRiskLevel);
  assert.equal(bad.json.riskSource, 'default');
});

test('a bug run with docs-only paths at LOW is single with one seat; at MEDIUM it is deep', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n', 'CHANGELOG.md': 'y\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  const low = await start(r, { base: r.base });
  assert.equal(low.exitCode, 0);
  assert.equal(low.json.depth, 'single');
  assert.equal(low.json.seats, 1);
  assert.deepEqual(low.json.depthBasis, { scope: 'light', files: 2, base: r.base, floor: 0, raisedBy: null });
  r.lines([r.line({ risk: 'MEDIUM' })]);
  const medium = await start(r, { base: r.base });
  assert.equal(medium.json.depth, 'deep');
  assert.equal(medium.json.seats, 2);
  assert.equal(medium.json.depthBasis.raisedBy, 'policy');
});

test('a feature run takes the gate-b floor: docs-only at LOW is deep, raised by gate-floor', async (t) => {
  const r: any = repo(t, { taskClass: 'feature', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  const { json } = await start(r, { base: r.base });
  assert.equal(json.depth, 'deep');
  assert.equal(json.seats, 2);
  assert.deepEqual(json.depthBasis, { scope: 'light', files: 1, base: r.base, floor: 2, raisedBy: 'gate-floor' });
});

// ---- 119 IC-005: the resolved protocol and --preset ----------------------------------------------------

test('--json carries the resolved protocol after riskSource; seats equals its seat count', async (t) => {
  const r: any = repo(t, { taskClass: 'feature', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  const { json } = await start(r, { base: r.base });
  assert.equal(json.protocol.id, 'review-deep');
  assert.equal(json.protocol.depth, json.depth);
  assert.equal(json.seats, json.protocol.seats.length);
  assert.equal(json.protocol.origins.id, 'floor');
  assert.equal(json.depthBasis.raisedBy, 'gate-floor');
  const keys = Object.keys(json);
  assert.deepEqual(keys.slice(keys.indexOf('risk')), ['risk', 'riskSource', 'protocol', 'protocolDigest', 'depthBasis', 'advice', 'authors', 'forbidden']);
});

test('--preset review-single on a feature with code changes is refused preset-looser: exit 1, no decision', async (t) => {
  const r = repo(t, { taskClass: 'feature' });
  r.lines([r.line()]);
  const { exitCode, json } = await start(r, { preset: 'review-single' });
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'preset-looser');
  assert.equal(json.applicable, null);
  assert.equal(json.depth, null);
  assert.equal(json.seats, null);
  assert.equal(json.protocol, null);
});

test('--preset with an unknown id, or a debate preset, is refused preset-unknown', async (t) => {
  const r = repo(t, { taskClass: 'bug' });
  r.lines([r.line()]);
  for (const preset of ['nope', 'debate-2']) {
    const { exitCode, json } = await start(r, { preset });
    assert.equal(exitCode, 1, preset);
    assert.equal(json.error, 'preset-unknown', preset);
  }
});

test('--preset review-deep on a LOW docs-only bug is taken: origin run, raisedBy run, 2 seats', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  const { exitCode, json } = await start(r, { base: r.base, preset: 'review-deep' });
  assert.equal(exitCode, 0);
  assert.equal(json.depth, 'deep');
  assert.equal(json.seats, 2);
  assert.equal(json.protocol.origins.id, 'run');
  assert.equal(json.depthBasis.raisedBy, 'run');
});

test('--preset is checked after the preconditions: a failed verify gives the verify reasons, not a preset refusal', async (t) => {
  const r = repo(t, { taskClass: 'feature' });
  const { exitCode, json } = await start(r, { preset: 'nope' });
  assert.equal(exitCode, 1);
  assert.deepEqual(json.reasons, ['verify-missing']);
  assert.equal(json.error, undefined);
});

test('--preset with an empty or malformed value, or with --action check, is a usage error', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  for (const preset of ['', '  ', 'Review_Deep', '-x', 'a b', ['review-deep', 'review-single']]) {
    const { exitCode, json } = await start(r, { preset });
    assert.equal(exitCode, 2, JSON.stringify(preset));
    assert.equal(json.error, 'usage');
  }
  const check = await start(r, { action: 'check', preset: 'review-deep' });
  assert.equal(check.exitCode, 2);
  assert.match(check.json.message, /--preset/);
});

test('the text form prints the protocol lines after riskSource', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const { exitCode, out } = await start(r, { json: false });
  assert.equal(exitCode, 0);
  const at = out.findIndex((line: any) => line.startsWith('protocol: id=review-deep '));
  assert.ok(at > out.findIndex((line: any) => line.startsWith('riskSource:')), out.join('\n'));
  assert.match(out[at + 1], /^protocol\.seats: seat-a\[/);
  assert.match(out[at + 2], /^protocol\.origins: id=risk /);
  assert.match(out[at + 3], /^protocol\.invariants: INV-1,/);
  assert.equal(out[at + 4], 'protocol.enforcement: reviewer native=claude,opencode,copilot,kiro unenforced=codex,pi,antigravity');
  assert.ok(out.some((line: any) => line.startsWith('depthBasis: ')));
});

test('the JSON protocol seats the reviewer agent and carries 7 enforcement rows', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.deepEqual(json.protocol.seats.map((seat: any) => seat.agent), ['reviewer', 'reviewer']);
  assert.deepEqual(json.protocol.enforcement.map((row: any) => `${row.agent}/${row.harness}/${row.status}`), [
    'reviewer/claude/native', 'reviewer/codex/unenforced', 'reviewer/opencode/native',
    'reviewer/pi/unenforced', 'reviewer/copilot/native', 'reviewer/kiro/native', 'reviewer/antigravity/unenforced',
  ]);
  assert.equal(json.protocol.enforcement[0].reason, null);
  assert.match(json.protocol.enforcement[1].reason, /sandbox_mode/);
});

// ---- IC-005: the seat floor is the shipped gates.json narrowed by the project's gates.override.json ----

const OVERRIDE = '.doflow/gates.override.json';
const overrideMinSeats = (n: any) => JSON.stringify({ classes: { feature: { 'gate-b': { minSeats: n } } } });

test('a project override that raises the feature gate-b minSeats to 3 gives 3 seats and floor 3', async (t) => {
  const r: any = repo(t, { taskClass: 'feature', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  put(r.cwd, OVERRIDE, overrideMinSeats(3));
  const { exitCode, json } = await start(r, { base: r.base });
  assert.equal(exitCode, 0);
  assert.equal(json.seats, 3);
  assert.equal(json.depth, 'deep');
  assert.deepEqual(json.depthBasis, { scope: 'light', files: 1, base: r.base, floor: 3, raisedBy: 'gate-floor' });
});

for (const [name, bytes, error, reason] of [
  ['an override that lowers minSeats to 1', overrideMinSeats(1), 'policy-override-widens', 'policy-override-widens:classes.feature.gate-b.minSeats'],
  ['an override that is not JSON', 'not json {', 'policy-override-invalid', 'policy-override-invalid'],
]) {
  test(`${name} is refused ${error}: exit 1, no decision, the message names the reason and the file`, async (t) => {
    const r: any = repo(t, { taskClass: 'feature', files: { 'docs/a.md': 'x\n' } });
    r.lines([r.line({ risk: 'LOW' })]);
    put(r.cwd, OVERRIDE, bytes);
    const { exitCode, json } = await start(r, { base: r.base });
    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.applicable, null);
    assert.equal(json.error, error);
    assert.ok(json.message.includes(reason), json.message);
    assert.ok(json.message.includes(OVERRIDE), json.message);
    assert.equal(json.depth, null);
    assert.equal(json.seats, null);
  });
}

test('an override does not turn a failed precondition into a policy refusal: the verify reasons still come first', async (t) => {
  const r = repo(t, { taskClass: 'feature' });
  put(r.cwd, OVERRIDE, 'not json {');
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.deepEqual(json.reasons, ['verify-missing']);
  assert.equal(json.error, undefined);
});

test('a base that does not resolve gives scope unknown and deep', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  const { exitCode, json } = await start(r, { base: 'no-such-ref' });
  assert.equal(exitCode, 0);
  assert.equal(json.depth, 'deep');
  assert.equal(json.depthBasis.scope, 'unknown');
  assert.equal(json.depthBasis.base, null);
});

test('a rename counts both paths: moving a doc into src is code', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/m.md': 'move me\n' } });
  const mid = r.head;
  fs.mkdirSync(path.join(r.cwd, 'src'), { recursive: true });
  r.git(['mv', 'docs/m.md', 'src/m.md']);
  r.git(['commit', '-q', '-m', 'move']);
  const head = r.git(['rev-parse', 'HEAD']);
  r.lines([r.line({ head, risk: 'LOW' })]);
  const { json } = await start(r, { base: mid });
  assert.equal(json.depthBasis.scope, 'code');
  assert.equal(json.depthBasis.files, 2);
  assert.equal(json.depth, 'deep');
});

for (const [name, records, dirty, reasons] of [
  ['missing', [], false, ['verify-missing']],
  ['not-pass', [{ verdict: 'FAIL' }], false, ['verify-not-pass']],
  ['flaky', [{ verdict: 'FAIL' }, { verdict: 'PASS' }], false, ['verify-flaky']],
  ['dirty', [{}], true, ['tree-dirty']],
  ['missing and dirty', [], true, ['tree-dirty', 'verify-missing']],
  ['not-pass and dirty', [{ verdict: 'PASS' }, { verdict: 'FAIL' }], true, ['tree-dirty', 'verify-not-pass']],
] as any[]) {
  test(`refused: ${name} exits 1 with sorted reasons and no decision`, async (t) => {
    const r = repo(t);
    r.lines(records.map((extra: any) => r.line(extra)));
    if (dirty) put(r.cwd, 'src/uncommitted.ts', 'x\n');
    const { exitCode, json } = await start(r);
    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.applicable, true);
    assert.deepEqual(json.reasons, reasons);
    assert.equal(json.depth, null);
    assert.equal(json.seats, null);
    assert.equal(json.depthBasis, null);
    assert.equal(json.clean, !dirty);
  });
}

test('the refused text form ends with the next command, and names --base when given', async (t) => {
  const r = repo(t);
  const plain = await start(r, { json: false });
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.out.at(-1), `doflow verify --action report --task-id ${SLUG}`);
  const based = await start(r, { json: false, base: r.base });
  assert.equal(based.out.at(-1), `doflow verify --action report --task-id ${SLUG} --baseline-ref ${r.base}`);
});

test('an unparseable record line exits 1 with records-unreadable', async (t) => {
  const r = repo(t);
  put(r.cwd, `.doflow/state/verification/runs/${SLUG}.jsonl`, `${JSON.stringify(r.line())}\nnot json\n`);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'records-unreadable');
});

for (const [name, setup, expected] of [
  ['class review', { taskClass: 'review' }, 'class-exempt'],
  ['class documentation', { taskClass: 'documentation' }, 'class-exempt'],
  ['class research (no review stage)', { taskClass: 'research' }, 'class-exempt'],
  ['no run', { run: false }, 'no-run'],
]) {
  test(`not applicable: ${name} exits 0 with applicable false, even on a dirty tree`, async (t) => {
    const r: any = repo(t, setup);
    put(r.cwd, 'src/uncommitted.ts', 'x\n');
    const { exitCode, json } = await start(r);
    assert.equal(exitCode, 0);
    assert.equal(json.applicable, false);
    assert.equal(json.notApplicable, expected);
    assert.equal(json.ok, true);
    assert.deepEqual(json.reasons, []);
  });
}

test('not applicable: no slug (no --slug and no active feature) exits 0 with no-feature', async (t) => {
  const r = repo(t);
  const { exitCode, json } = await start(r, { slug: undefined });
  assert.equal(exitCode, 0);
  assert.equal(json.applicable, false);
  assert.equal(json.notApplicable, 'no-feature');
  assert.equal(json.slug, null);
});

test('the active feature is the slug when --slug is absent', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const { json } = await start(r, { slug: undefined, resolve: () => ({ featureFolder: '/x', paths: { feature_slug: SLUG } }) });
  assert.equal(json.slug, SLUG);
  assert.equal(json.applicable, true);
});

test('a slug that is not a plain feature name is a usage error, never a path', async (t) => {
  const r = repo(t);
  for (const slug of ['../x', 'a/b', '.hidden', '']) {
    const { exitCode } = await start(r, { slug });
    assert.equal(exitCode, 2, `slug ${JSON.stringify(slug)}`);
  }
});

test('the verb writes nothing: the scratch tree is byte-identical after a run (applicable, refused, exempt)', async (t) => {
  for (const [setup, records] of [[{}, [{}]], [{}, []], [{ taskClass: 'documentation' }, []]] as any[]) {
    const r: any = repo(t, setup);
    r.lines(records.map((extra: any) => r.line(extra)));
    const before = tree(r.dir);
    await start(r);
    assert.deepEqual(tree(r.dir), before);
  }
});

test('--path with start, an unknown action and --base with check exit 2 as usage', async (t) => {
  const r = repo(t);
  const withPath = await start(r, { path: 'review/findings.json' });
  assert.equal(withPath.exitCode, 2);
  assert.equal(withPath.json.error, 'usage');
  const unknown = await start(r, { action: 'lint' });
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.json.error, 'usage');
  const base = await start(r, { action: 'check', base: 'main' });
  assert.equal(base.exitCode, 2);
});

test('through bin/doflow.js with stdin closed: refusal exits 1 and the run never prompts', (t) => {
  const r = repo(t);
  const res = spawnSync(process.execPath, [CLI, 'review', '--action', 'start', '--slug', SLUG, '--json'],
    { cwd: r.cwd, env: { ...r.env, DOFLOW_CLI: CLI }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).reasons, ['verify-missing']);
  r.lines([r.line()]);
  const ok = spawnSync(process.execPath, [CLI, 'review', '--action', 'start', '--slug', SLUG, '--base', r.base, '--json'],
    { cwd: r.cwd, env: { ...r.env, DOFLOW_CLI: CLI }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.equal(ok.status, 0, ok.stderr);
  const json = JSON.parse(ok.stdout);
  assert.equal(json.depth, 'deep');
  assert.equal(json.depthBasis.base, r.base);
  const bad = spawnSync(process.execPath, [CLI, 'review', '--action', 'start', '--path', 'x.json', '--json'],
    { cwd: r.cwd, env: { ...r.env, DOFLOW_CLI: CLI }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error, 'usage');
});

// ---- C-2: an empty changed-path list is an unknown scope ----------------------------------------------

test('C-2 (12b): a source change committed on the integration branch (no --base) is deep, never single', async (t) => {
  const r = repo(t, { taskClass: 'bug', files: { 'src/a.ts': 'export const a = 1;\n' } });
  r.git(['branch', '-m', 'develop']);
  r.lines([r.line({ risk: 'LOW' })]);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.equal(json.depth, 'deep');
  assert.equal(json.seats, 2);
  assert.equal(json.depthBasis.scope, 'unknown');
  assert.equal(json.depthBasis.files, 0);
});

test('C-2 (12c): a branch already contained in develop (empty diff) is deep, never single', async (t) => {
  const r = repo(t, { taskClass: 'bug', files: { 'src/a.ts': 'export const a = 1;\n' } });
  r.git(['branch', 'develop']);
  r.git(['checkout', '-q', '-b', 'feat/x']);
  r.lines([r.line({ risk: 'LOW' })]);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.equal(json.depth, 'deep');
  assert.equal(json.depthBasis.scope, 'unknown');
});

// ---- C-1: the run is found by slug in both layouts; every uncertain case refuses ----------------------

const FIX = `${SLUG}-fix`;
const putRun = (r: any, rel: any, run: any) => put(r.cwd, `.doflow/state/orchestration/${rel}`, typeof run === 'string' ? run : JSON.stringify(run));
const putRecords = (r: any, id: any, records: any) => put(r.cwd, `.doflow/state/verification/runs/${id}.jsonl`, records.map((x: any) => `${JSON.stringify(x)}\n`).join(''));

test('C-1 (R2-1): a bug run stored as <slug>/<slug>-fix.json with a verify FAIL and a dirty tree refuses', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, `${SLUG}/${FIX}.json`, { taskId: FIX, taskClass: 'bug', state: 'ACTIVE' });
  putRecords(r, FIX, [r.line({ taskId: FIX, verdict: 'FAIL' })]);
  put(r.cwd, 'src/uncommitted.ts', 'x\n');
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  assert.equal(json.applicable, true);
  assert.equal(json.taskClass, 'bug');
  assert.deepEqual(json.reasons, ['tree-dirty', 'verify-not-pass']);
  assert.equal(json.seats, null);
  assert.equal(json.depth, null);
});

test('C-1: the namespaced run is checked against the records of its own task id; a clean PASS there starts the review', async (t) => {
  const r = repo(t, { run: false, taskClass: 'bug' });
  putRun(r, `${SLUG}/${FIX}.json`, { taskId: FIX, taskClass: 'bug', state: 'ACTIVE' });
  putRecords(r, SLUG, [r.line()]);
  const wrongKey = await start(r);
  assert.equal(wrongKey.exitCode, 1);
  assert.deepEqual(wrongKey.json.reasons, ['verify-missing']);
  putRecords(r, FIX, [r.line({ taskId: FIX })]);
  const { exitCode, json } = await start(r, { base: r.base });
  assert.equal(exitCode, 0);
  assert.equal(json.applicable, true);
  assert.equal(json.taskClass, 'bug');
  assert.equal(json.ok, true);
  assert.equal(json.depth, 'deep');
  const plain = await start(r, { json: false });
  assert.equal(plain.exitCode, 0);
});

test('C-1: the refused text form names the run task id in the next command', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, `${SLUG}/${FIX}.json`, { taskId: FIX, taskClass: 'bug', state: 'ACTIVE' });
  const { exitCode, out } = await start(r, { json: false });
  assert.equal(exitCode, 1);
  assert.equal(out.at(-1), `doflow verify --action report --task-id ${FIX}`);
});

const REFUSE_SETUPS: any = [
  ['a truncated run file (case 17)', 'run-unreadable', (r: any) => putRun(r, `${SLUG}.json`, '{"taskId":"x","taskCla')],
  ['a run file with no taskClass (case 18)', 'run-unreadable', (r: any) => putRun(r, `${SLUG}.json`, { taskId: SLUG, state: 'ACTIVE' })],
  ['a run file whose taskClass is not a string', 'run-unreadable', (r: any) => putRun(r, `${SLUG}.json`, { taskId: SLUG, taskClass: 7 })],
  ['a class unknown to the workflows data (case 19, hotfix)', 'class-unknown', (r: any) => putRun(r, `${SLUG}.json`, { taskId: SLUG, taskClass: 'hotfix' })],
  ['two runs for the slug under different task ids', 'run-ambiguous', (r: any) => {
    putRun(r, `${SLUG}/a-fix.json`, { taskId: 'a-fix', taskClass: 'bug' });
    putRun(r, `${SLUG}/b-fix.json`, { taskId: 'b-fix', taskClass: 'bug' });
  }],
  ['a run with a task id that is not a plain name', 'run-unreadable', (r: any) => putRun(r, `${SLUG}.json`, { taskId: '../escape', taskClass: 'bug' })],
];
for (const [name, error, setup] of REFUSE_SETUPS) {
  test(`C-1: ${name} exits 1 with ${error} and no seats, even on a dirty tree`, async (t) => {
    const r = repo(t, { run: false });
    setup(r);
    put(r.cwd, 'src/uncommitted.ts', 'x\n');
    const { exitCode, json, out } = await start(r);
    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.error, error);
    assert.equal(typeof json.message, 'string');
    assert.equal(json.seats, null);
    assert.equal(json.depth, null);
    const text = await start(r, { json: false });
    assert.equal(text.exitCode, 1);
    assert.match(text.out[0], new RegExp(`^review start: ${error}: `));
    assert.ok(out.length >= 1);
  });
}

test('C-1: a resolver that throws exits 1 with feature-unresolved; one that reports no feature is still not applicable', async (t) => {
  const r = repo(t);
  const thrown = await start(r, { slug: undefined, resolve: () => { throw new Error('boom'); } });
  assert.equal(thrown.exitCode, 1);
  assert.equal(thrown.json.error, 'feature-unresolved');
  assert.match(thrown.json.message, /boom/);
  assert.equal(thrown.json.seats, null);
  const none = await start(r, { slug: undefined, resolve: () => ({ error: 'no-active-feature' }) });
  assert.equal(none.exitCode, 0);
  assert.equal(none.json.notApplicable, 'no-feature');
  const nothing = await start(r, { slug: undefined, resolve: () => null });
  assert.equal(nothing.exitCode, 0);
  assert.equal(nothing.json.notApplicable, 'no-feature');
});

// N-1: only no-active-feature is a known absence; every other resolver error and an invalid slug refuses.
for (const [name, resolve, pattern] of [
  ['jq-not-found', () => ({ error: 'jq-not-found', message: 'jq is required' }), /^jq-not-found: jq is required/],
  ['ambiguous-feature', () => ({ error: 'ambiguous-feature', message: 'ambiguous-feature (candidates: a, b)' }), /^ambiguous-feature: /],
  ['resolver-failed', () => ({ error: 'resolver-failed', message: 'could not run the feature resolver' }), /^resolver-failed: /],
  ['resolver-missing', () => ({ error: 'resolver-missing' }), /^resolver-missing: /],
  ['invalid-slug error', () => ({ error: 'invalid-slug', message: 'bad' }), /^invalid-slug: /],
  ['a feature_slug that is not a plain name', () => ({ featureFolder: '/x', paths: { feature_slug: '../escape' } }), /invalid-slug/],
  ['a feature with no feature_slug', () => ({ featureFolder: '/x', paths: { feature_slug: null } }), /invalid-slug/],
]) {
  test(`N-1: a resolver result of ${name} exits 1 with feature-unresolved and no seats, even on a dirty tree`, async (t) => {
    const r = repo(t);
    r.lines([{ ...r.line(), verdict: 'FAIL' }]);
    put(r.cwd, 'src/uncommitted.ts', 'x\n');
    const { exitCode, json } = await start(r, { slug: undefined, resolve });
    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'feature-unresolved');
    assert.match(json.message, pattern);
    assert.equal(json.notApplicable, null);
    assert.equal(json.seats, null);
    assert.equal(json.depth, null);
  });
}

test('C-1: a run known to be absent in both layouts stays not applicable (no-run), and another slug\'s namespace is ignored', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, 'other-feature/other-fix.json', { taskId: 'other-fix', taskClass: 'bug' });
  putRun(r, 'unrelated.json', { taskId: 'unrelated', taskClass: 'bug', featureSlug: 'other-feature' });
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.equal(json.notApplicable, 'no-run');
});

// ---- C-5: the two runtime-owned reads are bounded and non-blocking -------------------------------------

function fifoRegression(name: any, error: any, place: any) {
  test(`C-5: a FIFO at the ${name} exits 1 with ${error} within a bound`, (t) => {
    const r = repo(t);
    r.lines([r.line()]);
    const fifo = place(r);
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return t.skip('mkfifo is not available');
    try {
      const res = spawnSync(process.execPath, [CLI, 'review', '--action', 'start', '--slug', SLUG, '--json'],
        { cwd: r.cwd, env: { ...r.env, DOFLOW_CLI: CLI }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      assert.equal(res.signal, null, 'the verb must exit by itself before the timeout');
      assert.equal(res.status, 1, res.stderr);
      assert.equal(JSON.parse(res.stdout).error, error);
    } finally {
      fs.rmSync(fifo, { force: true });
    }
  });
}
fifoRegression('verify record file', 'records-unreadable', (r: any) => {
  const file = path.join(r.cwd, '.doflow/state/verification/runs', `${SLUG}.jsonl`);
  fs.rmSync(file);
  return file;
});
fifoRegression('run file', 'run-unreadable', (r: any) => {
  const file = path.join(r.cwd, '.doflow/state/orchestration', `${SLUG}.json`);
  fs.rmSync(file);
  return file;
});

// ---- N-2: a store or namespace folder that cannot be listed refuses (ENOENT alone means absent) ----------

function chmodRegression(name: any, place: any) {
  test(`N-2: ${name} that cannot be listed exits 1 with run-unreadable naming it`, (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root ignores directory modes');
    const r = repo(t, { run: false });
    putRun(r, `${SLUG}/${FIX}.json`, { taskId: FIX, taskClass: 'bug', state: 'ACTIVE' });
    putRecords(r, FIX, [r.line({ taskId: FIX, verdict: 'FAIL' })]);
    put(r.cwd, 'src/uncommitted.ts', 'x\n');
    const dir = place(r);
    fs.chmodSync(dir, 0o000);
    try {
      const res = spawnSync(process.execPath, [CLI, 'review', '--action', 'start', '--slug', SLUG, '--json'],
        { cwd: r.cwd, env: { ...r.env, DOFLOW_CLI: CLI }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      assert.equal(res.status, 1, res.stderr);
      const json = JSON.parse(res.stdout);
      assert.equal(json.error, 'run-unreadable');
      assert.ok(json.message.includes(dir), json.message);
      assert.equal(json.seats, null);
      assert.equal(json.notApplicable, null);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
}
chmodRegression('the orchestration store', (r: any) => path.join(r.cwd, '.doflow/state/orchestration'));
chmodRegression('the <slug>/ folder', (r: any) => path.join(r.cwd, '.doflow/state/orchestration', SLUG));

// ---- N-3: a flat run that cannot be attributed to a slug blocks, naming the file ---------------------------

const LEGACY = 'legacy-id.json';
for (const [name, place] of [
  ['truncated', (r: any) => putRun(r, LEGACY, '{"taskId":"legacy-id","featureSlug":"aaa-one","taskCla')],
  ['a symlink', (r: any) => {
    const target = path.join(r.dir, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ taskId: 'legacy-id', featureSlug: SLUG, taskClass: 'bug' }));
    fs.mkdirSync(path.join(r.cwd, '.doflow/state/orchestration'), { recursive: true });
    fs.symlinkSync(target, path.join(r.cwd, '.doflow/state/orchestration', LEGACY));
  }],
  ['a FIFO', (r: any) => {
    fs.mkdirSync(path.join(r.cwd, '.doflow/state/orchestration'), { recursive: true });
    const made = spawnSync('mkfifo', [path.join(r.cwd, '.doflow/state/orchestration', LEGACY)]);
    if (made.status !== 0) throw new Error('skip');
  }],
] as any[]) {
  test(`N-3: a flat run stored under another id that is ${name} exits 1 with run-unreadable naming the file`, async (t) => {
    const r = repo(t, { run: false });
    try { place(r); } catch (error: any) { if (error.message === 'skip') return t.skip('mkfifo is not available'); throw error; }
    r.lines([{ ...r.line(), verdict: 'FAIL' }]);
    put(r.cwd, 'src/uncommitted.ts', 'x\n');
    try {
      const { exitCode, json } = await start(r);
      assert.equal(exitCode, 1);
      assert.equal(json.error, 'run-unreadable');
      assert.ok(json.message.includes(LEGACY), json.message);
      assert.equal(json.seats, null);
    } finally {
      fs.rmSync(path.join(r.cwd, '.doflow/state/orchestration', LEGACY), { force: true });
    }
  });
}

test('N-3 control: a healthy flat run of another slug does not block; the slug has no run', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, LEGACY, { taskId: 'legacy-id', taskClass: 'bug', featureSlug: 'other-feature' });
  put(r.cwd, 'src/uncommitted.ts', 'x\n');
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.equal(json.notApplicable, 'no-run');
});

// ---- N-9: a readable legacy flat run that names the slug only through `slug` is the slug's run -----------

test('N-9: a flat <id>.json naming the slug only via `slug`, on a verify FAIL and a dirty tree, is found and refuses', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, LEGACY, { taskId: 'legacy-id', slug: SLUG, taskClass: 'bug' });
  // The verify records are keyed on the run's own task id.
  put(r.cwd, '.doflow/state/verification/runs/legacy-id.jsonl', `${JSON.stringify({ ...r.line({ taskId: 'legacy-id' }), verdict: 'FAIL' })}\n`);
  put(r.cwd, 'src/uncommitted.ts', 'x\n');
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.notEqual(json.notApplicable, 'no-run');
  assert.equal(json.seats, null);
  assert.deepEqual(json.reasons, ['tree-dirty', 'verify-not-pass']);
});

// ---- N-6: every error refusal prints applicable null -----------------------------------------------------

test('N-6: every error refusal prints applicable null; a precondition refusal stays applicable true', async (t) => {
  const r = repo(t, { run: false });
  putRun(r, `${SLUG}.json`, { taskId: SLUG, taskClass: 'hotfix' });
  const unknown = await start(r);
  assert.equal(unknown.json.error, 'class-unknown');
  assert.equal(unknown.json.applicable, null);
  const thrown = await start(r, { slug: undefined, resolve: () => { throw new Error('boom'); } });
  assert.equal(thrown.json.applicable, null);
  const pre = repo(t);
  const refused = await start(pre);
  assert.equal(refused.json.applicable, true);
  assert.deepEqual(refused.json.reasons, ['verify-missing']);
});

// ---- IC-001 step 6: advice raises, never lowers ---------------------------------------------------

function fakeClient(answer: any): any {
  const calls: any = [];
  return { calls, ask: async (request: any) => { calls.push(request); return answer; } };
}
const answered = (pick: any) => ({ status: 'answered', answers: [{ pick, pickId: null }] });

test('advice: an answer of single over a decided deep leaves deep', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  r.enableAdvice();
  const client = fakeClient(answered('single'));
  const { json } = await start(r, { adviceClient: client });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].kind, 'review-depth');
  assert.equal(client.calls[0].staticAnswer, 'deep');
  assert.equal(json.depth, 'deep');
  assert.equal(json.depthBasis.raisedBy, 'policy');
  assert.deepEqual(json.advice, { status: 'answered', pick: 'single' });
});

test('advice: an answer of deep over a decided single raises it, raisedBy advice, seats from the deep policy', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  r.enableAdvice();
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(client.calls[0].staticAnswer, 'single');
  assert.equal(json.depth, 'deep');
  assert.equal(json.seats, 2);
  assert.equal(json.depthBasis.raisedBy, 'advice');
  assert.deepEqual(json.advice, { status: 'answered', pick: 'deep' });
});

test('Q-A1: --preset review-single with an advice answer of deep on a light LOW change is not a refusal; the run preset wins', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  r.enableAdvice();
  const { exitCode, json } = await start(r, { adviceClient: fakeClient(answered('deep')), base: r.base, preset: 'review-single' });
  assert.equal(exitCode, 0);
  assert.equal(json.protocol.id, 'review-single');
  assert.equal(json.protocol.origins.id, 'run');
  assert.equal(json.depth, 'single');
  assert.deepEqual(json.protocol.disagreements, [{ field: 'id', by: 'advice', value: 'review-deep', reason: 'run-preset' }]);
  assert.equal(json.depthBasis.raisedBy, 'run');
  assert.equal(json.protocolDigest, protocolDigest(json.protocol));
});

test('settings: the verb reads the project settings; text form prints protocolDigest and the setting origin', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  put(r.cwd, '.doflow/settings.json', JSON.stringify({ schema: 1, 'review.preset': 'review-deep', 'review.rounds': 3 }));
  const { json } = await start(r, { base: r.base });
  assert.equal(json.protocol.id, 'review-deep');
  assert.equal(json.protocol.origins.id, 'project');
  assert.equal(json.protocol.rounds, 3);
  assert.equal(json.protocol.origins.rounds, 'project');
  const text = await start(r, { base: r.base, json: false });
  assert.ok(text.out.some((line: any) => line === `protocolDigest: ${json.protocolDigest}`), text.out.join('\n'));
  assert.match(text.out.find((line: any) => line.startsWith('protocol.origins:')), /^protocol\.origins: id=project /);
});

test('settings: the text form prints the rules line and one protocol.blocker line per project clause (C-5)', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  put(r.cwd, '.doflow/settings.json', JSON.stringify({ schema: 1, 'review.blockerClauses': ['no new dependency', 'no change to the public CLI'] }));
  const text = await start(r, { base: r.base, json: false });
  assert.ok(text.out.includes('protocol.rules: sameFamily=warn crossFamilyRereview=on'), text.out.join('\n'));
  assert.ok(text.out.includes('protocol.blocker: no new dependency'), text.out.join('\n'));
  assert.ok(text.out.includes('protocol.blocker: no change to the public CLI'), text.out.join('\n'));
});

test('settings: a project review.preset review-deep over a single-eligible change is raisedBy setting', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  put(r.cwd, '.doflow/settings.json', JSON.stringify({ schema: 1, 'review.preset': 'review-deep' }));
  const { json } = await start(r, { base: r.base });
  assert.equal(json.protocol.id, 'review-deep');
  assert.equal(json.protocol.origins.id, 'project');
  assert.equal(json.depthBasis.raisedBy, 'setting');
});

test('protocolDigest is null whenever protocol is null (a refused review), and set for a not-applicable one that resolves', async (t) => {
  const refused = await start(repo(t));
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.json.protocol, null);
  assert.equal(refused.json.protocolDigest, null);
  const exempt = await start(repo(t, { taskClass: 'documentation' }));
  assert.equal(exempt.json.applicable, false);
  assert.equal(exempt.json.protocolDigest, protocolDigest(exempt.json.protocol));
});

test('advice: an unavailable answer, or a client that throws, changes nothing', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  r.enableAdvice();
  const unavailable = await start(r, { adviceClient: fakeClient({ status: 'unavailable', reason: 'timeout', answers: [] }), base: r.base });
  assert.equal(unavailable.json.depth, 'single');
  assert.deepEqual(unavailable.json.advice, { status: 'unavailable', pick: null });
  const throwing = await start(r, { adviceClient: { ask: async () => { throw new Error('boom'); } }, base: r.base });
  assert.equal(throwing.exitCode, 0);
  assert.equal(throwing.json.depth, 'single');
  assert.equal(throwing.json.advice.status, 'unavailable');
});

test('advice: setting off makes no client call', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(json.advice, { status: 'off', pick: null });
});

test('advice: a refused review makes no client call; a not-applicable one still decides its depth', async (t) => {
  const refused = repo(t);
  refused.enableAdvice();
  const client = fakeClient(answered('deep'));
  const refusal = await start(refused, { adviceClient: client });
  assert.equal(refusal.exitCode, 1);
  assert.equal(client.calls.length, 0);
  const exempt = repo(t, { taskClass: 'documentation' });
  const { exitCode, json } = await start(exempt);
  assert.equal(exitCode, 0);
  assert.equal(json.applicable, false);
  assert.equal(json.risk, REGISTRY.policy.defaultRiskLevel);
  assert.equal(json.riskSource, 'default');
  assert.equal(json.depth, 'deep');
});

// ---- IC-002: reviewPrecondition (pure) -----------------------------------------------------------

test('reviewPrecondition: reasons are sorted and unique', () => {
  const line = (extra: any = {}) => ({ schema: 1, taskId: SLUG, head: HEX_A, clean: true, verdict: 'PASS', ...extra });
  const check = (records: any, clean: any = true, head: any = HEX_A) => reviewPrecondition({ records, head, clean, slug: SLUG });
  assert.deepEqual(check([line()]), []);
  assert.deepEqual(check([]), ['verify-missing']);
  assert.deepEqual(check([line()], false), ['tree-dirty']);
  assert.deepEqual(check([], false), ['tree-dirty', 'verify-missing']);
  assert.deepEqual(check([line({ verdict: 'FAIL' })]), ['verify-not-pass']);
  assert.deepEqual(check([line({ verdict: 'FAIL' }), line()]), ['verify-flaky']);
  assert.deepEqual(check([line({ head: 'b'.repeat(40) })]), ['verify-missing']);
  assert.deepEqual(check([line({ clean: false })]), ['verify-missing']);
  assert.deepEqual(check([line()], true, null), ['verify-missing']);
  const many = check([line({ verdict: 'FAIL' }), line({ verdict: 'PASS' }), line({ verdict: 'FAIL' })], false);
  assert.deepEqual(many, [...new Set(many)].sort());
  assert.deepEqual(many, ['tree-dirty', 'verify-flaky', 'verify-not-pass']);
});

// ---- 120 D.3 (IC-016): authors, forbidden pairs and primary-refused ----------------------------

test('120 D.3 negative control: slug with no dispatch store and primary unknown gives empty authors and forbidden', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.deepEqual(json.authors, []);
  assert.deepEqual(json.forbidden, []);
  const text = await start(r, { json: false });
  assert.equal(text.exitCode, 0);
  assert.ok(text.out.some((line: string) => line === 'authors: none'), text.out.join('\n'));
  assert.ok(text.out.some((line: string) => line === 'forbidden: none'), text.out.join('\n'));
});

test('120 D.3: scratch dispatch store populates authors and forbidden (harness, model) pairs in json and text', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  const storeFile = storeFileFor(r.cwd, SLUG);
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    revision: 1,
    slug: SLUG,
    run: { runId: 'p-123456789012', state: 'running' },
    lease: null,
    drivers: [],
    spawnRequests: {},
    steps: [],
    dispatches: {
      'd-1': {
        dispatchId: 'd-1',
        seq: 0,
        mode: 'subagent',
        harness: 'codex',
        phase: 'collected',
        collectedAt: '2026-10-24T12:00:00.000Z',
        outcome: 'offered',
        model: {
          requested: 'o3-mini',
          served: 'o3-mini-2025-01-31',
          source: 'binding',
          tier: 'standard',
        },
      },
      'd-2': {
        dispatchId: 'd-2',
        seq: 1,
        mode: 'sequential',
        harness: 'claude',
        primary: { harness: 'claude' },
        phase: 'collected',
        collectedAt: '2026-10-24T12:00:00.000Z',
        outcome: 'offered',
        model: {
          requested: 'claude-3-7-sonnet',
          source: 'binding',
          tier: 'standard',
        },
      },
      'd-uncollected': {
        dispatchId: 'd-uncollected',
        seq: 2,
        mode: 'subagent',
        harness: 'antigravity',
        phase: 'launched',
        model: { requested: 'gemini-2.0-flash' },
      },
    },
  }));

  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 0);
  assert.deepEqual(json.authors, [
    { kind: 'subagent', harness: 'codex', model: 'o3-mini-2025-01-31', channel: 'observed' },
    { kind: 'subagent', harness: 'codex', model: 'o3-mini', channel: 'observed' },
    { kind: 'sequential', harness: 'claude', model: 'claude-3-7-sonnet', channel: 'claim' },
  ]);
  assert.deepEqual(json.forbidden, [
    ['codex', 'o3-mini-2025-01-31'],
    ['codex', 'o3-mini'],
    ['claude', 'claude-3-7-sonnet'],
  ]);

  const text = await start(r, { json: false });
  assert.equal(text.exitCode, 0);
  assert.ok(text.out.some((line: string) => line === 'authors: subagent:codex/o3-mini-2025-01-31(observed) subagent:codex/o3-mini(observed) sequential:claude/claude-3-7-sonnet(claim)'), text.out.join('\n'));
  assert.ok(text.out.some((line: string) => line === 'forbidden: (codex, o3-mini-2025-01-31), (codex, o3-mini), (claude, claude-3-7-sonnet)'), text.out.join('\n'));
});

test('120 D.3: review start refuses primary-refused when resolvePrimary returns refused', async (t) => {
  const r = repo(t);
  r.lines([r.line()]);
  put(r.cwd, '.doflow/settings.json', JSON.stringify({
    'primary.harness': 'codex',
    'primary.model': 'gpt-4o',
    'primary.onContradiction': 'refuse',
  }));

  const obsDir = path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'session-env', 'primary', cwdHash(r.cwd), 'codex');
  fs.mkdirSync(obsDir, { recursive: true });
  fs.writeFileSync(path.join(obsDir, '0123456789abcdef.json'), JSON.stringify({
    schema: 1,
    harness: 'codex',
    model: 'gpt-4o-mini',
    event: 'SessionStart',
    observedAt: '2026-10-24T12:00:00.000Z',
    session: '0123456789abcdef',
  }));

  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  assert.equal(json.applicable, null);
  assert.equal(json.error, 'primary-refused');
  assert.match(json.message, /primary-contradicted/);

  const text = await start(r, { json: false });
  assert.equal(text.exitCode, 1);
  assert.match(text.out[0], /^review start: primary-refused:/);
});

test('120 D.3: preconditions run before primary check (preconditions and order unchanged)', async (t) => {
  const r = repo(t);
  // No verify record line -> verify-missing precondition failure
  put(r.cwd, '.doflow/settings.json', JSON.stringify({
    'primary.harness': 'codex',
    'primary.model': 'gpt-4o',
    'primary.onContradiction': 'refuse',
  }));
  const obsDir = path.join(r.env.XDG_CONFIG_HOME, 'doflow', 'session-env', 'primary', cwdHash(r.cwd), 'codex');
  fs.mkdirSync(obsDir, { recursive: true });
  fs.writeFileSync(path.join(obsDir, '0123456789abcdef.json'), JSON.stringify({
    schema: 1,
    harness: 'codex',
    model: 'gpt-4o-mini',
    event: 'SessionStart',
    observedAt: '2026-10-24T12:00:00.000Z',
    session: '0123456789abcdef',
  }));

  const { exitCode, json } = await start(r);
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  // Precondition failure preserves applicable: true and reports reasons, rather than primary-refused refusal
  assert.equal(json.applicable, true);
  assert.deepEqual(json.reasons, ['verify-missing']);
  assert.equal(json.error, undefined);
});

// ---- 084 H2: advice.kinds.review-depth routes the advice through the dispatcher only when it is set ----

/**
 * A decided-single review (bug, docs only, LOW risk) with advice on and `advice.kinds.review-depth` set. `bench` adds a
 * passing-looking project bench file, which the gate never reads (D3).
 */
function kindsRepo(t: any, mode: any, { bench = false }: any = {}) {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  r.enableAdvice();
  put(r.cwd, '.git/info/exclude', '.doflow/\nbench/\n');
  put(r.cwd, '.doflow/settings.json', JSON.stringify({ advice: { kinds: { 'review-depth': mode } } }));
  if (bench) {
    put(r.cwd, 'bench/advice/review-depth.json', JSON.stringify({
      kind: 'review-depth', models: { 'clef-flash': { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 10 } },
    }));
  }
  return r;
}
const adviceStore = (r: any) => fs.existsSync(path.join(r.cwd, '.doflow', 'state', 'advice'));

test('084 H2: advice.kinds.review-depth off makes no client call', async (t) => {
  const r = kindsRepo(t, 'off');
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(client.calls.length, 0);
  assert.equal(json.depth, 'single');
  assert.deepEqual(json.advice, { status: 'off', pick: null });
});

test('084 H2: advice.kinds.review-depth shadow keeps the decided depth and stays write-free', async (t) => {
  const r = kindsRepo(t, 'shadow');
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(json.depth, 'single');
  assert.equal(json.depthBasis.raisedBy, null);
  assert.deepEqual(json.advice, { status: 'shadow', pick: null, reason: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.calls.length, 0, 'record: false could keep no answer, so no call is made');
  assert.equal(adviceStore(r), false, 'record: false: no pick is stored');
});

test('084 H2: advice.kinds.review-depth act without a passed bench bar keeps the decided depth and says why', async (t) => {
  const r = kindsRepo(t, 'act');
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(json.depth, 'single');
  assert.equal(json.depthBasis.raisedBy, null);
  assert.equal(json.advice.status, 'shadow');
  assert.equal(json.advice.pick, null);
  assert.match(json.advice.reason, /^BENCH_BAR_UNMET: /);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.calls.length, 0, 'degraded to shadow with record: false, so no call is made');
  assert.equal(adviceStore(r), false, 'record: false: no pick is stored');
  const text = await start(r, { adviceClient: fakeClient(answered('deep')), base: r.base, json: false });
  assert.ok(text.out.some((line: string) => /^advice: status=shadow reason=BENCH_BAR_UNMET: /.test(line)), text.out.join('\n'));
});

test('084 D3: advice.kinds.review-depth act with a passing bench file in the project keeps the decided depth', async (t) => {
  const r = kindsRepo(t, 'act', { bench: true });
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(json.depth, 'single');
  assert.equal(json.depthBasis.raisedBy, null);
  assert.equal(json.advice.status, 'shadow');
  assert.equal(json.advice.pick, null);
  assert.match(json.advice.reason, /^BENCH_BAR_UNMET: /);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.calls.length, 0);
  assert.equal(adviceStore(r), false, 'record: false: no pick is stored');
});

test('085 H1: DOFLOW_ROLLOUT_PROFILE=baseline in the verb env turns a configured act off', async (t) => {
  const r = kindsRepo(t, 'act', { bench: true });
  const client = fakeClient(answered('deep'));
  const { json } = await start({ ...r, env: { ...r.env, DOFLOW_ROLLOUT_PROFILE: 'baseline' } }, { adviceClient: client, base: r.base });
  assert.equal(client.calls.length, 0);
  assert.equal(json.depth, 'single');
  assert.deepEqual(json.advice, { status: 'off', pick: null });
});

// 085 H1 on the unset-kinds path: a chosen profile whose advisor is off skips the client call.
const CHOSEN_OFF: any = {
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } } },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } },
  'an active rollback sentinel': { sentinel: { active: true, reason: 'manual' } },
  'an invalid profile value': { settings: { rollout: { profile: 'bogus' } } },
};
for (const [name, c] of Object.entries(CHOSEN_OFF) as any) {
  test(`085 H1: with advice.kinds unset, ${name} makes review start ask nothing`, async (t) => {
    const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
    r.lines([r.line({ risk: 'LOW' })]);
    r.enableAdvice();
    if (c.settings) put(r.cwd, '.doflow/settings.json', JSON.stringify(c.settings));
    if (c.sentinel) put(r.cwd, '.doflow/state/rollback.json', JSON.stringify(c.sentinel));
    const client = fakeClient(answered('deep'));
    const { json } = await start({ ...r, env: { ...r.env, ...(c.env || {}) } }, { adviceClient: client, base: r.base });
    assert.equal(client.calls.length, 0);
    assert.equal(json.depth, 'single');
    assert.deepEqual(json.advice, { status: 'off', pick: null });
  });
}

// 084 C-6: on the unset-kinds path a shadow cap (canary, or staged per D2) never raises the depth, and the write-free
// verb asks nothing, since it could not record the answer.
const CHOSEN_SHADOW: any = {
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } } },
  'env DOFLOW_ROLLOUT_PROFILE=canary': { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } } },
};
for (const [name, c] of Object.entries(CHOSEN_SHADOW) as any) {
  test(`084 C-6: with advice.kinds unset, ${name} keeps a decided single when the model answers deep`, async (t) => {
    const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
    r.lines([r.line({ risk: 'LOW' })]);
    r.enableAdvice();
    if (c.settings) put(r.cwd, '.doflow/settings.json', JSON.stringify(c.settings));
    const client = fakeClient(answered('deep'));
    const { json } = await start({ ...r, env: { ...r.env, ...(c.env || {}) } }, { adviceClient: client, base: r.base });
    assert.equal(json.depth, 'single');
    assert.equal(json.depthBasis.raisedBy, null);
    assert.deepEqual(json.advice, { status: 'shadow', pick: null, reason: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.calls.length, 0, 'no call: the answer could be neither applied nor recorded');
    assert.equal(fs.existsSync(path.join(r.cwd, '.doflow', 'state', 'advice')), false);
  });
}

test('084 C-6: with advice.kinds unset and no profile chosen the legacy raise still applies', async (t) => {
  const r: any = repo(t, { taskClass: 'bug', files: { 'docs/a.md': 'x\n' } });
  r.lines([r.line({ risk: 'LOW' })]);
  r.enableAdvice();
  const client = fakeClient(answered('deep'));
  const { json } = await start(r, { adviceClient: client, base: r.base });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].record, false);
  assert.equal(json.depth, 'deep');
  assert.equal(json.depthBasis.raisedBy, 'advice');
  assert.deepEqual(json.advice, { status: 'answered', pick: 'deep' });
});

// 084 C-10: a set kind consumes the dispatcher's mode and effectiveDecision, never advisorPick alone.
function stubDispatcher(t: any, resolution: any) {
  const dispatcher = require('../../src/runtime/advice/shadow-dispatcher.ts');
  const saved = dispatcher.interceptDecisionPoint;
  t.after(() => { dispatcher.interceptDecisionPoint = saved; });
  dispatcher.interceptDecisionPoint = async () => ({ kind: 'review-depth', staticPick: 'single', pickId: null, elevated: false, agreed: null, ...resolution });
}

test('084 C-10: a shadow result carrying a deep pick never raises the depth', async (t) => {
  const r = kindsRepo(t, 'act');
  stubDispatcher(t, { mode: 'shadow', advisorPick: 'deep', effectiveDecision: 'single' });
  const { json } = await start(r, { adviceClient: fakeClient(answered('deep')), base: r.base });
  assert.equal(json.depth, 'single');
  assert.deepEqual(json.advice, { status: 'shadow', pick: null, reason: null });
});

test('084 C-10: an act result applies the effective decision, not the raw advisor pick', async (t) => {
  const r = kindsRepo(t, 'act');
  stubDispatcher(t, { mode: 'act', advisorPick: 'deep', effectiveDecision: 'single' });
  const { json } = await start(r, { adviceClient: fakeClient(answered('deep')), base: r.base });
  assert.equal(json.depth, 'single');
  assert.deepEqual(json.advice, { status: 'answered', pick: 'single' });
});
