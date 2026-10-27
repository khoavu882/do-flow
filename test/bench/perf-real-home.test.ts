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
const runner = require('../../bench/perf/runner.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_TEST = process.platform !== 'win32' ? test : test.skip;

function underCanary(t: any, fn: (canary: { home: string; xdg: string }) => void) {
  const home = tempDir(t, 'doflow-real-home-canary-');
  const xdg = path.join(home, '.config');
  fs.mkdirSync(xdg);
  const saved: any = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fn({ home, xdg });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value as string;
    }
  }
}

const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry: any) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

const SURFACES = ['hook.antigravity.stop-check', 'hook.shared.stop-check'];

for (const id of SURFACES) {
  HOOK_TEST(`perf runner: ${id} with empty stdin writes nothing under the real HOME or XDG_CONFIG_HOME`, (t) => {
    const surface = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT }).surfaces.find((s: any) => s.id === id);
    assert.ok(surface, `${id} is an enumerated surface`);
    const { stdinFixture: _fixture, stdinField: _field, ...emptyStdin } = surface;
    underCanary(t, ({ home }) => {
      // The exit status is not the subject; a fault or a clean pass are both fine.
      try { runner.runSurfaceProcess({ ...emptyStdin, timeoutMs: 60000 }, REPO_ROOT); } catch { /* ignored */ }
      assert.deepEqual(filesUnder(home), [], 'the perf run left no file under the real HOME or XDG_CONFIG_HOME');
    });
  });
}
