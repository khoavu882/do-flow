'use strict';

// G34/G35 — lifecycle bridge boundaries and the envelope/decision contract (IC-030).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, loadCorpus, parseRecords, runPolicy } = require('../helper/hook-fixtures');
const { tempDir } = require('../helper/tmp');

const POLICY_DIR = path.join(REPO, 'core/harnesses/shared/hooks/policies');
const BRIDGE_DIR = path.join(REPO, 'core/harnesses/shared/hooks/bridge');
const POLICIES = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-context', 'stop-check', 'user-prompt-submit', 'subagent-audit'];
const BLOCKING = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check'];
const TOKENS = [
  'requirement.md', 'design.md', 'plan.md', '.doflow/state', 'blocked-patterns', 'mcp-policy.conf',
  'claude -p', 'codex exec', 'gemini -p', 'pi -p', 'kiro-cli chat', 'additionalContext',
];

function walkFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function bridgeFiles() {
  const files = walkFiles(path.join(REPO, 'core/harnesses'));
  return files.filter((file) => {
    const rel = path.relative(path.join(REPO, 'core/harnesses'), file).split(path.sep).join('/');
    if (rel.startsWith('shared/hooks/bridge/')) return true;
    if (rel === 'shared/hooks/stream-hook-runner.js' || rel === 'shared/hooks/adapters/antigravity.js' || rel === 'pi/extensions/doflow-guard.js') return true;
    if (/^(claude|codex|gemini|kiro)\/hooks\/.*\.sh$/.test(rel)) return fs.readFileSync(file, 'utf8').includes('doflow_bridge');
    return false;
  });
}

function boundaryFindings(files) {
  const findings = [];
  for (const [file, text] of files) {
    for (const token of TOKENS) if (text.includes(token)) findings.push(`${file}: forbidden policy or agent token ${token}`);
    if (/\bevent\.input\s*=/.test(text)) findings.push(`${file}: assignment to event.input`);
    if (/\.(?:sh|bash)$/.test(file) && /(?:^|[;&|()\s])node(?:\s|$)/m.test(text)) findings.push(`${file}: node call from bash`);
  }
  return findings;
}

function corpusFiles() {
  return walkFiles(path.join(REPO, 'test/fixtures/hooks')).filter((file) => {
    const relative = path.relative(path.join(REPO, 'test/fixtures/hooks'), file).split(path.sep).join('/');
    return file.endsWith('.json') && !relative.startsWith('policy-golden/');
  });
}

function bridgeInput(harness, native, fixtureEnv = {}) {
  if (harness !== 'kiro') return JSON.stringify(native);
  const translated = spawnSync('/bin/bash', ['-c', `. '${path.join(REPO, 'core/harnesses/kiro/hooks/lib.sh')}'; kiro_bridge_payload`], {
    input: JSON.stringify(native), encoding: 'utf8', env: { ...process.env, ...fixtureEnv },
  });
  assert.equal(translated.status, 0, translated.stderr);
  return translated.stdout;
}

function encodeFixture(harness, event, policy, native, envelopePath = path.join(BRIDGE_DIR, 'envelope.jq'), fixtureEnv = {}) {
  const result = spawnSync('jq', ['-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', policy, '-f', envelopePath], {
    input: bridgeInput(harness, native, fixtureEnv), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).doflow_event;
}

function contractClass(input) {
  const result = spawnSync('/bin/bash', ['-c', `. '${path.join(POLICY_DIR, 'contract.sh')}'; INPUT=$(cat); doflow_read_envelope; printf '%s' "$DF_ENV_CLASS"`], {
    input, encoding: 'utf8', env: { ...process.env, DOFLOW_DECISION_FD: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function syntaxErrorTree(root, syntaxError = true) {
  const tree = path.join(root, 'tree');
  fs.mkdirSync(path.join(tree, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'policies'), { recursive: true });
  for (const file of ['bridge.sh', 'envelope.jq', 'respond.sh']) fs.copyFileSync(path.join(BRIDGE_DIR, file), path.join(tree, 'bridge', file));
  for (const file of ['deny-json.sh', 'capture-failure.sh']) fs.copyFileSync(path.join(POLICY_DIR, file), path.join(tree, 'policies', file));
  for (const policy of POLICIES) fs.writeFileSync(path.join(tree, 'policies', `${policy}.sh`), policy === 'pre-implementation-gate' && syntaxError ? 'if then\n' : '#!/bin/bash\nexit 0\n');
  return tree;
}

function bridgeRun(tree, harness, event, policy) {
  return spawnSync('bash', [path.join(tree, 'bridge/bridge.sh'), harness, event, policy, '--emit', 'native'], {
    cwd: tree, encoding: 'utf8', input: '{}', env: { ...process.env, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_DECISION_FD: '' },
  });
}

test('G34.1: lifecycle bridge files contain no policy logic, agent spawn, injected context, bash Node call or Pi input mutation', () => {
  const files = bridgeFiles().map((file) => [path.relative(REPO, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')]);
  assert.ok(files.length > 10, `expected bridge files, found ${files.length}`);
  assert.deepEqual(boundaryFindings(files), []);
});

test('G34.1 control: each seeded forbidden token is reported with its file', (t) => {
  const root = tempDir(t, 'doflow-g34-boundary-control-');
  const seeded = TOKENS.map((token, index) => [`bridge-${index}.js`, `const x = ${JSON.stringify(token)};`]);
  seeded.push(['pi.js', 'event.input = next;'], ['door.sh', 'node helper.js']);
  for (const [file, contents] of seeded) fs.writeFileSync(path.join(root, file), contents);
  const findings = boundaryFindings(walkFiles(root).map((file) => [path.relative(root, file), fs.readFileSync(file, 'utf8')]));
  assert.equal(findings.length, seeded.length);
  for (const [file] of seeded) assert.ok(findings.some((finding) => finding.startsWith(`${file}:`)), file);
});

function architectureFindings(text) {
  const section = text.split('## Lifecycle bridges\n')[1]?.split('\n## ')[0] || '';
  const required = [
    'Install adapter', 'Lifecycle bridge', 'Harness execution adapter',
    'Decide a policy outcome', 'Hold policy rules', '081 defines and builds it', '077 assigns it no implementation obligation',
  ];
  return required.filter((part) => !section.includes(part));
}

test('G34.2: architecture documents the three responsibilities and 081 ownership boundary', () => {
  const text = fs.readFileSync(path.join(REPO, 'docs/architecture.md'), 'utf8');
  assert.deepEqual(architectureFindings(text), []);
});

test('G34.2 control: removing the 081 ownership line is detected in memory', () => {
  const text = fs.readFileSync(path.join(REPO, 'docs/architecture.md'), 'utf8');
  const mutated = text.replace('077 assigns it no implementation obligation', '077 owns the harness execution adapter');
  assert.ok(architectureFindings(mutated).includes('077 assigns it no implementation obligation'));
});

test('G35.1: envelope.jq reproduces every corpus case expected envelope', () => {
  let checked = 0;
  for (const file of corpusFiles()) {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = fixture.expect?.envelope;
    if (!expected || !fixture.native) continue;
    const harness = expected.harness;
    const event = expected.event;
    const policy = fixture.policy || fixture.expect?.decision?.policy || 'session-context';
    const actual = encodeFixture(harness, event, policy, fixture.native, path.join(BRIDGE_DIR, 'envelope.jq'), fixture.env);
    assert.deepEqual(actual, expected, path.relative(REPO, file));
    checked += 1;
  }
  assert.ok(checked >= 20, `expected corpus envelope cases, found ${checked}`);
});

test('G35.1 control: reverting the production version encoder line fails against the corpus', (t) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/hooks/claude/mcp-tool-guard/deny.json'), 'utf8'));
  const expected = fixture.expect.envelope;
  const source = fs.readFileSync(path.join(BRIDGE_DIR, 'envelope.jq'), 'utf8');
  const reverted = source.replace('{version:1,harness:$harness', '{harness:$harness');
  assert.notEqual(reverted, source, 'the production version field line exists');
  const root = tempDir(t, 'doflow-g35-version-revert-');
  const candidate = path.join(root, 'envelope.jq');
  fs.writeFileSync(candidate, reverted);
  const actual = encodeFixture(expected.harness, expected.event, fixture.policy || 'mcp-tool-guard', fixture.native, candidate);
  assert.throws(() => assert.deepEqual(actual, expected));
});

test('G35.2: unknown envelope versions are unsupported and absent version remains v0', () => {
  for (const version of [2, '1', null]) {
    assert.equal(contractClass(JSON.stringify({ doflow_event: { version } })), 'unsupported', `version ${JSON.stringify(version)}`);
  }
  assert.equal(contractClass(JSON.stringify({ doflow_event: {} })), 'v0');
  assert.equal(contractClass('{}'), 'v0');
});

test('G35.2 control: treating an unknown version as v0 is detected', () => {
  const expected = contractClass(JSON.stringify({ doflow_event: { version: 2 } }));
  assert.notEqual(expected, 'v0');
});

function policyHasDenyBeforeEveryExit(text) {
  const lines = text.split('\n');
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*exit\s+2\b/.test(lines[i])) {
      let found = false;
      for (let j = i - 1; j >= Math.max(0, i - 4); j -= 1) {
        if (/doflow_decide\s+deny\b/.test(lines[j])) { found = true; break; }
        if (/\b(exit|fi|else)\b/.test(lines[j])) break;
      }
      if (!found) failures.push(`line ${i + 1}: exit 2 has no preceding doflow_decide deny`);
    }
  }
  return failures;
}

test('G35.3: canonical policy no-fd bytes match committed 0fcd973 goldens and recorded policies start with provisional allow', () => {
  for (const policy of POLICIES) {
    let row;
    const root = path.join(REPO, 'test/fixtures/hooks/policy-golden', policy);
    const corpus = ['session-context', 'stop-check', 'user-prompt-submit', 'subagent-audit'].includes(policy)
      ? [] : loadCorpus(policy);
    if (corpus.length > 0) {
      const preferred = {
        'pre-implementation-gate': 'native-read', 'pre-bash-guard': 'native-safe-command',
        'mcp-tool-guard': 'native-builtin-allow', 'stop-check': 'default-allow',
      }[policy];
      row = corpus.find((item) => item.name === preferred) || corpus[0];
    } else {
      const expected = JSON.parse(fs.readFileSync(path.join(root, 'golden.json'), 'utf8'));
      row = { name: 'golden', input: fs.readFileSync(path.join(root, 'input.json'), 'utf8'), ...expected };
    }
    assert.ok(row, `${policy}: golden corpus exists`);
    const actual = runPolicy(policy, row.input);
    assert.deepEqual({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr },
      { status: row.status, stdout: row.stdout, stderr: row.stderr }, `${policy}/${row.name} no-fd golden`);
    const recorded = runPolicy(policy, row.input, { decisionFd: true });
    const records = parseRecords(recorded.records);
    assert.deepEqual(records[0], { v: 1, policy, policyVersion: 1, outcome: 'allow', code: 'allow' }, `${policy} provisional allow first`);
    assert.deepEqual(policyHasDenyBeforeEveryExit(fs.readFileSync(path.join(POLICY_DIR, `${policy}.sh`), 'utf8')), [], `${policy} deny sites`);
  }
});

test('G35.3 control: a temporary policy that writes fd 3 unconditionally breaks the no-fd golden assertion', (t) => {
  const root = tempDir(t, 'doflow-g35-unconditional-fd-');
  const policyPath = path.join(root, 'session-context.sh');
  fs.writeFileSync(policyPath, '#!/bin/bash\nprintf "record\\n" >&3\nexit 0\n');
  const actual = runPolicy('session-context', '{}', { policyPath });
  assert.notDeepEqual({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr },
    { status: 0, stdout: '', stderr: '' }, 'the unconditional fd writer breaks the no-fd golden assertion');
});

test('G35.4: unmarked syntax errors block on every blocking bridge with the fixed reason', (t) => {
  const root = tempDir(t, 'doflow-g35-exit-two-');
  const tree = syntaxErrorTree(root);
  const cases = [
    ['claude', 'PreToolUse'], ['codex', 'PreToolUse'], ['gemini', 'BeforeTool'], ['kiro', 'PreToolUse'],
    ['antigravity', 'PreToolUse'], ['antigravity', 'Stop'], ['pi', 'tool_call'], ['claude', 'Stop'], ['codex', 'Stop'], ['kiro', 'Stop'],
  ];
  for (const [harness, event] of cases) {
    const result = bridgeRun(tree, harness, event, 'pre-implementation-gate');
    const fixed = '[pre-implementation-gate] DoFlow policy error; details: doflow-run failure list';
    assert.ok((result.stdout + result.stderr).includes(fixed), `${harness}:${event} renders fixed reason`);
    assert.equal((result.stdout + result.stderr).includes('syntax error'), false, `${harness}:${event} hides parser diagnostic`);
  }
});

test('G35.4 control: removing the exit-2-unmarked classification rule is detected', () => {
  const text = fs.readFileSync(path.join(BRIDGE_DIR, 'bridge.sh'), 'utf8');
  assert.match(text, /DF_BRIDGE_CODE=exit-2-unmarked/);
  const mutated = text.replace(/DF_BRIDGE_CODE=exit-2-unmarked/g, 'DF_BRIDGE_CODE=exit-1-unmarked');
  assert.doesNotMatch(mutated, /DF_BRIDGE_CODE=exit-2-unmarked/);
});

test('G35.5: every exit 2 in every canonical policy is preceded by doflow_decide deny', () => {
  for (const policy of POLICIES) {
    assert.deepEqual(policyHasDenyBeforeEveryExit(fs.readFileSync(path.join(POLICY_DIR, `${policy}.sh`), 'utf8')), [], policy);
  }
});

test('G35.5 control: removing one deny record call identifies the unrecorded exit', () => {
  const text = fs.readFileSync(path.join(POLICY_DIR, 'stop-check.sh'), 'utf8');
  const mutated = text.replace('doflow_decide deny unfinished-work', '# reverted call');
  assert.ok(policyHasDenyBeforeEveryExit(mutated).length > 0);
});

function migrationFindings(text) {
  const pi = text.split('Pi')[1] || '';
  const relevant = pi.split('\n## ')[0];
  return [
    !/`tool_call`/.test(relevant) && !/\btool_call\b/.test(relevant) ? 'Pi is not anchored on tool_call' : null,
    !/envelope version 1|version 1 under `doflow_event`/i.test(text) ? 'envelope version 1 is not documented' : null,
  ].filter(Boolean);
}

test('G35.6: migration guide anchors Pi on tool_call and documents envelope version 1', () => {
  const text = fs.readFileSync(path.join(REPO, 'core/harnesses/shared/hooks/ENVELOPE_MIGRATION.md'), 'utf8');
  assert.deepEqual(migrationFindings(text), []);
});

test('G35.6 control: restoring the old Pi migration sentence is detected in memory', () => {
  const text = fs.readFileSync(path.join(REPO, 'core/harnesses/shared/hooks/ENVELOPE_MIGRATION.md'), 'utf8');
  const mutated = text.replace(/tool_call/g, 'tool_execution_start');
  assert.ok(migrationFindings(mutated).includes('Pi is not anchored on tool_call'));
});

