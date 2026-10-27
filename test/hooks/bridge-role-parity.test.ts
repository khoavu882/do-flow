'use strict';
const JQ_B = process.platform === 'win32' ? ['-b'] : []; // native jq.exe ends lines with CRLF unless -b

// FU-e62v99: envelope.jq and src/runtime/context/identity.ts must read DOFLOW_SESSION_ROLE the same
// way: ASCII-lowercased, `main` or `worker` kept, any other non-empty value is `worker`.
// Unset or empty is not a role for the envelope (IC-008 keeps it absent); identity.ts reads it as main.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { resolveIdentity } = require('../../src/runtime/context/identity.ts');

const ENVELOPE = path.resolve(__dirname, '../../core/harnesses/shared/hooks/bridge/envelope.jq');
const NATIVE = { hook_event_name: 'PreToolUse', session_id: 'role-parity', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'printf safe' } };

function encode(role: string) {
  const env: any = { ...process.env, DOFLOW_TELEMETRY: '', DOFLOW_SESSION_ROLE: role };
  for (const name of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_WORKTREE', 'DOFLOW_TASK_ID']) delete env[name];
  const result = spawnSync('jq', [...JQ_B, '-c', '--arg', 'harness', 'claude', '--arg', 'event', 'PreToolUse', '--arg', 'policy', 'pre-bash-guard', '--arg', 'mode', 'encode', '-f', ENVELOPE], {
    input: JSON.stringify(NATIVE), env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [tuple, event] = result.stdout.trim().split('\n').map((line: string) => JSON.parse(line));
  return { telemetryRole: tuple.role, envelopeRole: event.doflow_event.identity?.role ?? null };
}

function identityRole(role: string) {
  return resolveIdentity({ DOFLOW_SESSION_ROLE: role }, { cwd: '/tmp', sessionId: 'role-parity', warn: () => {} }).role;
}

test('every non-empty DOFLOW_SESSION_ROLE reads the same in envelope.jq (envelope and telemetry) and identity.ts', () => {
  const cases: any = [
    ['main', 'main'], ['MAIN', 'main'], ['Main', 'main'], ['worker', 'worker'], ['Worker', 'worker'], ['WORKER', 'worker'],
    ['LEAD', 'worker'], ['intruder', 'worker'], ['main ', 'worker'], ['wörker', 'worker'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(identityRole(raw), expected, `identity.ts ${JSON.stringify(raw)}`);
    assert.deepEqual(encode(raw), { telemetryRole: expected, envelopeRole: expected }, `envelope.jq ${JSON.stringify(raw)}`);
  }
});

test('an empty DOFLOW_SESSION_ROLE stays absent in the envelope and null in telemetry', () => {
  assert.deepEqual(encode(''), { telemetryRole: null, envelopeRole: null });
});
