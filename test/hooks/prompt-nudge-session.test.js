'use strict';
// prompt-nudge-session.test.js — `per-session`: the once-per-session `/do` nudge through the real hook (IC-001, IC-003, IC-004): envelope, markers, suppression, opt-out.
const { describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  scratch, LAYOUT, REGISTRY, MESSAGE, REPO, POLICIES, CASE, env, repo, prompt, request, out, markerText, sessionFolder, write, git, ownLayout, registryWith, plainContext, runPolicy, walk, AS_ROOT, suiteTempDir
} = require('./prompt-nudge.shared');

after(() => scratch.remove());

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

  for (const agent of ['claude', 'codex']) {
    CASE(`${agent}: a worker session is never nudged, on its first prompt or a later qualifying one, and leaves no marker`, () => {
      const { dir } = repo();
      const id = `ps-worker-${agent}`;
      const envExtra = { DOFLOW_SESSION_ROLE: 'worker' };
      const first = prompt(agent, id, dir, { extra: { prompt: request() }, envExtra });
      assert.deepStrictEqual(JSON.parse(first), {});
      const later = prompt(agent, id, dir, { start: false, extra: { prompt: request() }, envExtra });
      assert.deepStrictEqual(JSON.parse(later), {});
      assert.strictEqual(markerText(id), null);
      // The same session ids' environment, as a main session, is nudged: the role alone made the difference.
      const main = out(prompt(agent, `${id}-main`, dir, { extra: { prompt: request() } }));
      assert.ok(main.additionalContext.endsWith(MESSAGE));
    });
  }

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
      const xdg = suiteTempDir('doflow-prompt-nudge-xdg-');
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
});
