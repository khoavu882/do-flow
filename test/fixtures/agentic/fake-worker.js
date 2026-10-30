#!/usr/bin/env node
'use strict';

/**
 * Stand-in for the measured harness binary in the agentic tests (feature 097, IC-010). Tests put a
 * copy first on PATH under the registry binary name, so no real model, network or credential is ever
 * touched. It never opens a socket.
 *
 * Contract:
 *   --version                    prints "fake 0.0.0" and exits 0.
 *   otherwise                    reads the prompt from stdin, then follows the scenario.
 *
 * Environment (all set by the test through the executor's `extraEnv`):
 *   AGENTIC_FAKE_SCENARIO  path to a scenario JSON:
 *     { "armMarkers": { "D": "<substring of the arm D paragraph>" },
 *       "tasks": { "<taskId>": { "match": "<substring of the Question line>",
 *                                 "N": <spec>, "D": <spec> } },
 *       "default": { "N": <spec>, "D": <spec> } }
 *     <spec> = { "behaviour": "ok"|"timeout"|"api-error"|"silent"|"crash"|"exit"|"report-then-hang" (default ok),
 *                "files": [...], "truthFiles": k, "decoys": m, "commands": [...],
 *                "tokens": n|null, "outputTokens": n, "message": "<api-error text>",
 *                "usageEvents": [<usage object>|null, ...], "exitCode": n }
 *     `crash` writes the answer (stdout and the -o file) and then SIGKILLs itself before any turn end;
 *     `report-then-hang` reports one turn end with `tokens` and then never exits (an interrupt or a
 *     timeout after the worker already reported usage);
 *     `exit` answers like `ok` and then exits with `exitCode`. `usageEvents`, when present, replaces
 *     the single `turn.completed`: one event per entry, with that `usage` (null: no usage field).
 *     `match` may be left out when AGENTIC_FAKE_TRUTH is set: the task is then found by the truth
 *     file's query, so a scenario keyed by task id never goes stale when the task text changes.
 *     The files an `ok` run answers with are: the first `truthFiles` distinct qrel paths of the task
 *     (from the truth file), then `files`, then `decoys` made-up paths. Truth first keeps recall
 *     deterministic: `truthFiles: 0` finds nothing real.
 *   AGENTIC_FAKE_TRUTH     path to { "<taskId>": { "query": "...", "qrels": [{ "path": "..." }] } }.
 *   AGENTIC_FAKE_ARM       force the arm instead of reading armMarkers (default arm is N).
 *   AGENTIC_FAKE_DUMP      append one JSON line per call (version or run) describing argv, cwd,
 *                          environment variable NAMES, PATH, HOME, the harness-home listing
 *                          and any `doflow` file found on PATH (directory, mode, short text).
 *   AGENTIC_FAKE_HOME_VAR  name of the variable holding the harness home (for the dump listing).
 *   AGENTIC_FAKE_WATCH     comma-separated tool names; the dump's `watch` maps each to the PATH directories
 *                          that hold it (proves what the harness could reach).
 *   AGENTIC_FAKE_PIDFILE   where the `timeout` behaviour writes its child sleeper's pid.
 *
 * Events follow the codex-exec-json-v1 shapes the executor's parser reads.
 *
 * Claude mode (the with/without-DoFlow A/B): an argv holding `--output-format` is a Claude headless run and
 * speaks stream-json instead. Environment: AB_FAKE_SCENARIO (path), AB_FAKE_DUMP (append one JSON line per
 * call), AB_FAKE_SEEN (credential variable names whose values are checked, never written).
 *   scenario = { "tasks": { "<id>": { "match": "<substring of the first prompt>", "A": <spec>, "B": <spec> } },
 *                "cumulative": true }
 *   <spec> = { "behaviour": "ok"|"timeout"|"api-error"|"budget"|"silent"|"hang-after-usage" (default ok),
 *              "files": { "<path>": "<content>" }, "reviewJson": [...], "reviewRaw": "<text>",
 *              "commands": [...], "reads": [...], "skills": [...], "subagents": [{ "type", "model", "tokens" }],
 *              "usage": { "input", "output", "cacheCreation", "cacheRead" }, "costUsd": n,
 *              "askSegments": n, "finalOffer": true, "printEnv": true, "stream": { "messages": n, "perMessage": tokens },
 *              "initOverride": { "addSkills": [], "addAgents": [], "dropSkills": [], "noHooks": true, "model": "..." } }
 *   The arm is B when `$CLAUDE_CONFIG_DIR/.fake-hooks` exists (written by `--fake-install <export>`), else A.
 *   `--fake-install <export>` stands in for `doflow install`: it projects `<export>/core/shared/{skills,agent-specs}`
 *   into `$CLAUDE_CONFIG_DIR` (AB_FAKE_INSTALL=fail makes it exit 1).
 *   A resumed run (`--resume <id>`) is the next segment: `askSegments` segments end with a question, and the
 *   result reports running totals (usage and cost multiplied by the segment number) unless `cumulative` is false.
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const env = process.env;
const argv = process.argv.slice(2);

function dump(kind, extra = {}) {
  if (!env.AGENTIC_FAKE_DUMP) return;
  const homeVar = env.AGENTIC_FAKE_HOME_VAR;
  const harnessHome = homeVar ? env[homeVar] : undefined;
  let files = null;
  try {
    files = harnessHome ? fs.readdirSync(harnessHome).sort() : null;
  } catch { /* directory missing */ }
  const pathDirs = String(env.PATH || '').split(path.delimiter);
  const record = {
    kind, pid: process.pid, argv, cwd: process.cwd(), envKeys: Object.keys(env).sort(), PATH: env.PATH, HOME: env.HOME,
    harnessHome: harnessHome || null, harnessHomeFiles: files,
    harnessHomeModes: files ? Object.fromEntries(files.map((f) => [f, fs.statSync(path.join(harnessHome, f)).mode & 0o777])) : null,
    profileMode: env.HOME ? fs.statSync(path.dirname(env.HOME)).mode & 0o777 : null,
    hasGit: fs.existsSync(path.join(process.cwd(), '.git')),
    watch: Object.fromEntries(String(env.AGENTIC_FAKE_WATCH || '').split(',').filter(Boolean).map((name) => [name, pathDirs.filter((d) => d && fs.existsSync(path.join(d, name)))])),
    firstPathDir: firstDirListing(pathDirs[0]),
    doflowOnPath: pathDirs.filter((d) => d && fs.existsSync(path.join(d, 'doflow'))),
    doflowFiles: pathDirs.filter((d) => d && fs.existsSync(path.join(d, 'doflow'))).map((dir) => {
      const stat = fs.statSync(path.join(dir, 'doflow'));
      const text = stat.size < 1000 ? fs.readFileSync(path.join(dir, 'doflow'), 'utf8') : null;
      // The tree the shim runs from (`exec node '<root>/bin/doflow.js'`): its top-level entries.
      const target = text && (/exec node '([^']+)'/.exec(text) || [])[1];
      const root = target ? path.dirname(path.dirname(target)) : null;
      let rootEntries = null;
      try {
        rootEntries = root ? fs.readdirSync(root).sort() : null;
      } catch { /* missing */ }
      return { dir, mode: stat.mode & 0o777, text, root, rootEntries };
    }),
    ...extra,
  };
  fs.appendFileSync(env.AGENTIC_FAKE_DUMP, `${JSON.stringify(record)}\n`);
}

/** The first PATH directory's entries and, for symlinks, their targets (the per-run tool directory). */
function firstDirListing(dir) {
  try {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
      const full = path.join(dir, name);
      return [name, fs.lstatSync(full).isSymbolicLink() ? fs.readlinkSync(full) : null];
    }));
  } catch {
    return null;
  }
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The scenario spec for this prompt and arm, plus the task id and truth entry it matched. */
function pick(prompt) {
  const scenario = readJson(env.AGENTIC_FAKE_SCENARIO);
  const truth = env.AGENTIC_FAKE_TRUTH ? readJson(env.AGENTIC_FAKE_TRUTH) : {};
  const question = (/^Question: (.*)$/m.exec(prompt) || [])[1] || '';
  let arm = env.AGENTIC_FAKE_ARM || 'N';
  if (!env.AGENTIC_FAKE_ARM) {
    for (const [name, marker] of Object.entries(scenario.armMarkers || {})) if (prompt.includes(marker)) arm = name;
  }
  for (const [id, entry] of Object.entries(scenario.tasks || {})) {
    const needle = entry.match ?? truth[id]?.query;
    if (needle && question.includes(needle) && entry[arm]) return { id, arm, spec: entry[arm], truth: truth[id] };
  }
  if (scenario.default?.[arm]) return { id: null, arm, spec: scenario.default[arm], truth: null };
  return { id: null, arm, spec: null, truth: null };
}

function answerFiles(spec, truth) {
  const real = [...new Set((truth?.qrels || []).map((q) => q.path))].slice(0, spec.truthFiles || 0);
  const decoys = Array.from({ length: spec.decoys || 0 }, (_, i) => `decoy/file${i + 1}.js`);
  return [...real, ...(spec.files || []), ...decoys];
}

function main(prompt) {
  const { id, arm, spec, truth } = pick(prompt);
  dump('run', { taskId: id, arm, promptBytes: Buffer.byteLength(prompt, 'utf8'), prompt });
  if (!spec) {
    process.stderr.write('fake-worker: no scenario entry matches this prompt\n');
    process.exit(3);
  }
  const behaviour = spec.behaviour || 'ok';

  if (behaviour === 'silent') process.exit(0);

  if (behaviour === 'api-error') {
    emit({ type: 'turn.failed', error: { message: spec.message || 'fake api error' } });
    process.exit(1);
  }

  if (behaviour === 'timeout') {
    // A child in the same process group proves the executor ends the whole tree, not just the leader.
    const sleeper = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (env.AGENTIC_FAKE_PIDFILE) fs.writeFileSync(env.AGENTIC_FAKE_PIDFILE, String(sleeper.pid));
    setInterval(() => {}, 1000);
    return;
  }

  if (spec.leaveChild) {
    // A same-group child that outlives a normal exit: the executor must end the group after any exit.
    const sleeper = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (env.AGENTIC_FAKE_PIDFILE) fs.writeFileSync(env.AGENTIC_FAKE_PIDFILE, String(sleeper.pid));
  }

  if (behaviour === 'report-then-hang') {
    const output = Math.min(spec.tokens, spec.outputTokens ?? 100);
    emit({ type: 'turn.completed', usage: { input_tokens: spec.tokens - output, output_tokens: output } });
    setInterval(() => {}, 1000);
    return;
  }

  if (behaviour === 'crash') {
    const text = JSON.stringify({ files: answerFiles(spec, truth) });
    emit({ type: 'item.completed', item: { type: 'agent_message', text } });
    const out = argv.indexOf('-o');
    if (out !== -1 && argv[out + 1]) fs.writeFileSync(argv[out + 1], text);
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  for (const command of spec.commands || []) {
    emit({ type: 'item.completed', item: { type: 'command_execution', command, status: 'completed' } });
  }
  const text = JSON.stringify({ files: answerFiles(spec, truth) });
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  const out = argv.indexOf('-o');
  if (out !== -1 && argv[out + 1]) fs.writeFileSync(argv[out + 1], text);
  if (Array.isArray(spec.usageEvents)) {
    for (const usage of spec.usageEvents) emit(usage === null ? { type: 'turn.completed' } : { type: 'turn.completed', usage });
  } else if (Number.isInteger(spec.tokens)) {
    const output = Math.min(spec.tokens, spec.outputTokens ?? 100);
    emit({ type: 'turn.completed', usage: { input_tokens: spec.tokens - output, output_tokens: output } });
  } else {
    emit({ type: 'turn.completed' });
  }
  process.exit(behaviour === 'exit' ? (spec.exitCode ?? 1) : 0);
}

// ---------------------------------------------------------------------------------------------
// Claude mode

function configDir() {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '', '.claude');
}

/** `--name value` from argv (the installer is started without the wrapper's environment). */
const argFlag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

function abDump(kind, extra = {}) {
  const file = env.AB_FAKE_DUMP || argFlag('--dump');
  if (!file) return;
  const seen = Object.fromEntries(String(env.AB_FAKE_SEEN || argFlag('--seen') || '').split(',').filter(Boolean).map((n) => [n, Boolean(env[n])]));
  fs.appendFileSync(file, `${JSON.stringify({ kind, argv, cwd: process.cwd(), HOME: env.HOME, PATH: env.PATH, envKeys: Object.keys(env).sort(), credentialsSeen: seen, scrub: env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null, ...extra })}\n`);
}

function fakeInstall(exportDir) {
  abDump('install', { exportDir });
  if (env.AB_FAKE_INSTALL === 'fail' || argv.includes('--fail')) {
    process.stderr.write('fake install failed\n');
    process.exit(1);
  }
  const dir = configDir();
  const skills = path.join(exportDir, 'core', 'shared', 'skills');
  const agents = path.join(exportDir, 'core', 'shared', 'agent-specs');
  for (const name of fs.existsSync(skills) ? fs.readdirSync(skills) : []) {
    if (!fs.existsSync(path.join(skills, name, 'SKILL.md'))) continue;
    fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
    fs.copyFileSync(path.join(skills, name, 'SKILL.md'), path.join(dir, 'skills', name, 'SKILL.md'));
  }
  for (const file of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
    if (!file.endsWith('.md')) continue;
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(path.join(agents, file), path.join(dir, 'agents', file));
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.fake-hooks'), '1\n');
  process.exit(0);
}

const names = (dir, strip) => {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => f.replace(strip, '')).sort();
  } catch {
    return [];
  }
};

const FAKE_KEY_SHAPE = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';

function claudeMain(prompt) {
  const scenario = readJson(env.AB_FAKE_SCENARIO);
  const home = env.HOME;
  const dir = configDir();
  const installed = fs.existsSync(path.join(dir, '.fake-hooks'));
  const arm = installed ? 'B' : 'A';
  const counter = path.join(home, '.fake-seg');
  const taskFile = path.join(home, '.fake-task');
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  let taskId = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf8') : null;
  if (!taskId) {
    taskId = Object.keys(scenario.tasks).find((id) => prompt.includes(scenario.tasks[id].match)) || null;
    if (taskId) fs.writeFileSync(taskFile, taskId);
  }
  const spec = taskId ? scenario.tasks[taskId][arm] : null;
  abDump('run', { arm, taskId, segment: n, resumed: argv.includes('--resume'), promptBytes: Buffer.byteLength(prompt, 'utf8'), ...(n > 1 ? { prompt } : {}) });
  if (!spec) {
    process.stderr.write('fake-worker: no Claude scenario entry matches this prompt\n');
    process.exit(3);
  }
  const behaviour = spec.behaviour || 'ok';
  const sessionId = 'sess-fake-0001';
  const o = spec.initOverride || {};
  if (behaviour === 'silent') process.exit(0);

  if (installed && !o.noHooks) {
    for (const hook of ['SessionStart', 'UserPromptSubmit']) {
      emit({ type: 'system', subtype: 'hook_started', hook_id: `h-${hook}`, hook_name: `${hook}:startup`, hook_event: hook, session_id: sessionId });
      emit({ type: 'system', subtype: 'hook_response', hook_id: `h-${hook}`, hook_name: `${hook}:startup`, hook_event: hook, outcome: 'success', exit_code: 0, session_id: sessionId });
    }
  }
  const skills = [...names(path.join(dir, 'skills'), ''), ...(o.addSkills || [])].filter((x) => !(o.dropSkills || []).includes(x));
  const agents = [...names(path.join(dir, 'agents'), /\.md$/), ...(o.addAgents || []), 'general-purpose'];
  emit({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: ['Bash', 'Read', 'Edit', 'Write', 'Skill'], mcp_servers: [],
    model: o.model || 'claude-sonnet-5-5', permissionMode: 'bypassPermissions', slash_commands: [...skills, 'update-config'], skills: [...skills, 'update-config'], agents,
    apiKeySource: 'environment', claude_code_version: '2.1.308',
  });
  if (behaviour === 'timeout') {
    setInterval(() => {}, 1000);
    return;
  }
  if (behaviour === 'api-error') {
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'overloaded', session_id: sessionId });
    process.exit(1);
  }

  if (behaviour === 'budget') {
    // The harness stopped at --max-budget-usd: a failure result with the budget subtype, after some spend.
    emit({
      type: 'result', subtype: 'error_max_budget_usd', is_error: true, api_error_status: null, num_turns: 3, session_id: sessionId, total_cost_usd: 1.5,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 300, cacheReadInputTokens: 4000, costUSD: 1.5 } },
    });
    process.exit(1);
  }

  let msg = 0;
  const assistant = (content, extra = {}, parent = null) => emit({
    type: 'assistant', message: { id: `m${n}-${++msg}`, role: 'assistant', model: 'claude-sonnet-5-5', content, ...extra }, parent_tool_use_id: parent, session_id: sessionId,
  });
  const tool = (name, input, extra = {}, parent = null) => assistant([{ type: 'tool_use', id: `tu${n}-${msg + 1}`, name, input }], extra, parent);
  for (const skill of spec.skills || []) tool('Skill', { skill });
  for (const file of spec.reads || []) tool('Read', { file_path: file });
  for (const command of spec.commands || []) tool('Bash', { command });
  if (spec.printEnv) {
    // A model that runs `env`: the credential reaches the transcript, a tool result, the final text and a workspace file.
    const envText = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    tool('Bash', { command: 'env' });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n}-${msg}`, content: envText }] }, session_id: sessionId });
    assistant([{ type: 'text', text: `the key is ${FAKE_KEY_SHAPE}` }]);
    fs.writeFileSync(path.join(process.cwd(), 'env-dump.txt'), `${envText}\n${FAKE_KEY_SHAPE}\n`);
  }
  for (const sub of spec.subagents || []) {
    tool('Agent', { subagent_type: sub.type, description: 'work', prompt: 'work' });
    emit({ type: 'assistant', message: { id: `s${n}-${++msg}`, role: 'assistant', model: sub.model || 'claude-haiku-4-5', content: [{ type: 'tool_use', id: `tus${msg}`, name: 'Bash', input: { command: 'node --version' } }] }, parent_tool_use_id: `tu${n}-${msg - 1}`, session_id: sessionId });
  }
  if (spec.stream) {
    for (let i = 0; i < spec.stream.messages; i++) {
      assistant([{ type: 'text', text: `step ${i}` }], { usage: { input_tokens: spec.stream.perMessage, output_tokens: 0 } });
    }
    if (behaviour === 'hang-after-usage') {
      setInterval(() => {}, 1000);
      return;
    }
  }
  for (const [file, content] of Object.entries(spec.files || {})) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), file), content);
  }
  if (spec.reviewJson !== undefined) fs.writeFileSync(path.join(process.cwd(), 'review.json'), JSON.stringify(spec.reviewJson));
  if (spec.reviewRaw !== undefined) fs.writeFileSync(path.join(process.cwd(), 'review.json'), spec.reviewRaw);

  const asks = n <= (spec.askSegments || 0);
  const text = asks ? 'I made a first pass. Should I continue?' : (spec.finalOffer ? 'Done. Would you like me to add a test file as well?' : 'Done. Everything is in place.');
  assistant([{ type: 'text', text: spec.printEnv ? `${text} token ${env.CLAUDE_CODE_OAUTH_TOKEN}` : text }]);
  const mult = scenario.cumulative === false ? 1 : n;
  const u = spec.usage || { input: 10, output: 100, cacheCreation: 1000, cacheRead: 5000 };
  const main = { input_tokens: u.input * mult, output_tokens: u.output * mult, cache_creation_input_tokens: u.cacheCreation * mult, cache_read_input_tokens: u.cacheRead * mult };
  const modelUsage = {
    'claude-sonnet-5-5': {
      inputTokens: main.input_tokens, outputTokens: main.output_tokens, cacheCreationInputTokens: main.cache_creation_input_tokens,
      cacheReadInputTokens: main.cache_read_input_tokens, costUSD: (spec.costUsd ?? 0.1) * mult,
    },
  };
  for (const sub of spec.subagents || []) {
    const t = (sub.tokens || 500) * mult;
    modelUsage[sub.model || 'claude-haiku-4-5'] = { inputTokens: t, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0.01 * mult };
  }
  emit({
    type: 'result', subtype: 'success', is_error: false, api_error_status: null, duration_ms: 1000 * n, duration_api_ms: 900, num_turns: (spec.commands || []).length + 2,
    result: spec.printEnv ? `${text} token ${env.CLAUDE_CODE_OAUTH_TOKEN}` : text, stop_reason: 'end_turn', session_id: sessionId, total_cost_usd: (spec.costUsd ?? 0.1) * mult + (spec.subagents || []).length * 0.01 * mult,
    usage: main, modelUsage, permission_denials: [], terminal_reason: 'completed',
  });
  process.exit(0);
}

if (argv[0] === '--fake-install') fakeInstall(argv[1]);

if (argv.includes('--version')) {
  dump('version');
  process.stdout.write('fake 0.0.0\n');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => (argv.includes('--output-format') ? claudeMain(prompt) : main(prompt)));
