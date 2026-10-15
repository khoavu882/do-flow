'use strict';
// prompt-nudge-failures.test.js — `per-session` / `failures are silent`: a broken registry, marker folder, prompt or session id never changes the context.
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
      const xdg = suiteTempDir('doflow-prompt-nudge-xdg-');
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

    CASE('an unsafe session id gets no nudge and the silent response (DEC-032)', () => {
      const { dir } = repo();
      for (const [i, id] of ['a b', '../ps-escape', 'x'.repeat(129)].entries()) {
        assert.deepStrictEqual(JSON.parse(prompt('claude', id, dir, { start: false, extra: { prompt: request() } })), {}, `case ${i}`);
        assert.strictEqual(markerText(id), null, `case ${i}`);
        assert.strictEqual(fs.existsSync(sessionFolder(id)), false, `case ${i}`);
      }
      // No marker or session dir for these ids anywhere: inside nudge/ or where `../` would lead.
      const markers = [];
      walk(path.join(scratch.xdg, 'doflow', 'session-env'), (file) => {
        const base = path.basename(file);
        if (base === 'a b' || base === 'ps-escape' || base.startsWith('xxxx')) markers.push(file);
      });
      assert.deepStrictEqual(markers, []);
    });
  });
});
