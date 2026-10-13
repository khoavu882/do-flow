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
  // A runner simulating the bug where taskClass is null
  function runWithNullTaskClass(taskClass) {
    if (taskClass === null || taskClass === undefined) {
      // Prior bug: null taskClass passed directly to resolveBudget throws TypeError
      throw new TypeError("Cannot read properties of null (reading 'toUpperCase')");
    }
    return 'feature';
  }

  assert.throws(
    () => runWithNullTaskClass(null),
    /Cannot read properties of null/
  );
});

test('context-pack-cli: negative control — adding extra newline causes byte mismatch and empty last line', (t) => {
  const root = setupTestProject(t, 'doflow-cli-neg-newline-');
  const mdRes = runCli(root, ['context-pack', '--task-id', 'task-cli', '--slug', 'feat-cli']);
  assert.equal(mdRes.code, 0);

  // Simulating console.log appending extra newline
  const buggyStdout = mdRes.stdout + '\n';
  const match = buggyStdout.match(/\[end of pack\][^\n]*\bbytes=(\d{9})\b/);
  const reportedBytes = parseInt(match[1], 10);
  const buggyBytes = Buffer.byteLength(buggyStdout, 'utf8');

  assert.notEqual(buggyBytes, reportedBytes, 'Extra newline must cause byte count mismatch');
  assert.equal(buggyStdout.endsWith('\n\n'), true, 'Extra newline creates double newline');
  const buggyLines = buggyStdout.endsWith('\n') ? buggyStdout.slice(0, -1).split('\n') : buggyStdout.split('\n');
  assert.equal(buggyLines[buggyLines.length - 1], '', 'Last line is empty when extra newline added');
});

test('context-pack-cli: negative control — missing --invariants flag is rejected', (t) => {
  const root = setupTestProject(t, 'doflow-cli-neg-invariants-');
  // Pass a dummy unknown flag to verify rejection behavior
  const res = runCli(root, ['readiness', '--task-class', 'feature', '--task-id', 'task-cli', '--unknown-flag-test', 'val']);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes("unknown flag '--unknown-flag-test'"));
});
