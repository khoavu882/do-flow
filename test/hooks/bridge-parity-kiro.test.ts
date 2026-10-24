'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { buildInstallMirror, createScratch, createScratchGitRepo } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures/hooks/kiro');
const POLICIES: any = {
  'pre-implement-gate': 'pre-implementation-gate',
  'pre-bash-guard': 'pre-bash-guard',
  'mcp-tool-guard': 'mcp-tool-guard',
  'session-start': 'session-context',
  'stop-check': 'stop-check',
};
const scratch = createScratch('doflow-kiro-parity-');
after(() => scratch.remove());

function write(file: any, contents: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeProject(name: any, state: any) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-kiro-parity');
  if (state === 'no-design' || state === 'all-artifacts') {
    write(path.join(project.root, 'agent-docs/doflow/077-kiro-parity/intention/requirement.md'), '# requirement\n');
    write(path.join(project.root, 'agent-docs/doflow/077-kiro-parity/plan.md'), '- [ ] D.3 [US1] Kiro — owner: test; files: core/harnesses/kiro/hooks\n');
    if (state === 'all-artifacts') write(path.join(project.root, 'agent-docs/doflow/077-kiro-parity/design/design.md'), '# design\n');
  }
  return project.root;
}

function run(command: any, { cwd, input, env }: any) {
  const result = spawnSync(command[0], command.slice(1), { cwd, input, env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function fixtureCases() {
  const cases = [];
  for (const stem of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, stem);
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
  const door = path.join(mirror, '.kiro/hooks', `${stem}.sh`);
  assert.ok(fs.existsSync(door), `${fixturePath}: projected Kiro front door exists`);
  if (fixture.policyConfig) {
    const policyFile = path.join(mirror, '.doflow/shared/hooks/policies', fixture.policyConfig.file);
    fs.appendFileSync(policyFile, fixture.policyConfig.contents);
  }
  if (fixture.fault === 'crash-exit-1') {
    const policy = POLICIES[stem];
    fs.writeFileSync(path.join(mirror, '.doflow/shared/hooks/policies', `${policy}.sh`), '#!/usr/bin/env bash\necho private-policy-stderr >&2\nexit 1\n');
  }
  const trace = path.join(scratch.dir, `trace-${index}.jsonl`);
  const home = path.join(scratch.dir, `home-${index}`);
  const xdg = path.join(scratch.dir, `xdg-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_PROJECT_DIR: project,
    DOFLOW_AGENT: 'kiro', DOFLOW_BRIDGE_TRACE: trace, GIT_CONFIG_GLOBAL: '/dev/null',
    CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', ...(fixture.env || {}),
  };
  const result = run(['bash', door], { cwd: project, input: `${JSON.stringify(fixture.native)}\n`, env });
  const label = `Kiro ${path.relative(FIXTURES, fixturePath)}`;
  assert.equal(result.status, fixture.expect.exit, `${label}: native exit (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}, trace=${fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : 'missing'})`);
  if (fixture.fault) assert.equal(result.stderr.includes('private-policy-stderr'), false, `${label}: failed policy stderr stays private`);
  if (fixture.expect.stdout !== null) assert.equal(result.stdout, fixture.expect.stdout, `${label}: native stdout`);
  if (fixture.expect.stdoutIncludes) assert.ok(result.stdout.includes(fixture.expect.stdoutIncludes), `${label}: native stdout contains ${fixture.expect.stdoutIncludes}`);
  if (fixture.expect.stderrIncludes) assert.ok(result.stderr.includes(fixture.expect.stderrIncludes), `${label}: native stderr contains ${fixture.expect.stderrIncludes}`);
  else if (fixture.expect.stderrIncludes === null) assert.equal(result.stderr, '', `${label}: native stderr is empty`);
  if (fixture.expect.modelVisibleBytesMax !== undefined) {
    const modelBytes = Buffer.byteLength(stem === 'stop-check' && fixture.native.session_id ? result.stdout : result.stderr);
    assert.ok(modelBytes <= fixture.expect.modelVisibleBytesMax, `${label}: model-visible bytes (${modelBytes} > ${fixture.expect.modelVisibleBytesMax})`);
  }
  assert.ok(fs.existsSync(trace), `${label}: bridge trace was written`);
  const decision = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  const event = fixture.native.hook_event_name;
  const policy = POLICIES[stem];
  assert.equal(decision.harness, 'kiro', `${label}: decision harness`);
  assert.equal(decision.event, event, `${label}: decision event`);
  assert.equal(decision.policy, policy, `${label}: decision policy`);
  for (const [key, value] of Object.entries(fixture.expect.decision)) assert.equal(decision[key], value, `${label}: decision.${key}`);
  const payloadInput = spawnSync('bash', ['-c', `source "${path.join(mirror, '.kiro/hooks/lib.sh')}"; kiro_bridge_payload`], {
    cwd: project, input: `${JSON.stringify(fixture.native)}\n`, env, encoding: 'utf8',
  });
  assert.equal(payloadInput.status, 0, `${label}: Kiro payload translator`);
  const encoded = run(['jq', '-c', '--arg', 'harness', 'kiro', '--arg', 'event', event, '--arg', 'policy', policy, '-f', path.join(mirror, '.doflow/shared/hooks/bridge/envelope.jq')], {
    cwd: project, input: payloadInput.stdout, env,
  });
  assert.equal(encoded.status, 0, `${label}: envelope encoder`);
  const envelope = JSON.parse(encoded.stdout).doflow_event;
  assert.ok(envelope, `${label}: v1 envelope merged into native payload`);
  for (const [key, value] of Object.entries(fixture.expect.envelope)) assert.deepEqual(envelope[key], value, `${label}: envelope.${key}`);
}

const cases = fixtureCases();
cases.forEach((item, index) => {
  test(`Kiro parity ${path.relative(FIXTURES, item.fixturePath)}`, () => runFixture(item, index));
});

