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
 *     <spec> = { "behaviour": "ok"|"timeout"|"api-error"|"silent" (default ok),
 *                "files": [...], "truthFiles": k, "decoys": m, "commands": [...],
 *                "tokens": n|null, "outputTokens": n, "message": "<api-error text>" }
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
 *   AGENTIC_FAKE_PIDFILE   where the `timeout` behaviour writes its child sleeper's pid.
 *
 * Events follow the codex-exec-json-v1 shapes the executor's parser reads.
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
    kind, argv, cwd: process.cwd(), envKeys: Object.keys(env).sort(), PATH: env.PATH, HOME: env.HOME,
    harnessHome: harnessHome || null, harnessHomeFiles: files,
    profileMode: env.HOME ? fs.statSync(path.dirname(env.HOME)).mode & 0o777 : null,
    hasGit: fs.existsSync(path.join(process.cwd(), '.git')),
    doflowOnPath: pathDirs.filter((d) => d && fs.existsSync(path.join(d, 'doflow'))),
    doflowFiles: pathDirs.filter((d) => d && fs.existsSync(path.join(d, 'doflow'))).map((dir) => {
      const stat = fs.statSync(path.join(dir, 'doflow'));
      return { dir, mode: stat.mode & 0o777, text: stat.size < 1000 ? fs.readFileSync(path.join(dir, 'doflow'), 'utf8') : null };
    }),
    ...extra,
  };
  fs.appendFileSync(env.AGENTIC_FAKE_DUMP, `${JSON.stringify(record)}\n`);
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

  for (const command of spec.commands || []) {
    emit({ type: 'item.completed', item: { type: 'command_execution', command, status: 'completed' } });
  }
  const text = JSON.stringify({ files: answerFiles(spec, truth) });
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  const out = argv.indexOf('-o');
  if (out !== -1 && argv[out + 1]) fs.writeFileSync(argv[out + 1], text);
  if (Number.isInteger(spec.tokens)) {
    const output = Math.min(spec.tokens, spec.outputTokens ?? 100);
    emit({ type: 'turn.completed', usage: { input_tokens: spec.tokens - output, output_tokens: output } });
  } else {
    emit({ type: 'turn.completed' });
  }
  process.exit(0);
}

if (argv.includes('--version')) {
  dump('version');
  process.stdout.write('fake 0.0.0\n');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => main(prompt));
