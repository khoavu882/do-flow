'use strict';

// One place that says which bash the tests spawn. On POSIX it is /bin/bash (or `bash` on PATH when
// that is absent). On win32 a bare `bash` can resolve to WSL's C:\Windows\System32\bash.exe, which
// cannot run these scripts, so Git for Windows' bash.exe is located explicitly: DOFLOW_TEST_BASH,
// then the standard install paths, then `where bash` without any System32 entry. The resolved
// binary and PATH are logged once per process on win32 so a CI log shows what ran.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let cached: string | undefined;

function isWsl(file: string) {
  return /[\\/]system32[\\/]bash\.exe$/i.test(file) || /[\\/]windowsapps[\\/]/i.test(file);
}

function locateWin32() {
  if (process.env.DOFLOW_TEST_BASH) return process.env.DOFLOW_TEST_BASH;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean) as string[];
  for (const root of roots) {
    for (const rel of [['Git', 'bin', 'bash.exe'], ['Git', 'usr', 'bin', 'bash.exe']]) {
      const candidate = path.join(root, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const where = spawnSync('where', ['bash'], { encoding: 'utf8' });
  const found = String(where.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !isWsl(l));
  if (found.length) return found[0];
  throw new Error('bash-locator: Git for Windows bash.exe not found (install Git for Windows or set DOFLOW_TEST_BASH)');
}

/** The bash binary the tests should spawn. */
function bashPath({ quiet = false } = {}): string {
  if (cached) return cached;
  if (process.platform === 'win32') {
    cached = locateWin32();
    if (!quiet) {
      process.stderr.write(`bash-locator: bash=${cached}\nbash-locator: PATH=${process.env.PATH ?? process.env.Path}\n`);
    }
  } else {
    cached = process.env.DOFLOW_TEST_BASH || (fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash');
  }
  return cached;
}

module.exports = { bashPath };
