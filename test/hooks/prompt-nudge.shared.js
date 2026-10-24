'use strict';
// prompt-nudge.shared.js — the scratch layout, hook runners and case helpers the prompt-nudge test
// files share (design CH5, CH6). Not a test file: node's runner never discovers it.
//
// The policies are copied into a scratch install layout (<x>/shared/hooks/policies/ beside
// <x>/runtime/core/registry/workflows.json, IC-006 candidate 1) and run with bash in a scratch git
// repository under a scratch HOME, so a case can inject a broken or missing registry and nothing
// reads the developer's own state. Each test file is its own process, so each gets its own scratch;
// the file registers `after(() => scratch.remove())` itself.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { runPolicyV1 } = require('../helper/hook-fixtures.ts');

const REPO = path.resolve(__dirname, '../..');
const POLICIES = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');

const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // GUARD: needs bash + jq
const scratch = createScratch('doflow-prompt-nudge-');
/** A copy of every policy file at `<dir>/shared/hooks/policies/` and the registry beside it (none when `registryText` is null). */
function installLayout(dir, registryText = fs.readFileSync(REGISTRY, 'utf8')) {
  const dest = path.join(dir, 'shared', 'hooks', 'policies');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(POLICIES)) fs.copyFileSync(path.join(POLICIES, name), path.join(dest, name));
  if (registryText === null) return dest;
  const registry = path.join(dir, 'runtime', 'core', 'registry', 'workflows.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, registryText);
  return dest;
}

const LAYOUT = installLayout(path.join(scratch.dir, 'layout'));

function env(agent, extra = {}) {
  // Harness variables naming the developer's own config folders must not reach the hook.
  return scratch.env({
    DOFLOW_AGENT: agent, CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', GEMINI_CONFIG_DIR: '', DOFLOW_PROJECT_DIR: '', ...extra,
  });
}

let seq = 0;
/** A scratch repository on `main` with one commit; `sha` is its short sha. */
function repo({ git = true } = {}) {
  const dir = path.join(scratch.dir, `repo${seq++}`);
  fs.mkdirSync(dir);
  if (!git) return { dir, sha: '' };
  const run = (...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'first');
  return { dir, sha: run('rev-parse', '--short', 'HEAD') };
}

function runPolicy(layout, script, payload, agent, envExtra = {}) {
  const event = script === 'session-context.sh' ? 'SessionStart' : 'UserPromptSubmit';
  const r = runPolicyV1(script.replace(/\.sh$/, ''), payload, {
    harness: 'claude', event, policyPath: path.join(layout, script), env: env(agent, envExtra),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * One prompt: `session-context.sh` first (unless `start` is false), then the prompt hook. Returns stdout.
 * `envExtra` adds environment variables (for example another XDG_CONFIG_HOME) to both policies.
 */
function prompt(agent, sessionId, cwd, { start = true, extra = {}, layout = LAYOUT, envExtra = {}, source = 'startup' } = {}) {
  if (start) runPolicy(layout, 'session-context.sh', { session_id: sessionId, cwd, source }, agent, envExtra);
  return runPolicy(layout, 'user-prompt-submit.sh', { session_id: sessionId, cwd, ...extra }, agent, envExtra);
}

// ── per-session ───────────────────────────────────────────────────────────────

const MESSAGE = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).promptNudge.message;
const REQUEST = 'add a retry to the upload client in src/upload.js';

let tokenSeq = 0;
let caseTokens = [];
/** A request that qualifies for the nudge and carries a token no file may ever contain (NFR-006). */
function request(extraLine = '') {
  const token = `zqtok${process.pid}x${tokenSeq++}`;
  caseTokens.push(token);
  return `${REQUEST} (${token})${extraLine}`;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '.git') walk(full, visit); } else if (entry.isFile()) visit(full);
  }
}

/** One case; afterwards no file under the scratch directory (outside .git) holds a token the case used. */
function CASE(name, fn, options) {
  HOOK_TEST(name, options, async (t) => {
    caseTokens = [];
    await fn(t);
    const leaks = [];
    walk(scratch.dir, (file) => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      for (const token of caseTokens) if (text.includes(token)) leaks.push(`${file} holds ${token}`);
    });
    assert.deepStrictEqual(leaks, [], 'the prompt text reached a file');
  });
}

const out = (stdout) => JSON.parse(stdout).hookSpecificOutput;
const markerFile = (id, xdg = scratch.xdg) => path.join(xdg, 'doflow', 'session-env', 'nudge', id);
const markerText = (id, xdg) => { try { return fs.readFileSync(markerFile(id, xdg), 'utf8'); } catch { return null; } };
const sessionFolder = (id, xdg = scratch.xdg) => path.join(xdg, 'doflow', 'session-env', 'sessions', id);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
let layoutSeq = 0;
/** An install-shaped layout of its own (the registry is IC-006 candidate 1); `null` leaves out the registry. */
const ownLayout = (registryText) => installLayout(path.join(scratch.dir, `own${layoutSeq++}`, 'x'), registryText);
const registryWith = (change) => { const r = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); change(r); return JSON.stringify(r); };

/** The first-prompt context this repository gets from a non-qualifying prompt (no nudge, no marker). */
function plainContext(agent, cwd, id) {
  return out(prompt(agent, id, cwd, { extra: { prompt: 'hi' } })).additionalContext;
}
const AS_ROOT = Boolean(process.getuid && process.getuid() === 0);

module.exports = {
  REPO, POLICIES, REGISTRY, HOOK_TEST, scratch, installLayout, LAYOUT, env, repo, runPolicy, prompt,
  MESSAGE, REQUEST, request, walk, CASE, out, markerFile, markerText, sessionFolder, write, git,
  ownLayout, registryWith, plainContext, AS_ROOT, suiteTempDir,
};
