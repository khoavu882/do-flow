'use strict';
const { bashPath } = require('../helper/bash-locator.ts');
// prompt-nudge-process.test.js — `per-session`: relative cwd, no node/doflow-run process, NFR-002 prompt-size bound, and the Claude front door through an install mirror.
const { describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPolicyV1 } = require('../helper/hook-fixtures.ts');
const {
  scratch, LAYOUT, REGISTRY, MESSAGE, REPO, POLICIES, CASE, env, repo, prompt, request, out, markerText, sessionFolder, write, git, ownLayout, registryWith, plainContext, runPolicy, walk, AS_ROOT, suiteTempDir
} = require('./prompt-nudge.shared.ts');

after(() => scratch.remove());

describe('per-session', () => {
  CASE('a cwd without a leading / ends: the first qualifying prompt keeps its context and is nudged', () => {
    const base = suiteTempDir('doflow-prompt-nudge-relcwd-');
    const rel = path.join(base, 'relrepo');
    fs.mkdirSync(rel);
    git(rel, 'init', '-q', '-b', 'main');
    git(rel, 'commit', '-q', '--allow-empty', '-m', 'first');
    // Run from `base` with a hard limit: a walk that never ends fails here instead of hanging the suite.
    const run = (script: any, payload: any) => {
      const r = runPolicyV1(script.replace(/\.sh$/, ''), payload, {
        harness: 'claude', event: script === 'session-context.sh' ? 'SessionStart' : 'UserPromptSubmit',
        policyPath: path.join(LAYOUT, script), cwd: base, env: env('claude'), timeout: 5000,
      });
      assert.equal(r.error && r.error.code, undefined, `${script} with cwd ${payload.cwd} did not finish in 5 s`);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const shapes = [['relrepo', 'Git context — branch: main |'], ['relative/dir', 'Not a git repository.'], ['C:\\Work\\dev\\proj', 'Not a git repository.']];
    shapes.forEach(([cwd, context], i) => {
      const id = `ps-relcwd-${i}`;
      run('session-context.sh', { session_id: id, cwd, source: 'startup' });
      const o = out(run('user-prompt-submit.sh', { session_id: id, cwd, prompt: request() }));
      assert.ok(o.additionalContext.startsWith(context), `${cwd}: ${o.additionalContext}`);
      assert.ok(o.additionalContext.endsWith(`\n\n${MESSAGE}`), `${cwd}: ${o.additionalContext}`);
      assert.strictEqual(markerText(id), 'nudged\n', cwd);
    });
  });

  CASE('the hook never starts node or doflow-run', () => {
    const shims = path.join(scratch.dir, 'shims');
    const trace = path.join(shims, 'called');
    for (const name of ['node', 'doflow-run', 'doflow']) {
      write(path.join(shims, name), `#!/bin/sh\necho ${name} >> "${trace}"\nexit 1\n`);
      fs.chmodSync(path.join(shims, name), 0o755);
    }
    const { dir } = repo();
    for (const agent of ['claude', 'codex']) {
      const envExtra = { PATH: `${shims}:${process.env.PATH}` };
      const o = out(prompt(agent, `ps-noproc-${agent}`, dir, { envExtra, extra: { prompt: request() } }));
      assert.ok(o.additionalContext.endsWith(MESSAGE), agent);
    }
    assert.ok(!fs.existsSync(trace), 'a shim was called');
    const text = fs.readFileSync(path.join(POLICIES, 'user-prompt-submit.sh'), 'utf8');
    assert.ok(!/\b(doflow-run|node)\b/.test(text.replace(/^#.*$/gm, '')), 'the hook names node or doflow-run');
  });

  // NFR-002: the hook's time must not grow with the prompt. Wall time on a shared machine swings
  // with load, so the check compares two prompt sizes measured interleaved in the same run: the
  // median of seven 200 KB prompts against the median of seven 2 KB prompts carrying the same
  // request, on a first prompt and on a later one, must stay under LONG_SHORT_BOUND. With the
  // whole-prompt decision program the ratio was 1.9 to 2.1 (first) and 2.9 (later) on a loaded
  // machine; with the bounded one and the single payload read, about 1.2 to 1.4 for both. The
  // absolute medians are printed, never asserted.
  const LONG_SHORT_BOUND = 2;
  CASE('a 200 KB prompt costs the hook less than twice a 2 KB prompt with the same request', (t: any) => {
    const { dir } = repo();
    const line = '2026-10-09T10:00:01 INFO worker[7] processed batch 12 in 12ms (queue=4, retries=0)\n';
    const body = (n: any) => line.repeat(Math.ceil(n / line.length)).slice(0, n);
    let run = 0;
    const timed = (size: any, later: any) => {
      const id = `ps-size-${run++}`;
      runPolicy(LAYOUT, 'session-context.sh', { session_id: id, cwd: dir, source: 'startup' }, 'claude');
      if (later) runPolicy(LAYOUT, 'user-prompt-submit.sh', { session_id: id, cwd: dir, prompt: 'hi' }, 'claude');
      const payload = { session_id: id, cwd: dir, prompt: `${request()}\n${body(size)}` };
      const start = process.hrtime.bigint();
      const r = runPolicyV1('user-prompt-submit', payload, { harness: 'claude', event: 'UserPromptSubmit', policyPath: path.join(LAYOUT, 'user-prompt-submit.sh'), env: env('claude') });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(r.status, 0, r.stderr);
      assert.ok(out(r.stdout).additionalContext.endsWith(MESSAGE), `${size} bytes, ${later ? 'later' : 'first'} prompt: no nudge`);
      return ms;
    };
    timed(20 * 1024, false); // the memo's 20 KB shape is decided too (and warms the caches)
    const median = (xs: any) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    for (const later of [false, true]) {
      const short = [];
      const long = [];
      for (let i = 0; i < 7; i += 1) { short.push(timed(2 * 1024, later)); long.push(timed(200 * 1024, later)); }
      const [s, l] = [median(short), median(long)];
      const which = later ? 'later' : 'first';
      t.diagnostic(`prompt-nudge ${which} prompt: 2 KB median ${s.toFixed(1)} ms, 200 KB median ${l.toFixed(1)} ms, ratio ${(l / s).toFixed(2)}`);
      if (process.platform !== 'win32') assert.ok(l / s < LONG_SHORT_BOUND, `${which} prompt: 200 KB ${l.toFixed(1)} ms vs 2 KB ${s.toFixed(1)} ms`);
    }
  });

  CASE('the Claude front door nudges through an install-shaped mirror', () => {
    const mirror = path.join(scratch.dir, 'mirror');
    const built = spawnSync(bashPath(), [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const registry = path.join(scratch.home, '.doflow', 'runtime', 'core', 'registry', 'workflows.json'); // IC-006 candidate 4
    write(registry, fs.readFileSync(REGISTRY, 'utf8'));
    const { dir } = repo();
    const id = 'ps-front-door';
    const run = (script: any, payload: any) => {
      const r = spawnSync(bashPath(), [path.join(mirror, '.claude', 'hooks', script)], { input: JSON.stringify(payload), env: scratch.env({ CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '' }), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    run('session-start.sh', { session_id: id, cwd: dir, source: 'startup' });
    const o = out(run('user-prompt-submit.sh', { session_id: id, cwd: dir, prompt: request() }));
    assert.ok(o.additionalContext.endsWith(`\n\n${MESSAGE}`), o.additionalContext);
    fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  });
});
