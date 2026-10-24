'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, createScratchGitRepo, encodeEnvelope } = require('../helper/hook-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');
const FIXTURE_ROOT = path.join(REPO, 'test/fixtures/hooks');

const POLICIES = new Set([
  'pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'session-context',
  'stop-check', 'user-prompt-submit', 'subagent-audit',
]);
const STEM_POLICY = {
  'pre-implement-gate': 'pre-implementation-gate',
  'pre-bash-guard': 'pre-bash-guard',
  'mcp-tool-guard': 'mcp-tool-guard',
  'session-start': 'session-context',
  'stop-check': 'stop-check',
  'user-prompt-submit': 'user-prompt-submit',
  'subagent-audit': 'subagent-audit',
};

let coreStatusBefore;
before(() => {
  const status = spawnSync('git', ['status', '--porcelain', '--', 'core/'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  coreStatusBefore = status.stdout;
});

after(() => {
  const status = spawnSync('git', ['status', '--porcelain', '--', 'core/'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, coreStatusBefore, 'the parity test must not change repository core status');
});

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile() && full.endsWith('.json')) files.push(full);
  }
  return files;
}

function corpusCases() {
  return filesUnder(FIXTURE_ROOT).filter((file) => !file.includes(`${path.sep}policy-golden${path.sep}`)).flatMap((file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fixture.expect?.envelope || !fixture.native) return [];
    const relative = path.relative(FIXTURE_ROOT, file).split(path.sep);
    const stem = relative[1];
    const policy = fixture.policy || fixture.expect.decision?.policy || STEM_POLICY[stem];
    if (!POLICIES.has(policy)) return [];
    return [{ file, fixture, harness: fixture.expect.envelope.harness, event: fixture.expect.envelope.event, policy }];
  });
}

function runPolicy(policyDir, policy, input, cwd, env) {
  const result = spawnSync('bash', [path.join(policyDir, `${policy}.sh`)], {
    cwd, input, encoding: 'utf8', env,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function verdict(status) {
  return status === 0 ? 'allow' : 'deny';
}

function projectFor(scratch, name, state) {
  const project = createScratchGitRepo(scratch, name);
  project.run('checkout', '-q', '-b', 'feat/077-parity');
  if (state === 'no-design' || state === 'all-artifacts') {
    fs.mkdirSync(path.join(project.root, 'agent-docs/doflow/077-parity/intention'), { recursive: true });
    fs.mkdirSync(path.join(project.root, 'agent-docs/doflow/077-parity/design'), { recursive: true });
    fs.writeFileSync(path.join(project.root, 'agent-docs/doflow/077-parity/intention/requirement.md'), '# requirement\n');
    fs.writeFileSync(path.join(project.root, 'agent-docs/doflow/077-parity/plan.md'), '- [ ] C.1 [US1] verdict — owner: test; files: src/a.js\n');
    if (state === 'all-artifacts') fs.writeFileSync(path.join(project.root, 'agent-docs/doflow/077-parity/design/design.md'), '# design\n');
  }
  return project.root;
}

function encodeNative(harness, event, policy, native, env) {
  let input = JSON.stringify(native);
  if (harness === 'kiro') {
    const translated = spawnSync('/bin/bash', ['-c', `. '${path.join(REPO, 'core/harnesses/kiro/hooks/lib.sh')}'; kiro_bridge_payload`], {
      input, encoding: 'utf8', env,
    });
    assert.equal(translated.status, 0, translated.stderr);
    input = translated.stdout;
  }
  return encodeEnvelope(harness, event, policy, input, env);
}

function legacyNative(baseline, harness, event, native, env) {
  if (harness === 'antigravity') {
    const adapter = require(path.join(path.dirname(baseline), 'adapters/antigravity.js'));
    return JSON.stringify(adapter.toCanonical(event, native));
  }
  if (harness === 'kiro') {
    const translated = spawnSync('/bin/bash', ['-c', `. '${path.join(REPO, 'core/harnesses/kiro/hooks/lib.sh')}'; kiro_bridge_payload`], {
      input: JSON.stringify(native), encoding: 'utf8', env,
    });
    assert.equal(translated.status, 0, translated.stderr);
    return translated.stdout;
  }
  return `${JSON.stringify(native)}\n`;
}

function archiveBaseline(t) {
  const root = tempDir(t, 'doflow-verdict-0fcd973-');
  const result = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', '0fcd973', 'core/harnesses'], {
    encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `required baseline 0fcd973 is unavailable: ${String(result.stderr)}`);
  const unpacked = spawnSync('tar', ['-x', '-C', root], { input: result.stdout, encoding: 'utf8' });
  assert.equal(unpacked.status, 0, `could not extract 0fcd973 policy archive: ${unpacked.stderr}`);
  return { root: path.join(root, 'core/harnesses'), policies: path.join(root, 'core/harnesses/shared/hooks/policies') };
}

test('each canonical corpus v1 policy verdict matches its 0fcd973 native verdict (IC-031 rows 1 and 8)', (t) => {
  const baselineArchive = archiveBaseline(t);
  const baseline = baselineArchive.policies;
  const scratch = { path: (...parts) => path.join(tempDirRoot, ...parts) };
  const tempDirRoot = tempDir(t, 'doflow-verdict-projects-');
  const current = path.join(tempDirRoot, 'current-policies');
  fs.cpSync(path.join(REPO, 'core/harnesses/shared/hooks/policies'), current, { recursive: true });
  const cases = corpusCases();
  assert.ok(cases.length > 0, 'canonical corpus includes envelope cases');
  // IC-031 rows 1 and 8 compare pre-077 doors; derive exclusions from the archived baseline tree.
  const excludedHarnesses = [...new Set(cases.map(({ harness }) => harness))]
    .filter((harness) => !fs.existsSync(path.join(baselineArchive.root, harness, 'hooks')))
    .sort();
  assert.deepEqual(excludedHarnesses, ['pi'], 'only Pi lacks a 0fcd973 front door');

  cases.filter(({ harness }) => !excludedHarnesses.includes(harness)).forEach(({ file, fixture, harness, event, policy }, index) => {
    const label = path.relative(FIXTURE_ROOT, file).split(path.sep).join('/');
    const project = projectFor(scratch, `project-${index}`, fixture.state || 'none');
    const home = path.join(tempDirRoot, `home-${index}`);
    const xdg = path.join(tempDirRoot, `xdg-${index}`);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(xdg, { recursive: true });
    const baseEnv = {
      ...process.env, DOFLOW_PROJECT_DIR: project,
      DOFLOW_AGENT: harness, DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_DECISION_FD: '',
      GIT_CONFIG_GLOBAL: '/dev/null', ...(fixture.env || {}),
    };
    const oldEnv = { ...baseEnv, HOME: home, XDG_CONFIG_HOME: xdg };
    const currentEnv = { ...baseEnv, HOME: `${home}-current`, XDG_CONFIG_HOME: `${xdg}-current` };
    fs.mkdirSync(currentEnv.HOME, { recursive: true });
    fs.mkdirSync(currentEnv.XDG_CONFIG_HOME, { recursive: true });
    if (fixture.policyConfig) {
      for (const policyDir of [baseline, current]) {
        fs.writeFileSync(path.join(policyDir, fixture.policyConfig.file), fixture.policyConfig.contents);
      }
    }
    const native = legacyNative(baseline, harness, event, fixture.native, oldEnv);
    const v1 = encodeNative(harness, event, policy, fixture.native, currentEnv);
    const currentResult = runPolicy(current, policy, v1, project, currentEnv);
    const oldResult = runPolicy(baseline, policy, native, project, oldEnv);
    // DEC-025/IC-013 alter front-door fault rendering and missing-policy behavior; this compares policy verdicts only.
    assert.equal(verdict(currentResult.status), verdict(oldResult.status), `${label}: payload=${v1} v1 ${currentResult.status} ${JSON.stringify(currentResult)} vs 0fcd973 native ${oldResult.status} ${JSON.stringify(oldResult)}`);
  });
});

test('negative control: changing the current gate deny exit breaks the legacy verdict comparison', (t) => {
  const baseline = archiveBaseline(t).policies;
  const root = tempDir(t, 'doflow-verdict-negative-control-');
  const policyDir = path.join(root, 'policies');
  fs.cpSync(path.join(REPO, 'core/harnesses/shared/hooks/policies'), policyDir, { recursive: true });
  const gate = path.join(policyDir, 'pre-implementation-gate.sh');
  const original = fs.readFileSync(gate, 'utf8');
  const changed = original.replace(/(doflow_decide deny missing-artifacts\n\s*)exit 2/, '$1exit 0');
  assert.notEqual(changed, original, 'current gate has the missing-artifacts deny exit');
  fs.writeFileSync(gate, changed);
  const file = path.join(FIXTURE_ROOT, 'claude/pre-implement-gate/deny.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const project = projectFor({ path: (...parts) => path.join(root, ...parts) }, 'project', 'no-design');
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'), DOFLOW_PROJECT_DIR: project, DOFLOW_AGENT: 'claude', DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_DECISION_FD: '', GIT_CONFIG_GLOBAL: '/dev/null' };
  const oldResult = runPolicy(baseline, 'pre-implementation-gate', legacyNative(baseline, 'claude', 'PreToolUse', fixture.native, env), project, env);
  const v1 = encodeNative('claude', 'PreToolUse', 'pre-implementation-gate', fixture.native, env);
  const flipped = runPolicy(policyDir, 'pre-implementation-gate', v1, project, env);
  assert.equal(verdict(oldResult.status), 'deny');
  assert.equal(verdict(flipped.status), 'allow', 'flipped policy no longer matches the 0fcd973 deny verdict');
});
