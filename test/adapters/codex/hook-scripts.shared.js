'use strict';

// Shared by codex-hook-scripts.test.js and gemini-hook-scripts.test.js: a real install into a scratch
// HOME and project, and the helpers to read what the hook scripts beside the config did. "Older"
// scripts are the bytes of develop commit 0fcd973 (before the hook envelope), installed by that
// commit's own CLI from `git archive`; its Codex hooks.json and Gemini settings.json hooks key are
// the same bytes as this checkout's, so only the scripts differ.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../../helper/scratch-env.ts');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { IS_WIN } = require('../../helper-platform.ts');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const OLDER = '0fcd973';
const SKIP = IS_WIN ? 'the hook scripts are POSIX shell'
  : (spawnSync('git', ['cat-file', '-e', `${OLDER}^{commit}`], { cwd: REPO }).status === 0 ? false
    : `commit ${OLDER} is absent from this clone, so the older scripts cannot be installed (git fetch --all)`);

/** Where each harness keeps its hook scripts (relative to the project) and the native gate payload. */
const HARNESSES = {
  codex: { hooks: '.codex/hooks', source: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks'),
    payload: { hook_event_name: 'PreToolUse', session_id: 'scripts', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } } },
  gemini: { hooks: '.gemini/hooks', source: path.join(REPO, 'core', 'harnesses', 'gemini', 'hooks'),
    payload: { hook_event_name: 'BeforeTool', session_id: 'scripts', tool_name: 'replace', tool_input: { file_path: 'src/a.js' } } },
};

let olderCli = null;
function olderCliPath() {
  if (olderCli) return olderCli;
  const dir = suiteTempDir('doflow-hook-scripts-older-');
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'older.tar'), OLDER], { cwd: REPO, encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  assert.equal(spawnSync('tar', ['-x', '-f', path.join(dir, 'older.tar'), '-C', dir]).status, 0);
  olderCli = path.join(dir, 'bin', 'doflow.js');
  return olderCli;
}

/** A scratch directory with a `proj/` project and an empty HOME. */
function cell(name) {
  const scratch = createScratch(`doflow-hook-scripts-${name}-`);
  const proj = path.join(scratch.dir, 'proj');
  fs.mkdirSync(proj);
  const run = (args, { cli = CLI, answer = 'y\n' } = {}) => {
    const done = spawnSync(process.execPath, [cli, ...args], { cwd: scratch.dir, env: scratch.env({ DOFLOW_FAILURE_CAPTURE: 'off' }), input: answer, encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, output: `${done.stdout}\n${done.stderr}` };
  };
  return { scratch, proj, run };
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const scriptNames = (harness) => fs.readdirSync(HARNESSES[harness].source).filter((name) => !name.endsWith('.json'));
const installed = (c, harness, name) => path.join(c.proj, HARNESSES[harness].hooks, name);

/** Names of the shipped scripts whose installed bytes differ from the source. */
function staleScripts(c, harness) {
  return scriptNames(harness).filter((name) => !fs.existsSync(installed(c, harness, name))
    || !fs.readFileSync(installed(c, harness, name)).equals(fs.readFileSync(path.join(HARNESSES[harness].source, name))));
}

/** The installed pre-implement-gate door run on an edit in a project with no design.md: its recorded decision. */
function gateDecision(c, harness) {
  const root = path.join(c.scratch.dir, 'no-design');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '077-scripts', 'intention'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '077-scripts', 'intention', 'requirement.md'), '# requirement\n');
    fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '077-scripts', 'plan.md'), '- [ ] C.1 [US1] scripts - owner: test; files: src/a.js\n');
    const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=scripts', '-c', 'user.email=scripts@example.invalid', ...args], { cwd: root, env: c.scratch.env(), encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
    git('init', '-q', '-b', 'feat/077-scripts');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');
  }
  const trace = path.join(c.scratch.dir, `trace-${harness}.jsonl`);
  fs.rmSync(trace, { force: true });
  const ran = spawnSync('bash', [installed(c, harness, 'pre-implement-gate.sh')], { cwd: root, encoding: 'utf8', input: `${JSON.stringify(HARNESSES[harness].payload)}\n`,
    env: c.scratch.env({ DOFLOW_PROJECT_DIR: root, DOFLOW_BRIDGE_TRACE: trace, DOFLOW_FAILURE_CAPTURE: 'off' }) });
  return { status: ran.status, stderr: ran.stderr, decision: fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8').trim().split('\n').pop()) : null };
}

function ledgerRows(c) {
  return JSON.parse(fs.readFileSync(path.join(c.proj, '.doflow', 'state', 'ledger.json'), 'utf8')).resources;
}

module.exports = { REPO, CLI, SKIP, HARNESSES, olderCliPath, cell, sha, scriptNames, installed, staleScripts, gateDecision, ledgerRows };
