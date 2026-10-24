'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo, jqSorted } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks/antigravity');
const scratch = createScratch('doflow-antigravity-parity-');
after(() => scratch.remove());

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function projectFor(name, state) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-antigravity');
  if (state === 'no-design' || state === 'all-artifacts') {
    const base = path.join(project.root, 'agent-docs/doflow/077-antigravity');
    write(path.join(base, 'intention/requirement.md'), '# requirement\n');
    write(path.join(base, 'plan.md'), '- [ ] E.1 [US1] bridge — owner: test; files: src/a.js\n');
    if (state === 'all-artifacts') write(path.join(base, 'design/design.md'), '# design\n');
  }
  return project.root;
}

function readFixtures() {
  const rows = [];
  for (const stem of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, stem);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      const fixturePath = path.join(dir, name);
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      if (!Object.hasOwn(fixture, 'native')) continue;
      rows.push({ stem, fixturePath, fixture });
    }
  }
  return rows.sort((a, b) => a.fixturePath.localeCompare(b.fixturePath));
}

function run(row, index) {
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  const project = projectFor(`project-${index}`, row.fixture.state);
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const native = row.fixture.native === null ? null : JSON.parse(JSON.stringify(row.fixture.native));
  if (native && Array.isArray(native.workspacePaths)) native.workspacePaths = [project];
  if (native?.transcriptPath === '<transcript>') {
    const transcript = path.join(scratch.dir, `transcript-${index}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', content: '// TODO: finish this work' })}\n`);
    native.transcriptPath = transcript;
  }
  if (row.fixture.fault === 'policy-exit-9') {
    const policy = path.join(mirror, '.doflow/shared/hooks/policies/pre-implementation-gate.sh');
    fs.writeFileSync(policy, "#!/usr/bin/env bash\nprintf '%200s\\n' '' | tr ' ' x >&2\nexit 9\n", { mode: 0o755 });
  }
  const event = row.stem === 'stop-check' ? 'Stop' : 'PreToolUse';
  const runner = path.join(mirror, '.doflow/shared/hooks/stream-hook-runner.js');
  const result = spawnSync(process.execPath, [runner, event], {
    cwd: project,
    input: native === null ? 'null\n' : `${JSON.stringify(native)}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      DOFLOW_PROJECT_DIR: project,
      DOFLOW_AGENT: 'antigravity',
      DOFLOW_BRIDGE_TRACE: trace,
      DOFLOW_FAILURE_CAPTURE: '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...(row.fixture.env || {}),
    },
  });
  const label = path.relative(FIXTURES, row.fixturePath);
  assert.equal(result.status, row.fixture.expect.exit, `${label}: exit`);
  if (row.fixture.expect.stdout === '<deny-json>') {
    const body = JSON.parse(result.stdout);
    assert.equal(body.decision, 'deny', `${label}: native deny`);
    assert.match(body.reason, /^\[pre-implementation-gate\] doflow gate: feature .* is missing/);
  } else if (row.fixture.expect.stdout === '<error-json>') {
    const body = JSON.parse(result.stdout);
    assert.deepEqual(body, { decision: 'deny', reason: '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list' }, `${label}: fixed error render`);
    assert.equal(result.stdout.includes('x'.repeat(200)), false, `${label}: raw policy stderr is hidden`);
  } else if (row.fixture.expect.stdout === '<continue-json>') {
    const body = JSON.parse(result.stdout);
    assert.equal(body.decision, 'continue', `${label}: Stop block`);
    assert.match(body.reason, /^\[stop-check\]/, `${label}: Stop reason`);
  } else if (row.fixture.expect.stdout !== undefined) {
    assert.equal(result.stdout, row.fixture.expect.stdout, `${label}: stdout`);
  }
  if (row.fixture.expect.stderrIncludes !== null && row.fixture.expect.stderrIncludes !== undefined) {
    assert.ok(result.stderr.includes(row.fixture.expect.stderrIncludes), `${label}: stderr`);
  }
  if (row.fixture.expect.modelVisibleBytesMax !== undefined) {
    assert.ok(Buffer.byteLength(result.stdout) <= row.fixture.expect.modelVisibleBytesMax, `${label}: model-visible bytes`);
  }

  if (row.fixture.expect.decision) {
    assert.ok(fs.existsSync(trace), `${label}: bridge decision trace exists`);
    const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
    for (const [key, value] of Object.entries(row.fixture.expect.decision)) {
      assert.equal(decision[key], value, `${label}: decision.${key}`);
    }
    if (!row.fixture.expect.envelope) {
      if (row.fixture.expect.taskStateUnchanged) assert.equal(fs.existsSync(path.join(project, '.doflow/state')), false, `${label}: task state unchanged`);
      return;
    }
    const encoder = path.join(mirror, '.doflow/shared/hooks/bridge/envelope.jq');
    const encoded = spawnSync('jq', ['-c', '--arg', 'harness', 'antigravity', '--arg', 'event', event,
      '--arg', 'policy', decision.policy, '-f', encoder], {
      cwd: project,
      input: native === null ? 'null\n' : `${JSON.stringify(native)}\n`,
      encoding: 'utf8',
      env: { ...process.env, DOFLOW_TASK_ID: '', DOFLOW_RUN_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_LINEAGE_ID: '', DOFLOW_SESSION_ROLE: '', DOFLOW_WORKTREE: '', ...(row.fixture.env || {}) },
    });
    assert.equal(encoded.status, 0, `${label}: envelope encoder`);
    const envelope = JSON.parse(encoded.stdout).doflow_event;
    for (const [key, value] of Object.entries(row.fixture.expect.envelope)) {
      assert.deepEqual(envelope[key], value, `${label}: envelope.${key}`);
    }
    assert.equal(jqSorted(envelope), jqSorted(row.fixture.expect.envelope), `${label}: envelope fields`);
  } else {
    assert.equal(fs.existsSync(trace), false, `${label}: malformed native input never reaches the bridge`);
  }
  if (row.fixture.expect.taskStateUnchanged) assert.equal(fs.existsSync(path.join(project, '.doflow/state')), false, `${label}: task state unchanged`);
}

const rows = readFixtures();
test('Antigravity corpus has every wired event and a perf case per front door', () => {
  assert.ok(rows.some((row) => row.stem === 'pre-implement-gate' && path.basename(row.fixturePath) === 'allow-perf.json'));
  assert.ok(rows.some((row) => row.stem === 'stop-check' && path.basename(row.fixturePath) === 'allow-perf.json'));
  assert.ok(rows.some((row) => row.stem === 'pre-implement-gate'));
  assert.ok(rows.some((row) => row.stem === 'stop-check'));
});
rows.forEach((row, index) => test(`Antigravity parity ${path.relative(FIXTURES, row.fixturePath)}`, () => run(row, index)));
