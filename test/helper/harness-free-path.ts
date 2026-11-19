'use strict';

// A PATH that mirrors this process's own minus every harness CLI, for tests whose product code probes
// `<harness> --version` through PATH (doctor, install, the bench context). The standing rule is that a
// test never runs a real harness CLI or a model, so the answer must not depend on what the developer has
// installed. Mirroring (rather than a hand-picked list) keeps git, jq, bash and the coreutils reachable.
//
// `node --test` runs each file in its own process, so a file calls useHarnessFreePath() once at the top.
// A test that needs a harness answer links a fake under a `fake-<harness>` name (fake-harness-cli.ts);
// no real harness name is ever linked.
//
// win32 cannot link without a privilege, so there a whole PATH folder that holds a harness binary is
// dropped instead; that also drops node or npm when they share the folder with a harness.

const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('./tmp.ts');
const { retiredIds } = require('../../src/registry/harness-ids.ts');

/** Every harness id, worker binary and retired id the registry names (claude, ..., kiro-cli, agy, gemini), so a change to the registry needs no edit here. Package workers are out of scope. */
const HARNESS_BINARY_NAMES: readonly string[] = Object.freeze([...new Set(
  require('../../core/registry/harnesses.json').harnesses
    .flatMap((h: any) => [h.id, h.worker?.cli?.binary].filter((name: any) => typeof name === 'string' && name))
    .concat(retiredIds()),
)]) as string[];

let cached: string | undefined;

/** Strips the Windows executable suffix, so `claude.exe` matches `claude`. */
function stem(file: string) { return file.replace(/\.(exe|bat|cmd|com)$/i, ''); }

/** A regular file the process may execute, as a real PATH lookup requires. */
function isRunnable(full: string, fsImpl: any): boolean {
  try {
    if (!fsImpl.statSync(full).isFile()) return false;
    fsImpl.accessSync(full, fsImpl.constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The PATH `pathValue` with the harness binaries removed. POSIX: one scratch directory of symlinks to the
 * runnable regular files of every other PATH entry (first match wins, as on a real PATH; a relative entry
 * is resolved first). Only an existing link (EEXIST) is skipped; any other symlink error throws. win32:
 * a whole folder holding a harness binary is dropped, which can drop node/npm when they share it.
 * `fsImpl` is for a test that stubs a failure.
 */
function buildHarnessFreePath(pathValue: string, fsImpl: any = fs): string {
  const deny = new Set(HARNESS_BINARY_NAMES);
  const entries = String(pathValue || '').split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
  if (process.platform === 'win32') {
    return entries.filter((entry) => {
      try { return !fsImpl.readdirSync(entry).some((file: string) => deny.has(stem(file))); } catch { return false; }
    }).join(path.delimiter);
  }
  const dir = String(suiteTempDir('doflow-harness-free-path-'));
  const linked = new Set<string>();
  for (const entry of entries) {
    let files: string[];
    try { files = fsImpl.readdirSync(entry); } catch { continue; }
    for (const file of files) {
      if (deny.has(file) || linked.has(file)) continue;
      const target = path.join(entry, file);
      if (!isRunnable(target, fsImpl)) continue;
      try { fsImpl.symlinkSync(target, path.join(dir, file)); } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
      linked.add(file);
    }
  }
  return dir;
}

/** The harness-free form of this process's PATH, built once. */
function harnessFreePath(): string {
  cached ??= buildHarnessFreePath(process.env.PATH || '');
  return cached;
}

/** Puts the harness-free PATH into this process; `node --test` gives each file its own process. */
function useHarnessFreePath(): string {
  const free = harnessFreePath();
  process.env.PATH = free;
  return free;
}

module.exports = { harnessFreePath, buildHarnessFreePath, useHarnessFreePath, HARNESS_BINARY_NAMES };
