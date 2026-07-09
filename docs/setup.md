# Setup

Full installation guide covering all deployment options, MCP server configuration, and the
`doflow` CLI.

---

## Prerequisites

| Requirement | Purpose | Install |
|------------|---------|---------|
| Git | Clone the repository | System package manager |
| Claude Code | Primary AI tool (Option A/B) | [code.claude.com/docs](https://code.claude.com/docs) |
| Node.js 18+ | Runs `doflow` (zero runtime dependencies) and the MCP servers | [nodejs.org](https://nodejs.org) |
| jq | Hook scripts (JSON parsing) | `sudo apt-get install jq` / `brew install jq` |

`bash`/`rsync` are only needed if you're running the frozen `bin/sync-legacy.sh` reference
implementation for parity testing — not for normal installs.

---

## Installation

### Option A — Claude Code Only

Clone directly into `~/.claude`. Claude Code reads this directory at startup.

```bash
git clone git@github.com:khoavu882/do-flow.git ~/.claude
chmod +x ~/.claude/hooks/*.sh
```

**When to use Option A:** You only use Claude Code, and you want the simplest setup. No CLI
needed — updates are a `git pull`.

---

### Option B — All Tools (Claude + Codex + Gemini), via the `doflow` CLI

Clone to a working directory, then deploy with `doflow` — the maintained Node CLI, zero runtime
dependencies, `node >= 18`.

```bash
git clone git@github.com:khoavu882/do-flow.git ~/do-flow
cd ~/do-flow

# Make the `doflow` command available on your PATH, without a global npm publish/install.
# npm link creates a symlink from your global node_modules/.bin into this repo's bin/doflow.js —
# edits to the repo take effect immediately, no reinstall needed. Undo anytime with `npm unlink -g doflow`.
npm link

# Preview what would change — no writes
doflow install --dry-run

# Install to all tools, global scope ($HOME/.claude, .codex, .gemini)
doflow install -g

# Or target specific tools
doflow install -g --target claude,codex

# Prefer not to touch your global npm bin? Skip `npm link` and call the script directly:
node bin/doflow.js install -g --dry-run
```

**Project-scoped installs** (the default when `-g`/`--global` is omitted) deploy into a specific
project directory instead of `$HOME`, rooted at an optional path argument:

```bash
doflow install ../my-other-project --target claude
# -> ../my-other-project/.claude/
```

**When to use Option B:** You use multiple AI tools and want consistent rules across all of them,
or you want project-scoped installs (config that lives with a specific repo rather than globally).
`doflow` handles per-tool file selection and maintains an install manifest for rollback.

---

## MCP Servers

Install after the base framework. These are optional but significantly enhance Claude Code's
capabilities.

```bash
# Context7 — library documentation lookup
# Trigger: --c7 / --context7
npx -y @upstash/context7-mcp

# Sequential Thinking — structured multi-step reasoning
# Trigger: --seq / --sequential
npx -y @modelcontextprotocol/server-sequential-thinking

# Chrome DevTools — browser inspection and performance
# Trigger: --chrome / --devtools
npx -y chrome-devtools-mcp@latest

# Playwright — browser automation and E2E testing
# Trigger: --play / --playwright
# npx @playwright/mcp  (or configure via Claude Code settings)
```

The packages above are the MCP server runtimes themselves (`npx` fetches and runs them on demand).
Separately, `doflow install`/`update` registers *which* of these 4 servers Claude Code should launch
— not by copying `core/.mcp.json` into `.claude/` (Claude Code never reads a `.mcp.json` from inside
`.claude/`), but by writing to the locations it actually resolves MCP servers from:

- **Global** (`-g`): merged into `~/.claude.json`'s top-level `mcpServers` key. This is a
  read-merge-write — only the 4 server names doflow ships are added/removed; any other key in that
  file (history, projects, a server you registered yourself via `claude mcp add`) is left alone.
- **Project scope** (no `-g`): read-merge-write into `<projectRoot>/.mcp.json` — a sibling of
  `.claude/`, not inside it — matching the project-root convention Claude Code auto-discovers. Same
  merge semantics as global: a server you added to this file by hand, under a name doflow doesn't
  ship, survives.

Both writes refuse to proceed (clean error, no changes made) if the existing file is present but not
valid JSON — silently treating a malformed file as empty would mean the write discards whatever
content it actually held.

By default all 4 servers are installed. To choose a subset:

```bash
doflow install -g --mcp context7,sequential-thinking   # only these two
doflow install -g                                      # interactive checkbox picker (real TTY only)
doflow install -g --force                               # non-interactive -> defaults to all
```

The selection is recorded in `.install-manifest.json` and reused by later `doflow update` runs —
`update` never re-prompts, so it won't silently re-add a server you deliberately excluded. Pass
`--mcp` again on `update` to change the selection (it becomes the new remembered value). Check the
current selection with `doflow status`.

Neither `~/.claude.json` nor `<projectRoot>/.mcp.json` is covered by doflow's backup/rollback —
those only snapshot `<install-root>/.claude/`. `doflow rollback` restores `.claude/` (and thus your
CLAUDE.md/agents/skills/etc.) to a prior state but leaves the current MCP server selection exactly
as it was, since it never touches either file. Both writes are surgical merges (only the known
server keys are added/removed) rather than a full overwrite, which keeps the blast radius of a bad
run contained without needing a dedicated backup — but a rolled-back repo's MCP selection can still
drift out of sync with everything else that *did* revert, so check `doflow status` after a rollback
if the MCP servers matter.

---

## `doflow` CLI Reference

```bash
# Full install (with automatic backup)
doflow install -g

# Update changed files only (incremental)
doflow update -g

# Check current installed state
doflow status -g

# List available backups
doflow list-backups -g

# Restore a specific backup
doflow rollback -g install_2026-03-26_14-30-00

# Pull latest changes and reinstall
doflow self-update -g
```

**Full flag reference:**

| Flag | Short | Description |
|------|-------|--------------|
| `-g, --global` | | Install to `$HOME/.{claude,codex,gemini}` |
| `[path]` | | Project-scoped install root (default `.`) — mutually exclusive with `-g` (global wins if both given) |
| `-t, --target <list>` | | Comma-separated: `claude,codex,gemini` (default: all) |
| `--mcp <list>` | | Comma-separated MCP server names (default: all; omit for an interactive picker on a real terminal). Remembered for later `update`; only applies when `claude` is a target |
| `-n, --dry-run` | | Preview without writing |
| `-f, --force` | | Skip confirmation prompts |
| `--no-backup` | | Skip backup — requires `--force` |
| `--prune <N>` | | Keep only N most recent backups |
| `--checksum` | | SHA256 diff (`update`) — more accurate than mtime |
| `--json` | | Machine-readable output (`status`) |
| `-h, --help` / `-v, --version` | | |

**Deprecated compatibility shim:** `./sync.sh` still works, translating its old flag grammar
(`--install`, `--rollback [ID]`, ...) into `doflow`'s subcommand grammar and always adding
`-g` (matching `sync.sh`'s historical `$HOME`-only behavior). Use `doflow` directly for new
setups — the shim exists only so muscle-memory scripts referencing `sync.sh` keep working.

---

## What Gets Installed

Configured in `bin/mappings.conf`. Each tool gets the appropriate subset:

| Component | Claude | Codex | Gemini |
|-----------|--------|-------|--------|
| `CLAUDE.md` + `FLAGS.md` + `PRINCIPLES.md` | ✓ | — | — |
| `rules/` (4 rule files) | ✓ | ✓ | ✓ |
| `agents/` (15 agents) | ✓ | ✓ | ✓ |
| `skills/` (37 skills) | ✓ | — | — |
| `modes/` (6 modes) | ✓ | — | — |
| `hooks/` (13 hook scripts) | ✓ | — | — |
| `mcp/` (4 server docs) | ✓ | — | — |
| `reference/` | ✓ | ✓ | ✓ |
| `scripts/`, `templates/` (doflow chain helpers) | ✓ | — | — |
| `settings.json` + `keybindings.json` | ✓ | — | — |
| `.mcp.json` — **not** mapped here; see [MCP Servers](#mcp-servers) below | | | |

---

## Backup and Rollback

Backups are stored under `<install-root>/.claude/backups/` (`~/.claude/backups/` for a global
install).

- **Full install** → `tar.gz` snapshot of the entire target directory
- **Incremental update** → plain directory copy of changed files only (user-inspectable)

```bash
# Keep only the 5 most recent backups after installing
doflow install -g --prune 5

# Restore interactively (shows list, prompts for ID)
doflow rollback -g

# Restore a specific backup by ID
doflow rollback -g install_2026-03-26_14-30-00
```

A pre-rollback safety snapshot is always created before restoring.

---

## Updating

```bash
# Pull changes and reinstall (content-based diff — handles git timestamp refresh)
doflow self-update -g

# Or manually: pull then update changed files only
git pull
doflow update -g
```

---

## Verify the Installation

```bash
# Check doflow install state
doflow status -g

# In Claude Code, verify skills loaded
/do-help
```

The status output shows which tools are installed and when they were last updated.
