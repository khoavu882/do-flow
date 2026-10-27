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
  return cached as string;
}

let fd3Counter = 0;

/**
 * spawnSync of `bash args` with a decision-record stream on fd 3, returned as `output[3]` like a
 * `stdio: ['pipe','pipe','pipe','pipe']` spawn. A Windows Node cannot hand an extra pipe to an MSYS
 * bash (it has no fd 3 there), so on win32 the child is a bash that opens fd 3 onto a file itself and
 * execs the real bash; the policy under test sees the same `>&3` and its records are read back.
 */
function spawnWithFd3(args: any, options: any = {}) {
  const bash = bashPath({ quiet: true });
  if (process.platform !== 'win32') {
    const r = spawnSync(bash, args, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    return r;
  }
  const file = path.join(require('node:os').tmpdir(), `doflow-fd3-${process.pid}-${fd3Counter++}`);
  fs.writeFileSync(file, '');
  const env = { ...(options.env ?? process.env), DOFLOW_FD3_FILE: file };
  const r: any = spawnSync(bash, ['-c', 'exec 3>"$DOFLOW_FD3_FILE"; exec bash "$@"', 'x', ...args], { ...options, env });
  let records = Buffer.from('');
  try { records = fs.readFileSync(file); } catch { /* the child never opened it */ }
  try { fs.unlinkSync(file); } catch { /* best effort */ }
  r.output = [null, r.stdout, r.stderr, records];
  return r;
}

module.exports = { bashPath, spawnWithFd3 };
