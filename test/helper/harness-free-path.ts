'use strict';

// A PATH that mirrors this process's own minus every harness CLI, for tests whose product code probes
// `<harness> --version` through PATH (doctor, install, the bench context). The standing rule is that a
// test never runs a real harness CLI or a model, so the answer must not depend on what the developer has
// installed. Mirroring (rather than a hand-picked list) keeps git, jq, bash and the coreutils reachable.
//
// `node --test` runs each file in its own process, so a file calls useHarnessFreePath() once at the top.
// A test that needs a harness answer links a fake under a `fake-<harness>` name (fake-harness-cli.ts);
// no real harness name is ever linked.

const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('./tmp.ts');

/** Every harness id and worker binary the registry names (claude, codex, ..., kiro-cli, agy), so a new harness is covered without an edit. */
const HARNESS_BINARY_NAMES: readonly string[] = Object.freeze([...new Set(
  require('../../core/registry/harnesses.json').harnesses
    .flatMap((h: any) => [h.id, h.worker?.cli?.binary].filter((name: any) => typeof name === 'string' && name)),
)]) as string[];

let cached: string | undefined;

/** Strips the Windows executable suffix, so `claude.exe` matches `claude`. */
function stem(file: string) { return file.replace(/\.(exe|bat|cmd|com)$/i, ''); }

/**
 * The PATH of this process with the harness binaries removed. POSIX: one scratch directory of symlinks to
 * every other PATH entry (first match wins, as on a real PATH). win32 cannot link without a privilege, so
 * a whole directory holding a harness binary is dropped instead.
 */
function harnessFreePath(): string {
  if (cached) return cached;
  const deny = new Set(HARNESS_BINARY_NAMES);
  const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const kept: string = entries.filter((entry) => {
      try { return !fs.readdirSync(entry).some((file: string) => deny.has(stem(file))); } catch { return false; }
    }).join(path.delimiter);
    cached = kept;
    return kept;
  }
  const dir = suiteTempDir('doflow-harness-free-path-');
  for (const entry of entries) {
    let files: string[];
    try { files = fs.readdirSync(entry); } catch { continue; }
    for (const file of files) {
      if (deny.has(file)) continue;
      const link = path.join(dir, file);
      try { fs.symlinkSync(path.join(entry, file), link); } catch { /* already linked by an earlier entry, or unreadable */ }
    }
  }
  cached = String(dir);
  return cached;
}

/** Puts the harness-free PATH into this process; `node --test` gives each file its own process. */
function useHarnessFreePath(): string {
  const free = harnessFreePath();
  process.env.PATH = free;
  return free;
}

module.exports = { harnessFreePath, useHarnessFreePath, HARNESS_BINARY_NAMES };
