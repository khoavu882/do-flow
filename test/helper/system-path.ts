'use strict';

// The PATH a test hands to a child that must see POSIX system tools and nothing else: `/usr/bin:/bin`
// on POSIX. On win32 the ':' separator and those directories do not exist, so the same intent is the
// Git for Windows usr/bin (cat, cp, printf, ...) plus the directories holding jq.exe and git.exe.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('./bash-locator.ts');

let cachedWin: string[] | undefined;

function whereFirst(tool: string): string | undefined {
  const out = String(spawnSync('where', [tool], { encoding: 'utf8' }).stdout ?? '');
  return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
}

function winDirs(): string[] {
  if (cachedWin) return cachedWin;
  // POSIX /usr/bin holds the coreutils, jq and git; on win32 they live in three places.
  const dirs = [path.join(path.dirname(path.dirname(bashPath({ quiet: true }))), 'usr', 'bin')];
  for (const tool of ['jq', 'git']) {
    const found = whereFirst(tool);
    if (found && !dirs.includes(path.dirname(found))) dirs.push(path.dirname(found));
  }
  cachedWin = dirs;
  return dirs;
}

/** PATH entries (joined with the platform delimiter) for `front` directories first, then the system tools. */
function systemPath(...front: string[]): string {
  const system = process.platform === 'win32' ? winDirs() : ['/usr/bin', '/bin'];
  return [...front, ...system].join(path.delimiter);
}

module.exports = { systemPath };
