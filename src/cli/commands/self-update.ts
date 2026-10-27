'use strict';
// `doflow self-update` — git fetch/pull the checkout, then re-run the install path so the
// installed trees match the freshly pulled source.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../shared.ts');
const cmdInstall = require('./install.ts');

/** The second argument is for tests: the checkout to update and the install it re-runs. */
function cmdSelfUpdate(o: any, { repoRoot = REPO_ROOT, install = cmdInstall }: { repoRoot?: string; install?: (o: any) => void } = {}): void {
  console.log('[INFO] Self-update: checking for upstream changes...');
  let pulled = false;
  let fetchOk = false;
  // An npm install is not a git checkout: `git -C` there would act on whatever repository holds
  // node_modules (or fail), never on DoFlow's source.
  const isCheckout = fs.existsSync(path.join(repoRoot, '.git'));
  if (!isCheckout) console.log('[INFO] This install is not a git checkout; to upgrade DoFlow run: npm install -g @khoavu882/doflow');
  if (isCheckout) {
    try {
      execFileSync('git', ['-C', repoRoot, 'fetch', '--depth=1', 'origin'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      fetchOk = true;
    } catch {
      console.error('[WARN]  git fetch failed (offline or no remote configured) — installing from current HEAD');
    }
  }
  if (fetchOk) {
    try {
      execFileSync('git', ['-C', repoRoot, 'pull', '--ff-only'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      pulled = true;
      const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD']).toString().trim();
      console.log(`[INFO] Updated to commit: ${commit}`);
    } catch {
      console.error('[WARN]  Fast-forward not possible — using current local state');
    }
  }
  console.log(`[INFO] Running install (after ${pulled ? 'a git pull' : 'checking for updates'})...`);
  install(o);
}

module.exports = cmdSelfUpdate;
