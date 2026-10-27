'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// The failure and permission paths get their OWN handlers rather than reusing an existing hook.
// An earlier attempt bound them to post-edit-lint.sh and subagent-audit.sh, which are written for
// different payloads: post-edit-lint queues a path for end-of-turn linting, so on a FAILED edit it
// would queue a file that was never written; subagent-audit records agent_type/agent_id, which a
// permission decision does not carry. Both would have exited zero while recording nonsense.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { msysArgConvGuards } = require('../helper-platform.ts');

const HOOKS = path.resolve(__dirname, '../..', 'core/harnesses/claude/hooks');

function run(t: any, script: any, payload: any) {
  const home = tempDir(t, 'doflow-failure-hooks-');
  const userHome = tempDir(t, 'doflow-failure-hooks-home-');
  const status = { code: 0 };
  try {
    execFileSync(bashPath(), [path.join(HOOKS, script)], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      // Without the MSYS guards, Git Bash rewrites a payload path like /x/y.js into X:/y.js when
      // it hands it to native jq.exe ("/x/" reads as drive X:) — a fixture artifact, not hook
      // behavior; real Windows payloads carry Windows paths, which are never rewritten.
      env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: home, ...msysArgConvGuards() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) { status.code = error.status ?? 1; }
  const sessions = path.join(home, 'doflow', 'session-env', 'sessions');
  const records: any = {};
  if (fs.existsSync(sessions)) {
    for (const id of fs.readdirSync(sessions)) {
      for (const file of fs.readdirSync(path.join(sessions, id))) {
        records[file] = fs.readFileSync(path.join(sessions, id, file), 'utf8').trim();
      }
    }
  }
  return { ...status, records };
}

test('post-tool-failure.sh records the failed tool, its target, and the error', (t) => {
  const { code, records }: any = run(t, 'post-tool-failure.sh', {
    session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Edit',
    tool_input: { file_path: '/x/y.js' }, tool_response: { error: 'String not found' },
  });
  assert.equal(code, 0);
  const entry = JSON.parse(records['tool-failures.log']);
  assert.equal(entry.tool_name, 'Edit');
  assert.equal(entry.file_path, '/x/y.js');
  assert.equal(entry.error, 'String not found');
  // It must NOT write the edited-files queue stop-check.sh lints: the edit never happened.
  assert.equal(records['edited-files.txt'], undefined,
    'a failed edit must never enter the lint queue — the file was not written');
});

test('permission-audit.sh records the refused tool and the reason', (t) => {
  const { code, records }: any = run(t, 'permission-audit.sh', {
    session_id: 's1', hook_event_name: 'PermissionDenied', tool_name: 'Bash',
    permission_decision_reason: 'blocked by rule',
  });
  assert.equal(code, 0);
  const entry = JSON.parse(records['permission-audit.log']);
  assert.equal(entry.tool_name, 'Bash');
  assert.equal(entry.reason, 'blocked by rule');
  // Must not pollute the subagent audit log with rows carrying no agent identity.
  assert.equal(records['subagent-audit.log'], undefined,
    'a permission event carries no agent_type/agent_id and must stay out of that log');
});

test('both hooks degrade to a thinner record when optional fields are absent', (t) => {
  const { code, records }: any = run(t, 'post-tool-failure.sh', { session_id: 's2', hook_event_name: 'PostToolUseFailure' });
  assert.equal(code, 0);
  const entry = JSON.parse(records['tool-failures.log']);
  assert.equal(entry.session_id, 's2');
  assert.equal(entry.tool_name, '');
});

test('both hooks are no-ops without a session id, and survive malformed input', (t) => {
  for (const script of ['post-tool-failure.sh', 'permission-audit.sh']) {
    assert.equal(run(t, script, {}).code, 0, `${script} must not fail without a session`);
    assert.deepEqual(run(t, script, {}).records, {}, `${script} must write nothing without a session`);
    assert.equal(run(t, script, 'not json').code, 0, `${script} must survive malformed input`);
  }
});
