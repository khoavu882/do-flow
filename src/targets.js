'use strict';
// targets.js — target validation + install-dir resolution.
// PARITY: sync.sh is global-only — $HOME/.{claude,codex,gemini}, hardcoded, NOT CLAUDE_CONFIG_DIR.
// doflow extends this with a second, DoFlow-only scope: project-local install (this repo's own
// .claude/ is a real precedent — Claude Code, Codex, and Copilot all support project-scoped config
// alongside global, see agent-docs/research/context-setup-claude-codex-copilot.md).
//
// Scope is explicit, never inferred: -g/--global -> $HOME-based (sync.sh parity); default (no -g) ->
// rooted at an explicit project path, defaulting to cwd ('.') when no path is given. The parity
// harness must pass -g for doflow, since sync.sh has no project mode to compare against.
const os = require('node:os');
const path = require('node:path');

const VALID = ['claude', 'codex', 'gemini'];

/** Default to all valid tools; validate any explicitly requested. */
function resolveTargets(requested) {
  const targets = requested && requested.length ? requested : [...VALID];
  for (const t of targets) {
    if (!VALID.includes(t)) {
      throw new Error(`Unknown target: '${t}' (valid: ${VALID.join(', ')})`);
    }
  }
  return targets;
}

/**
 * Map tool -> install root.
 * @param {{global?: boolean, projectRoot?: string}} [opts]
 *   global=true       -> $HOME/.{claude,codex,gemini}        (sync.sh parity)
 *   global=false (dflt) -> <resolved projectRoot>/.{claude,codex,gemini}
 */
function toolDirs(opts = {}) {
  const { global = false, projectRoot = '.' } = opts;
  const root = global ? os.homedir() : path.resolve(projectRoot);
  return {
    claude: path.join(root, '.claude'),
    codex: path.join(root, '.codex'),
    gemini: global ? path.join(root, '.gemini') : path.join(root, '.agents'),
  };
}

module.exports = { VALID, resolveTargets, toolDirs };
