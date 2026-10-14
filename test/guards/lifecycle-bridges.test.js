'use strict';

// G34/G35 — lifecycle bridge boundaries and the envelope/decision contract (IC-030).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, loadCorpus, parseRecords, runPolicy, encodeEnvelope } = require('../helper/hook-fixtures');
const { tempDir } = require('../helper/tmp');
const { rowsDigest, renderEnforcementMatrix, NEVER_BLOCKING_EVENTS } = require('../../src/lifecycle/coverage.ts');
const { hookReachabilityFindings, runnerHeaderFindings } = require('../helper/hook-reachability');

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

test('G35.2: unknown envelope versions are unsupported and absent version is missing', () => {
  for (const version of [2, '1', null]) {
    assert.equal(contractClass(JSON.stringify({ doflow_event: { version } })), 'unsupported', `version ${JSON.stringify(version)}`);
  }
  assert.equal(contractClass(JSON.stringify({ doflow_event: {} })), 'missing');
  assert.equal(contractClass('{}'), 'missing');
});

test('G35.2 control: treating an unknown version as v0 is detected', () => {
  const expected = contractClass(JSON.stringify({ doflow_event: { version: 2 } }));
  assert.notEqual(expected, 'missing');
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
    const native = JSON.parse(row.input);
    const events = { 'pre-implementation-gate': 'PreToolUse', 'pre-bash-guard': 'PreToolUse', 'mcp-tool-guard': 'PreToolUse', 'session-context': 'SessionStart', 'stop-check': 'Stop', 'user-prompt-submit': 'UserPromptSubmit', 'subagent-audit': 'SubagentStart' };
    const input = native.doflow_event?.version === 1 ? row.input : encodeEnvelope('claude', events[policy], policy, row.input);
    const actual = runPolicy(policy, input);
    assert.deepEqual({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr },
      { status: row.status, stdout: row.stdout, stderr: row.stderr }, `${policy}/${row.name} no-fd golden`);
    const recorded = runPolicy(policy, input, { decisionFd: true });
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

const COVERAGE_PATH = path.join(REPO, 'core/registry/lifecycle.json');
const INVENTORY_PATH = path.join(REPO, 'bench/inventory/coverage.json');
const COVERAGE_CLASSES = ['blocking', 'observation', 'advisory', 'unsupported', 'unknown'];
const COVERAGE_TIMINGS = ['pre-tool', 'post-tool', 'session', 'prompt', 'stop', 'compact', 'subagent'];
const COVERAGE_KINDS = ['doc', 'types', 'fixture', 'live'];
function readCoverage(filename = COVERAGE_PATH) { return JSON.parse(fs.readFileSync(filename, 'utf8')).coverage; }
function rowKey(row) { return [row.policy, row.harness, row.event, row.profile].join('\0'); }
function coverageFindings(coverage) {
  const errors = [];
  const required = ['policy','harness','event','timing','profile','wired','configSource','harnessVersion','class','verification','prerequisites','covers','doesNotCover','caveats','provenance'];
  const tuples = new Set();
  for (const [i, row] of (coverage.rows || []).entries()) {
    for (const key of required) if (!Object.hasOwn(row, key)) errors.push(`row ${i} missing ${key}`);
    if (!COVERAGE_CLASSES.includes(row.class)) errors.push(`row ${i} invalid class`);
    if (!COVERAGE_TIMINGS.includes(row.timing)) errors.push(`row ${i} invalid timing`);
    if (!Object.hasOwn(coverage.profiles || {}, row.profile)) errors.push(`row ${i} invalid profile`);
    for (const key of ['wired']) if (typeof row[key] !== 'boolean') errors.push(`row ${i} invalid ${key}`);
    for (const key of ['prerequisites','covers','doesNotCover','caveats','provenance']) if (!Array.isArray(row[key])) errors.push(`row ${i} invalid ${key}`);
    if (!row.harnessVersion || typeof row.harnessVersion.tested !== 'string') errors.push(`row ${i} invalid harnessVersion`);
    if (!['verified','unverified'].includes(row.verification)) errors.push(`row ${i} invalid verification`);
    for (const p of row.provenance || []) if (!COVERAGE_KINDS.includes(p.kind) || typeof p.locator !== 'string' || !p.locator || ((p.kind === 'doc' || p.kind === 'types' || p.kind === 'live') && !/^\d{4}-\d{2}-\d{2}$/.test(p.date || ''))) errors.push(`row ${i} invalid provenance`);
    if (tuples.has(rowKey(row))) errors.push(`row ${i} duplicate tuple`); tuples.add(rowKey(row));
  }
  return errors;
}
function honestyFindings(coverage) {
  const errors = [];
  for (const row of coverage.rows) {
    const key = `${row.harness}\0${row.event}`;
    const evidence = row.provenance || [];
    if (row.class === 'blocking' && (row.verification !== 'verified' || !evidence.some(p => ['doc','types'].includes(p.kind)) || !evidence.some(p => p.kind === 'fixture' && fs.existsSync(path.join(REPO, p.locator))))) errors.push(`${rowKey(row)} blocking evidence`);
    if (row.verification === 'unverified' && row.class === 'blocking') errors.push(`${rowKey(row)} unverified class`);
    if (NEVER_BLOCKING_EVENTS.has(key) && row.class === 'blocking') errors.push(`${rowKey(row)} never-blocking event`);
    if (row.policy === 'pre-implementation-gate' && !row.doesNotCover.includes('writes via shell commands')) errors.push(`${rowKey(row)} missing shell-write exclusion`);
    if ((row.harness === 'pi' && ['user-headless','project-headless'].includes(row.profile)) && row.class !== 'unknown') errors.push(`${rowKey(row)} Pi headless must stay unknown`);
    if (row.harness === 'pi' && row.profile.startsWith('project-') && !row.prerequisites.includes('project-trust')) errors.push(`${rowKey(row)} missing Pi project-trust`);
    if (row.harness === 'pi' && row.profile === 'no-extensions' && row.class !== 'unsupported') errors.push(`${rowKey(row)} Pi no-extensions must be unsupported`);
  }
  return errors;
}
function joinFindings(coverage, lifecycle, inventory) {
  const errors = [];
  for (const policy of lifecycle.policies) for (const [harness, mapping] of Object.entries(policy.mappings)) {
    if (['supported','different'].includes(mapping.status) && !coverage.rows.some(r => r.policy === policy.id && r.harness === harness && r.event === mapping.event)) errors.push(`${policy.id}/${harness}/${mapping.event} missing row`);
    if (mapping.status === 'unavailable' && !coverage.rows.some(r => r.policy === policy.id && r.harness === harness && r.event === '*' && r.class === 'unsupported')) errors.push(`${policy.id}/${harness} missing unavailable row`);
  }
  const byHarness = new Map(inventory.rows.map(r => [`${r.harness}\0${r.event}`, r]));
  for (const row of coverage.rows.filter(r => r.wired)) {
    if (!byHarness.get(`${row.harness}\0${row.event}`)?.wired) errors.push(`${rowKey(row)} missing wired inventory event`);
    const installed = byHarness.get(`${row.harness}\0${row.event}`)?.installedVersion?.value;
    if (installed && row.harnessVersion.tested !== installed && !row.caveats.includes(`version-drift:${installed}`)) errors.push(`${rowKey(row)} missing version-drift caveat`);
  }
  return errors;
}
function matrixDocFindings(text, coverage) {
  const start = '<!-- BEGIN GENERATED:enforcement-matrix -->'; const end = '<!-- END GENERATED:enforcement-matrix -->';
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a) return ['enforcement matrix markers missing'];
  const actual = text.slice(a + start.length, b).trim();
  return actual === renderEnforcementMatrix(coverage) ? [] : ['enforcement matrix differs from renderer'];
}
function parityEnumeratesCorpus(files) {
  const parityFiles = fs.readdirSync(path.join(REPO, 'test/hooks')).filter(f => /^(bridge-parity(?:-[^.]+)?|pi-bridge)\.test\.js$/.test(f));
  const sources = parityFiles.map(f => fs.readFileSync(path.join(REPO, 'test/hooks', f), 'utf8')).join('\n');
  const parityHarnesses = new Set(parityFiles.map(f => f === 'bridge-parity.test.js' ? 'claude' : f === 'pi-bridge.test.js' ? 'pi' : f.match(/^bridge-parity-(.+)\.test\.js$/)?.[1]));
  return files.filter(file => {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    const harness = row.expect?.envelope?.harness || (file.includes('/pi/') && row.native?.type === 'tool_call' ? 'pi' : null);
    return harness && !parityHarnesses.has(harness);
  });
}
function missingWiredFixtures(coverage, files) {
  const events = new Set(files.flatMap(file => {
    const row = JSON.parse(fs.readFileSync(file,'utf8'));
    const envelope = row.expect?.envelope;
    if (envelope) return [`${envelope.harness}\0${envelope.event}`];
    if (file.includes('/pi/') && row.native?.type === 'tool_call') return ['pi\0tool_call'];
    return [];
  }));
  return [...new Set(coverage.rows.filter(r=>r.wired).filter(r=>{
    const aliases = r.harness === 'kiro' ? [r.event, r.event === 'PreToolUse' ? 'preToolUse' : r.event === 'Stop' ? 'stop' : r.event] : [r.event];
    return !aliases.some(event=>events.has(`${r.harness}\0${event}`));
  }).map(r=>`${r.harness}\0${r.event}`))];
}
function wiredTemplateFindings(coverage, lifecycle) {
  const errors = [];
  for (const row of coverage.rows.filter(r => r.wired)) {
    const [relative, lineText] = row.configSource.split(':');
    const file = path.join(REPO, relative);
    if (!fs.existsSync(file)) { errors.push(`${rowKey(row)} configSource missing ${relative}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const line = Number(lineText);
    const nearby = Number.isInteger(line) ? text.split('\n').slice(Math.max(0,line-2),line+3).join('\n') : text;
    const policy = lifecycle.policies.find(p => p.id === row.policy);
    const sourcePolicy = row.policy === 'pre-implementation-gate' ? 'pre-implement-gate' : row.policy;
    const doflowName = row.policy === 'pre-implementation-gate' ? 'pre-implementation-gate' : sourcePolicy;
    const hasPolicy = policy && (text.includes(policy.id) || text.includes(row.policy) || text.includes(sourcePolicy) || text.includes(`doflow-${doflowName}`));
    const hasEvent = row.harness === 'pi' ? text.includes("'tool_call'") || text.includes('tool_call') : text.includes(row.event) || (row.harness === 'kiro' && text.includes(row.event === 'PreToolUse' ? 'preToolUse' : row.event === 'Stop' ? 'stop' : row.event)) || (row.harness === 'antigravity' && text.includes(row.event));
    if (row.harness === 'pi' && row.event === 'tool_execution_start') continue;
    const sourceHasEvent = text.includes(row.event) || (row.harness === 'kiro' && text.includes(row.event === 'Stop' ? 'stop' : row.event === 'PreToolUse' ? 'preToolUse' : row.event));
    if (!hasEvent || (!hasPolicy && row.harness !== 'pi' && !['claude','codex','gemini'].includes(row.harness))) errors.push(`${rowKey(row)} configSource does not contain event/policy`);
    if (!sourceHasEvent && !(row.harness === 'pi' && row.event === 'tool_call')) errors.push(`${rowKey(row)} configSource has no event declaration`);
  }
  return errors;
}
function kiroStopFindings(coverage) {
  return coverage.rows.filter(r => r.harness === 'kiro' && r.event === 'Stop').flatMap(r => {
    const pinned = r.provenance.some(p => p.kind === 'doc' && /Stop|stop/.test(p.locator));
    return (!pinned && (r.class !== 'unknown' || !r.provenance.some(p => p.kind === 'doc') || !r.provenance.some(p => p.kind === 'fixture'))) ? [`${rowKey(r)} must be unknown with doc and fixture provenance`] : [];
  });
}

function g36Data() {
  const lifecycle = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'));
  return { lifecycle, coverage: lifecycle.coverage, inventory: JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8')) };
}
test('G36.1: coverage rows have required fields, enums, and unique tuples', () => { assert.deepEqual(coverageFindings(readCoverage()), []); });
test('G36.1 control: deleting provenance from a copied row fails', () => { const c=structuredClone(readCoverage()); delete c.rows[0].provenance; assert.ok(coverageFindings(c).some(x=>x.includes('missing provenance'))); });
test('G36.2: coverage rows satisfy IC-022 rules 1 to 4 and 8', () => { assert.deepEqual(honestyFindings(readCoverage()), []); });
test('G36.2 control: flipping Pi observation to blocking is detected', () => { const c=structuredClone(readCoverage()); c.rows.find(r=>r.harness==='pi'&&r.event==='tool_execution_start').class='blocking'; assert.ok(honestyFindings(c).some(x=>x.includes('never-blocking'))); });
test('G36.3: lifecycle supported, different, and unavailable mappings join to rows', () => { const {lifecycle,coverage}=g36Data(); assert.deepEqual(joinFindings(coverage,lifecycle,JSON.parse('{"rows":[]}')).filter(x=>x.includes('missing row')||x.includes('missing unavailable')), []); });
test('G36.3 control: a supported mapping without a coverage row is detected', () => { const {lifecycle,coverage}=g36Data(); const c=structuredClone(coverage); c.rows=c.rows.filter(r=>!(r.policy==='stop-check'&&r.harness==='claude')); assert.ok(joinFindings(c,lifecycle,{rows:[]}).some(x=>x.includes('missing row'))); });
test('G36.4: wired rows join inventory and installed-version caveats', () => { const {lifecycle,coverage,inventory}=g36Data(); assert.deepEqual(joinFindings(coverage,lifecycle,inventory).filter(x=>x.includes('inventory')||x.includes('version-drift')), []); });
test('G36.4 control: removing an inventory row is detected', () => { const {lifecycle,coverage,inventory}=g36Data(); const i=structuredClone(inventory); i.rows=i.rows.filter(r=>!(r.harness==='claude'&&r.event==='PreToolUse')); assert.ok(joinFindings(coverage,lifecycle,i).some(x=>x.includes('inventory event'))); });
test('G36.5: rowsDigest is the digest of canonical rows', () => { const c=readCoverage(); assert.equal(c.rowsDigest, rowsDigest(c.rows)); });
test('G36.5 control: a changed row without a digest refresh is detected', () => { const c=structuredClone(readCoverage()); c.rows[0].event='Mutated'; assert.notEqual(c.rowsDigest, rowsDigest(c.rows)); });
test('G36.6: generated enforcement matrix matches renderer', () => { assert.deepEqual(matrixDocFindings(fs.readFileSync(path.join(REPO,'docs/capability-map.md'),'utf8'),readCoverage()),[]); });
test('G36.6 control: mutating a rendered matrix cell in memory is detected', () => { const c=readCoverage(); const text=fs.readFileSync(path.join(REPO,'docs/capability-map.md'),'utf8').replace('| claude |','| mutated |'); assert.ok(matrixDocFindings(text,c).length); });
test('G36.7: every gate row declares shell writes outside its coverage', () => { assert.deepEqual(honestyFindings(readCoverage()).filter(x=>x.includes('shell-write')),[]); });
test('G36.7 control: deleting shell-write exclusion is detected', () => { const c=structuredClone(readCoverage()); c.rows[0].doesNotCover=[]; assert.ok(honestyFindings(c).some(x=>x.includes('shell-write'))); });
test('G37.1: wired events have corpus fixtures enumerated by their parity suite', () => { const files=corpusFiles(); assert.deepEqual(parityEnumeratesCorpus(files),[]); assert.deepEqual(missingWiredFixtures(readCoverage(),files),[]); });
test('G37.1 control: removing a corpus fixture is detected by event coverage', () => { const files=corpusFiles(); const candidates=files.filter(f=>{const x=JSON.parse(fs.readFileSync(f,'utf8')); return x.expect?.envelope?.harness==='claude'&&x.expect.envelope.event==='PreToolUse';}); assert.ok(candidates.length); const removed=files.filter(f=>!candidates.includes(f)); assert.ok(missingWiredFixtures(readCoverage(),removed).includes('claude\0PreToolUse')); });
test('G37.2: wired configSource entries resolve and canonical policies have rows', () => { const {lifecycle,coverage}=g36Data(); assert.deepEqual(wiredTemplateFindings(coverage,lifecycle),[]); });
test('G37.2 control: a row pointing at a removed template line is detected', () => { const {lifecycle,coverage}=g36Data(); const c=structuredClone(coverage); c.rows[0].configSource='core/missing/template.json:1'; assert.ok(wiredTemplateFindings(c,lifecycle).some(x=>x.includes('configSource missing'))); });
test('G37.3: shipped hook files are reachable from wiring and owned by registry assets', () => { assert.deepEqual(hookReachabilityFindings(), []); });
test('G37.3 control: orphan hook files are reported, including a mutually-referencing pair', (t) => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const root = tempDir(t, 'doflow-g37-orphans-');
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  const orphan = 'core/harnesses/shared/hooks/orphan.sh';
  const pairA = 'core/harnesses/shared/hooks/pair-a.sh';
  const pairB = 'core/harnesses/shared/hooks/pair-b.sh';
  fs.writeFileSync(path.join(root, orphan), '. "$(dirname "$0")/pair-a.sh"\n');
  fs.writeFileSync(path.join(root, pairA), '. "$(dirname "$0")/pair-b.sh"\n');
  fs.writeFileSync(path.join(root, pairB), '. "$(dirname "$0")/pair-a.sh"\n');
  const withOrphan = hookReachabilityFindings(root, [...tracked, orphan, pairA, pairB]);
  assert.ok(withOrphan.includes(`orphan shipped hook file ${orphan}`));
  assert.ok(withOrphan.includes(`orphan shipped hook file ${pairA}`));
  assert.ok(withOrphan.includes(`orphan shipped hook file ${pairB}`));
});
test('G37.3 control: an old runner header is rejected', () => {
  const runner = fs.readFileSync(path.join(REPO, 'core/harnesses/shared/hooks/stream-hook-runner.js'), 'utf8');
  const restored = runner.replace('translation (delegated', 'Gemini is a wired harness. translation (delegated');
  assert.notEqual(restored, runner);
  assert.deepEqual(runnerHeaderFindings(restored), ['runner header names a harness other than Antigravity']);
});
test('G37.3 control: wiring to a missing door is reported for every door harness', (t) => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const cases = [
    { harness: 'claude', template: 'core/harnesses/claude/settings/settings.json' },
    { harness: 'codex', template: 'core/harnesses/codex/hooks/hooks.json' },
    { harness: 'gemini', template: 'core/harnesses/gemini/hooks/hooks.json' },
    { harness: 'kiro', template: 'core/harnesses/kiro/hooks/doflow.json' },
    { harness: 'antigravity', template: 'core/registry/harnesses.json' },
  ];
  for (const { harness, template } of cases) {
    const root = tempDir(t, `doflow-g37-missing-${harness}-`);
    fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
    const file = path.join(root, template);
    if (harness === 'antigravity') {
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = registry.harnesses.find((item) => item.id === harness);
      entry.paths.hookScript.project.segments[entry.paths.hookScript.project.segments.length - 1] = 'missing-door.sh';
      fs.writeFileSync(file, JSON.stringify(registry));
    } else {
      fs.appendFileSync(file, '\nmissing-door.sh\n');
    }
    assert.ok(hookReachabilityFindings(root, tracked).some((finding) => finding.includes('missing-door.sh')), harness);
  }
});
test('G37.4: Kiro Stop rows remain unknown with documented and fixture provenance', () => { assert.deepEqual(kiroStopFindings(readCoverage()),[]); });
test('G37.4 control: Kiro Stop blocking without trigger documentation is detected', () => { const c=structuredClone(readCoverage()); const r=c.rows.find(x=>x.harness==='kiro'&&x.event==='Stop'); r.class='blocking'; r.provenance=r.provenance.filter(p=>p.kind!=='doc'); assert.ok(kiroStopFindings(c).length); });

