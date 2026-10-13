'use strict';
// settings-scope.js — GLOBAL_HOOK_PREFIX/PROJECT_HOOK_PREFIX are the shared constants the Claude
// adapter's settings-asset renderer (src/adapters/claude/index.ts#settingsContent) uses to rewrite
// a project-scoped settings.json's hook `command` paths from the global-only `~/.claude/hooks/`
// form to Claude Code's documented ${CLAUDE_PROJECT_DIR}/.claude/hooks/ placeholder — see
// https://code.claude.com/docs/en/hooks. chmodHooksExecutable is a defensive final pass: an
// npm-packaged tarball does not reliably preserve the executable bit on arbitrary files (unlike a
// git checkout, which usually does), so this unconditionally re-adds +x after hook scripts are
// deployed, regardless of what bit the source file happened to carry on this machine.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../helper/settings-scope.ts')` keeps working while the tree is still `.js`.
const fs = require('node:fs');
const path = require('node:path');

const GLOBAL_HOOK_PREFIX = '~/.claude/hooks/';
const PROJECT_HOOK_PREFIX = '${CLAUDE_PROJECT_DIR}/.claude/hooks/';

/** Adds ugo+x (relative — preserves existing bits), not an absolute mode — a hook file copied in
 * at 664/775 must stay that way, only gaining +x. */
function chmodHooksExecutable(claudeDir: string): void {
  const hooksDir = path.join(claudeDir, 'hooks');
  if (!fs.existsSync(hooksDir)) return;
  for (const f of fs.readdirSync(hooksDir)) {
    if (!f.endsWith('.sh')) continue;
    const p = path.join(hooksDir, f);
    const currentMode = fs.statSync(p).mode & 0o777;
    fs.chmodSync(p, currentMode | 0o111);
  }
}

module.exports = { GLOBAL_HOOK_PREFIX, PROJECT_HOOK_PREFIX, chmodHooksExecutable };
