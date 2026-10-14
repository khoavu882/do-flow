'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test/fixtures/hooks');
const REASON = (harness) => `[doflow] shared hooks lack the bridge; run: doflow update -t ${harness}`;

function nativeFixture(relativePath) {
  const row = JSON.parse(fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8'));
  assert.ok(row.native, `${relativePath} has a native corpus payload`);
  return row.native;
}

test('every current front door renders its IC-036 fallback with the bridge removed', (t) => {
  const mirror = tempDir(t, 'doflow-bridge-missing-');
  execFileSync('bash', [path.join(__dirname, 'build-install-mirror.sh'), mirror]);
  fs.rmSync(path.join(mirror, '.doflow/shared/hooks/bridge'), { recursive: true, force: true });

  const doors = [
    ...[
      ['pre-implement-gate.sh', 'claude/pre-implement-gate/deny.json'],
      ['pre-bash-guard.sh', 'claude/pre-bash-guard/deny.json'],
      ['mcp-tool-guard.sh', 'claude/mcp-tool-guard/deny.json'],
    ].map(([door, fixture]) => ({ harness: 'claude', door, fixture, render: 'claude-tool' })),
    ...[
      ['session-start.sh', 'claude/session-start/perf.json'],
      ['subagent-audit.sh', 'claude/subagent-audit/perf.json'],
      ['stop-check.sh', 'claude/stop-check/perf.json'],
    ].map(([door, fixture]) => ({ harness: 'claude', door, fixture, render: 'silent' })),
    { harness: 'claude', door: 'user-prompt-submit.sh', fixture: 'claude/user-prompt-submit/perf.json', render: 'silent' },
    ...[
      ['pre-implement-gate.sh', 'codex/pre-implement-gate/deny.json'],
      ['pre-bash-guard.sh', 'codex/pre-bash-guard/deny.json'],
      ['mcp-tool-guard.sh', 'codex/mcp-tool-guard/deny.json'],
    ].map(([door, fixture]) => ({ harness: 'codex', door, fixture, render: 'claude-tool' })),
    ...[
      ['session-start.sh', 'codex/session-start/perf.json'],
      ['subagent-audit.sh', 'codex/subagent-audit/start.json'],
      ['stop-check.sh', 'codex/stop-check/perf.json'],
    ].map(([door, fixture]) => ({ harness: 'codex', door, fixture, render: door === 'stop-check.sh' ? 'codex-empty' : 'silent' })),
    { harness: 'codex', door: 'user-prompt-submit.sh', fixture: 'codex/user-prompt-submit/perf.json', render: 'silent' },
    ...[
      ['pre-implement-gate.sh', 'gemini/pre-implement-gate/deny.json'],
      ['pre-bash-guard.sh', 'gemini/pre-bash-guard/deny.json'],
      ['mcp-tool-guard.sh', 'gemini/mcp-tool-guard/deny.json'],
    ].map(([door, fixture]) => ({ harness: 'gemini', door, fixture, render: 'gemini-tool' })),
    { harness: 'gemini', door: 'session-start.sh', fixture: 'gemini/session-start/perf.json', render: 'silent' },
    ...[
      ['pre-implement-gate.sh', 'kiro/pre-implement-gate/deny.json', 'kiro-tool'],
      ['pre-bash-guard.sh', 'kiro/pre-bash-guard/deny.json', 'kiro-tool'],
      ['mcp-tool-guard.sh', 'kiro/mcp-tool-guard/deny.json', 'kiro-tool'],
      ['session-start.sh', 'kiro/session-start/perf.json', 'silent'],
      ['stop-check.sh', 'kiro/stop-check/v3-deny.json', 'silent'],
    ].map(([door, fixture, render]) => ({ harness: 'kiro', door, fixture, render })),
  ];

  for (const row of doors) {
    const input = JSON.stringify(nativeFixture(row.fixture));
    const script = path.join(mirror, `.${row.harness}/hooks`, row.door);
    const result = spawnSync('bash', [script], {
      input,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `${row.harness}/${row.door} starts`);
    const reason = REASON(row.harness);
    if (row.render === 'claude-tool') {
      assert.equal(result.status, 0, `${row.harness}/${row.door} exit`);
      assert.deepEqual(JSON.parse(result.stdout), {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }, `${row.harness}/${row.door} native deny`);
      assert.equal(result.stderr, '', `${row.harness}/${row.door} stderr`);
    } else if (row.render === 'gemini-tool') {
      assert.equal(result.status, 0, `${row.harness}/${row.door} exit`);
      assert.deepEqual(JSON.parse(result.stdout), { decision: 'deny', reason }, `${row.harness}/${row.door} native deny`);
      assert.equal(result.stderr, '', `${row.harness}/${row.door} stderr`);
    } else if (row.render === 'kiro-tool') {
      assert.equal(result.status, 2, `${row.harness}/${row.door} exit: ${result.stderr}`);
      assert.equal(result.stdout, '', `${row.harness}/${row.door} stdout`);
      assert.equal(result.stderr.trim().split('\n').pop(), reason, `${row.harness}/${row.door} reason`);
    } else {
      assert.equal(result.status, 0, `${row.harness}/${row.door} exit`);
      assert.equal(result.stdout, row.render === 'codex-empty' ? '{}\n' : '', `${row.harness}/${row.door} stdout`);
      assert.equal(result.stderr, '', `${row.harness}/${row.door} stderr`);
    }
  }
});
