'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 091 B.3, rider R1 (CH10; FR-014, NFR-001): the UserPromptSubmit hook line carries the
// emission metadata `emit_reason`, `emit_bytes` and `emit_digest`, which the policy hands to the
// bridge as one extra record on the decision fd. Metadata only: the byte count and a 32-bit hash of
// the printed response, never its bytes. The digest is computed inside the jq render process. What the model sees (stdout, stderr, exit) is byte-equal
// with telemetry on and off. Every case runs the real front door in a scratch install mirror.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInstallMirror, createScratch } = require('../helper/hook-fixtures.ts');

const BASH = bashPath();
const REASONS = new Set(['emit', 'refused:mandatory-over-budget', 'silent:already-bootstrapped', 'silent:unchanged',
  'silent:no-home', 'fault:deps', 'fault:unit', 'fault:slot', 'fault:summary', 'fault:grant', 'fault:warning', 'fault:render']);
const PROMPT = 'canary091prompt please refactor src/canary091path.js';
const BRANCH = 'canary091branch';
const COMMIT = 'canary091commit message';
const NULLS = { emit_reason: null, emit_bytes: null, emit_digest: null };
const SURFACES: any = {
  claude: { door: '.claude/hooks/user-prompt-submit.sh' },
  codex: { door: '.codex/hooks/user-prompt-submit.sh' },
};
const PLANT_POINT = 'doflow_emit_record\n';

const scratch = createScratch('doflow-emit-telemetry-');
after(() => scratch.remove());
let worlds = 0;

/** A project mirror with its own .doflow/state/runs and a fresh config home. */
function world({ plant }: any = {}) {
  const id = worlds += 1;
  const root = scratch.path(`project-${id}`);
  buildInstallMirror(root);
  fs.mkdirSync(path.join(root, '.doflow/state/runs'), { recursive: true });
  const home = scratch.path(`home-${id}`);
  fs.mkdirSync(home, { recursive: true });
  if (plant) {
    const file = path.join(root, '.doflow/shared/hooks/policies/user-prompt-submit.sh');
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(PLANT_POINT), 'the scratch policy has the emit record call');
    fs.writeFileSync(file, source.replaceAll(PLANT_POINT, `printf '\\036%s\\n' "$EM_PLANT" >&"$DOFLOW_DECISION_FD"\n`));
  }
  return { root, home, xdg: path.join(home, 'xdg') };
}

/** The git context the session-context hook would have written, so the first prompt renders. */
function seedGit(w: any, session: any, branch = BRANCH) {
  const dir = path.join(w.xdg, 'doflow/session-env/sessions', session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'git-context.json'), JSON.stringify({
    branch, sha: 'abc1234', commits: [COMMIT], uncommitted_count: 1, stash_count: 0, is_git_repo: true,
  }));
}

function env(w: any, extra = {}) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('DOFLOW_')) delete base[key];
  const out: any = { ...base, HOME: w.home, XDG_CONFIG_HOME: w.xdg, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'on', GIT_CONFIG_GLOBAL: '/dev/null', ...extra };
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return out;
}

function prompt(w: any, harness: any, session: any, extra = {}) {
  const input = `${JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: w.root, prompt: PROMPT })}\n`;
  const r = spawnSync(BASH, [path.join(w.root, SURFACES[harness].door)], { cwd: w.root, input, encoding: 'utf8', timeout: 20000, env: env(w, extra) });
  assert.equal(r.error, undefined, r.error?.message);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lines(w: any) {
  const dir = path.join(w.root, '.doflow/state/runs/telemetry');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((name: any) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean));
}

function emitOf(line: any) {
  const parsed = JSON.parse(line);
  return { emit_reason: parsed.emit_reason, emit_bytes: parsed.emit_bytes, emit_digest: parsed.emit_digest };
}

/** Reference for emission.jq response_digest: h = (h*31 + c) mod 2^32 over the code points of the
 *  printed response without its trailing newline, as 8 lowercase hex. */
function refDigest(stdout: any) {
  assert.ok(stdout.endsWith('\n'));
  let h = 0;
  for (const ch of stdout.slice(0, -1)) h = (h * 31 + ch.codePointAt(0)) % 4294967296;
  return h.toString(16).padStart(8, '0');
}

/** Runs `steps` in a telemetry-on world and a telemetry-off world built the same way; returns the on lines. */
function pair(steps: any, { setup = () => {}, plant }: any = {}) {
  const on = world({ plant });
  const off = world({ plant });
  setup(on);
  setup(off);
  for (const [harness, session, extra = {}] of steps) {
    const a = prompt(on, harness, session, extra);
    const b = prompt(off, harness, session, { ...extra, DOFLOW_TELEMETRY: 'off' });
    assert.deepEqual(a, b, `${harness}/${session}: stdout, stderr and exit are byte-equal with telemetry on and off`);
  }
  assert.deepEqual(lines(off), [], 'telemetry off writes no line');
  return { on, out: lines(on) };
}

function assertNoContent(text: any, w: any) {
  for (const canary of ['canary091', PROMPT, BRANCH, COMMIT, w.root, w.home]) assert.ok(!text.includes(canary), `the line carries no '${canary}'`);
}

for (const harness of Object.keys(SURFACES)) {
  test(`${harness}: a first prompt writes emit with the stdout byte count and its digest; the second is silent`, () => {
    const session = `${harness}-emit-091`;
    const on = world();
    seedGit(on, session);
    const first = prompt(on, harness, session);
    const second = prompt(on, harness, session);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /additionalContext/, 'the first prompt renders context');
    const written = lines(on);
    assert.equal(written.length, 2);
    assert.deepEqual(emitOf(written[0]), {
      emit_reason: 'emit', emit_bytes: Buffer.byteLength(first.stdout, 'utf8'), emit_digest: refDigest(first.stdout),
    });
    assert.deepEqual(emitOf(written[1]), { emit_reason: 'silent:already-bootstrapped', emit_bytes: 0, emit_digest: null });
    assert.match(written[0], /"duration_ms":(null|\d+),"emit_reason":"emit","emit_bytes":\d+,"emit_digest":"[0-9a-f]{8}","timestamp":/);
    for (const line of written) assertNoContent(line, on);
  });

  test(`${harness}: emit, silent, no-home and fault runs are byte-equal to telemetry off and write the reason`, () => {
    const session = `${harness}-pair-091`;
    const { on, out } = pair([
      [harness, session],
      [harness, session],
      [harness, `${harness}-nohome-091`, { HOME: undefined, XDG_CONFIG_HOME: undefined, ...(process.platform === 'win32' ? { USERPROFILE: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined } : {}) }],
      [harness, 'has space'],
    ], { setup: (w: any) => seedGit(w, session) });
    assert.deepEqual(out.map((line: any) => emitOf(line).emit_reason), ['emit', 'silent:already-bootstrapped', 'silent:no-home', 'fault:unit']);
    for (const line of out) {
      const value = emitOf(line);
      assert.ok(REASONS.has(value.emit_reason));
      if (value.emit_reason === 'emit') assert.match(value.emit_digest, /^[0-9a-f]{8}$/);
      else assert.deepEqual([value.emit_bytes, value.emit_digest], [0, null]);
      assertNoContent(line, on);
    }
  });
}

test('equal responses give equal digests and a changed response a different one', () => {
  const run = (branch: any) => {
    const w = world();
    seedGit(w, 'digest-091', branch);
    const r = prompt(w, 'claude', 'digest-091');
    const [line] = lines(w);
    assert.equal(emitOf(line).emit_reason, 'emit');
    assert.equal(emitOf(line).emit_digest, refDigest(r.stdout));
    return { stdout: r.stdout, digest: emitOf(line).emit_digest };
  };
  const a = run('topic-a');
  const b = run('topic-a');
  const c = run('topic-"b"\\\t\u00e9\u{1F600}\u007f\u2028'); // escapes, non-ASCII and astral code points
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.digest, b.digest, 'identical responses, identical digest');
  assert.notEqual(a.stdout, c.stdout);
  assert.notEqual(a.digest, c.digest, 'a changed response changes the digest');
});

test('a pre-bash-guard line carries the three emit keys as null', () => {
  const w = world();
  const input = `${JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'pbg-091', tool_name: 'Bash', tool_input: { command: 'printf canary091' } })}\n`;
  const r = spawnSync(BASH, [path.join(w.root, '.claude/hooks/pre-bash-guard.sh')], { cwd: w.root, input, encoding: 'utf8', env: env(w) });
  assert.equal(r.status, 0, r.stderr);
  const [line] = lines(w);
  assert.deepEqual(emitOf(line), NULLS);
  assert.ok(Object.hasOwn(JSON.parse(line), 'emit_reason'));
});

test('a policy record with an invalid value writes all three keys as null, and output is unchanged', () => {
  const planted = [
    '{"v":1,"emit":{"reason":"canary091 please refactor the login flow","bytes":12,"digest":null}}',
    '{"v":1,"emit":{"reason":"emit","bytes":"12x","digest":"0123abcd"}}',
    '{"v":1,"emit":{"reason":"emit","bytes":-1,"digest":"0123abcd"}}',
    '{"v":1,"emit":{"reason":"emit","bytes":12,"digest":"0123ABCD"}}',
    '{"v":1,"emit":{"reason":"emit","bytes":12,"digest":"0123abcde"}}',
    '{"v":1,"emit":{"reason":"emit","bytes":12345678901,"digest":"0123abcd"}}',
    '{"v":1,"emit":{"bytes":12,"digest":"0123abcd"}}',
  ];
  for (const record of planted) {
    const { on, out } = pair([['claude', 'plant-091', { EM_PLANT: record }]], { plant: true });
    assert.equal(out.length, 1, record);
    assert.deepEqual(emitOf(out[0]), NULLS, record);
    assertNoContent(out[0], on);
  }
  // control: a valid planted record is written as given, so the null above comes from validation
  const { out } = pair([['claude', 'plant-091', { EM_PLANT: '{"v":1,"emit":{"reason":"emit","bytes":12,"digest":"0123abcd"}}' }]], { plant: true });
  assert.deepEqual(emitOf(out[0]), { emit_reason: 'emit', emit_bytes: 12, emit_digest: '0123abcd' });
});

test('an emit record never becomes the decision record: the verdict and outcome stay allow', () => {
  const { out } = pair([['codex', 'verdict-091', { EM_PLANT: '{"v":1,"emit":{"reason":"emit","bytes":3,"digest":null}}' }]], { plant: true });
  assert.equal(JSON.parse(out[0]).verdict, 'allow');
  assert.deepEqual(emitOf(out[0]), { emit_reason: 'emit', emit_bytes: 3, emit_digest: null });
});
