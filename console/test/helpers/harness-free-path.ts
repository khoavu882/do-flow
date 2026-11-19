'use strict';

// A PATH that mirrors this process's own minus every harness CLI, for Console tests whose core children probe
// `<harness> --version` through PATH (doctor, the health read). A test never runs a real harness CLI, so the
// answer must not depend on what the developer has installed. This is the Console's own form of
// test/helper/harness-free-path.ts: that helper also loads test/helper/tmp.ts, which repoints TMPDIR at the
// `doflow-test.noindex` root, and the Console fixtures need os.tmpdir() unchanged (the project list filters that root).
// The names come from the same registry: every harness id, worker binary and retired id.
//
// `node --test` runs each file in its own process, so a file calls useHarnessFreePath() once at the top.
// win32 cannot link without a privilege, so there a whole PATH folder that holds a harness binary is dropped.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { retiredIds } = require('../../../src/registry/harness-ids.ts');

const DENY = new Set<string>(
  require('../../../core/registry/harnesses.json').harnesses
    .flatMap((h: any) => [h.id, h.worker?.cli?.binary].filter((name: any) => typeof name === 'string' && name))
    .concat(retiredIds()),
);

const stem = (file: string) => file.replace(/\.(exe|bat|cmd|com)$/i, '');

function isRunnable(full: string): boolean {
  try {
    if (!fs.statSync(full).isFile()) return false;
    fs.accessSync(full, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** Puts the harness-free form of this process's PATH into it and returns it. */
function useHarnessFreePath(): string {
  const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
  if (process.platform === 'win32') {
    process.env.PATH = entries.filter((entry) => {
      try { return !fs.readdirSync(entry).some((file: string) => DENY.has(stem(file))); } catch { return false; }
    }).join(path.delimiter);
    return process.env.PATH as string;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-harness-free-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  const linked = new Set<string>();
  for (const entry of entries) {
    let files: string[];
    try { files = fs.readdirSync(entry); } catch { continue; }
    for (const file of files) {
      if (DENY.has(file) || linked.has(file)) continue;
      const target = path.join(entry, file);
      if (!isRunnable(target)) continue;
      try { fs.symlinkSync(target, path.join(dir, file)); } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
      linked.add(file);
    }
  }
  process.env.PATH = dir;
  return dir;
}

module.exports = { useHarnessFreePath };
