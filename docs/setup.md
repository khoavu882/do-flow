# Setup

This is the canonical installation and lifecycle guide for DoFlow. The [Quickstart](quickstart.md)
contains only the shortest path to a working installation.

## Prerequisites

### Core

| Requirement | Needed for | Notes |
|---|---|---|
| Node.js 18+ | The `doflow` installer, and `npx` for the bundled MCP servers | `package.json` declares `engines.node >= 18`; CI exercises 18 and 20 |
| Git | Cloning, `self-update`, and the git context hooks | |
| `bash` | Hook scripts, on any harness that supports hooks | POSIX bash, Git Bash/MSYS2, and WSL bash all qualify. DoFlow runs `bash --version` rather than a PATH check, so a same-named unrelated binary will not satisfy it. Installs that carry no hooks do not need it. |
| `jq` | The DoFlow shell scripts and hook payload parsing | Preinstalled on GitHub-hosted runners |
| At least one coding agent | Somewhere to install to | See the table below |

### Coding agents

DoFlow installs into whichever of these you have. None is required individually; you need at least
one.

| Agent | `--target` value | What DoFlow installs |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude` | `CLAUDE.md`, skills, agents, hooks, MCP registration, session context |
| [Codex](https://learn.chatgpt.com/docs/customization/overview) | `codex` | `AGENTS.md`, skills, scripts, templates, agents, hooks, MCP via `config.toml` |
| [Gemini CLI](https://geminicli.com/) / [Antigravity](https://antigravity.google/) | `gemini` | `GEMINI.md`, guidance, skills, agents, and hooks merged into `settings.json` |
| [OpenCode](https://opencode.ai/) | *not yet* | Declared in the registry; the adapter is not implemented, so `--target opencode` is currently rejected |
| [Pi](https://pi.dev/) | *not yet* | Declared in the registry; the adapter is not implemented, so `--target pi` is currently rejected |

Codex and Gemini both gate hook execution behind their own trust/review step — DoFlow writes the
configuration, but neither runs a hook until you approve it in that tool. Antigravity and Gemini CLI
share `~/.gemini/GEMINI.md`, so a global `--target gemini` install affects both; see
[what gets installed](#what-gets-installed).

### Optional external tools

DoFlow can inspect and manage these, but never requires them. `doflow tools --tool <list> --action
status` reports what is present; `install`/`update`/`uninstall` display and separately confirm every
command, and `--force` is intentionally rejected.

| Tool | Requires | Used for | DoFlow's install command |
|---|---|---|---|
| [`uv`](https://docs.astral.sh/uv/) | — | Prerequisite for Graphify and Semble | **None.** DoFlow explains a missing `uv` and stops; it will not install a package manager for you |
| [RTK](https://www.rtk-ai.app/docs/getting-started/installation/) | Rust toolchain (`cargo`) | Compressing high-output CLI commands (`command.compress`) | `cargo install --git https://github.com/rtk-ai/rtk --branch master rtk` |
| [Graphify](https://docs.astral.sh/uv/) | `uv` | Code relationships and blast-radius analysis (`code.relationships`, `code.impact-analysis`) | `uv tool install graphifyy` |
| [Semble](https://docs.astral.sh/uv/) | `uv` | Semantic code search (`code.semantic-search`) | `uv tool install semble` |

`doflow tools --tool rtk --action update` always reports **skipped**: no upstream update command has
been verified, and DoFlow will not guess one. Reinstall instead.

Each tool backs a capability the router resolves. When one is absent the router falls back — Semble
and Graphify degrade to Ripgrep — so DoFlow stays functional without any of them. Run `doflow
capabilities` to see which provider is actually active on your machine, and `doflow doctor` for a
health check across all three.

### MCP servers

DoFlow registers `context7` and `sequential-thinking` for the harnesses that support MCP. Both run
via `npx`, so they need no separate installation beyond Node. Select a subset with `--mcp`, or omit
the flag to be prompted on a real terminal.

## Installation modes

### Claude Code only

Clone directly into the configuration directory when Claude is your only target:

```bash
git clone git@github.com:khoavu882/do-flow.git ~/.claude
chmod +x ~/.claude/hooks/*.sh
```

Update this installation with `git pull` from `~/.claude`.

### CLI installation

Use the CLI for multi-tool or project-scoped configuration. It is published as
`@khoavu882/doflow` — the unscoped `doflow` name on npm is an unrelated package:

```bash
# Always inspect the plan before the first real installation.
npx @khoavu882/doflow install --dry-run -g
npx @khoavu882/doflow install -g --target claude,codex
```

### CLI installation from a checkout

Prefer this when you are developing DoFlow itself, or want installs to track a source tree you
control rather than the published version:

```bash
git clone git@github.com:khoavu882/do-flow.git ~/do-flow
cd ~/do-flow
npm link

doflow install --dry-run -g
doflow install -g --target claude,codex
```

Both forms expose the same commands. The rest of this guide writes `doflow`; substitute
`npx @khoavu882/doflow` if you did not link a checkout.

Without `-g`, the optional path is the project root and configuration is placed beneath it:

```bash
doflow install ../my-project --target codex
# -> ../my-project/.codex/
```

`doflow` always writes to the real per-tool directory below — never to `core/`, which is only the
source tree this repo ships. `doflow status` (see below) prints the exact resolved paths for any
given invocation, so treat it as the source of truth over this table for a specific run:

| Target | Global (`-g`) | Project (default) |
|---|---|---|
| Claude Code | `~/.claude/` | `<projectRoot>/.claude/` |
| Codex | `~/.codex/` | `<projectRoot>/.codex/` |
| Gemini CLI | `~/.gemini/` | `<projectRoot>/.agents/` **and** `<projectRoot>/.gemini/` — see below |

Gemini is the one target that writes to two directories in project scope, because its own config
surface and its customization surface follow different conventions:

| What | Project-scope location | Why |
|---|---|---|
| Skills | `<projectRoot>/.agents/skills/` | Antigravity customization convention |
| Agents | `<projectRoot>/.agents/agents/<name>/agent.md` | Antigravity discovers a custom agent as a **directory** containing `agent.md`, not a flat `<name>.md` |
| `settings.json`, `hooks/` | `<projectRoot>/.gemini/` | Gemini CLI reads its own config from `.gemini/` in both scopes |
| `GEMINI.md` | `<projectRoot>/GEMINI.md` | Gemini reads the instruction file from the workspace root |

A project install therefore creates `.agents/`, `.gemini/`, and a root `GEMINI.md`. Auditing what
DoFlow wrote into a repo means checking all three, not `.agents/` alone.

#### Gemini CLI and Antigravity share one global file

Both products read **`~/.gemini/GEMINI.md`**, and neither offers a way to separate them. A global
`--target gemini` install therefore configures **both** tools, whichever one you meant. This is a
property of those products, not of DoFlow — but it has two consequences worth knowing:

- If you use only one of them, the other still picks up DoFlow's guidance the next time you run it.
- If another tool already manages that file, DoFlow merges into its own marker block and leaves the
  rest untouched. It will refuse the install outright rather than overwrite a `GEMINI.md` that has
  no DoFlow section — add an empty `<!-- doflow:start -->` / `<!-- doflow:end -->` pair where you
  want DoFlow's content to live, and re-run.

Project scope avoids the collision entirely: `<projectRoot>/GEMINI.md` is per-repository, so
installing without `-g` keeps the two tools' global configuration untouched.

## CLI lifecycle

```bash
# Show the current installation state, including the resolved per-tool directories.
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
configuration is disposable.

## Harness capabilities and activation

| Component | Claude Code | Codex | Gemini CLI |
|---|:---:|:---:|:---:|
| Instructions | `CLAUDE.md` | Managed `AGENTS.md` | `GEMINI.md` |
| Rules, agents, references | ✓ | ✓ | ✓ |
| Skills | ✓ | ✓ | ✓ |
| Scripts and templates | ✓ | ✓ | Scripts/templates unavailable |
| Modes | ✓ | Native mode unavailable | Guidance projection |
| Hooks and settings | ✓ | Hooks require trust/review; settings differ | Hooks merge into settings.json, require trust/review; some events unmapped |
| MCP registration | ✓ | ✓ | Native registration differs |

This is a capability contract, not a statement that every native surface is active after copying
files. Verify installation in the target harness and review the [capability map](capability-map.md)
before treating a feature as available. The repository exposes
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

DoFlow can register two optional servers for Claude Code: Context7 and Sequential Thinking. The installer writes only the DoFlow-owned server entries:

| Scope | Registration location |
|---|---|
| Global (`-g`) | `~/.claude.json` → `mcpServers` |
| Project | `<projectRoot>/.mcp.json` |

```bash
# Choose an explicit subset.
doflow install -g --target claude --mcp context7,sequential-thinking
```

The selected servers are stored in the installer manifest and reused by `doflow update`.

## Verify, state, and recover

```bash
doflow status -g
doflow list-backups -g
```

Use `/do` in Claude Code. In Codex, verify the managed `AGENTS.md` section, skill discovery,
and any trusted hook/MCP configuration. In Gemini CLI, verify `GEMINI.md` and discovered skills;
unavailable capability rows must remain unavailable rather than appearing as copied files.

During the registry migration, verified ownership and recovery records are stored independently of
the harness: `<project>/.doflow/state/` for project scope and `~/.doflow/state/` for user scope.
Legacy backups and manifests remain compatible while this migration is in progress.

If a configuration update is wrong, restore the named backup with `doflow rollback`. MCP server
registration is a surgical merge outside the installed directory and is intentionally not reverted
by rollback.
