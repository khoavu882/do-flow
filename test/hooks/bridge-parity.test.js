'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo, jqSorted } = require('../helper/hook-fixtures');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks');
const CANONICAL = new Set(['pre-implement-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-start', 'user-prompt-submit', 'subagent-audit', 'stop-check']);
const scratch = createScratch('doflow-bridge-parity-');
after(() => scratch.remove());

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=hook-test', '-c', 'user.email=hook-test@example.invalid', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function makeProject(name, state) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-parity');
  if (state === 'no-design' || state === 'all-artifacts') {
    write(path.join(project.root, 'agent-docs/doflow/077-parity/intention/requirement.md'), '# requirement\n');
    write(path.join(project.root, 'agent-docs/doflow/077-parity/plan.md'), '- [ ] C.1 [US1] parity — owner: test; files: src/a.js\n');
    if (state === 'all-artifacts') write(path.join(project.root, 'agent-docs/doflow/077-parity/design/design.md'), '# design\n');
  }
  return project.root;
}

function snapshotState(root) {
  const target = path.join(root, '.doflow/state');
  if (!fs.existsSync(target)) return null;
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push([path.relative(target, full), fs.readFileSync(full, 'base64')]);
    }
  };
  walk(target);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function call(command, { cwd, input, env }) {
  const result = spawnSync(command[0], command.slice(1), { cwd, input, env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function nativeResponseBytes(harness, event, result) {
  if (harness === 'claude' && event === 'PreToolUse') {
    return Buffer.byteLength(result.stdout);
  }
  return Buffer.byteLength(result.stderr);
}

function fixtureFiles(harnesses) {
  const cases = [];
  for (const harness of harnesses) {
    const harnessDir = path.join(FIXTURES, harness);
    if (!fs.statSync(harnessDir).isDirectory()) continue;
    for (const stem of fs.readdirSync(harnessDir)) {
      const stemDir = path.join(harnessDir, stem);
      if (!fs.statSync(stemDir).isDirectory()) continue;
      for (const filename of fs.readdirSync(stemDir).filter((name) => name.endsWith('.json'))) {
        const fixturePath = path.join(stemDir, filename);
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        if (!fixture.native || !fixture.expect) continue; // Existing Pi tool_call input is not an IC-028 case.
        cases.push({ harness, stem, fixturePath, fixture });
      }
    }
  }
  return cases.sort((a, b) => {
    const errorFirst = Number(b.fixture.fault === 'crash-exit-1') - Number(a.fixture.fault === 'crash-exit-1');
    return errorFirst || a.fixturePath.localeCompare(b.fixturePath);
  });
}

function runFixture({ harness, stem, fixturePath, fixture }, index) {
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  const stateName = fixture.state || 'none';
  const project = makeProject(`project-${index}`, stateName);
  const caseName = path.basename(fixturePath);
  const script = path.join(mirror, `.${harness}`, 'hooks', `${stem}.sh`);
  assert.ok(fs.existsSync(script), `fixture ${fixturePath} names an installed front door ${harness}/${stem}.sh`);
  const policy = stem;
  if (fixture.policyConfig) write(path.join(mirror, '.doflow/shared/hooks/policies', fixture.policyConfig.file), fixture.policyConfig.contents);
  const event = fixture.native.hook_event_name;
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: xdg,
    DOFLOW_PROJECT_DIR: project, DOFLOW_AGENT: harness, DOFLOW_BRIDGE_TRACE: trace,
    GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '',
    ...(fixture.env || {}),
  };
  const before = snapshotState(project);
  if (fixture.fault === 'missing-policy') {
    const policyId = ({ 'pre-implement-gate': 'pre-implementation-gate', 'session-start': 'session-context' })[stem] || stem;
    const policyPath = path.join(mirror, '.doflow/shared/hooks/policies', `${policyId}.sh`);
    fs.renameSync(policyPath, `${policyPath}.missing`);
  }
  if (['crash-exit-1', 'context-crash-exit-1', 'policy-stderr', 'stop-exit-2', 'stop-exit-7'].includes(fixture.fault)) {
    const policyId = ({ 'pre-implement-gate': 'pre-implementation-gate', 'session-start': 'session-context' })[stem] || stem;
    const policyPath = path.join(mirror, '.doflow/shared/hooks/policies', `${policyId}.sh`);
    if (fixture.fault === 'policy-stderr') write(policyPath, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'fixture stderr\\n' >&2\nexit 0\n`);
    else if (fixture.fault === 'stop-exit-2' || fixture.fault === 'stop-exit-7') write(policyPath, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'stop private stderr\\n' >&2\nexit ${fixture.fault === 'stop-exit-2' ? 2 : 7}\n`);
    else write(policyPath, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '${'P'.repeat(200)}' >&2\nexit 1\n`);
    fs.chmodSync(policyPath, 0o755);
  }
  const result = call(['bash', script], { cwd: project, input: `${JSON.stringify(fixture.native)}\n`, env });
  const label = `${harness}/${stem}/${caseName}`;
  assert.equal(result.status, fixture.expect.exit, `${label}: exit status`);
  if (fixture.expect.stdout !== null) assert.equal(result.stdout, fixture.expect.stdout, `${label}: stdout`);
  if (fixture.expect.stderrIncludes !== null) assert.ok(result.stderr.includes(fixture.expect.stderrIncludes), `${label}: stderr contains expected text (${JSON.stringify(result.stderr)})`);
  if (fixture.expect.modelVisibleBytesMax !== undefined) {
    const bytes = nativeResponseBytes(harness, event, result);
    assert.ok(bytes <= fixture.expect.modelVisibleBytesMax, `${label}: model-visible bytes (${bytes} > ${fixture.expect.modelVisibleBytesMax})`);
  }
  if (fixture.fault === 'crash-exit-1') {
    const body = JSON.parse(result.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecisionReason, '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list', `${label}: fixed error reason`);
    assert.ok(!result.stdout.includes('P'.repeat(200)), `${label}: private policy stderr is not forwarded`);
  }
  if (fixture.fault === 'stop-exit-2' || fixture.fault === 'stop-exit-7') {
    assert.equal(result.stderr, '[stop-check] DoFlow policy error; details: doflow-run failure list\n', `${label}: fixed Stop reason has baseline newline`);
    assert.equal(result.stderr.includes('private'), false, `${label}: raw Stop stderr is hidden`);
  }
  if (fixture.expect.taskStateUnchanged) assert.deepEqual(snapshotState(project), before, `${label}: task state unchanged`);

  if (!CANONICAL.has(stem)) {
    assert.equal(fs.existsSync(trace), false, `${label}: fixture-only hook does not call the bridge`);
    return;
  }

  const policyId = ({
    'pre-implement-gate': 'pre-implementation-gate',
    'session-start': 'session-context',
  })[stem] || stem;
  const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(decision.harness, harness, `${label}: actual decision harness`);
  assert.equal(decision.event, event, `${label}: actual decision event`);
  assert.equal(decision.policy, policyId, `${label}: actual decision policy`);
  for (const [key, value] of Object.entries(fixture.expect.decision)) assert.equal(decision[key], value, `${label}: decision.${key}`);
  const failureFile = path.join(xdg, 'doflow/failures/events.jsonl');
  const actualFailurePoints = fs.existsSync(failureFile)
    ? fs.readFileSync(failureFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  assert.deepEqual(actualFailurePoints, fixture.expect.failurePoint === null ? [] : [fixture.expect.failurePoint], `${label}: failure point`);
  const encoder = path.join(mirror, '.doflow/shared/hooks/bridge/envelope.jq');
  const encoded = call(['jq', '-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', policyId, '-f', encoder], {
    cwd: project, input: `${JSON.stringify(fixture.native)}\n`, env,
  });
  assert.equal(encoded.status, 0, `${label}: envelope encoder`);
  const encodedPayload = JSON.parse(encoded.stdout);
  assert.ok(encodedPayload.doflow_event, `${label}: v1 envelope is merged into the native payload`);
  const envelope = encodedPayload.doflow_event;
  for (const [key, value] of Object.entries(fixture.expect.envelope)) assert.deepEqual(envelope[key], value, `${label}: envelope.${key}`);

  // Run the bridge-produced v1 payload through the canonical policy in the same project.
  const nativePolicy = path.join(mirror, '.doflow/shared/hooks/policies', `${policyId}.sh`);
  if (fixture.fault === 'none') {
    const policyResult = call(['bash', nativePolicy], { cwd: project, input: encoded.stdout, env: { ...env, DOFLOW_BRIDGE_TRACE: '', DOFLOW_DECISION_FD: '' } });
    assert.equal(policyResult.status, decision.outcome === 'deny' ? 2 : 0, `${label}: bridge and direct v1 policy verdict parity`);
  }
  assert.equal(jqSorted(envelope), jqSorted(fixture.expect.envelope), `${label}: envelope fields match fixture`);
}

const fixtures = fixtureFiles(['claude']);
test('Claude hook corpus includes every wired event and a perf case for every canonical front door', () => {
  assert.ok(fixtures.length >= 15, 'the corpus includes every Claude wired event and a perf case for each canonical front door');
});
fixtures.forEach((fixture, index) => {
  test(`Claude parity ${path.relative(FIXTURES, fixture.fixturePath)}`, () => runFixture(fixture, index));
});
