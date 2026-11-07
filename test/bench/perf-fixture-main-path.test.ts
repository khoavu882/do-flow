'use strict';

// FU-r2td5n: a hook perf fixture that makes its policy exit at an early guard measures the guard, not the policy.
// Each executable shared policy names one command that its xtrace shows only after the guards for its fixture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const budgets = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'bench', 'perf', 'budgets.json'), 'utf8'));

// stem -> text in the policy's xtrace that appears only past the early-exit guards the fixture must clear.
const MAIN_PATH_MARKER: Record<string, RegExp> = {
  'mcp-tool-guard': /\+ POLICY_FILE=/, // after the v1 `operation == mcp` check, before the pattern loop
  'pre-implementation-gate': /branch --show-current/, // after the `operation == edit` check and path handling
  'session-context': /\+ SESSION_PATH=/, // after the session id guard
  'stop-check': /\+ STUB_PATTERN=/, // after the empty last-assistant-message guard
  'subagent-audit': /jq -nc --arg ts /, // the audit record write
  'user-prompt-submit': /\+ SESSION_PATH=/, // after the session id guard
};

// Sourced libraries: run as a script they only define functions, so there is no main path to reach.
const SOURCED_LIBRARY = new Set([
  'capture-failure', 'compact-text', 'emission', 'emission-rules', 'identity', 'summary-store',
]);

const sharedSurfaces = budgets.surfaces.filter((s: any) => s.harness === 'shared' && /^hook\.shared\./.test(s.id));

test('every shared policy perf surface is a known executable policy or sourced library', () => {
  assert.ok(sharedSurfaces.length > 0);
  for (const surface of sharedSurfaces) {
    const stem = surface.id.slice('hook.shared.'.length);
    assert.ok(
      MAIN_PATH_MARKER[stem] || SOURCED_LIBRARY.has(stem),
      `${surface.id} needs a main-path marker or a sourced-library entry`,
    );
  }
});

for (const surface of sharedSurfaces) {
  const stem = surface.id.slice('hook.shared.'.length);
  if (!MAIN_PATH_MARKER[stem]) continue;

  test(`${surface.id} perf fixture reaches the policy main path`, (t) => {
    assert.ok(surface.stdinFixture, `${surface.id} has no stdin fixture`);
    const home = tempDir(t, 'doflow-main-path-home-');
    let project: string | null = null;
    if (surface.setup && surface.setup.kind === 'copy-fixture-project') {
      project = tempDir(t, 'doflow-main-path-project-');
      fs.cpSync(path.join(REPO_ROOT, surface.setup.fixture), project, { recursive: true });
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=DoFlow Perf', '-c', 'user.email=perf@doflow.dev', ...args], { cwd: project });
      git('init', '-q', '-b', surface.setup.branch || 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'fixture');
    }
    const res = spawnSync(bashPath(), ['-x', path.join(REPO_ROOT, ...surface.argv[1].split('/'))], {
      cwd: project && surface.setup.cwdProject ? project : REPO_ROOT,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), DOFLOW_QUIET: '1' },
      input: fs.readFileSync(path.join(REPO_ROOT, surface.stdinFixture), 'utf8'),
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr.slice(-400));
    assert.match(res.stderr, MAIN_PATH_MARKER[stem], `${surface.id} exited before its main path`);
  });
}
