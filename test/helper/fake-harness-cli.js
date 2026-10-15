#!/usr/bin/env node
'use strict';

// fake-harness-cli.js — feature 081, IC-029 (DEC-036). Test-only, never shipped.
//
// A stand-in for a harness CLI. Tests link this file into a scratch bin/ under each binary name a
// fake descriptor (test/fixtures/worker/descriptors.json) declares, and give the child a PATH of
// that bin/ plus the directory of process.execPath, nothing else (NFR-002, RK9). The fake names are
// `fake-<harness>` so a real harness binary that happens to share the node directory is never hit.
//
// Each invocation appends one JSON line `{ argv, cwd, doflowEnv }` to FAKE_HARNESS_LOG, where
// doflowEnv holds the five DOFLOW_* identity values (null when unset). It then classifies itself by
// argv and runs the steps the scenario file named by FAKE_HARNESS_SCENARIO gives that kind:
//
//   kind               argv
//   version            contains '--version'
//   runnable|hooks|    ['probe', <kind>, ...]
//   guidance|login
//   model-check:<id>   ['model-check', <id>, ...]
//   run                anything else (the IC-003 run recipe)
//
// A scenario is `{ <kind>: [step, ...], byBinary?: { <binary>: { <kind>: [step, ...] } } }`; the
// byBinary entry for the invoked name wins over the top-level kind. A kind with no steps exits 0.
// Steps, run in order:
//
//   { print: 'text' }                       stdout text plus a newline
//   { emit: event | [event, ...] }          one JSON line per IC-016 event on stdout
//   { write: 'rel' | { path, content } }    a file under cwd; a path leaving cwd exits 97
//   { sleep: ms }                           wait
//   { spawnChild: { newGroup?, ms?, pidFile? } }
//                                           a sleeping node child (default 30000 ms), detached into
//                                           its own process group when newGroup; its pid is written
//                                           to pidFile (absolute, or relative to cwd)
//   { ignoreTerm: true }                    SIGTERM is ignored from here on
//   { frontDoors: { mirror, harness, stripEnv?, out?, sessionId?, prompt? } }
//                                           runs <mirror>/.<harness>/hooks/session-start.sh then
//                                           user-prompt-submit.sh with the inherited environment,
//                                           every DOFLOW_* removed when stripEnv; writes
//                                           { sessionStart, userPromptSubmit } (status and stdout of
//                                           each) to out when given; skipped when argv holds
//                                           '--skip-front-doors' (the codex fake's hooksProbe)
//   { exit: code }                          stop and exit with code
//
// The fake descriptors: claude is fully supported (doflow-jsonl-v1, every probe argv, prompt in
// argv); codex takes the prompt on stdin and its hooksProbe skips the front doors; gemini has
// readOnly unknown; opencode has no free hooks probe and one model check, hooks-roundtrip.
//
// Required as a module it exports linkBin, writeScenario and readLog for tests.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const FAKE_CLI = __filename;
const IDENTITY_VARS = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];
const PROBE_KINDS = new Set(['runnable', 'hooks', 'guidance', 'login']);
const ESCAPE_EXIT = 97;

/** The invocation kind for an argv (process.argv without node and the script). */
function kindOf(argv) {
  if (argv.includes('--version')) return 'version';
  if (argv[0] === 'probe' && PROBE_KINDS.has(argv[1])) return argv[1];
  if (argv[0] === 'model-check' && typeof argv[1] === 'string' && argv[1]) return `model-check:${argv[1]}`;
  return 'run';
}

/** The steps a scenario gives one binary name and kind. */
function stepsFor(scenario, binary, kind) {
  const own = scenario?.byBinary?.[binary];
  if (own && Object.hasOwn(own, kind)) return own[kind];
  return Object.hasOwn(scenario ?? {}, kind) ? scenario[kind] : [];
}

function out(text) {
  fs.writeSync(1, text);
}

/** A path under cwd, or null when it leaves cwd. */
function underCwd(cwd, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const full = path.resolve(cwd, rel);
  const back = path.relative(cwd, full);
  return back && !back.startsWith('..') && !path.isAbsolute(back) ? full : null;
}

function runFrontDoors(spec, cwd) {
  const env = { ...process.env };
  if (spec.stripEnv) for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_')) delete env[key];
  const sessionId = spec.sessionId ?? `fake-${process.pid}`;
  const hooks = path.join(spec.mirror, `.${spec.harness ?? 'claude'}`, 'hooks');
  // The child PATH is a scratch bin/ plus the node directory, so bash is taken from /bin when there.
  const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  const door = (script, payload) => {
    const r = spawnSync(bash, [path.join(hooks, script)], { cwd, env, input: `${JSON.stringify(payload)}\n`, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '' };
  };
  const result = {
    sessionStart: door('session-start.sh', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    userPromptSubmit: door('user-prompt-submit.sh', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: spec.prompt ?? 'continue' }),
  };
  if (spec.out) fs.writeFileSync(path.resolve(cwd, spec.out), `${JSON.stringify(result)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  // The invoked name: the symlink's basename, or the name the win32 shim passes.
  const binary = process.platform === 'win32' && process.env.FAKE_HARNESS_NAME
    ? process.env.FAKE_HARNESS_NAME
    : path.basename(process.argv[1]);
  if (process.env.FAKE_HARNESS_LOG) {
    const doflowEnv = Object.fromEntries(IDENTITY_VARS.map((key) => [key, process.env[key] ?? null]));
    fs.appendFileSync(process.env.FAKE_HARNESS_LOG, `${JSON.stringify({ argv, cwd, doflowEnv })}\n`);
  }
  const scenarioFile = process.env.FAKE_HARNESS_SCENARIO;
  const scenario = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {};

  for (const step of stepsFor(scenario, binary, kindOf(argv))) {
    if (Object.hasOwn(step, 'print')) out(`${step.print}\n`);
    else if (Object.hasOwn(step, 'emit')) for (const event of [].concat(step.emit)) out(`${JSON.stringify(event)}\n`);
    else if (Object.hasOwn(step, 'write')) {
      const spec = typeof step.write === 'string' ? { path: step.write, content: '' } : step.write;
      const full = underCwd(cwd, spec.path);
      if (!full) {
        fs.writeSync(2, `fake-harness-cli: write path leaves cwd: ${spec.path}\n`);
        process.exitCode = ESCAPE_EXIT;
        return;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, spec.content ?? '');
    } else if (Object.hasOwn(step, 'sleep')) await new Promise((resolve) => setTimeout(resolve, step.sleep));
    else if (Object.hasOwn(step, 'spawnChild')) {
      const spec = step.spawnChild ?? {};
      const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(spec.ms ?? 30000)})`], {
        detached: Boolean(spec.newGroup), stdio: 'ignore',
      });
      if (spec.pidFile) fs.writeFileSync(path.resolve(cwd, spec.pidFile), `${child.pid}\n`);
      child.unref();
    } else if (Object.hasOwn(step, 'ignoreTerm')) process.on('SIGTERM', () => {});
    else if (Object.hasOwn(step, 'frontDoors')) {
      if (!argv.includes('--skip-front-doors')) runFrontDoors(step.frontDoors, cwd);
    }
    else if (Object.hasOwn(step, 'exit')) {
      process.exitCode = step.exit;
      return;
    } else {
      fs.writeSync(2, `fake-harness-cli: unknown step ${JSON.stringify(step)}\n`);
      process.exitCode = 98;
      return;
    }
  }
}

/**
 * Links the fake CLI into `dir` under each name in `names` (a `.cmd` shim on win32) and returns the
 * child PATH: `dir` plus the directory of process.execPath, nothing else.
 */
function linkBin(dir, names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@setlocal & set "FAKE_HARNESS_NAME=${name}" & "${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    } else {
      fs.symlinkSync(FAKE_CLI, path.join(dir, name));
    }
  }
  return [dir, path.dirname(process.execPath)].join(path.delimiter);
}

/** Writes `scenario` to `<dir>/scenario.json` and returns that path, for FAKE_HARNESS_SCENARIO. */
function writeScenario(dir, scenario) {
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`);
  return file;
}

/** The parsed lines of a FAKE_HARNESS_LOG file; [] when it does not exist. */
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

if (require.main === module) {
  main().catch((error) => {
    fs.writeSync(2, `fake-harness-cli: ${error.stack ?? error}\n`);
    process.exitCode = 99;
  });
}

module.exports = { FAKE_CLI, IDENTITY_VARS, kindOf, linkBin, writeScenario, readLog };
