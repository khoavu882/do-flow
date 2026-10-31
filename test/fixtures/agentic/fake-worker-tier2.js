#!/usr/bin/env node
'use strict';

/**
 * Stand-in for the Claude binary in the tier-2 executor test (no model, network or credential). It speaks the
 * stream-json shapes of `claude -p --output-format stream-json --verbose --include-hook-events` and follows a
 * scenario; DoFlow's install is stood in for by fake-worker.js `--fake-install`, which writes `.fake-hooks`.
 *
 * Environment: T2_FAKE_SCENARIO (path), T2_FAKE_DUMP (append one JSON line per call).
 *   scenario = { "cumulative": true,
 *                "tasks": { "<id>": { "match": "<substring of the first prompt>", "A": <spec>, "B": <spec>, "C": <spec>, "all": <spec> } } }
 *   <spec> = { "sessions": [ <session>, <session> ] }   (a spec without `sessions` is the one session)
 *   <session> = { "steps": [ {"write": {"<path>": "<content>"}} | {"sleepMs": n} ], "hang": true, "askSegments": n,
 *                 "skills": [..], "classify": "<class>", "denies": [ {"event","matcher","stderr","exitCode"} ],
 *                 "burn": n (tokens streamed before any result), "usage": {input,output,cacheCreation,cacheRead}, "costUsd": n, "opus": {"tokens","costUsd"},
 *                 "behaviour": "ok"|"budget" }
 *   The arm is A (no install), B (installed) or C (installed and the prompt starts with "/do-flow ").
 *   A session is a run without `--resume`; a segment is one process of it.
 */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const env = process.env;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (argv.includes('--version')) {
  process.stdout.write('fake 0.0.0\n');
  process.exit(0);
}

async function main(prompt) {
  const scenario = readJson(env.T2_FAKE_SCENARIO);
  const home = env.HOME;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const installed = fs.existsSync(path.join(configDir, '.fake-hooks'));
  // The arm is fixed by the first prompt of the run: a resume or a session-2 prompt may not repeat the prefix.
  const armFile = path.join(home, '.fake-arm');
  if (!fs.existsSync(armFile)) fs.writeFileSync(armFile, installed ? (prompt.startsWith('/do-flow ') ? 'C' : 'B') : 'A');
  const arm = fs.readFileSync(armFile, 'utf8');
  const resumed = argv.includes('--resume');
  const sessFile = path.join(home, '.fake-sess');
  const segFile = path.join(home, '.fake-seg');
  const taskFile = path.join(home, '.fake-task');
  const sess = (fs.existsSync(sessFile) ? Number(fs.readFileSync(sessFile, 'utf8')) : 0) + (resumed ? 0 : 1);
  fs.writeFileSync(sessFile, String(sess));
  const seg = (resumed ? Number(fs.readFileSync(segFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(segFile, String(seg));
  let taskId = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf8') : null;
  if (!taskId) {
    taskId = Object.keys(scenario.tasks).find((id) => prompt.includes(scenario.tasks[id].match)) || null;
    if (taskId) fs.writeFileSync(taskFile, taskId);
  }
  const entry = taskId ? scenario.tasks[taskId] : null;
  const spec = entry ? (entry[arm] || entry.all) : null;
  if (env.T2_FAKE_DUMP) {
    fs.appendFileSync(env.T2_FAKE_DUMP, `${JSON.stringify({ arm, taskId, session: sess, segment: seg, resumed, prompt, HOME: home, cwd: process.cwd(), budget: flag('--max-budget-usd') ?? null })}\n`);
  }
  if (!spec) {
    process.stderr.write('fake-worker-tier2: no scenario entry matches this prompt\n');
    process.exit(3);
  }
  const session = (spec.sessions ? spec.sessions[sess - 1] : spec) || {};
  const sessionId = `sess-fake-${sess}`;

  if (installed) {
    for (const hook of ['SessionStart', 'UserPromptSubmit']) {
      emit({ type: 'system', subtype: 'hook_started', hook_id: `h-${hook}`, hook_name: `${hook}:startup`, hook_event: hook, session_id: sessionId });
      emit({ type: 'system', subtype: 'hook_response', hook_id: `h-${hook}`, hook_name: `${hook}:startup`, hook_event: hook, outcome: 'success', exit_code: 0, session_id: sessionId });
    }
  }
  const names = (dir, strip) => { try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => f.replace(strip, '')).sort(); } catch { return []; } };
  const skills = names(path.join(configDir, 'skills'), '');
  emit({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: ['Bash', 'Read', 'Edit', 'Write', 'Skill', 'Task'], mcp_servers: [],
    model: 'claude-sonnet-5-5', permissionMode: 'default', slash_commands: [...skills, 'update-config'], skills: [...skills, 'update-config'],
    agents: [...names(path.join(configDir, 'agents'), /\.md$/), 'general-purpose'], apiKeySource: 'environment', claude_code_version: '2.1.308',
  });

  let msg = 0;
  const tool = (name, input) => emit({
    type: 'assistant', message: { id: `m${sess}-${seg}-${++msg}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `tu${sess}-${seg}-${msg}`, name, input }], usage: { input_tokens: 5, output_tokens: 5 } },
    parent_tool_use_id: null, session_id: sessionId,
  });
  for (const skill of session.skills || []) tool('Skill', { skill });
  if (session.classify) tool('Bash', { command: `"$DOFLOW" classify --task-class ${session.classify} --calling-skill do --request-file /tmp/req.txt --json` });
  for (const [i, d] of (session.denies || []).entries()) {
    const id = `deny-${sess}-${seg}-${i}`;
    emit({ type: 'system', subtype: 'hook_started', hook_id: id, hook_name: `${d.event}:${d.matcher || ''}`.replace(/:$/, ''), hook_event: d.event, session_id: sessionId });
    emit({ type: 'system', subtype: 'hook_response', hook_id: id, hook_name: `${d.event}:${d.matcher || ''}`.replace(/:$/, ''), hook_event: d.event, output: '', stdout: '', stderr: d.stderr || '', exit_code: d.exitCode ?? 2, outcome: 'error', session_id: sessionId });
  }
  for (const step of session.steps || []) {
    if (step.sleepMs) await sleep(step.sleepMs);
    for (const [file, content] of Object.entries(step.write || {})) {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), file), content);
    }
  }
  if (session.burn) {
    // tokens streamed before any result event (what the executor's in-flight token cap watches)
    emit({ type: 'assistant', message: { id: `burn-${sess}-${seg}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: session.burn, output_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId });
  }
  if (session.hang) {
    // Stays alive with tokens already streamed and no result event: only the executor's kill ends it.
    setInterval(() => {}, 1000);
    return;
  }
  const mult = scenario.cumulative === false ? 1 : seg;
  const asks = seg <= (session.askSegments || 0);
  const text = asks ? 'First pass done. Should I continue?' : 'Done. Everything is in place.';
  emit({ type: 'assistant', message: { id: `m${sess}-${seg}-${++msg}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 5 } }, parent_tool_use_id: null, session_id: sessionId });
  const u = session.usage || { input: 10, output: 100, cacheCreation: 1000, cacheRead: 5000 };
  const main = { input_tokens: u.input * mult, output_tokens: u.output * mult, cache_creation_input_tokens: u.cacheCreation * mult, cache_read_input_tokens: u.cacheRead * mult };
  const cost = (session.costUsd ?? 0.1) * mult;
  const modelUsage = {
    'claude-sonnet-5-5': { inputTokens: main.input_tokens, outputTokens: main.output_tokens, cacheCreationInputTokens: main.cache_creation_input_tokens, cacheReadInputTokens: main.cache_read_input_tokens, costUSD: cost },
  };
  let total = cost;
  if (session.opus) {
    modelUsage['claude-opus-5'] = { inputTokens: session.opus.tokens * mult, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: session.opus.costUsd * mult };
    total += session.opus.costUsd * mult;
  }
  if (session.behaviour === 'budget') {
    emit({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, api_error_status: null, num_turns: 3, session_id: sessionId, total_cost_usd: total, usage: main, modelUsage });
    process.exit(1);
  }
  emit({
    type: 'result', subtype: 'success', is_error: false, api_error_status: null, duration_ms: 1000 * seg, duration_api_ms: 900, num_turns: 3, result: text,
    stop_reason: 'end_turn', session_id: sessionId, total_cost_usd: total, usage: main, modelUsage, permission_denials: [], terminal_reason: 'completed',
  });
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => { main(prompt).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(4); }); });
