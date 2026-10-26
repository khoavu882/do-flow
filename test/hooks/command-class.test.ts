'use strict';

// 088 E.3, IC-003/IC-005. Native fixtures follow the E.1 captures from Claude Code 2.1.292.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { projectSpans } = require('../../src/runtime/trace/spans.ts');
const perf = require('../../bench/perf/runner.ts');

const REPO = path.resolve(__dirname, '../..');
const BRIDGE = 'core/harnesses/shared/hooks/bridge';
const DOOR = 'core/harnesses/claude/hooks/post-shell-observe.sh';
const FIXTURES = 'test/fixtures/hooks/claude/post-shell-observe';
const SECRET = 'ARGV_CANARY_088_SECRET';
const OUTPUT = 'OUTPUT_CANARY_088_SECRET';
const PATH_CANARY = '/PATH_CANARY_088_SECRET';
const EVENTS: any = ['PostToolUse', 'PostToolUseFailure'];
const CASES: any = [
  ['npm test', 'test.full'],
  ['pnpm run test', 'test.full'],
  ['yarn test', 'test.full'],
  ['bun run test', 'test.full'],
  ['node --test', 'test.full'],
  ['node --test --test-reporter=spec test/', 'test.full'],
  ['pytest', 'test.full'],
  ['pytest -q', 'test.full'],
  ['go test ./...', 'test.full'],
  ['cargo test', 'test.full'],
  [`npm test -- --token=${SECRET}`, 'test.scoped'],
  ['pnpm test unit.js', 'test.scoped'],
  ['yarn run test --watch', 'test.scoped'],
  ['bun test unit.js', 'test.scoped'],
  [`node --test ${PATH_CANARY}/unit.test.js --token=${SECRET}`, 'test.scoped'],
  ['pytest unit.py', 'test.scoped'],
  ['go test ./pkg', 'test.scoped'],
  ['cargo test one_case', 'test.scoped'],
  ['npx jest', 'test.other'],
  ['vitest run', 'test.other'],
  ['mocha unit.js', 'test.other'],
  ['npx playwright test', 'test.other'],
  ['npm run test:unit', 'test.other'],
  ['pnpm run test:ci', 'test.other'],
  ['bun run test:smoke', 'test.other'],
  [`TOKEN=${SECRET} MODE=ci npm test`, 'test.full'],
  [`cd ${PATH_CANARY}; node --test unit.test.js`, 'test.scoped'],
  ['npx jest | pytest unit.py || npm test && doflow verify --risk LOW', 'verify.verb'],
  ['doflow-run verify', 'verify.verb'],
  [`printf ${SECRET}`, 'none'],
];

function env(root: any, extra: any = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOFLOW_')));
  return { ...clean, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home/.config'), DOFLOW_TELEMETRY: 'on', ...extra };
}
function native(command: any, event: any = EVENTS[0]) {
  const file = event === EVENTS[0] ? 'test-class.json' : 'test-class-failure.json';
  const payload = JSON.parse(fs.readFileSync(path.join(REPO, FIXTURES, file), 'utf8')).native;
  return { ...payload, tool_input: { command } };
}
function encode(payload: any, { root = REPO, mode = 'encode', harness = 'claude', policy = 'pre-bash-guard' }: any = {}) {
  const result = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', payload.hook_event_name || 'PreToolUse', '--arg', 'policy', policy,
    ...(mode === null ? [] : ['--arg', 'mode', mode]), '-f', path.join(root, BRIDGE, 'envelope.jq')], {
    input: JSON.stringify(payload), encoding: 'utf8', env: env(root), timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map((line: any) => JSON.parse(line));
}
function project(t: any, { state = true, mutate }: any = {}) {
  const root = tempDir(t, 'doflow-command-class-');
  fs.mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home'));
  const bridge = path.join(root, '.doflow/shared/hooks/bridge');
  fs.cpSync(path.join(REPO, BRIDGE), bridge, { recursive: true });
  fs.copyFileSync(path.join(REPO, DOOR), path.join(root, '.claude/hooks/post-shell-observe.sh'));
  if (state) fs.mkdirSync(path.join(root, '.doflow/state/runs'), { recursive: true });
  if (mutate) {
    const file = path.join(bridge, 'envelope.jq');
    const source = fs.readFileSync(file, 'utf8');
    const changed = mutate(source);
    assert.notEqual(changed, source, 'negative control must change the scratch encoder');
    fs.writeFileSync(file, changed);
  }
  return root;
}
function observe(root: any, payload: any, { event = payload?.hook_event_name, extra = {}, input, cwd = root }: any = {}) {
  const result = spawnSync('/bin/bash', [path.join(root, '.claude/hooks/post-shell-observe.sh'), ...(event === undefined ? [] : [event])], {
    cwd, input: input === undefined ? JSON.stringify(payload) : input, encoding: 'utf8', timeout: 5000, env: env(root, extra),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
}
function lines(root: any) {
  const dir = path.join(root, '.doflow/state/runs/telemetry');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((name: any) => {
    assert.match(name, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  });
}
function noContent(records: any) {
  for (const canary of [SECRET, OUTPUT, PATH_CANARY]) assert.ok(!JSON.stringify(records).includes(canary), `telemetry leaked ${canary}`);
  for (const line of records) for (const key of ['command', 'stdout', 'stderr', 'error', 'cwd', 'transcript_path', 'exit_code']) assert.ok(!Object.hasOwn(line, key), key);
}

test('30 commands classify by the highest segment and telemetry contains classes only, including secret argv', (t) => {
  assert.equal(CASES.length, 30);
  const root = project(t);
  for (const [command, expected] of CASES) {
    const payload = native(command);
    const encoded = encode({ ...payload, hook_event_name: 'PreToolUse' });
    assert.equal(encoded.length, 2);
    assert.equal(encoded[0].test_class, expected, command);
    assert.equal(encoded[1].doflow_event.command, command, 'classification does not change the policy envelope');
    noContent([encoded[0]]);
    const count = lines(root).length;
    observe(root, payload);
    const records = lines(root);
    assert.equal(records.length, count + (expected.startsWith('test.') ? 1 : 0), command);
    if (expected.startsWith('test.')) assert.equal(records.at(-1).test_class, expected, `prefilter admits ${command}`);
    noContent(records);
  }
});

test('all five harness decoders classify the same command; other policies and modes do not add a class', () => {
  const command = 'npm test';
  for (const harness of ['claude', 'codex', 'kiro', 'antigravity', 'pi']) {
    const payload = harness === 'pi' ? { toolName: 'bash', input: { command } }
      : harness === 'antigravity' ? { toolCall: { name: 'run_command', args: { CommandLine: command } } }
        : { tool_name: 'Bash', tool_input: { command } };
    assert.equal(encode(payload, { harness })[0].test_class, 'test.full', harness);
  }
  const payload = native(command);
  assert.equal(encode(payload, { policy: 'mcp-tool-guard' })[0].test_class, null);
  assert.equal(encode({ ...payload, tool_name: 'Edit' })[0].test_class, null);
  for (const mode of [null, 'minimal']) assert.equal(encode(payload, { mode }).length, 1);
  assert.equal(encode(payload, { mode: 'observe', policy: 'post-shell-observe' }).length, 1, 'observe returns only the tuple');
});

test('assignments, cd, segment priority, runner boundaries and malformed commands', () => {
  const cases: any = [
    ['cd dir && A=x B=y pytest -q', 'test.full'], ['npm test unit.js; pytest', 'test.full'],
    ['cd mocha', 'none'], ['ROOT=dir cd jest; printf safe', 'none'],
    ['mocha; node --test unit.js', 'test.scoped'], ['printf x | npm test', 'test.full'],
    ['doflow verify; npm test', 'verify.verb'], ['npm testing', 'none'], ['node --testing', 'none'],
    ['pytestish', 'none'], ['echo jesting', 'none'], [null, 'none'], [42, 'none'], [{}, 'none'],
  ];
  for (const [command, expected] of cases) assert.equal(encode(native(command))[0].test_class, expected, String(command));
});

test('captured pass and failure shapes yield real duration, event status, safe ids and no output or paths', (t) => {
  const root = project(t);
  for (const event of EVENTS) {
    const payload = native(`node --test --token=${SECRET}` , event);
    payload.cwd = PATH_CANARY;
    payload.transcript_path = `${PATH_CANARY}/transcript`;
    if (event === EVENTS[0]) payload.tool_response.stdout = OUTPUT;
    else { payload.error = `Exit code 999\n${OUTPUT}\n${PATH_CANARY}`; assert.ok(!Object.hasOwn(payload, 'tool_response')); }
    observe(root, payload, { extra: { DOFLOW_RUN_ID: 'run-088', DOFLOW_LINEAGE_ID: 'lineage-088', DOFLOW_ATTEMPT: '2' } });
    const line = lines(root).at(-1);
    assert.deepEqual([line.kind, line.harness, line.event, line.policy, line.verdict], ['hook', 'claude', event, 'post-shell-observe', 'observe']);
    assert.deepEqual([line.session, line.tool, line.tool_call_id], [payload.session_id, 'Bash', payload.tool_use_id]);
    assert.deepEqual([line.run, line.lineage, line.attempt], ['run-088', 'lineage-088', 2]);
    assert.equal(line.duration_ms, null, 'observer hook latency is unavailable (IC-005)');
    assert.equal(line.tool_duration_ms, payload.duration_ms, 'native runtime is a separate measure');
    assert.match(line.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    noContent([line]);
  }
});

test('all four captured-shape fixtures exercise their declared fast-exit or classified event', (t) => {
  const root = project(t);
  for (const file of ['fast-exit.json', 'test-class.json', 'fast-exit-failure.json', 'test-class-failure.json']) {
    const fixture = JSON.parse(fs.readFileSync(path.join(REPO, FIXTURES, file), 'utf8'));
    const before = lines(root).length;
    observe(root, fixture.native);
    const records = lines(root);
    assert.equal(records.length - before, fixture.expect.records, file);
    if (fixture.expect.records) {
      assert.equal(records.at(-1).test_class, fixture.expect.test_class);
      assert.equal(records.at(-1).duration_ms, fixture.expect.duration_ms);
      assert.equal(records.at(-1).tool_duration_ms, fixture.expect.tool_duration_ms);
    }
  }
});

test('pre and post pair by BOTH session and tool_call_id in the real span projection', (t) => {
  const root = project(t);
  for (const event of EVENTS) observe(root, native('npm test', event));
  const posts = lines(root);
  const records = posts.flatMap((post: any, i: any) => {
    const pre = encode({ ...native('npm test', post.event), hook_event_name: 'PreToolUse' })[0];
    assert.deepEqual([pre.session, pre.tool_call_id], [post.session, post.tool_call_id]);
    const timestamp = new Date(Date.now() + i * 10000).toISOString();
    const start: any = { ...pre, kind: 'hook', event: 'PreToolUse', harness: 'claude', policy: 'pre-bash-guard', verdict: 'allow', timestamp, duration_ms: null };
    delete start.dft; delete start.date;
    return [start, { ...start, session: 'other-session' }, { ...start, tool_call_id: 'other-call' },
      { ...post, timestamp: new Date(Date.parse(timestamp) + 2000).toISOString() }];
  });
  const dir = path.join(root, '.doflow/state/runs/telemetry');
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, `${records[0].timestamp.slice(0, 10)}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
  const view = projectSpans({ projectRoot: root, env: {} });
  const spans = view.ungrouped.flatMap((group: any) => group.spans);
  const paired = spans.filter((span: any) => span.kind === 'test');
  assert.equal(paired.length, 2);
  assert.deepEqual(paired.map((span: any) => span.durationMs), [2000, 2000]);
  assert.deepEqual(paired.map((span: any) => span.attrs.status), ['pass', 'fail']);
  assert.equal(spans.filter((span: any) => span.kind === 'hook' && (span.attrs.session === 'other-session' || span.attrs.tool_call_id === 'other-call')).length, 4, 'unrelated ids remain unpaired');
});

test('invalid durations become null; unsafe ids are null; failure output is never an exit-code source', (t) => {
  const root = project(t);
  for (const duration of [undefined, null, -1, 1.5, '93', {}, 1e100]) {
    const payload: any = { ...native('npm test', EVENTS[1]), duration_ms: duration, session_id: '../session', tool_use_id: 'has space' };
    observe(root, payload);
    const line = lines(root).at(-1);
    assert.deepEqual([line.duration_ms, line.tool_duration_ms, line.session, line.tool_call_id], [null, null, null, null]);
    noContent([line]);
  }
});

test('observer exits silently on malformed, irrelevant, missing-bridge, missing-jq and encode-fault paths', (t) => {
  const root = project(t);
  for (const input of ['', 'not json test', '[]', 'null', '42', '{}', JSON.stringify({ ...native('npm test'), tool_name: 'Read' }),
    JSON.stringify({ ...native('npm test'), hook_event_name: 'Stop' }), JSON.stringify(native(null))]) observe(root, null, { input, event: EVENTS[0] });
  observe(root, native('npm test'), { event: 'Stop' });
  observe(root, null, { input: JSON.stringify(native('npm test')) });
  assert.deepEqual(lines(root), []);
  const faulted = project(t, { mutate: (s: any) => s.replace('session:dft_token($d.identity.session)', 'session:error("tuple fault")') });
  observe(faulted, native('npm test'));
  assert.deepEqual(lines(faulted), []);
  fs.rmSync(path.join(root, '.doflow/shared'), { recursive: true });
  observe(root, native('npm test'));
  const noJq = project(t);
  observe(noJq, native('npm test'), { extra: { PATH: path.join(noJq, 'no-executables') } });
  assert.deepEqual(lines(noJq), []);
});

test('telemetry off exits without waiting for stdin or touching dependencies or state', async (t) => {
  const root = project(t, { state: false });
  const child = spawn('/bin/bash', [path.join(root, '.claude/hooks/post-shell-observe.sh'), EVENTS[0]], {
    cwd: root, env: env(root, { DOFLOW_TELEMETRY: 'off', PATH: '/nonexistent' }), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (value: any) => { stdout += value; });
  child.stderr.on('data', (value: any) => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const result = await new Promise((resolve) => child.once('exit', (code: any, signal: any) => resolve([code, signal])));
  clearTimeout(timer); child.stdin.destroy();
  assert.deepEqual([result, stdout, stderr], [[0, null], '', '']);
  assert.ok(!fs.existsSync(path.join(root, '.doflow/state')));
});

test('observer store faults never block, and nested dispatch delivery stores route to the project', (t) => {
  const root = project(t);
  const worktree = path.join(root, '.doflow/state/dispatch-worktrees/d-000000000001');
  fs.mkdirSync(path.join(worktree, '.doflow/state/delivery'), { recursive: true });
  observe(root, native('npm test'), { cwd: worktree });
  assert.equal(lines(root).length, 1);
  assert.deepEqual(lines(worktree), []);
  const noState = project(t, { state: false });
  observe(noState, native('npm test'));
  assert.ok(!fs.existsSync(path.join(noState, '.doflow/state')));
  for (const kind of ['directory', 'fifo', 'file-parent']) {
    const broken = project(t);
    const dir = path.join(broken, '.doflow/state/runs/telemetry');
    if (kind === 'file-parent') fs.writeFileSync(dir, 'blocked');
    else {
      fs.mkdirSync(dir);
      // Protect both possible UTC partitions if the test crosses midnight.
      for (const ms of [Date.now(), Date.now() + 86400000]) {
        const file = path.join(dir, `${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
        if (kind === 'directory') fs.mkdirSync(file);
        else assert.equal(spawnSync('mkfifo', [file]).status, 0);
      }
    }
    observe(broken, native('npm test'));
  }
});

test('negative control: emitting the raw command instead of class makes the SAME secrets assertion red in a scratch copy', (t) => {
  const root = project(t, { mutate: (source: any) => source.replace('test_class:classify($d.command)', 'test_class:$d.command') });
  const payload = native(`node --test --token=${SECRET}`);
  const records = encode(payload, { root: REPO });
  noContent([records[0]]);
  // The scratch encoder is installed beneath .doflow; invoke it without executing any command.
  const scratchEncoder = path.join(root, '.doflow/shared/hooks/bridge/envelope.jq');
  const result = spawnSync('jq', ['-c', '--arg', 'harness', 'claude', '--arg', 'event', 'PreToolUse', '--arg', 'policy', 'pre-bash-guard', '--arg', 'mode', 'encode', '-f', scratchEncoder], {
    input: JSON.stringify(payload), encoding: 'utf8', env: env(root),
  });
  assert.equal(result.status, 0, result.stderr);
  const [tuple] = result.stdout.trim().split('\n').map(JSON.parse);
  assert.throws(() => noContent([tuple]), /telemetry leaked ARGV_CANARY_088_SECRET/);
});

test('settings register BOTH Bash events alongside the existing failure capture; storage declares the observer', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, 'core/harnesses/claude/settings/settings.json'), 'utf8'));
  for (const event of EVENTS) {
    const observer = settings.hooks[event].filter((entry: any) => entry.matcher === 'Bash').flatMap((entry: any) => entry.hooks).filter((hook: any) => hook.command.includes('post-shell-observe.sh'));
    assert.deepEqual(observer.map((hook: any) => hook.command), [`~/.claude/hooks/post-shell-observe.sh ${event}`]);
  }
  assert.ok(settings.hooks.PostToolUseFailure.flatMap((entry: any) => entry.hooks).some((hook: any) => hook.command === '~/.claude/hooks/post-tool-failure.sh'));
  const storage = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/storage.json'), 'utf8'));
  assert.ok(storage.stores.find((store: any) => store.id === 'runs-telemetry').writers.includes(DOOR));
});

test('observer perf surfaces select captured fast-exit and test-class payloads with an explicit event argument', () => {
  const { surfaces, unmeasuredRows } = perf.enumerateHookSurfaces({ repoRoot: REPO, isToolInstalledFn: () => true });
  for (const [suffix, file] of [['', 'fast-exit.json'], ['.test-class', 'test-class.json']]) {
    const id = `hook.claude.post-shell-observe${suffix}`;
    const surface = surfaces.find((candidate: any) => candidate.id === id);
    assert.ok(surface, id);
    assert.equal(surface.argv.at(-1), EVENTS[0]);
    assert.equal(surface.stdinFixture, path.join(FIXTURES, file));
    assert.equal(surface.stdinField, 'native');
    assert.ok(!unmeasuredRows.some((row: any) => row.surfaceId === id));
  }
});
