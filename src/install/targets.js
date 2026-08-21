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

const VALID = ['claude', 'codex', 'gemini', 'copilot', 'kiro', 'opencode', 'pi'];

/** The target used when `--target` is omitted. Deliberately one harness, not all of VALID: an
 * install with no flag should touch the one tool the user almost certainly has, not write
 * configuration into every harness DoFlow knows about — several of which may not be installed at
 * all. That mattered less when VALID was three entries and matters more as it grows. Ask for the
 * rest explicitly with `--target claude,codex,gemini`. */
const DEFAULT_TARGETS = ['claude'];

const TARGET_ALIASES = {
  antigravity: 'gemini',
  agy: 'gemini',
};

/** Default to DEFAULT_TARGETS; validate any explicitly requested. */
function resolveTargets(requested) {
  const rawTargets = requested && requested.length ? requested : [...DEFAULT_TARGETS];
  const targets = rawTargets.map((t) => TARGET_ALIASES[t] || t);
  for (const t of targets) {
    if (!VALID.includes(t)) {
      throw new Error(`Unknown target: '${t}' (valid: ${VALID.join(', ')})`);
    }
  }
  return [...new Set(targets)];
}

/**
 * Map tool -> install root.
 * @param {{global?: boolean, projectRoot?: string}} [opts]
 *   global=true         -> $HOME/.{claude,codex,gemini,copilot,kiro,pi}, $HOME/.config/opencode
 *                          (sync.sh parity for claude/codex/gemini; the four new harnesses follow
 *                          each one's own documented global root — see below)
 *   global=false (dflt) -> <resolved projectRoot>/.{claude,codex,kiro,opencode,pi}, but .agents for
 *     gemini and .github for copilot — both deliberately asymmetric with their own global-scope
 *     directory, for reasons native to each harness (see per-key notes below).
 *
 *   gemini   -> project-scoped Gemini config follows the Antigravity customization convention, not
 *               `.gemini/`, so it is asymmetric with its own global directory and with the other
 *               targets.
 *   copilot  -> Copilot has no single native root the way Claude's `.claude` is one: instructions,
 *               skills, agents, and MCP each live under a different path (see design.md §4's
 *               native-surfaces table). `.github` is the project root DoFlow treats as Copilot's
 *               "home" here because that is where `copilot-instructions.md` and `.github/agents`
 *               live; `~/.copilot` is the equivalent global root.
 *   kiro     -> `.kiro` / `~/.kiro` is the one native root that actually holds everything Kiro
 *               reads (steering, agents, hooks, settings/mcp.json), so — unlike copilot — this is
 *               the clean, symmetric case.
 *   opencode -> Global config is `~/.config/opencode`, NOT `~/.opencode/` — a path DoFlow's own
 *               docs asserted incorrectly for several releases (see src/adapters/opencode/index.js).
 *               Project scope is `.opencode`, asymmetric with the global path the same way gemini's
 *               is.
 *   pi       -> Global config is `~/.pi/agent` — note the `agent/` segment; `~/.pi/settings.json`
 *               is not a location Pi reads. Project scope is `.pi` (see
 *               src/adapters/pi/index.js's own `nativePaths()`, which this mirrors exactly).
 */
function toolDirs(opts = {}) {
  const { global = false, projectRoot = '.' } = opts;
  const root = global ? os.homedir() : path.resolve(projectRoot);
  return {
    claude: path.join(root, '.claude'),
    codex: path.join(root, '.codex'),
    gemini: global ? path.join(root, '.gemini') : path.join(root, '.agents'),
    copilot: global ? path.join(root, '.copilot') : path.join(root, '.github'),
    kiro: path.join(root, '.kiro'),
    opencode: global ? path.join(root, '.config', 'opencode') : path.join(root, '.opencode'),
    pi: global ? path.join(root, '.pi', 'agent') : path.join(root, '.pi'),
  };
}

module.exports = { VALID, DEFAULT_TARGETS, resolveTargets, toolDirs };
