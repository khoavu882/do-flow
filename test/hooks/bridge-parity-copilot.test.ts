'use strict';

// Copilot CLI parity: every fixture under test/fixtures/hooks/copilot/<door>/ runs through the
// projected front door (.github/hooks/doflow-<door>.sh in an install-shaped mirror) with the native
// camelCase payload Copilot sends, and the native stdout/exit, the bridge decision and the envelope
// are compared. The payloads are the shapes of the live capture of 2026-10-27 (Copilot CLI 1.0.103).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks/copilot');
const POLICIES: any = {
  'pre-implement-gate': 'pre-implementation-gate',
  'pre-bash-guard': 'pre-bash-guard',
  'mcp-tool-guard': 'mcp-tool-guard',
  'session-start': 'session-context',
  'stop-check': 'stop-check',
  'subagent-start': 'subagent-audit',
  'subagent-stop': 'subagent-audit',
};
const scratch = createScratch('doflow-copilot-parity-');
after(() => scratch.remove());

function write(file: any, contents: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeProject(name: any, state: any) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/021-copilot-parity');
  if (state === 'no-design' || state === 'all-artifacts') {
    write(path.join(project.root, 'agent-docs/doflow/021-copilot-parity/intention/requirement.md'), '# requirement\n');
    write(path.join(project.root, 'agent-docs/doflow/021-copilot-parity/plan.md'), '- [ ] D.3 [US1] Copilot — owner: test; files: core/harnesses/copilot/hooks\n');
    if (state === 'all-artifacts') write(path.join(project.root, 'agent-docs/doflow/021-copilot-parity/design/design.md'), '# design\n');
  }
  return project.root;
}

function fixtureCases() {
  const cases = [];
  for (const stem of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, stem);
    if (!fs.statSync(dir).isDirectory() || stem === 'live') continue;
    for (const name of fs.readdirSync(dir).filter((entry: any) => entry.endsWith('.json'))) {
      const fixturePath = path.join(dir, name);
      cases.push({ stem, fixturePath, fixture: JSON.parse(fs.readFileSync(fixturePath, 'utf8')) });
    }
  }
  return cases.sort((a, b) => a.fixturePath.localeCompare(b.fixturePath));
}

function runFixture({ stem, fixturePath, fixture }: any, index: any) {
  const mirror = path.join(scratch.dir, `mirror-${index}`);
  buildInstallMirror(mirror);
  const project = makeProject(`project-${index}`, fixture.state || 'none');
  const door = path.join(mirror, '.github/hooks', `doflow-${stem}.sh`);
  assert.ok(fs.existsSync(door), `${fixturePath}: projected Copilot front door exists`);
  if (fixture.policyConfig) fs.appendFileSync(path.join(mirror, '.doflow/shared/hooks/policies', fixture.policyConfig.file), fixture.policyConfig.contents);
  const policy = POLICIES[stem];
  if (fixture.fault === 'crash-exit-1') {
    fs.writeFileSync(path.join(mirror, '.doflow/shared/hooks/policies', `${policy}.sh`), '#!/usr/bin/env bash\necho private-policy-stderr >&2\nexit 1\n');
  }
  if (fixture.fault === 'missing-bridge') fs.rmSync(path.join(mirror, '.doflow/shared/hooks/bridge'), { recursive: true });
  const native = JSON.parse(JSON.stringify(fixture.native));
  if (fixture.transcript) {
    const transcript = path.join(scratch.dir, `transcript-${index}.jsonl`);
    write(transcript, fixture.transcript.map((line: any) => JSON.stringify(line)).join('\n') + '\n');
    native.transcriptPath = transcript;
  }
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_PROJECT_DIR: project,
    DOFLOW_AGENT: 'copilot', DOFLOW_BRIDGE_TRACE: trace, GIT_CONFIG_GLOBAL: '/dev/null',
    CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', ...(fixture.env || {}),
  };
  const result = spawnSync('bash', [door], { cwd: project, input: `${JSON.stringify(native)}\n`, env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  const label = `Copilot ${path.relative(FIXTURES, fixturePath)}`;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  assert.equal(result.status, fixture.expect.exit, `${label}: native exit (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}, trace=${fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : 'missing'})`);
  if (fixture.fault === 'crash-exit-1') assert.equal(stderr.includes('private-policy-stderr'), false, `${label}: failed policy stderr stays private`);
  if (fixture.expect.stdout !== undefined) assert.equal(stdout, fixture.expect.stdout, `${label}: native stdout`);
  if (fixture.expect.stdoutJson) assert.deepEqual(JSON.parse(stdout), fixture.expect.stdoutJson, `${label}: native stdout JSON`);
  if (fixture.expect.stdoutIncludes) assert.ok(stdout.includes(fixture.expect.stdoutIncludes), `${label}: native stdout contains ${fixture.expect.stdoutIncludes}`);
  if (fixture.expect.stderrIncludes === null) assert.equal(stderr, '', `${label}: native stderr is empty`);
  if (fixture.expect.modelVisibleBytesMax !== undefined) {
    assert.ok(Buffer.byteLength(stdout) <= fixture.expect.modelVisibleBytesMax, `${label}: model-visible bytes (${Buffer.byteLength(stdout)} > ${fixture.expect.modelVisibleBytesMax})`);
  }
  if (fixture.fault === 'missing-bridge') return; // no bridge, no trace: the front door answers alone
  if (fixture.expect.noBridgeRun) { assert.equal(fs.existsSync(trace), false, `${label}: the bridge did not run`); return; }
  assert.ok(fs.existsSync(trace), `${label}: bridge trace was written`);
  const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(decision.harness, 'copilot', `${label}: decision harness`);
  assert.equal(decision.event, fixture.event, `${label}: decision event`);
  assert.equal(decision.policy, policy, `${label}: decision policy`);
  for (const [key, value] of Object.entries(fixture.expect.decision)) assert.equal(decision[key], value, `${label}: decision.${key}`);
  const normalised = spawnSync('bash', ['-c', `source "${path.join(mirror, '.github/hooks/doflow-lib.sh')}"; copilot_bridge_payload ${fixture.event}`], {
    cwd: project, input: `${JSON.stringify(native)}\n`, env, encoding: 'utf8',
  });
  assert.equal(normalised.status, 0, `${label}: Copilot payload normaliser`);
  const encoded = spawnSync('jq', ['-c', '--arg', 'harness', 'copilot', '--arg', 'event', fixture.event, '--arg', 'policy', policy, '-f', path.join(mirror, '.doflow/shared/hooks/bridge/envelope.jq')], {
    cwd: project, input: normalised.stdout, env, encoding: 'utf8',
  });
  assert.equal(encoded.status, 0, `${label}: envelope encoder (${encoded.stderr})`);
  const envelope = JSON.parse(encoded.stdout).doflow_event;
  assert.ok(envelope, `${label}: v1 envelope merged into the normalised payload`);
  for (const [key, value] of Object.entries(fixture.expect.envelope)) assert.deepEqual(envelope[key], value, `${label}: envelope.${key}`);
}

const cases = fixtureCases();
assert.ok(cases.length > 0, 'Copilot parity fixtures exist');
cases.forEach((item, index) => {
  test(`Copilot parity ${path.relative(FIXTURES, item.fixturePath)}`, () => runFixture(item, index));
});
