'use strict';

// IC-024 — recurring harness surfaces must stay unaware of context-pack delivery state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO } = require('./_shared');

const TOKENS = ['context-pack', 'delivery/', 'omissions', 'packEnd', '[end of pack]'];
const SCAN_ROOTS = [
  'core/harnesses',
  'core/harnesses/shared/hooks/policies',
  'src/runtime/lifecycle',
];
const SESSION_POLICY = 'core/harnesses/shared/hooks/policies/session-context.sh';
const PROMPT_POLICY = 'core/harnesses/shared/hooks/policies/user-prompt-submit.sh';

function scanFiles(files) {
  const findings = [];
  for (const { rel, text } of files) {
    for (const token of TOKENS) {
      if (text.includes(token)) findings.push(`${rel}: contains ${token}`);
    }
  }
  return findings;
}

function filesUnder(relativeRoot) {
  const root = path.join(REPO, relativeRoot);
  if (!fs.existsSync(root)) return [];
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({
        rel: path.relative(REPO, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  }(root));
  return files;
}

function runPolicy(script, input, env, cwd) {
  const result = spawnSync('bash', [path.join(REPO, script)], {
    cwd, env, input, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined, `${script}: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, `${script} exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, '', `${script} wrote stderr`);
  return result.stdout;
}

function policyOutput(project, home) {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const xdg = path.join(home, 'xdg');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_AGENT: 'codex' };
  const input = JSON.stringify({ session_id: 'silence-fixture', cwd: project });
  const started = runPolicy(SESSION_POLICY, input, env, project);
  const prompted = runPolicy(PROMPT_POLICY, input, env, project);
  return started + prompted;
}

test('IC-024 static scan keeps recurring surfaces free of delivery terminology', () => {
  const files = SCAN_ROOTS.flatMap(filesUnder);
  assert.ok(files.length > 0, 'expected recurring surface files to scan');
  assert.deepEqual(scanFiles(files), []);
});

test('IC-024 shared policies produce identical output with and without delivery records', (t) => {
  const root = tempDir(t, 'doflow-context-silence-');
  const plainProject = path.join(root, 'plain-project');
  const recordedProject = path.join(root, 'recorded-project');
  const plainHome = path.join(root, 'plain-home');
  const recordedHome = path.join(root, 'recorded-home');

  fs.mkdirSync(plainProject, { recursive: true });
  fs.mkdirSync(recordedProject, { recursive: true });
  const record = path.join(recordedProject, '.doflow', 'state', 'delivery', 'fixture-feature', 'silence-fixture.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({
    taskId: 'silence-fixture',
    entries: [{ key: 'sha256:fixture', packDigest: 'sha256:overflow', status: 'OVERFLOW', exitCode: 3 }],
  }));

  const plain = policyOutput(plainProject, plainHome);
  const recorded = policyOutput(recordedProject, recordedHome);
  assert.equal(recorded, plain, 'shared policy stdout changed when a project had delivery state');
  for (const token of TOKENS) assert.ok(!recorded.includes(token), `stdout contains ${token}`);
});

test('IC-024 negative control names an injected token in a temporary hook copy', (t) => {
  const dir = tempDir(t, 'doflow-context-silence-control-');
  const source = path.join(REPO, 'core/harnesses/codex/hooks/user-prompt-submit.sh');
  const copy = path.join(dir, 'user-prompt-submit.sh');
  fs.copyFileSync(source, copy);
  fs.appendFileSync(copy, '\n# injected context-pack control\n');
  const findings = scanFiles([{ rel: 'temporary copy of core/harnesses/codex/hooks/user-prompt-submit.sh', text: fs.readFileSync(copy, 'utf8') }]);
  assert.deepEqual(findings, ['temporary copy of core/harnesses/codex/hooks/user-prompt-submit.sh: contains context-pack']);
});
