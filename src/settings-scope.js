'use strict';
// settings-scope.js — rewrites core/settings.json's hook `command` paths after a project-scoped
// install. `~/.claude/hooks/*.sh` is only correct for a global install (a fixed, home-relative
// location); a project-scoped install's hooks live at `<project>/.claude/hooks/`, which Claude
// Code's own ${CLAUDE_PROJECT_DIR} placeholder is documented to resolve to a project's root — see
// https://code.claude.com/docs/en/hooks (fetched live to confirm before writing this).
// Without this rewrite, a project-scoped install's settings.json would still tell Claude Code to
// run hooks from the user's real $HOME/.claude/hooks/ — wrong location, or a stale/absent one.
const fs = require('node:fs');

const GLOBAL_HOOK_PREFIX = '~/.claude/hooks/';
const PROJECT_HOOK_PREFIX = '${CLAUDE_PROJECT_DIR}/.claude/hooks/';

/**
 * Rewrite every hook `command` string in a deployed settings.json from the global-only
 * `~/.claude/hooks/` prefix to the project-relative `${CLAUDE_PROJECT_DIR}/.claude/hooks/` form.
 * No-op (returns false) if the file doesn't exist or has no matching commands.
 * @returns {boolean} whether the file was rewritten
 */
function rewriteHookPathsForProjectScope(settingsJsonPath) {
  if (!fs.existsSync(settingsJsonPath)) return false;

  const raw = fs.readFileSync(settingsJsonPath, 'utf8');
  if (!raw.includes(GLOBAL_HOOK_PREFIX)) return false;

  const rewritten = raw.split(GLOBAL_HOOK_PREFIX).join(PROJECT_HOOK_PREFIX);
  fs.writeFileSync(settingsJsonPath, rewritten);
  return true;
}

module.exports = { rewriteHookPathsForProjectScope, GLOBAL_HOOK_PREFIX, PROJECT_HOOK_PREFIX };
