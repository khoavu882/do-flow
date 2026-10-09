'use strict';
// prompt-nudge.test.js — the UserPromptSubmit policy's output (design CH5, CH6).
//
// The policies are copied into a scratch install layout (<x>/shared/hooks/policies/ beside
// <x>/runtime/core/registry/workflows.json, IC-006 candidate 1) and run with bash in a scratch git
// repository under a scratch HOME, so a case can inject a broken or missing registry and nothing
// reads the developer's own state.
//
// `envelope`: the existing first-prompt context leaves in one nested envelope for Claude and Codex
// (IC-002); Claude's top-level `additionalContext` is ignored by Claude Code (memo T1).
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '../..');
const POLICIES = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');

const HOOK_TEST = process.platform !== 'win32' ? test : test.skip; // GUARD: needs bash + jq
const scratch = createScratch('doflow-prompt-nudge-');
after(() => scratch.remove());

/** A copy of every policy file at `<dir>/shared/hooks/policies/` and the registry beside it. */
function installLayout(dir, registryText = fs.readFileSync(REGISTRY, 'utf8')) {
  const dest = path.join(dir, 'shared', 'hooks', 'policies');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(POLICIES)) fs.copyFileSync(path.join(POLICIES, name), path.join(dest, name));
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

function runPolicy(layout, script, payload, agent) {
  const r = spawnSync('bash', [path.join(layout, script)], { input: JSON.stringify(payload), env: env(agent), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** One prompt: `session-context.sh` first (unless `start` is false), then the prompt hook. Returns stdout. */
function prompt(agent, sessionId, cwd, { start = true, extra = {}, layout = LAYOUT } = {}) {
  if (start) runPolicy(layout, 'session-context.sh', { session_id: sessionId, cwd, source: 'startup' }, agent);
  return runPolicy(layout, 'user-prompt-submit.sh', { session_id: sessionId, cwd, ...extra }, agent);
}

describe('envelope', () => {
  HOOK_TEST('Claude first prompt: nested envelope with the context and the session title', () => {
    const { dir, sha } = repo();
    const parsed = JSON.parse(prompt('claude', 'env-claude', dir));
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
    const out = parsed.hookSpecificOutput;
    assert.deepStrictEqual(Object.keys(out), ['hookEventName', 'additionalContext', 'sessionTitle']);
    assert.strictEqual(out.hookEventName, 'UserPromptSubmit');
    assert.ok(out.additionalContext.startsWith('Git context — branch: main |'), out.additionalContext);
    assert.strictEqual(out.sessionTitle, `main — ${sha}`);
  });

  HOOK_TEST('Claude: a payload session_title suppresses sessionTitle, an empty one does not', () => {
    const { dir, sha } = repo();
    const titled = JSON.parse(prompt('claude', 'env-titled', dir, { extra: { session_title: 'mine' } }));
    assert.deepStrictEqual(Object.keys(titled), ['hookSpecificOutput']);
    assert.deepStrictEqual(Object.keys(titled.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    const empty = JSON.parse(prompt('claude', 'env-empty-title', dir, { extra: { session_title: '' } }));
    assert.strictEqual(empty.hookSpecificOutput.sessionTitle, `main — ${sha}`);
  });

  HOOK_TEST('Claude outside a git repository: the context and the no-git title, nested', () => {
    const { dir } = repo({ git: false });
    const parsed = JSON.parse(prompt('claude', 'env-nogit', dir));
    assert.deepStrictEqual(parsed.hookSpecificOutput.additionalContext, 'Not a git repository.');
    assert.strictEqual(parsed.hookSpecificOutput.sessionTitle, 'no-git');
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  });

  HOOK_TEST('Codex first prompt: exactly hookEventName and additionalContext, bytes as jq -n prints them', () => {
    const { dir } = repo();
    const stdout = prompt('codex', 'env-codex', dir, { extra: { session_title: '' } });
    const parsed = JSON.parse(stdout);
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(parsed.hookSpecificOutput.additionalContext.startsWith('Git context — branch: main |'));
    assert.strictEqual(stdout, JSON.stringify(parsed, null, 2) + '\n');
  });

  HOOK_TEST('a second prompt prints {} on both harnesses', () => {
    const { dir } = repo();
    for (const agent of ['claude', 'codex']) {
      const id = `env-second-${agent}`;
      prompt(agent, id, dir);
      assert.deepStrictEqual(JSON.parse(prompt(agent, id, dir, { start: false })), {});
    }
  });

  HOOK_TEST('a session whose SessionStart never ran gets the nested fallback text and no sessionTitle', () => {
    const { dir } = repo();
    for (const agent of ['claude', 'codex']) {
      const parsed = JSON.parse(prompt(agent, `env-nostart-${agent}`, dir, { start: false }));
      assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
      assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
      assert.strictEqual(parsed.hookSpecificOutput.additionalContext, 'Git context unavailable for this session.');
    }
  });
});
