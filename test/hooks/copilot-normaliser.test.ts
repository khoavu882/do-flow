'use strict';

// copilot_bridge_payload against the payloads Copilot CLI 1.0.103 really sent (live capture of
// 2026-10-27, test/fixtures/hooks/copilot/live/capture-2026-10-27.jsonl). One case per camelCase
// event the capture holds; the PascalCase `P:` lines and the deny-session line are evidence only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '../..');
const LIB = path.join(REPO, 'core/harnesses/copilot/hooks/doflow-lib.sh');
const CAPTURE = path.join(REPO, 'test/fixtures/hooks/copilot/live/capture-2026-10-27.jsonl');
const PASCAL: any = {
  sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', userPromptSubmitted: 'UserPromptSubmit', preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse', agentStop: 'Stop', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop',
};
const lines = fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((line: any) => JSON.parse(line));

function normalise(event: any, native: any, env: any = {}) {
  const result = spawnSync('bash', ['-c', `source '${LIB}'; copilot_bridge_payload '${event}'`], {
    input: typeof native === 'string' ? native : JSON.stringify(native), encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function first(name: any, pick: any = () => true) {
  const row = lines.find((line: any) => line.event === name && pick(line.stdin));
  assert.ok(row, `capture holds a ${name} line`);
  return row.stdin;
}

test('every camelCase event of the capture normalises to a canonical payload with its session, cwd and event name', () => {
  const seen = new Set();
  for (const { event, stdin } of lines) {
    if (!PASCAL[event]) continue;
    const out = normalise(PASCAL[event], stdin);
    seen.add(event);
    assert.equal(out.hook_event_name, PASCAL[event], event);
    assert.equal(out.session_id, stdin.sessionId, event);
    assert.equal(out.cwd, stdin.cwd, event);
  }
  assert.deepEqual([...seen].sort(), Object.keys(PASCAL).sort(), 'the capture covers every wired event');
});

test('preToolUse bash: toolName bash -> Bash and the toolArgs object becomes tool_input', () => {
  const stdin = first('preToolUse', (s: any) => s.toolName === 'bash');
  const out = normalise('PreToolUse', stdin);
  assert.equal(out.tool_name, 'Bash');
  assert.equal(out.tool_input.command, stdin.toolArgs.command);
});

test('preToolUse apply_patch: toolArgs is a raw patch string, kept under tool_input.command', () => {
  const stdin = first('preToolUse', (s: any) => s.toolName === 'apply_patch');
  assert.equal(typeof stdin.toolArgs, 'string', 'the capture shows a raw string, not a JSON object');
  const out = normalise('PreToolUse', stdin);
  assert.equal(out.tool_name, 'apply_patch');
  assert.equal(out.tool_input.command, stdin.toolArgs);
});

test('toolArgs given as a JSON string (the documented form) parses to the same tool_input as an object', () => {
  const stdin = first('preToolUse', (s: any) => s.toolName === 'bash');
  const asString = normalise('PreToolUse', { ...stdin, toolArgs: JSON.stringify(stdin.toolArgs) });
  assert.deepEqual(asString.tool_input, normalise('PreToolUse', stdin).tool_input);
});

test('preToolUse of other tools passes the name through: skill and task are not remapped', () => {
  for (const name of ['skill', 'task']) {
    const out = normalise('PreToolUse', first('preToolUse', (s: any) => s.toolName === name));
    assert.equal(out.tool_name, name);
    assert.equal(typeof out.tool_input, 'object');
  }
});

test('edit and create tools carry file_path, copied from path', () => {
  const edit = normalise('PreToolUse', { sessionId: 's', cwd: '/tmp', toolName: 'edit', toolArgs: { path: '/tmp/a.js', old_str: 'a', new_str: 'b' } });
  assert.equal(edit.tool_name, 'Edit');
  assert.equal(edit.tool_input.file_path, '/tmp/a.js');
  const create = normalise('PreToolUse', { sessionId: 's', cwd: '/tmp', toolName: 'create', toolArgs: { path: '/tmp/b.js', file_text: 'x' } });
  assert.equal(create.tool_name, 'Write');
  assert.equal(create.tool_input.file_path, '/tmp/b.js');
});

test('agentStop carries the transcript path and the continuation flag; a subagent stop carries its ids', () => {
  const main = normalise('Stop', first('agentStop', (s: any) => !s.agentId));
  assert.match(main.transcript_path, /events\.jsonl$/);
  assert.equal(main.stop_hook_active, false);
  assert.equal(main.stop_reason, 'end_turn');
  const sub = normalise('Stop', first('agentStop', (s: any) => s.agentId));
  assert.equal(sub.agent_id, sub.session_id);
  assert.ok(sub.parent_agent_id);
});

test('subagentStart and subagentStop map the agent ids, and the response becomes last_assistant_message', () => {
  const start = normalise('SubagentStart', first('subagentStart'));
  assert.deepEqual([start.agent_type, start.agent_name, typeof start.agent_id, typeof start.parent_agent_id], ['task', 'task', 'string', 'string']);
  const stdin = first('subagentStop');
  const stop = normalise('SubagentStop', stdin);
  assert.equal(stop.last_assistant_message, stdin.response);
  assert.equal(stop.agent_id, stdin.agentId);
});

test('sessionStart keeps the source and the initial prompt; userPromptSubmitted keeps the prompt', () => {
  const start = normalise('SessionStart', first('sessionStart'));
  assert.equal(start.source, 'new');
  assert.ok(start.initial_prompt);
  assert.ok(normalise('UserPromptSubmit', first('userPromptSubmitted')).prompt);
});

test('a payload jq cannot read is printed unchanged', () => {
  const result = spawnSync('bash', ['-c', `source '${LIB}'; copilot_bridge_payload PreToolUse`], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.stdout, 'not json\n');
});

test('the live deny proof is the flat shape the bridge renders for a preToolUse deny', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/hooks/copilot/live/deny-proof-2026-10-27.json'), 'utf8'));
  const rendered = spawnSync('bash', ['-c', `. '${path.join(REPO, 'core/harnesses/shared/hooks/bridge/respond.sh')}'; doflow_render_response copilot PreToolUse deny 'doflow capture test' 2`], { encoding: 'utf8' });
  assert.equal(rendered.status, 0);
  assert.deepEqual(JSON.parse(rendered.stdout), proof.hookStdout);
  assert.equal(proof.toolRan, false);
});

test('the Stop deny renders the documented block shape and exits 0', () => {
  const rendered = spawnSync('bash', ['-c', `. '${path.join(REPO, 'core/harnesses/shared/hooks/bridge/respond.sh')}'; doflow_render_response copilot Stop deny 'unfinished' 2`], { encoding: 'utf8' });
  assert.equal(rendered.status, 0);
  assert.deepEqual(JSON.parse(rendered.stdout), { decision: 'block', reason: 'unfinished' });
});
