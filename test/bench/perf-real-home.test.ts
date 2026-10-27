'use strict';
// FU-9g6j0n: a perf measurement runs bridge and hook scripts, and a hook that faults records the
// failure under the config home of whoever runs it. The runner must give every hook surface a
// scratch HOME and XDG_CONFIG_HOME, so a bench run never writes into the real user's.
//
// The test stands in for the real user: HOME and XDG_CONFIG_HOME of this process point at empty
// canary directories, a representative surface with EMPTY stdin (the input that makes the bridge
// fault) is run for real, and the canaries must still be empty afterwards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../../bench/perf/runner.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_TEST = process.platform !== 'win32' ? test : test.skip;

function underCanary(t: any, fn: (canary: { home: string; xdg: string }) => void) {
  const home = tempDir(t, 'doflow-real-home-canary-');
  const xdg = path.join(home, '.config');
  // Capture is forced on: an inherited DOFLOW_FAILURE_CAPTURE=off would make the guard pass vacuously.
  const saved: any = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DOFLOW_FAILURE_CAPTURE: process.env.DOFLOW_FAILURE_CAPTURE };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.DOFLOW_FAILURE_CAPTURE = 'on';
  try {
    fn({ home, xdg });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value as string;
    }
  }
}

/** Every file and every directory under `dir`: an empty directory is a write too. */
const entriesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? [full, ...entriesUnder(full)] : [full];
  });

const SURFACES = ['hook.antigravity.stop-check', 'hook.shared.stop-check'];
const surfaceOf = (id: string) => {
  const surface = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT }).surfaces.find((s: any) => s.id === id);
  assert.ok(surface, `${id} is an enumerated surface`);
  const { stdinFixture: _fixture, stdinField: _field, ...emptyStdin } = surface;
  return { ...emptyStdin, timeoutMs: 60000 };
};

for (const id of SURFACES) {
  HOOK_TEST(`perf runner: ${id} with empty stdin writes nothing under the real HOME or XDG_CONFIG_HOME`, (t) => {
    const surface = surfaceOf(id);
    underCanary(t, ({ home }) => {
      // A non-zero exit of the hook is fine; a launch, setup or timeout error means it did not run.
      try {
        runner.runSurfaceProcess(surface, REPO_ROOT);
      } catch (error: any) {
        if (!/^process exited with status \d+$/.test(error.message)) throw error;
      }
      assert.deepEqual(entriesUnder(home), [], 'the perf run left no file or directory under the real HOME or XDG_CONFIG_HOME');
    });
  });
}

for (const id of SURFACES) {
  HOOK_TEST(`perf runner: positive control, ${id} run with the canary as its HOME does write`, (t) => {
    const surface = surfaceOf(id);
    underCanary(t, ({ home, xdg }) => {
      const [cmd, ...args] = surface.argv;
      spawnSync(cmd === 'node' ? process.execPath : cmd, args, {
        cwd: REPO_ROOT, input: '', encoding: 'utf8', timeout: 60000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'on' },
      });
      assert.notDeepEqual(entriesUnder(home), [], 'the guard can see a write: this surface records its fault under the config home');
    });
  });
}

HOOK_TEST('perf runner: the guard counts a directory created under the real HOME or XDG_CONFIG_HOME', (t) => {
  underCanary(t, ({ xdg }) => {
    spawnSync(process.execPath, ['-e', "require('node:fs').mkdirSync(process.env.XDG_CONFIG_HOME + '/doflow', { recursive: true })"], { env: process.env });
    assert.deepEqual(entriesUnder(path.dirname(xdg)), [xdg, path.join(xdg, 'doflow')]);
  });
});
