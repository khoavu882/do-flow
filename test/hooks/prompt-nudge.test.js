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
// `per-session`: the once-per-session `/do` nudge through the real hook (IC-001, IC-003, IC-004).
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
  const r = spawnSync('bash', [path.join(layout, script)], { input: JSON.stringify(payload), env: env(agent, envExtra), encoding: 'utf8' });
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

  HOOK_TEST('Codex first prompt: exactly hookEventName and additionalContext, pretty-printed with a two-space indent and a final newline', () => {
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

describe('per-session', () => {
  for (const agent of ['claude', 'codex']) {
    CASE(`${agent}: a qualifying first prompt gets the git block, a blank line and the message in one envelope`, () => {
      const { dir } = repo();
      const base = plainContext(agent, dir, `ps-base-${agent}`);
      const stdout = prompt(agent, `ps-first-${agent}`, dir, { extra: { prompt: request() } });
      const parsed = JSON.parse(stdout);
      assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
      assert.strictEqual(parsed.hookSpecificOutput.additionalContext, `${base}\n\n${MESSAGE}`);
      assert.deepStrictEqual(Object.keys(parsed.hookSpecificOutput),
        agent === 'codex' ? ['hookEventName', 'additionalContext'] : ['hookEventName', 'additionalContext', 'sessionTitle']);
      assert.strictEqual(markerText(`ps-first-${agent}`), 'nudged\n');
    });

    CASE(`${agent}: a non-qualifying first prompt gets the git block only and no marker`, () => {
      const { dir } = repo();
      const stdout = prompt(agent, `ps-plain-${agent}`, dir, { extra: { prompt: 'what does src/upload.js do?' } });
      const o = out(stdout);
      assert.ok(o.additionalContext.startsWith('Git context — branch: main |'));
      assert.ok(!o.additionalContext.includes(MESSAGE));
      assert.strictEqual(markerText(`ps-plain-${agent}`), null);
      // Codex: the pretty-printed shape `jq -n` gives (a round trip, not a comparison with an older hook).
      if (agent === 'codex') assert.strictEqual(stdout, JSON.stringify(JSON.parse(stdout), null, 2) + '\n');
    });

    CASE(`${agent}: a second qualifying prompt in the same session prints {}`, () => {
      const { dir } = repo();
      const id = `ps-twice-${agent}`;
      prompt(agent, id, dir, { extra: { prompt: request() } });
      assert.deepStrictEqual(JSON.parse(prompt(agent, id, dir, { start: false, extra: { prompt: request() } })), {});
      assert.strictEqual(markerText(id), 'nudged\n');
    });

    CASE(`${agent}: two session ids in one repository are each nudged once`, () => {
      const { dir } = repo();
      for (const id of [`ps-two-a-${agent}`, `ps-two-b-${agent}`]) {
        assert.ok(out(prompt(agent, id, dir, { extra: { prompt: request() } })).additionalContext.endsWith(MESSAGE), id);
        assert.deepStrictEqual(JSON.parse(prompt(agent, id, dir, { start: false, extra: { prompt: request() } })), {}, id);
      }
    });

    CASE(`${agent}: a session that opens with hi and then sends a request is nudged once, with the message alone`, () => {
      const { dir } = repo();
      const id = `ps-later-${agent}`;
      prompt(agent, id, dir, { extra: { prompt: 'hi' } });
      const stdout = prompt(agent, id, dir, { start: false, extra: { prompt: request() } });
      assert.deepStrictEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: MESSAGE } });
      assert.deepStrictEqual(JSON.parse(prompt(agent, id, dir, { start: false, extra: { prompt: request() } })), {});
      assert.strictEqual(markerText(id), 'nudged\n');
    });
  }

  CASE('a later non-qualifying prompt prints {} and leaves the session open to a nudge', () => {
    const { dir } = repo();
    const id = 'ps-later-plain';
    prompt('claude', id, dir, { extra: { prompt: 'hi' } });
    assert.deepStrictEqual(JSON.parse(prompt('claude', id, dir, { start: false, extra: { prompt: 'thanks' } })), {});
    assert.strictEqual(markerText(id), null);
  });

  CASE('SessionStart re-run after compaction re-sends the context and gives no second nudge', () => {
    const { dir } = repo();
    const id = 'ps-compact';
    const first = out(prompt('claude', id, dir, { extra: { prompt: request() } }));
    assert.ok(first.additionalContext.endsWith(MESSAGE));
    const again = out(prompt('claude', id, dir, { source: 'compact', extra: { prompt: request() } }));
    assert.ok(again.additionalContext.startsWith('Git context — branch: main |'));
    assert.ok(!again.additionalContext.includes(MESSAGE));
  });

  CASE('a resumed session with the same session id is not nudged again', () => {
    const { dir } = repo();
    const id = 'ps-resume';
    prompt('codex', id, dir, { extra: { prompt: request() } });
    fs.rmSync(sessionFolder(id), { recursive: true, force: true }); // what SessionEnd removes
    const resumed = out(prompt('codex', id, dir, { extra: { prompt: request() } }));
    assert.ok(resumed.additionalContext.startsWith('Git context — branch: main |'));
    assert.ok(!resumed.additionalContext.includes(MESSAGE));
    assert.strictEqual(markerText(id), 'nudged\n');
  });

  CASE('a feature folder for the branch gives no nudge and marker suppressed', () => {
    const { dir } = repo();
    git(dir, 'checkout', '-q', '-b', 'feat/900-demo');
    fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', '900-demo'), { recursive: true });
    const id = 'ps-feature';
    const o = out(prompt('claude', id, dir, { extra: { prompt: request() } }));
    assert.ok(!o.additionalContext.includes(MESSAGE));
    assert.strictEqual(markerText(id), 'suppressed\n');
    assert.deepStrictEqual(JSON.parse(prompt('claude', id, dir, { start: false, extra: { prompt: request() } })), {});
  });

  CASE('a run-ledger record newer than the session start gives no nudge and marker suppressed', () => {
    const { dir } = repo();
    write(path.join(dir, '.doflow', 'state', 'runs', '2999-01-01.jsonl'), '{"timestamp":"2999-01-01T00:00:00Z","event":"x"}\n');
    const id = 'ps-ledger';
    const o = out(prompt('codex', id, dir, { extra: { prompt: request() } }));
    assert.ok(!o.additionalContext.includes(MESSAGE));
    assert.strictEqual(markerText(id), 'suppressed\n');
  });

  CASE('a run-ledger record older than the session start does not suppress', () => {
    const { dir } = repo();
    write(path.join(dir, '.doflow', 'state', 'runs', '2001-01-01.jsonl'), '{"timestamp":"2001-01-01T00:00:00Z","event":"x"}\n');
    assert.ok(out(prompt('claude', 'ps-ledger-old', dir, { extra: { prompt: request() } })).additionalContext.endsWith(MESSAGE));
  });

  CASE('a prompt that mentions /do-plan writes suppressed and a later request is silent', () => {
    const { dir } = repo();
    const id = 'ps-slash-do';
    const first = out(prompt('claude', id, dir, { extra: { prompt: request(' then run /do-plan') } }));
    assert.ok(!first.additionalContext.includes(MESSAGE));
    assert.strictEqual(markerText(id), 'suppressed\n');
    assert.deepStrictEqual(JSON.parse(prompt('claude', id, dir, { start: false, extra: { prompt: request() } })), {});
  });

  CASE('a payload with a non-empty agent_id or agent_type, of any type, gives no nudge and no marker', () => {
    const { dir } = repo();
    const subagents = [
      ['ps-agent-id', { agent_id: 'sub-1' }], ['ps-agent-type', { agent_type: 'Explore' }],
      ['ps-agent-num', { agent_id: 7 }], ['ps-agent-bool', { agent_type: true }], ['ps-agent-obj', { agent_id: { n: 1 } }],
    ];
    for (const [id, extra] of subagents) {
      const o = out(prompt('claude', id, dir, { extra: { prompt: request(), ...extra } }));
      assert.ok(!o.additionalContext.includes(MESSAGE), id);
      assert.strictEqual(markerText(id), null, id);
    }
    // A null or empty value is no subagent.
    const o = out(prompt('claude', 'ps-agent-none', dir, { extra: { prompt: request(), agent_id: null, agent_type: '' } }));
    assert.ok(o.additionalContext.endsWith(MESSAGE));
  });

  CASE('a NUL inside a payload field is dropped and shifts no other field', () => {
    const { dir, sha } = repo();
    runPolicy(LAYOUT, 'session-context.sh', { session_id: 'psnulid', cwd: dir, source: 'startup' }, 'claude');
    const stdout = runPolicy(LAYOUT, 'user-prompt-submit.sh', { session_id: 'psnul\u0000id', cwd: dir, session_title: '\u0000', prompt: request() }, 'claude');
    const o = out(stdout);
    assert.ok(o.additionalContext.startsWith('Git context — branch: main |'), o.additionalContext);
    assert.strictEqual(o.sessionTitle, `main — ${sha}`, 'the cwd did not move into session_title');
    assert.ok(o.additionalContext.endsWith(MESSAGE));
    assert.strictEqual(markerText('psnulid'), 'nudged\n');
  });

  CASE('opt-out: project on beats user off, project off beats user on, user off alone silences', () => {
    const settings = [
      { project: 'on', user: 'off', nudged: true },
      { project: 'off', user: 'on', nudged: false },
      { project: null, user: 'off', nudged: false },
      { project: null, user: null, nudged: true },
    ];
    settings.forEach(({ project, user, nudged }, i) => {
      const { dir } = repo();
      const xdg = fs.mkdtempSync(path.join(scratch.dir, 'xdg-'));
      if (project) write(path.join(dir, '.doflow', 'prompt-nudge'), `${project}\n`);
      if (user) write(path.join(xdg, 'doflow', 'prompt-nudge'), `${user}\n`);
      const id = `ps-setting-${i}`;
      const o = out(prompt('claude', id, dir, { envExtra: { XDG_CONFIG_HOME: xdg }, extra: { prompt: request() } }));
      assert.strictEqual(o.additionalContext.includes(MESSAGE), nudged, JSON.stringify({ project, user }));
      assert.strictEqual(markerText(id, xdg), nudged ? 'nudged\n' : null, JSON.stringify({ project, user }));
      assert.ok(o.additionalContext.startsWith('Git context'), 'the opt-out never touches the first-prompt context');
    });
  });

  const AS_ROOT = Boolean(process.getuid && process.getuid() === 0);

  CASE('an empty or unknown setting counts as off', () => {
    for (const [i, content] of ['', 'maybe\n', '\n'].entries()) {
      const { dir } = repo();
      write(path.join(dir, '.doflow', 'prompt-nudge'), content);
      assert.ok(!out(prompt('claude', `ps-badsetting-${i}`, dir, { extra: { prompt: request() } })).additionalContext.includes(MESSAGE), JSON.stringify(content));
    }
  });

  CASE('an unreadable setting counts as off', () => {
    const { dir } = repo();
    const file = write(path.join(dir, '.doflow', 'prompt-nudge'), 'on\n');
    fs.chmodSync(file, 0);
    try {
      const o = out(prompt('claude', 'ps-unreadable-setting', dir, { extra: { prompt: request() } }));
      assert.ok(o.additionalContext.startsWith('Git context — branch: main |'));
      assert.ok(!o.additionalContext.includes(MESSAGE));
      assert.strictEqual(markerText('ps-unreadable-setting'), null);
    } finally { fs.chmodSync(file, 0o644); }
  }, { skip: AS_ROOT ? 'root reads any file' : false });

  describe('failures are silent', () => {
    const broken = {
      'no registry at any candidate': () => ownLayout(null),
      'a registry without promptNudge': () => ownLayout(registryWith((r) => { delete r.promptNudge; })),
      'a pathPattern that does not compile': () => ownLayout(registryWith((r) => { r.promptNudge.pathPattern = '('; })),
      'an empty message': () => ownLayout(registryWith((r) => { r.promptNudge.message = ''; })),
      'a message that is not a string': () => ownLayout(registryWith((r) => { r.promptNudge.message = 7; })),
      'an unparsable registry': () => ownLayout('{ not json'),
    };
    for (const [name, make] of Object.entries(broken)) {
      for (const agent of ['claude', 'codex']) {
        CASE(`${agent}: ${name}: exit 0, the context unchanged, no marker`, () => {
          const { dir } = repo();
          const base = plainContext(agent, dir, `ps-brk-base-${agent}`);
          const id = `ps-brk-${agent}`;
          const o = out(prompt(agent, id, dir, { layout: make(), extra: { prompt: request() } }));
          assert.strictEqual(o.additionalContext, base);
          assert.strictEqual(markerText(id), null);
        });
      }
    }

    CASE('an unreadable registry is silent', () => {
      const layout = ownLayout();
      const registry = path.join(layout, '..', '..', '..', 'runtime', 'core', 'registry', 'workflows.json');
      fs.chmodSync(registry, 0);
      try {
        const { dir } = repo();
        const o = out(prompt('claude', 'ps-unreadable-registry', dir, { layout, extra: { prompt: request() } }));
        assert.ok(o.additionalContext.startsWith('Git context'));
        assert.ok(!o.additionalContext.includes(MESSAGE));
        assert.strictEqual(markerText('ps-unreadable-registry'), null);
      } finally { fs.chmodSync(registry, 0o644); }
    }, { skip: AS_ROOT ? 'root reads any file' : false });

    CASE('an unwritable marker folder gives no nudge, and the context is unchanged', () => {
      const { dir } = repo();
      const xdg = fs.mkdtempSync(path.join(scratch.dir, 'xdg-'));
      const nudgeDir = path.join(xdg, 'doflow', 'session-env', 'nudge');
      fs.mkdirSync(nudgeDir, { recursive: true });
      fs.chmodSync(nudgeDir, 0o500);
      try {
        const o = out(prompt('claude', 'ps-readonly', dir, { envExtra: { XDG_CONFIG_HOME: xdg }, extra: { prompt: request() } }));
        assert.ok(o.additionalContext.startsWith('Git context — branch: main |'));
        assert.ok(!o.additionalContext.includes(MESSAGE));
        assert.deepStrictEqual(fs.readdirSync(nudgeDir), []);
      } finally { fs.chmodSync(nudgeDir, 0o700); }
    }, { skip: AS_ROOT ? 'root writes any folder' : false });

    CASE('an empty, whitespace-only, missing or non-string prompt is silent with no marker', () => {
      const { dir } = repo();
      const variants = [{ prompt: '' }, { prompt: '  \n\t ' }, {}, { prompt: 42 }, { prompt: null }];
      variants.forEach((extra, i) => {
        const id = `ps-empty-${i}`;
        const o = out(prompt('claude', id, dir, { extra }));
        assert.ok(o.additionalContext.startsWith('Git context — branch: main |'), JSON.stringify(extra));
        assert.ok(!o.additionalContext.includes(MESSAGE), JSON.stringify(extra));
        assert.strictEqual(markerText(id), null, JSON.stringify(extra));
      });
    });

    CASE('an unsafe session id gets no nudge and the context path still runs', () => {
      const { dir } = repo();
      for (const [i, id] of ['a b', '../ps-escape', 'x'.repeat(129)].entries()) {
        const o = out(prompt('claude', id, dir, { start: false, extra: { prompt: request() } }));
        assert.strictEqual(o.additionalContext, 'Git context unavailable for this session.', `case ${i}`);
      }
      // No marker for these ids anywhere: inside nudge/ or where `../` would lead.
      const markers = [];
      walk(path.join(scratch.xdg, 'doflow', 'session-env'), (file) => {
        const base = path.basename(file);
        if (base === 'a b' || base === 'ps-escape' || base.startsWith('xxxx')) markers.push(file);
      });
      assert.deepStrictEqual(markers, []);
    });
  });

  CASE('a cwd without a leading / ends: the first qualifying prompt keeps its context and is nudged', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(scratch.dir, 'relcwd-')));
    const rel = path.join(base, 'relrepo');
    fs.mkdirSync(rel);
    git(rel, 'init', '-q', '-b', 'main');
    git(rel, 'commit', '-q', '--allow-empty', '-m', 'first');
    // Run from `base` with a hard limit: a walk that never ends fails here instead of hanging the suite.
    const run = (script, payload) => {
      const r = spawnSync('bash', [path.join(LAYOUT, script)], {
        cwd: base, input: JSON.stringify(payload), env: env('claude'), encoding: 'utf8', timeout: 5000,
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
  CASE('a 200 KB prompt costs the hook less than twice a 2 KB prompt with the same request', (t) => {
    const { dir } = repo();
    const line = '2026-10-09T10:00:01 INFO worker[7] processed batch 12 in 12ms (queue=4, retries=0)\n';
    const body = (n) => line.repeat(Math.ceil(n / line.length)).slice(0, n);
    let run = 0;
    const timed = (size, later) => {
      const id = `ps-size-${run++}`;
      runPolicy(LAYOUT, 'session-context.sh', { session_id: id, cwd: dir, source: 'startup' }, 'claude');
      if (later) runPolicy(LAYOUT, 'user-prompt-submit.sh', { session_id: id, cwd: dir, prompt: 'hi' }, 'claude');
      const payload = { session_id: id, cwd: dir, prompt: `${request()}\n${body(size)}` };
      const start = process.hrtime.bigint();
      const r = spawnSync('bash', [path.join(LAYOUT, 'user-prompt-submit.sh')], { input: JSON.stringify(payload), env: env('claude'), encoding: 'utf8' });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(r.status, 0, r.stderr);
      assert.ok(out(r.stdout).additionalContext.endsWith(MESSAGE), `${size} bytes, ${later ? 'later' : 'first'} prompt: no nudge`);
      return ms;
    };
    timed(20 * 1024, false); // the memo's 20 KB shape is decided too (and warms the caches)
    const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
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
    const built = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const registry = path.join(scratch.home, '.doflow', 'runtime', 'core', 'registry', 'workflows.json'); // IC-006 candidate 4
    write(registry, fs.readFileSync(REGISTRY, 'utf8'));
    const { dir } = repo();
    const id = 'ps-front-door';
    const run = (script, payload) => {
      const r = spawnSync('bash', [path.join(mirror, '.claude', 'hooks', script)], { input: JSON.stringify(payload), env: scratch.env({ CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '' }), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    run('session-start.sh', { session_id: id, cwd: dir, source: 'startup' });
    const o = out(run('user-prompt-submit.sh', { session_id: id, cwd: dir, prompt: request() }));
    assert.ok(o.additionalContext.endsWith(`\n\n${MESSAGE}`), o.additionalContext);
    fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true });
  });
});

// ── corpus ────────────────────────────────────────────────────────────────────
//
// IC-012 / IC-013: every prompt in the corpus goes through IC-005's invocation against the shipped
// registry. A `silent` case must not nudge; recall is reported and never asserted (D-2).

const CORPUS = path.join(__dirname, 'prompt-nudge.corpus.json');
const PROGRAM = path.join(POLICIES, 'prompt-nudge.jq');
const TAGS = ['positive', 'question', 'slash', 'stall', 'review', 'how-why-what-explain', 'contains-do', 'short', 'empty', 'non-english', 'near-miss'];
const REQUIRED_SILENT_TAGS = ['question', 'slash', 'stall', 'review', 'how-why-what-explain', 'contains-do'];
const ORIGINS = ['rules-aware', 'rules-blind'];
const BLIND_SILENT_FLOOR = 20;

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
}

/** IC-005's invocation for one prompt; returns the spawn result. */
function decideCorpusCase(prompt) {
  return spawnSync('jq', ['-r', '--slurpfile', 'R', REGISTRY, '-f', PROGRAM], {
    input: JSON.stringify({ session_id: 'corpus', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt }),
    env: scratch.env(),
    encoding: 'utf8',
  });
}

/** Every IC-012 violation in `doc`, as strings (empty when the file is valid). */
function corpusProblems(doc) {
  const problems = [];
  if (doc === null || typeof doc !== 'object' || doc.version !== 1) problems.push('version must be 1');
  const cases = doc && Array.isArray(doc.cases) ? doc.cases : null;
  if (!cases) return [...problems, 'cases must be an array'];
  const seen = new Set();
  cases.forEach((c, i) => {
    const where = `case ${i} (${c && c.id})`;
    if (c === null || typeof c !== 'object') { problems.push(`${where}: not an object`); return; }
    if (typeof c.id !== 'string' || !/^(pos|neg)-\d{3,}$/.test(c.id)) problems.push(`${where}: id must be pos-NNN or neg-NNN`);
    if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    seen.add(c.id);
    if (typeof c.prompt !== 'string') problems.push(`${where}: prompt must be a string`);
    if (c.expect !== 'nudge' && c.expect !== 'silent') problems.push(`${where}: expect must be nudge or silent`);
    if (!TAGS.includes(c.tag)) problems.push(`${where}: tag ${JSON.stringify(c.tag)} is not in the closed set`);
    if (!ORIGINS.includes(c.origin)) problems.push(`${where}: origin ${JSON.stringify(c.origin)} is not rules-aware or rules-blind`);
    if (typeof c.id === 'string' && c.id.startsWith('pos-') && c.expect !== 'nudge') problems.push(`${where}: pos- ids take expect nudge`);
    if (typeof c.id === 'string' && c.id.startsWith('neg-') && c.expect !== 'silent') problems.push(`${where}: neg- ids take expect silent`);
    if ((c.tag === 'positive') !== (c.expect === 'nudge')) problems.push(`${where}: tag positive goes with expect nudge, and only with it`);
  });
  const silent = cases.filter((c) => c && c.expect === 'silent');
  for (const tag of REQUIRED_SILENT_TAGS) {
    if (!silent.some((c) => c.tag === tag)) problems.push(`content floor: no silent case tagged ${tag}`);
  }
  const blind = silent.filter((c) => c.origin === 'rules-blind').length;
  if (blind < BLIND_SILENT_FLOOR) problems.push(`content floor: ${blind} rules-blind silent cases, need ${BLIND_SILENT_FLOOR}`);
  return problems;
}

describe('corpus', () => {
  HOOK_TEST('the corpus file holds valid IC-012 cases and meets the content floor', () => {
    assert.deepStrictEqual(corpusProblems(loadCorpus()), []);
  });

  HOOK_TEST('no silent case nudges; recall is printed, never asserted', (t) => {
    const { cases } = loadCorpus();
    const errors = [];
    const falseNudges = [];
    const recall = { all: [0, 0], 'rules-aware': [0, 0], 'rules-blind': [0, 0] };
    for (const c of cases) {
      const r = decideCorpusCase(c.prompt);
      if (r.status !== 0 || !/^(nudge|suppress|)\n$/.test(r.stdout)) {
        errors.push(`${c.id}: jq exit ${r.status} ${r.stderr.trim()} ${JSON.stringify(r.stdout)}`);
        continue;
      }
      const nudged = r.stdout === 'nudge\n';
      if (c.expect === 'silent' && nudged) falseNudges.push(c.id);
      if (c.expect === 'nudge') {
        for (const key of ['all', c.origin]) { recall[key][1] += 1; if (nudged) recall[key][0] += 1; }
      }
    }
    for (const [key, [n, m]] of Object.entries(recall)) {
      t.diagnostic(`prompt-nudge recall ${key} ${n}/${m} = ${m ? (n / m).toFixed(2) : 'n/a'}`);
    }
    assert.deepStrictEqual(errors, [], 'the decision program failed on these cases');
    assert.deepStrictEqual(falseNudges, [], `silent cases that nudged: ${falseNudges.join(', ')}`);
  });
});
