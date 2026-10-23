'use strict';

// FU-85a127: the shared home-less bash spawn keeps a runner-side `brew` call out of the hook tests.
// The real trigger on the macOS runner is unproven until a CI run, so this file simulates two ways
// a HOME-less bash could reach brew with a fake bash binary that wraps /bin/bash:
//   - `startup`: a start-up file that prints brew's HOME error unless bash got `--norc`;
//   - `lookup`: a start-up step that runs whatever `brew` PATH resolves (a `brew shellenv` line).
// A spawn built the old way (`spawnSync(bash, args, { env: { PATH } })`) shows the error through
// either fake; the helper's spawn shows none.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./tmp');
const { bashEnv, pathWithoutHomebrew, spawnBash } = require('./home-less-bash');

const POSIX = process.platform !== 'win32';
const BREW_ERROR = 'Error: $HOME must be set to run brew.';
const FAKES = {
  startup: `if [ -z "\${HOME-}" ]; then case " $* " in *" --norc "*) ;; *) echo '${BREW_ERROR}' >&2;; esac; fi`,
  lookup: 'if [ -z "${HOME-}" ] && command -v brew >/dev/null 2>&1; then brew; fi',
};

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A fake bash for `kind`, and a PATH that has a Homebrew-shaped folder holding a failing `brew`, then the system folders. */
function world(t, kind) {
  const root = tempDir(t, 'doflow-home-less-bash-');
  const bash = executable(path.join(root, 'bin', 'bash'), `${FAKES[kind]}\nexec /bin/bash "$@"`);
  executable(path.join(root, 'opt', 'homebrew', 'bin', 'brew'), `echo '${BREW_ERROR}' >&2; exit 1`);
  const PATH = [path.join(root, 'opt', 'homebrew', 'bin'), '/usr/bin', '/bin'].join(path.delimiter);
  return { bash, PATH };
}

for (const kind of Object.keys(FAKES)) {
  test(`${kind} simulation: an old-style HOME-less spawn sees the brew error`, { skip: !POSIX }, (t) => {
    const { bash, PATH } = world(t, kind);
    const r = spawnSync(bash, ['-c', 'printf ok'], { env: { PATH }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'ok', `${BREW_ERROR}\n`]);
  });

  test(`${kind} simulation: spawnBash with no HOME writes nothing to stderr`, { skip: !POSIX }, (t) => {
    const { bash, PATH } = world(t, kind);
    const r = spawnBash(['-c', 'printf ok'], { bash, env: { PATH }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'ok', '']);
  });

  test(`control: ${kind} simulation with a HOME set stays silent for both spawns`, { skip: !POSIX }, (t) => {
    const { bash, PATH } = world(t, kind);
    const env = { PATH, HOME: '/nonexistent-doflow-home' };
    assert.equal(spawnSync(bash, ['-c', 'printf ok'], { env, encoding: 'utf8' }).stderr, '');
    assert.equal(spawnBash(['-c', 'printf ok'], { bash, env, encoding: 'utf8' }).stderr, '');
  });
}

test('bashEnv drops BASH_ENV and ENV, and keeps PATH whole when HOME is set', () => {
  const PATH = ['/opt/homebrew/bin', '/usr/bin'].join(path.delimiter);
  assert.deepEqual(bashEnv({ PATH, HOME: '/h', BASH_ENV: '/x', ENV: '/y' }), { PATH, HOME: '/h' });
});

test('pathWithoutHomebrew drops the Homebrew folders when the tools stay reachable', { skip: !POSIX }, (t) => {
  const root = tempDir(t, 'doflow-home-less-bash-');
  const brew = path.join(root, 'opt', 'homebrew', 'bin');
  const sys = path.join(root, 'usr', 'bin');
  executable(path.join(brew, 'brew'), 'exit 1');
  for (const tool of ['jq', 'git']) executable(path.join(sys, tool), 'exit 0');
  assert.equal(pathWithoutHomebrew([brew, sys].join(path.delimiter)), sys);
});

test('pathWithoutHomebrew keeps the whole PATH when a hook tool lives only in a Homebrew folder', { skip: !POSIX }, (t) => {
  const root = tempDir(t, 'doflow-home-less-bash-');
  const brew = path.join(root, 'opt', 'homebrew', 'bin');
  const sys = path.join(root, 'usr', 'bin');
  executable(path.join(brew, 'jq'), 'exit 0');
  fs.mkdirSync(sys, { recursive: true });
  const whole = [brew, sys].join(path.delimiter);
  assert.equal(pathWithoutHomebrew(whole), whole);
});
