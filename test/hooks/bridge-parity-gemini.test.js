'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo, encodeEnvelope, jqSorted } = require('../helper/hook-fixtures.ts');

const CORPUS = path.resolve(__dirname, '../fixtures/hooks/gemini');
const POLICIES = {
  'pre-implement-gate': 'pre-implementation-gate',
  'pre-bash-guard': 'pre-bash-guard',
  'mcp-tool-guard': 'mcp-tool-guard',
  'session-start': 'session-context',
};
const scratch = createScratch('doflow-gemini-bridge-');
after(() => scratch.remove());

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixtureRows() {
  const rows = [];
  for (const stem of fs.readdirSync(CORPUS).sort()) {
    const dir = path.join(CORPUS, stem);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const filename of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      rows.push({ stem, filename, fixture: JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')) });
    }
  }
  return rows;
}

function createProject(name, state) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-gemini');
  if (state === 'no-design' || state === 'all-artifacts') {
    const feature = path.join(project.root, 'agent-docs/doflow/077-gemini');
    write(path.join(feature, 'intention/requirement.md'), '# requirement\n');
    write(path.join(feature, 'plan.md'), '- [ ] D.2 [US1] Gemini — owner: test; files: src/a.js\n');
    if (state === 'all-artifacts') write(path.join(feature, 'design/design.md'), '# design\n');
  }
  return project.root;
}

function snapshotState(project) {
  const root = path.join(project, '.doflow/state');
  if (!fs.existsSync(root)) return null;
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push([path.relative(root, full), fs.readFileSync(full, 'base64')]);
    }
  };
  walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function runFixture({ stem, filename, fixture }, index) {
  const label = `gemini/${stem}/${filename}`;
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  const project = createProject(`project-${index}`, fixture.state || 'none');
  const script = path.join(mirror, '.gemini/hooks', `${stem}.sh`);
  assert.ok(fs.existsSync(script), `${label}: fixture names an installed front door`);
  if (fixture.policyConfig) {
    write(path.join(mirror, '.doflow/shared/hooks/policies', fixture.policyConfig.file), fixture.policyConfig.contents);
  }
  if (fixture.fault === 'crash-exit-1') {
    const policyPath = path.join(mirror, '.doflow/shared/hooks/policies', `${POLICIES[stem]}.sh`);
    write(policyPath, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '${'P'.repeat(200)}' >&2\nexit 1\n`);
    fs.chmodSync(policyPath, 0o755);
  }
  const event = fixture.native.hook_event_name;
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    DOFLOW_PROJECT_DIR: project,
    DOFLOW_AGENT: 'gemini',
    DOFLOW_BRIDGE_TRACE: trace,
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(fixture.env || {}),
  };
  const before = snapshotState(project);
  const result = spawnSync('bash', [script], {
    cwd: project,
    input: `${JSON.stringify(fixture.native)}\n`,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  assert.equal(result.status, fixture.expect.exit, `${label}: exit status`);
  if (fixture.expect.stdout !== null) assert.equal(result.stdout, fixture.expect.stdout, `${label}: stdout`);
  if (fixture.expect.stderrIncludes !== null) assert.ok(result.stderr.includes(fixture.expect.stderrIncludes), `${label}: stderr includes expected text`);
  if (fixture.expect.modelVisibleBytesMax !== undefined) {
    assert.ok(Buffer.byteLength(result.stdout) <= fixture.expect.modelVisibleBytesMax, `${label}: model-visible response respects byte ceiling`);
  }
  if (fixture.expect.taskStateUnchanged) assert.deepEqual(snapshotState(project), before, `${label}: task state unchanged`);

  const policy = POLICIES[stem];
  if (!policy) {
    assert.equal(fs.existsSync(trace), false, `${label}: fixture-only event does not call a policy`);
    return;
  }

  const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(decision.harness, 'gemini', `${label}: decision harness`);
  assert.equal(decision.event, event, `${label}: decision event`);
  assert.equal(decision.policy, policy, `${label}: decision policy`);
  for (const [key, value] of Object.entries(fixture.expect.decision)) {
    assert.deepEqual(decision[key], value, `${label}: decision.${key}`);
  }

  const envelope = JSON.parse(encodeEnvelope('gemini', event, policy, `${JSON.stringify(fixture.native)}\n`, fixture.env || {})).doflow_event;
  for (const [key, value] of Object.entries(fixture.expect.envelope)) {
    assert.deepEqual(envelope[key], value, `${label}: envelope.${key}`);
  }
  assert.equal(jqSorted(envelope), jqSorted(fixture.expect.envelope), `${label}: complete envelope equals fixture`);
  const failureFile = path.join(xdg, 'doflow/failures/events.jsonl');
  const failurePoints = fs.existsSync(failureFile)
    ? fs.readFileSync(failureFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  assert.deepEqual(failurePoints, fixture.expect.failurePoint === null ? [] : [fixture.expect.failurePoint], `${label}: captured failure point`);

  if (decision.outcome === 'deny') {
    const response = JSON.parse(result.stdout);
    assert.equal(response.decision, 'deny', `${label}: flat Gemini deny decision`);
    assert.equal(typeof response.reason, 'string', `${label}: Gemini deny reason`);
    assert.equal('hookSpecificOutput' in response, false, `${label}: deny is not nested in Claude shape`);
  }
  if (fixture.fault === 'crash-exit-1' && fixture.expect.decision.effect === 'block') {
    const response = JSON.parse(result.stdout);
    assert.equal(response.reason, `[${policy}] DoFlow policy error; details: doflow-run failure list`, `${label}: fixed error reason`);
    assert.equal(result.stdout.includes('P'.repeat(200)), false, `${label}: private policy stderr is not exposed`);
  } else if (fixture.fault === 'crash-exit-1') {
    assert.equal(result.stdout, '', `${label}: advisory fault is silent`);
    assert.equal(result.stderr.includes('P'.repeat(200)), false, `${label}: private policy stderr is not exposed`);
  }
}

const rows = fixtureRows();
test('Gemini corpus covers every configured hook event and canonical perf input', () => {
  const expected = {
    'pre-implement-gate': 'BeforeTool',
    'pre-bash-guard': 'BeforeTool',
    'mcp-tool-guard': 'BeforeTool',
    'session-start': 'SessionStart',
    'post-edit-lint': 'AfterTool',
    'pre-compact': 'PreCompress',
    'session-end': 'SessionEnd',
  };
  for (const [stem, event] of Object.entries(expected)) {
    const matching = rows.filter((row) => row.stem === stem);
    assert.ok(matching.some((row) => row.fixture.native.hook_event_name === event), `${stem} has ${event} fixture`);
    if (POLICIES[stem]) assert.ok(matching.some((row) => row.filename === 'perf.json'), `${stem} has perf fixture`);
  }
});

for (const [index, row] of rows.entries()) {
  test(`Gemini parity ${row.stem}/${row.filename}`, () => runFixture(row, index));
}

test('Gemini flat deny assertion catches a reverted native renderer', () => {
  const mirror = path.join(scratch.dir, 'mirror-nested-deny-control');
  buildInstallMirror(mirror);
  const responseScript = path.join(mirror, '.doflow/shared/hooks/bridge/respond.sh');
  const source = fs.readFileSync(responseScript, 'utf8');
  const flatRenderer = 'gemini:BeforeTool) emit_pretooluse_deny_flat "$reason"; return 0 ;;';
  assert.ok(source.includes(flatRenderer), 'the install mirror contains the Gemini flat renderer');
  fs.writeFileSync(responseScript, source.replace(flatRenderer, 'gemini:BeforeTool) emit_pretooluse_deny_nested "$reason"; return 0 ;;'));

  const project = createProject('nested-deny-control-project', 'no-design');
  const result = spawnSync('bash', [path.join(mirror, '.gemini/hooks/pre-implement-gate.sh')], {
    cwd: project,
    input: `${JSON.stringify({ hook_event_name: 'BeforeTool', session_id: 'gemini-negative-control', tool_name: 'replace', tool_input: { file_path: 'src/a.js' } })}\n`,
    env: { ...process.env, HOME: path.join(scratch.dir, 'negative-home'), XDG_CONFIG_HOME: path.join(scratch.dir, 'negative-xdg'), DOFLOW_PROJECT_DIR: project, DOFLOW_AGENT: 'gemini', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.throws(() => assert.equal(response.decision, 'deny', 'flat Gemini deny decision'), /flat Gemini deny decision/);
});
