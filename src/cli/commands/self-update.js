'use strict';
// `doflow self-update` — git fetch/pull the checkout, then re-run the install path so the
// installed trees match the freshly pulled source.
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../shared');
const cmdInstall = require('./install');

function cmdSelfUpdate(o) {
  console.log('[INFO] Self-update: checking for upstream changes...');
  let pulled = false;
  let fetchOk = false;
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'fetch', '--depth=1', 'origin'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
    fetchOk = true;
  } catch {
    console.error('[WARN]  git fetch failed (offline or no remote configured) — installing from current HEAD');
  }
  if (fetchOk) {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'pull', '--ff-only'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      pulled = true;
      const commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD']).toString().trim();
      console.log(`[INFO] Updated to commit: ${commit}`);
    } catch {
      console.error('[WARN]  Fast-forward not possible — using current local state');
    }
  }
  console.log(`[INFO] Running install (after ${pulled ? 'a git pull' : 'checking for updates'})...`);
  cmdInstall(o);
}

module.exports = cmdSelfUpdate;
