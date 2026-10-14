'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch, createScratchGitRepo, loadCorpus, parseRecords, runPolicy } = require('../helper/hook-fixtures');

const scratch = createScratch('doflow-policy-envelope-');
after(() => scratch.remove());
const baselineRoot = scratch.path('baseline');
fs.mkdirSync(baselineRoot, { recursive: true });
const baselineArchive = spawnSync('git', ['archive', '0fcd973', 'core/harnesses'], { cwd: path.resolve(__dirname, '../..') });
if (baselineArchive.status !== 0) throw new Error(baselineArchive.stderr.toString());
const baselineExtract = spawnSync('tar', ['-x', '-C', baselineRoot], { input: baselineArchive.stdout });
if (baselineExtract.status !== 0) throw new Error(baselineExtract.stderr.toString());

function runBaseline(policy, input, { cwd = path.resolve(__dirname, '../..'), env = {}, policyPath } = {}) {
  const actual = spawnSync('bash', [policyPath || path.join(baselineRoot, 'core/harnesses/shared/hooks/policies', `${policy}.sh`)], {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, HOME: scratch.path('baseline-home'), XDG_CONFIG_HOME: scratch.path('baseline-xdg'), DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_DECISION_FD: '', DOFLOW_PROJECT_DIR: cwd, DOFLOW_AGENT: '', ...env },
  });
  return { status: actual.status, stdout: actual.stdout || '', stderr: actual.stderr || '' };
}

for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
  test(`${policy}: legacy inputs preserve golden stdout, stderr and exit status`, () => {
    let cwd = undefined;
    if (policy === 'pre-implementation-gate') {
      const repo = createScratchGitRepo(scratch, 'gate-golden');
      repo.run('checkout', '-q', '-b', 'feat/missing-plan');
      fs.mkdirSync(path.join(repo.root, 'agent-docs/doflow/missing-plan'), { recursive: true });
      fs.writeFileSync(path.join(repo.root, 'agent-docs/doflow/missing-plan/requirement.md'), 'started\n');
      cwd = repo.root;
    }
    for (const row of loadCorpus(policy)) {
      if (policy === 'mcp-tool-guard' && row.name === 'pattern-deny') continue;
      const result = runPolicy(policy, row.input, { cwd, env: cwd ? { DOFLOW_PROJECT_DIR: cwd, HOME: scratch.path('golden-home') } : {} });
      const baseline = runBaseline(policy, row.input, { cwd, env: cwd ? { DOFLOW_PROJECT_DIR: cwd, HOME: scratch.path('golden-home') } : {} });
      assert.equal(result.status, row.status, `${row.name} exit`);
      assert.equal(result.stdout, row.stdout, `${row.name} stdout`);
      assert.equal(result.stderr, row.stderr, `${row.name} stderr`);
      assert.deepEqual(baseline, { status: row.status, stdout: row.stdout, stderr: row.stderr }, `${row.name} 0fcd973 bytes`);
    }
  });
}

test('decision fd writes provisional allow before each deny record', () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const result = runPolicy('pre-bash-guard', input, { decisionFd: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Catastrophic delete blocked/);
  const records = parseRecords(result.records);
  assert.deepEqual(records.map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['deny', 'blocked-pattern'],
  ]);
});

test('decision fd records every gate deny site', () => {
  const repo = createScratchGitRepo(scratch, 'gate-missing-artifacts');
  repo.run('checkout', '-q', '-b', 'feat/missing-plan');
  fs.mkdirSync(path.join(repo.root, 'agent-docs/doflow/missing-plan'), { recursive: true });
  fs.writeFileSync(path.join(repo.root, 'agent-docs/doflow/missing-plan/requirement.md'), 'started\n');
  const result = runPolicy('pre-implementation-gate', JSON.stringify({
    doflow_event: { version: 1, operation: 'edit', paths: ['src/a.js'] },
  }), { decisionFd: true, cwd: repo.root, env: { DOFLOW_PROJECT_DIR: repo.root, HOME: scratch.path('gate-home') } });
  assert.equal(result.status, 2);
  assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['deny', 'missing-artifacts'],
  ]);
});

test('decision fd records missing, not-ready and wrong-template readiness denies', () => {
  const repo = createScratchGitRepo(scratch, 'gate-readiness-records');
  repo.run('checkout', '-q', '-b', 'feat/readiness-records');
  const feature = path.join(repo.root, 'agent-docs/doflow/readiness-records');
  fs.mkdirSync(path.join(feature, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'design'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'intention/requirement.md'), '# requirement\n');
  fs.writeFileSync(path.join(feature, 'design/design.md'), '# design\n');
  fs.writeFileSync(path.join(feature, 'plan.md'), '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n');
  fs.writeFileSync(path.join(feature, 'decisions/register.json'), JSON.stringify({ version: 1, slug: 'readiness-records', nextId: 1, decisions: [] }));
  for (const [state, taskClass, code] of [
    ['', '', 'readiness-missing'], ['NEEDS_EVIDENCE', 'feature', 'readiness-not-ready'], ['READY', 'bug', 'readiness-wrong-template'],
  ]) {
    const readiness = path.join(repo.root, '.doflow/state/readiness/readiness-records.json');
    fs.rmSync(readiness, { force: true });
    if (state) {
      fs.mkdirSync(path.dirname(readiness), { recursive: true });
      fs.writeFileSync(readiness, JSON.stringify({ state, taskClass, evaluatedAt: '2026-01-01T00:00:00.000Z' }));
    }
    const result = runPolicy('pre-implementation-gate', JSON.stringify({
      doflow_event: { version: 1, operation: 'edit', paths: ['src/a.js'] },
    }), { decisionFd: true, cwd: repo.root, env: { DOFLOW_PROJECT_DIR: repo.root, HOME: scratch.path('readiness-home') } });
    assert.equal(result.status, 2, code);
    assert.equal(parseRecords(result.records).at(-1).code, code);
  }
});

test('decision fd records all hardcoded floor deny sites when patterns are missing', () => {
  const policyDir = scratch.path('floor-no-patterns');
  fs.mkdirSync(policyDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies/pre-bash-guard.sh'), path.join(policyDir, 'pre-bash-guard.sh'));
  fs.copyFileSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies/contract.sh'), path.join(policyDir, 'contract.sh'));
  fs.copyFileSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies/capture-failure.sh'), path.join(policyDir, 'capture-failure.sh'));
  for (const [command, expected] of [
    ['rm -rf /', 'catastrophic-rm-root'], ['rm -rf ~', 'catastrophic-rm-home'], ['rm -rf /etc', 'catastrophic-rm-system'],
  ]) {
    const result = runPolicy('pre-bash-guard', JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), {
      decisionFd: true, policyPath: path.join(policyDir, 'pre-bash-guard.sh'),
    });
    assert.equal(result.status, 2, command);
    assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
      ['allow', 'allow'], ['error', 'patterns-missing'], ['deny', expected],
    ], command);
  }
});

test('MCP deny, patterns-missing and mcp-policy-missing sites write records', () => {
  const policyDir = scratch.path('mcp-record-sites');
  fs.mkdirSync(policyDir, { recursive: true });
  for (const file of ['mcp-tool-guard.sh', 'contract.sh', 'capture-failure.sh']) {
    fs.copyFileSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies', file), path.join(policyDir, file));
  }
  const denyFixture = loadCorpus('mcp-tool-guard').find((row) => row.name === 'pattern-deny');
  fs.copyFileSync(path.join(__dirname, '../../test/fixtures/hooks/policy-golden/mcp-tool-guard/pattern-deny/mcp-policy.conf'), path.join(policyDir, 'mcp-policy.conf'));
  const baselinePolicyDir = scratch.path('baseline-mcp-patterns');
  fs.cpSync(path.join(baselineRoot, 'core/harnesses/shared/hooks/policies'), baselinePolicyDir, { recursive: true });
  fs.copyFileSync(path.join(policyDir, 'mcp-policy.conf'), path.join(baselinePolicyDir, 'mcp-policy.conf'));
  const denied = runPolicy('mcp-tool-guard', denyFixture.input, { decisionFd: true, policyPath: path.join(policyDir, 'mcp-tool-guard.sh') });
  const baselineDeny = runBaseline('mcp-tool-guard', denyFixture.input, { policyPath: path.join(baselinePolicyDir, 'mcp-tool-guard.sh') });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout, denyFixture.stdout);
  assert.equal(denied.stderr, denyFixture.stderr);
  assert.deepEqual(baselineDeny, { status: denyFixture.status, stdout: denyFixture.stdout, stderr: denyFixture.stderr });
  assert.deepEqual(parseRecords(denied.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['deny', 'blocked-pattern'],
  ]);
  fs.rmSync(path.join(policyDir, 'mcp-policy.conf'));
  const missing = runPolicy('mcp-tool-guard', denyFixture.input, { decisionFd: true, policyPath: path.join(policyDir, 'mcp-tool-guard.sh') });
  assert.equal(missing.status, 0);
  assert.deepEqual(parseRecords(missing.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['error', 'mcp-policy-missing'],
  ]);
});

test('v1 policy verdicts match v0 verdicts for every legacy fixture input', () => {
  for (const row of loadCorpus('pre-implementation-gate')) {
    const legacyResult = runPolicy('pre-implementation-gate', row.input);
    let native;
    try { native = JSON.parse(row.input); } catch { continue; }
    const v1 = { doflow_event: { version: 1, operation: 'edit', paths: [native.tool_input.file_path] } };
    const envelopeResult = runPolicy('pre-implementation-gate', JSON.stringify(v1));
    assert.equal(envelopeResult.status, legacyResult.status, row.name);
    assert.equal(envelopeResult.stdout, legacyResult.stdout, row.name);
    assert.equal(envelopeResult.stderr, legacyResult.stderr, row.name);
  }
  for (const row of loadCorpus('pre-bash-guard')) {
    let native;
    try { native = JSON.parse(row.input); } catch { continue; }
    const v1 = {
      doflow_event: {
        version: 1, operation: 'command', tool: native.tool_name,
        command: native.tool_input.command,
      },
    };
    const legacyResult = runPolicy('pre-bash-guard', row.input);
    const envelopeResult = runPolicy('pre-bash-guard', JSON.stringify(v1));
    assert.equal(envelopeResult.status, legacyResult.status, row.name);
    assert.equal(envelopeResult.stdout, legacyResult.stdout, row.name);
    assert.equal(envelopeResult.stderr, legacyResult.stderr, row.name);
  }
  for (const row of loadCorpus('mcp-tool-guard')) {
    let native;
    try { native = JSON.parse(row.input); } catch { continue; }
    const name = native.tool_name;
    const v1 = { doflow_event: { version: 1, operation: name.startsWith('mcp_') ? 'mcp' : 'tool', tool: name } };
    const legacyResult = runPolicy('mcp-tool-guard', row.input);
    const envelopeResult = runPolicy('mcp-tool-guard', JSON.stringify(v1));
    assert.equal(envelopeResult.status, legacyResult.status, row.name);
    assert.equal(envelopeResult.stdout, legacyResult.stdout, row.name);
    assert.equal(envelopeResult.stderr, legacyResult.stderr, row.name);
  }
});

test('v1 patch input uses the same path parser and gate decision as native apply_patch', () => {
  const repo = createScratchGitRepo(scratch, 'gate-v1-patch');
  repo.run('checkout', '-q', '-b', 'feat/patch-no-plan');
  fs.mkdirSync(path.join(repo.root, 'agent-docs/doflow/patch-no-plan'), { recursive: true });
  fs.writeFileSync(path.join(repo.root, 'agent-docs/doflow/patch-no-plan/requirement.md'), 'started\n');
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch';
  const env = { DOFLOW_PROJECT_DIR: repo.root, HOME: scratch.path('patch-home') };
  const native = runPolicy('pre-implementation-gate', JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: patch } }), { decisionFd: true, cwd: repo.root, env });
  const v1 = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { version: 1, operation: 'edit', patch } }), { decisionFd: true, cwd: repo.root, env });
  assert.equal(native.status, 2);
  assert.equal(v1.status, native.status);
  assert.equal(v1.stderr, native.stderr);
  assert.deepEqual(parseRecords(v1.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['deny', 'missing-artifacts'],
  ]);
});

test('v1 policies use envelope fields and unsupported versions do not evaluate native fields', () => {
  const cases = [];
  for (const version of [2, '1', null]) {
    cases.push(
      ['pre-implementation-gate', { doflow_event: { version, operation: 'edit' }, tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }],
      ['pre-bash-guard', { doflow_event: { version, operation: 'command', command: 'rm -rf /' }, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
      ['mcp-tool-guard', { doflow_event: { version, operation: 'mcp', tool: 'mcp__x__delete' }, tool_name: 'mcp__x__delete' }],
    );
  }
  for (const [policy, payload] of cases) {
    const result = runPolicy(policy, JSON.stringify(payload), { decisionFd: true });
    assert.equal(result.status, 0, policy);
    assert.equal(result.stdout, '', policy);
    assert.equal(result.stderr, '', policy);
    assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
      ['allow', 'allow'], ['unsupported', 'envelope-version'],
    ]);
  }
});

test('v1 edit without a target is diagnosed; v0 remains silent', () => {
  const v1 = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { version: 1, operation: 'edit' } }), { decisionFd: true });
  assert.equal(v1.status, 0);
  assert.deepEqual(parseRecords(v1.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['unsupported', 'edit-without-target'],
  ]);

  const v0 = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { operation: 'edit' } }), { decisionFd: true });
  assert.equal(v0.status, 0);
  assert.deepEqual(parseRecords(v0.records).map(({ outcome, code }) => [outcome, code]), [['allow', 'allow']]);
});

test('all three policies remain safe when sourced under set -euo pipefail', () => {
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const script = `set -euo pipefail\nINPUT='{}'\nsource "${path.resolve(__dirname, '../../core/harnesses/shared/hooks/policies/contract.sh')}"\ndoflow_decision_init ${policy} 1\ndoflow_read_envelope\n`;
    const result = require('node:child_process').spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${policy}: ${result.stderr}`);
  }
});

test('jq missing records a fault and keeps today’s allow result', () => {
  const bin = scratch.path('no-jq-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync('/bin/bash', path.join(bin, 'bash'));
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const result = runPolicy(policy, '{}', {
      decisionFd: true,
      env: { PATH: bin },
    });
    assert.equal(result.status, 0, policy);
    assert.equal(result.stdout, '', policy);
    assert.equal(result.stderr, '', policy);
    assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
      ['allow', 'allow'], ['error', 'dependency-missing:jq'],
    ]);
  }
});

test('contract missing keeps 0fcd973 bytes and records contract-missing for every policy', () => {
  const cases = [
    ['pre-implementation-gate', 'native-read'],
    ['pre-bash-guard', 'native-safe-command'],
    ['mcp-tool-guard', 'native-mcp-allow'],
  ];
  for (const [policy, fixture] of cases) {
    const policyDir = scratch.path(`missing-contract/${policy}`);
    fs.mkdirSync(path.dirname(policyDir), { recursive: true });
    fs.cpSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies'), policyDir, { recursive: true });
    fs.rmSync(path.join(policyDir, 'contract.sh'));
    const row = loadCorpus(policy).find((item) => item.name === fixture);
    const failureRoot = scratch.path(`missing-contract/${policy}/failures`);
    const result = runPolicy(policy, row.input, {
      policyPath: path.join(policyDir, `${policy}.sh`),
      env: { XDG_CONFIG_HOME: failureRoot, DOFLOW_FAILURE_CAPTURE: '' },
    });
    assert.equal(result.status, row.status, `${policy} exit`);
    assert.equal(result.stdout, row.stdout, `${policy} stdout`);
    assert.equal(result.stderr, row.stderr, `${policy} stderr`);
    const events = JSON.parse(fs.readFileSync(path.join(failureRoot, 'doflow/failures/events.jsonl'), 'utf8').trim());
    assert.deepEqual([events.command, events.kind], [policy, 'contract-missing']);
  }
});
