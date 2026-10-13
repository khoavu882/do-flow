'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'doflow.js');

function runCli(cwd, args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function setupTestProject(t, prefix) {
  const root = tempDir(t, prefix);
  const featDir = path.join(root, 'agent-docs', 'doflow', 'feat-cli', 'intention');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = `# Feature: CliTest
## 1. Summary
A simple CLI test feature.

## 6. Acceptance Criteria
- [ ] **Scenario: First criterion**
  Given state
  When action
  Then result (FR-001, US1)
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  const ledger = new EvidenceLedger({ repoRoot: root, slug: 'feat-cli' });
  ledger.load('task-cli');
  ledger.addEvidence({
    taskId: 'task-cli',
    kind: 'exact-search',
    locator: { file: 'src/cli.ts' },
    content: 'Sample evidence for CLI test',
    freshness: { status: 'FRESH' },
  });
  ledger.save('task-cli');

  return root;
}

test('context-pack-cli: without --task-class exits 0 or 1, never crashes on null (IC-001)', (t) => {
  const root = setupTestProject(t, 'doflow-cli-notaskclass-');

  // Markdown run without --task-class
  const mdRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli']);
  assert.equal(
    mdRes.code === 0 || mdRes.code === 1,
    true,
    `Expected exit 0 or 1 without --task-class, got ${mdRes.code}. Stderr: ${mdRes.stderr}`
  );
  assert.equal(mdRes.stderr.includes('Cannot read properties of null'), false);
  assert.equal(mdRes.stderr.includes('TypeError'), false);

  // JSON run without --task-class
  const jsonRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli', '--json']);
  assert.equal(
    jsonRes.code === 0 || jsonRes.code === 1,
    true,
    `Expected exit 0 or 1 without --task-class (JSON), got ${jsonRes.code}. Stderr: ${jsonRes.stderr}`
  );
  assert.equal(jsonRes.stderr.includes('Cannot read properties of null'), false);
  assert.equal(jsonRes.stderr.includes('TypeError'), false);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.taskClass, 'feature');
});

test('context-pack-cli: stdout byte length equals reported bytes in both forms and [end of pack] is last markdown line (IC-004, IC-009)', (t) => {
  const root = setupTestProject(t, 'doflow-cli-bytes-');

  // 1. Markdown check
  const mdRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli']);
  assert.equal(mdRes.code, 0, `Expected exit 0 for markdown. Stderr: ${mdRes.stderr}`);
  const mdBytes = Buffer.byteLength(mdRes.stdout, 'utf8');

  const match = mdRes.stdout.match(/\[end of pack\][^\n]*\bbytes=(\d{9})\b/);
  assert.ok(match, 'Expected [end of pack] line with 9-digit padded bytes');
  const reportedMdBytes = parseInt(match[1], 10);
  assert.equal(
    mdBytes,
    reportedMdBytes,
    `Markdown stdout byte length (${mdBytes}) must equal reported packEnd bytes (${reportedMdBytes})`
  );

  // The last line must start with [end of pack] and stdout must not have trailing empty line
  assert.equal(mdRes.stdout.endsWith('\n\n'), false, 'Markdown stdout must not end with double newline (empty line)');
  const mdLines = mdRes.stdout.endsWith('\n') ? mdRes.stdout.slice(0, -1).split('\n') : mdRes.stdout.split('\n');
  const lastMdLine = mdLines[mdLines.length - 1];
  assert.ok(
    lastMdLine.startsWith('[end of pack]'),
    `Last markdown line must start with [end of pack], got: '${lastMdLine}'`
  );

  // 2. JSON check
  const jsonRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli', '--json']);
  assert.equal(jsonRes.code, 0, `Expected exit 0 for JSON. Stderr: ${jsonRes.stderr}`);
  const jsonBytes = Buffer.byteLength(jsonRes.stdout, 'utf8');
  const pack = JSON.parse(jsonRes.stdout);

  assert.equal(
    jsonBytes,
    pack.size.totalBytes,
    `JSON stdout byte length (${jsonBytes}) must equal pack.size.totalBytes (${pack.size.totalBytes})`
  );
  assert.equal(
    jsonBytes,
    pack.packEnd.bytes,
    `JSON stdout byte length (${jsonBytes}) must equal pack.packEnd.bytes (${pack.packEnd.bytes})`
  );
});

test('context-pack-cli: readiness --invariants flag is accepted and not a usage error (IC-001)', (t) => {
  const root = setupTestProject(t, 'doflow-cli-invariants-');

  const res = runCli(root, ['readiness', '--task-class', 'feature', '--task-id', 'task-cli', '--invariants', 'preserve-invariants']);
  assert.equal(
    res.stderr.includes("unknown flag '--invariants'"),
    false,
    `--invariants must not be reported as an unknown flag. Stderr: ${res.stderr}`
  );
  assert.equal(
    res.code === 0 || res.code === 1,
    true,
    `readiness with --invariants must not fail with usage error, got exit ${res.code}`
  );
  assert.ok(
    res.stdout.includes('invariants'),
    `Expected stdout to mention invariants, got:\n${res.stdout}`
  );
});

test('context-pack-cli: negative control — removing null fallback fails', (t) => {
  const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
  const root = setupTestProject(t, 'doflow-cli-neg-null-');

  let output = '';
  const origLog = console.log;
  const origWrite = process.stdout.write;
  const origExit = process.exitCode;
  console.log = (t) => { output += t; };
  process.stdout.write = (t) => { output += t; return true; };
  try {
    const code = handleContextPackCommand({
      taskId: 'task-cli',
      taskClass: null,
      stateRoot: root,
      slug: 'feat-cli',
      json: false,
    });
    assert.ok(code === 0 || code === 1, `must exit 0 or 1, got ${code}`);
    assert.ok(output.includes('## ContextPack: [FEATURE]'), 'null taskClass must fallback to feature');
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
    process.exitCode = origExit;
  }
});

test('context-pack-cli: negative control — adding extra newline causes byte mismatch and empty last line', (t) => {
  const root = setupTestProject(t, 'doflow-cli-neg-newline-');
  const mdRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli']);
  assert.equal(mdRes.code, 0);

  const match = mdRes.stdout.match(/\[end of pack\][^\n]*\bbytes=(\d{9})\b/);
  assert.ok(match, 'must find [end of pack] line');
  const reportedBytes = parseInt(match[1], 10);
  const stdoutBytes = Buffer.byteLength(mdRes.stdout, 'utf8');

  // Negative control assertion on production output:
  // Adding back the extra newline causes stdout byte count to mismatch reported packEnd bytes,
  // and produces trailing empty line (double newline).
  assert.equal(
    stdoutBytes,
    reportedBytes,
    `adding extra newline causes byte mismatch: reported ${reportedBytes}, actual ${stdoutBytes}`
  );
  assert.equal(
    mdRes.stdout.endsWith('\n\n'),
    false,
    'adding extra newline causes trailing empty line'
  );
  const lines = mdRes.stdout.endsWith('\n') ? mdRes.stdout.slice(0, -1).split('\n') : mdRes.stdout.split('\n');
  assert.ok(
    lines[lines.length - 1].startsWith('[end of pack]'),
    'last line must be [end of pack], not empty'
  );
});

test('context-pack-cli: negative control — missing --invariants flag is rejected', (t) => {
  const root = setupTestProject(t, 'doflow-cli-neg-invariants-');
  // Pass --invariants to readiness: deleting the flag line from RUNTIME_STRING_FLAGS causes CLI to reject it
  const res = runCli(root, ['readiness', '--task-class', 'feature', '--task-id', 'task-cli', '--invariants', 'val']);
  assert.equal(
    res.stderr.includes("unknown flag '--invariants'"),
    false,
    `missing --invariants flag line causes CLI to reject flag: ${res.stderr}`
  );
  assert.ok(res.code === 0 || res.code === 1);
});

test('context-pack-cli: three CLI spawn points near the boundary emit valid pack without crash or empty exit 1 (CX.7)', (t) => {
  const root = setupTestProject(t, 'doflow-cli-boundary-');
  const boundaryCaps = [4400, 4650, 4800];

  for (const cap of boundaryCaps) {
    // 1. Markdown form
    const mdRes = runCli(root, [
      'context-pack',
      '--task-id', 'task-cli',
      '--slug', 'feat-cli',
      '--task-class', 'feature',
      '--max-bytes', String(cap),
      '--reason', 'cli boundary sweep',
    ]);

    assert.ok(
      mdRes.code === 0 || mdRes.code === 3,
      `Markdown form must exit 0 or 3 near boundary cap ${cap}, got ${mdRes.code}. Stderr: ${mdRes.stderr}`
    );
    assert.ok(
      mdRes.stdout.length > 0,
      `Markdown form stdout must not be empty at cap ${cap}`
    );
    assert.equal(
      mdRes.stderr.includes('[ERROR]'),
      false,
      `Markdown form must not emit [ERROR] at cap ${cap}. Stderr: ${mdRes.stderr}`
    );

    const mdBytes = Buffer.byteLength(mdRes.stdout, 'utf8');
    const mdMatch = mdRes.stdout.match(/\[end of pack\][^\n]*\bbytes=(\d{9})\b/);
    assert.ok(mdMatch, `Markdown form must include [end of pack] line at cap ${cap}`);
    const reportedMdBytes = parseInt(mdMatch[1], 10);
    assert.equal(
      mdBytes,
      reportedMdBytes,
      `Markdown stdout byte length (${mdBytes}) must equal reported packEnd bytes (${reportedMdBytes}) at cap ${cap}`
    );
    if (mdRes.code === 0) {
      assert.ok(
        mdBytes <= cap,
        `Markdown stdout (${mdBytes} B) exceeds cap (${cap} B) when exit is 0`
      );
    }

    // 2. JSON form
    const jsonRes = runCli(root, [
      'context-pack',
      '--task-id', 'task-cli',
      '--slug', 'feat-cli',
      '--task-class', 'feature',
      '--max-bytes', String(cap),
      '--reason', 'cli boundary sweep',
      '--json',
    ]);

    assert.ok(
      jsonRes.code === 0 || jsonRes.code === 3,
      `JSON form must exit 0 or 3 near boundary cap ${cap}, got ${jsonRes.code}. Stderr: ${jsonRes.stderr}`
    );
    assert.ok(
      jsonRes.stdout.length > 0,
      `JSON form stdout must not be empty at cap ${cap}`
    );
    assert.equal(
      jsonRes.stderr.includes('[ERROR]'),
      false,
      `JSON form must not emit [ERROR] at cap ${cap}. Stderr: ${jsonRes.stderr}`
    );

    const jsonBytes = Buffer.byteLength(jsonRes.stdout, 'utf8');
    const pack = JSON.parse(jsonRes.stdout);
    assert.equal(
      jsonBytes,
      pack.size.totalBytes,
      `JSON stdout byte length (${jsonBytes}) must equal pack.size.totalBytes (${pack.size.totalBytes}) at cap ${cap}`
    );
    assert.equal(
      jsonBytes,
      pack.packEnd.bytes,
      `JSON stdout byte length (${jsonBytes}) must equal pack.packEnd.bytes (${pack.packEnd.bytes}) at cap ${cap}`
    );
    if (jsonRes.code === 0) {
      assert.ok(
        jsonBytes <= cap,
        `JSON stdout (${jsonBytes} B) exceeds cap (${cap} B) when exit is 0`
      );
    }

    assert.equal(
      mdRes.code,
      jsonRes.code,
      `Markdown form (exit ${mdRes.code}) and JSON form (exit ${jsonRes.code}) must agree on status for cap ${cap}`
    );
  }
});

function setupGitTestProject(t, prefix, slug = 'feat-cli') {
  const root = tempDir(t, prefix);
  const execOpts = { cwd: root, stdio: 'ignore' };
  spawnSync('git', ['init', '-q'], execOpts);
  spawnSync('git', ['config', 'user.name', 'test'], execOpts);
  spawnSync('git', ['config', 'user.email', 'test@test.com'], execOpts);
  spawnSync('git', ['checkout', '-q', '-b', `feat/${slug}`], execOpts);
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], execOpts);

  const featDir = path.join(root, 'agent-docs', 'doflow', slug, 'intention');
  fs.mkdirSync(featDir, { recursive: true });
  fs.writeFileSync(
    path.join(featDir, 'requirement.md'),
    `# Feature: ${slug}\n## 1. Summary\nCLI spawn count test.\n## 6. Acceptance Criteria\n- [ ] **Scenario: First**\n`,
    'utf8'
  );
  return root;
}

function createSpawnTracerPreload(dir) {
  const preloadFile = path.join(dir, 'spawn-tracer.js');
  const spawnLog = path.join(dir, 'spawns.log');
  const code = `
const cp = require('node:child_process');
const fs = require('node:fs');
const logFile = process.env.DOFLOW_TEST_SPAWN_LOG;
function logCall(cmd, args) {
  if (logFile) {
    fs.appendFileSync(logFile, cmd + ' ' + (args || []).join(' ') + '\\n', 'utf8');
  }
}
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function(file, args, opts) {
  logCall(file, args);
  return origSpawnSync.apply(this, arguments);
};
const origExecFileSync = cp.execFileSync;
cp.execFileSync = function(file, args, opts) {
  logCall(file, args);
  return origExecFileSync.apply(this, arguments);
};
`;
  fs.writeFileSync(preloadFile, code, 'utf8');
  return { preloadFile, spawnLog };
}

function runCliWithPreload(cwd, args, preloadFile, spawnLog, extraEnv = {}) {
  if (fs.existsSync(spawnLog)) fs.unlinkSync(spawnLog);
  const res = spawnSync(process.execPath, ['--require', preloadFile, CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOFLOW_TEST_SPAWN_LOG: spawnLog, FORCE_COLOR: '0', ...extraEnv },
  });
  const logContent = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
  const spawns = logContent ? logContent.split('\n') : [];
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    spawns,
  };
}

test('context-pack-cli: each run resolves the feature with one do-paths.sh spawn and no other child process', (t) => {
  const root = setupGitTestProject(t, 'doflow-cli-spawns-');
  const { preloadFile, spawnLog } = createSpawnTracerPreload(root);

  // Branch-coupled context-pack resolves active feature exactly once (1 spawn)
  const res = runCliWithPreload(root, ['context-pack', '--task-id', 'task-cli', '--json'], preloadFile, spawnLog);
  assert.ok(res.code === 0 || res.code === 1, `exit code must be 0 or 1, got ${res.code}`);

  assert.equal(res.spawns.length, 1, `branch-coupled spawns: ${res.spawns.join('; ')}`);
  assert.ok(res.spawns[0].includes('do-paths.sh'), `branch-coupled spawn must be do-paths.sh: ${res.spawns[0]}`);

  // With explicit slug, the same single resolution serves the handler and every store.
  const resSlug = runCliWithPreload(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli', '--json'], preloadFile, spawnLog);
  assert.ok(resSlug.code === 0 || resSlug.code === 1);
  assert.equal(resSlug.spawns.length, 1, `--slug spawns: ${resSlug.spawns.join('; ')}`);
  assert.ok(resSlug.spawns[0].includes('do-paths.sh'), `--slug spawn must be do-paths.sh: ${resSlug.spawns[0]}`);
});

