# Setup

This is the canonical installation and lifecycle guide for DoFlow. The [Quickstart](quickstart.md)
contains only the shortest path to a working installation.

## Prerequisites

| Requirement | Needed for |
|---|---|
| Git | Cloning and source updates |
| Node.js 18+ | The `doflow` installer |
| Claude Code | Claude integration |
| `jq` | Claude hook scripts |

`bash`, `rsync`, and `jq` are additionally required only when running the frozen legacy parity harness.

## Installation modes

### Claude Code only

Clone directly into the configuration directory when Claude is your only target:

```bash
git clone git@github.com:khoavu882/do-flow.git ~/.claude
chmod +x ~/.claude/hooks/*.sh
```

Update this installation with `git pull` from `~/.claude`.

### CLI installation

Use the CLI for multi-tool or project-scoped configuration:

```bash
git clone git@github.com:khoavu882/do-flow.git ~/do-flow
cd ~/do-flow
npm link

# Always inspect the plan before the first real installation.
doflow install --dry-run -g
doflow install -g --target claude,codex
```

Without `-g`, the optional path is the project root and configuration is placed beneath it:

```bash
doflow install ../my-project --target codex
# -> ../my-project/.codex/
```

## CLI lifecycle

```bash
# Show the current installation state.
doflow status -g

# Apply changed source files only.
doflow update -g

# List or restore backups.
doflow list-backups -g
doflow rollback -g install_YYYY-MM-DD_HH-MM-SS

# Preview any command without writing.
doflow install --dry-run -g --target codex
```

Every normal install creates a backup. `--no-backup` requires `--force`; use it only when the
configuration is disposable. `sync.sh` remains a compatibility shim; use `doflow` for new setup.

## What gets installed

| Component | Claude | Codex | Gemini |
|---|:---:|:---:|:---:|
| Instructions | `CLAUDE.md` + shared framework files | `AGENTS.md` from `core/CLAUDE.md` | `AGENTS.md` + shared framework files |
| Rules, agents, references | ✓ | ✓ | ✓ |
| Skills | ✓ | ✓ | ✓ |
| Scripts and templates | ✓ | ✓ | — |
| Modes | ✓ | — | ✓ |
| Hooks and settings | ✓ | — | — |
| MCP registration | ✓ | — | — |

Codex’s file-based installation intentionally excludes Claude hooks. The repository exposes
`core/` as a Claude Code marketplace plugin through its `.claude-plugin/marketplace.json` and
`.claude-plugin/plugin.json`, and as a Codex/ChatGPT plugin through
`core/.codex-plugin/plugin.json`. These manifests are distribution artifacts and are not copied by
`doflow install`.

### Claude Code marketplace

To add the canonical Claude configuration directory as a marketplace, run:

```bash
claude plugin marketplace add /path/to/do-flow/core
```

Then install `doflow` from the marketplace in Claude Code. The marketplace entry points to the
current `core/` directory, so the plugin and the CLI installer share the same canonical skills and
guidance.

## Claude MCP servers

DoFlow can register four optional servers for Claude Code: Context7, Sequential Thinking, Chrome
DevTools, and Playwright. The installer writes only the DoFlow-owned server entries:

| Scope | Registration location |
|---|---|
| Global (`-g`) | `~/.claude.json` → `mcpServers` |
| Project | `<projectRoot>/.mcp.json` |

```bash
# Choose an explicit subset.
doflow install -g --target claude --mcp context7,sequential-thinking
```

The selected servers are stored in the installer manifest and reused by `doflow update`.

## Verify and recover

```bash
doflow status -g
doflow list-backups -g
```

Use `/do-help` in Claude Code. In Codex, verify that `AGENTS.md`, `skills/`, `scripts/`, and
`templates/` exist under the configured `.codex/` directory.

If a configuration update is wrong, restore the named backup with `doflow rollback`. MCP server
registration is a surgical merge outside the installed directory and is intentionally not reverted
by rollback.
