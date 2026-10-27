---
description: Prerequisites, install modes and scopes, updates, backup, rollback, MCP servers, and per-tool mapping.
---
# Setup

This is the canonical installation and lifecycle guide for DoFlow. The [Quickstart](quickstart.md)
contains only the shortest path to a working installation.

## Prerequisites

### Core

| Requirement | Needed for | Notes |
|---|---|---|
| Node.js 24.22.1+ | The `doflow` installer and runtime, and `npx` for the bundled MCP servers | `package.json` declares `engines.node` as `>=24.22.1`, the Node 24 security release of 2026-10-21 (CVE-2026-111497). A source checkout runs `src/**/*.ts` directly through Node's native type-stripping (`process.features.typescript`); the npm package ships JavaScript built by `npm run build:package`, and its `bin/doflow.js` still requires type-stripping support. Type-stripping is on by default on every supported Node, with no `ExperimentalWarning`. `doflow` refuses an older Node with one line on stderr and exit code 2, and refuses a Node with stripping disabled with `--no-experimental-strip-types` (for example through `NODE_OPTIONS`) the same way. `doflow doctor` warns, without refusing, on a Node below the patched release of its line (24.22.1, 26.12.1; a prerelease of the patched version counts as below it); a line with no known patched release, such as Node 25 or 27, gets no warning. Node 22 and every Node 24 before 24.22.1 are no longer supported, and Node 18/20 were dropped earlier, with the TypeScript migration (semver-major). |
| Git | Cloning, `self-update`, and the git context hooks | |
| `bash` | Hook scripts, on any harness that supports hooks | POSIX bash, Git Bash/MSYS2, and WSL bash all qualify. DoFlow runs `bash --version` rather than a PATH check, so a same-named unrelated binary will not satisfy it. Installs that carry no hooks do not need it. |
| `jq` | The DoFlow shell scripts and hook payload parsing | Preinstalled on GitHub-hosted runners. The prompt nudge also needs a `jq` built with regex support (Oniguruma) and stays silent without it |
| At least one coding agent | Somewhere to install to | See the table below |

### Coding agents

DoFlow installs into whichever of these you have. None is required individually; you need at least
one. All seven are fully declared, adapted, and installable via `--target <id>`.

| Agent | `--target` value | What DoFlow installs |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude` | `CLAUDE.md`, skills, agents, hooks, MCP registration, session context |
| [Codex](https://learn.chatgpt.com/docs/customization/overview) | `codex` | `AGENTS.md` (project root, or `~/.codex/AGENTS.md` globally), skills at `.agents/skills/` (the only tree Codex scans), scripts and templates in the shared `.doflow/` tree, agents (`.codex/agents/*.toml`), hooks (`.codex/hooks.json`), MCP via `config.toml` |
| [OpenCode](https://opencode.ai/) | `opencode` | Managed `AGENTS.md` section (registered via `opencode.json`'s `instructions[]`), skills discovered natively at `.opencode/skills/` (project) or `~/.config/opencode/skills/` (global), the `doflow-run` dispatcher and runtime plus the guidance tree in the shared `.doflow/` tree, and MCP servers merged into `opencode.json`'s `mcp` key |
| [Pi](https://pi.dev/) | `pi` | Managed `AGENTS.md` section, skills copied into `.pi/skills/` (project) or `~/.pi/agent/skills/` (global), with `settings.json` left untouched, the `doflow-run` dispatcher and runtime plus the guidance tree in the shared `.doflow/` tree, and MCP servers merged into `.pi/mcp.json` (project; Pi reads it only after you trust the project) or `~/.pi/agent/mcp.json` (global, or `$PI_CODING_AGENT_DIR/mcp.json`; Pi moves its whole agent dir with that variable; DoFlow moves `mcp.json` there, and the guard extension when it installs one, so skills and `AGENTS.md` stay in `~/.pi/agent/`); the [capability map](capability-map.md) states the Pi version floor and the `pi-mcp-adapter` case |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) | `copilot` | `.github/copilot-instructions.md` (DoFlow writes project scope only; a personal `~/.copilot/copilot-instructions.md` also exists upstream but receives nothing), the core guidance set as `*.instructions.md` under `.github/instructions/` (project) or `~/.copilot/instructions/` (global), skills at `.agents/skills/` (project) or `~/.agents/skills/` (global), agents at `.github/agents/` (project) or `~/.copilot/agents/` (global), the `doflow-run` dispatcher and runtime plus the guidance tree in the shared `.doflow/` tree, and MCP merged into `.mcp.json` (project) or `~/.copilot/mcp-config.json` (global) |
| [Kiro](https://kiro.dev/) | `kiro` | The core guidance set (the `DOFLOW_CORE.md` import walk) projected as steering files under `.kiro/steering/` (project) or `~/.kiro/steering/` (global), skills at `.kiro/skills/`, the `doflow-run` dispatcher and runtime in the shared `.doflow/` tree, agents rendered as `.kiro/agents/<name>.json` (the seven specialists plus a `doflow` main agent, each carrying DoFlow's guard hooks), hooks at `.kiro/hooks/` (not in Kiro's untrusted-workspace exclusion list; whether its shell-command prompt covers hooks is undocumented), and MCP via `.kiro/settings/mcp.json` |
| [Antigravity CLI](https://antigravity.google/) (`agy`) | `antigravity` | Managed `AGENTS.md` section (project), the core guidance set flat in `.agents/rules/` (project, each file under `trigger: always_on` front-matter), skills at `.agents/skills/` (project) or `~/.gemini/config/skills/` (global), shared agents at `.agents/agents/` (project) or `~/.gemini/config/agents/` (global), the runtime locator, the `doflow-run` dispatcher and runtime in the shared `.doflow/` tree (both scopes), and MCP merged into `.agents/mcp_config.json` / `~/.gemini/config/mcp_config.json` (remote servers project to `serverUrl`). The `AGENTS.md` section and the rules are project scope only; at global scope the harness instead writes a marker-managed guidance-pointer section into `~/.gemini/GEMINI.md` |

Kiro CLI reads hooks from an agent's own configuration, so DoFlow's guards run only for the DoFlow
agents. Start the main session with `kiro-cli chat --agent doflow`, or opt in permanently with
`kiro-cli agent set-default doflow`; DoFlow never changes your default agent. The specialists
(`core-implementer`, `delivery-lead`, `quality-guardian`, `reviewer`, `spec-analyst`,
`system-architect`, `research-writer`) can be dispatched by role and carry the same pre-tool-use
guards. The `doflow` agent adds the session-context
(`agentSpawn`) and stop-check (`stop`) hooks. `.kiro/hooks/doflow.json` stays for the Kiro IDE;
kiro-cli does not read it.

Codex gates hook execution behind its own trust/review step — DoFlow writes the
configuration, but Codex runs no hook until you approve it in that tool. Kiro's hooks are
not in Kiro v3's untrusted-workspace exclusion list (custom agents, steering, MCP configuration,
skills, workflows); an untrusted workspace asks before every shell command, and whether that covers
hook commands is undocumented. Copilot CLI hooks are projected from `.github/hooks/doflow.json` (project) or
`$COPILOT_HOME/hooks/doflow.json`, default `~/.copilot/hooks/doflow.json` (user), once `copilot` is in `hooks.harnesses`; DoFlow writes no
Copilot settings file and no plugin. OpenCode
uses code modules rather than the shell commands DoFlow ships, so no OpenCode hook is installed.
Pi now has a `tool_call` guard extension at user and project scope; the project extension runs only
after the project is trusted. OpenCode's `opencode.json` merge remains supported; DoFlow does not write Pi's `settings.json`.
Gemini CLI was retired in favour of Antigravity: `--target gemini` is refused, and an existing
Gemini CLI install is released on the next `install`, `update` or `reconcile`; see
[Antigravity's global instructions file](#antigravity-global-instructions-file). Each of the three
backs up the files the release changes before it applies it, so `doflow rollback` can undo it. The
run prints one summary line:
`[RETIRED] gemini → antigravity: deleted N, stripped N, released N, dropped N, deferred N, kept N`.

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

Each tool backs a capability the router resolves. When one is absent the router falls back where a
fallback exists: Semble falls back to Ripgrep, and so does Graphify for `code.relationships`;
`code.impact-analysis` (Graphify) and `command.compress` (RTK) have no fallback provider. Run `doflow
capabilities` to see which provider is actually active on your machine, and `doflow doctor` for a
health check across all three.

### MCP servers

DoFlow registers `context7` and `sequential-thinking` for the harnesses that support MCP. Both run
via `npx`, so they need no separate installation beyond Node. `--mcp` picks the servers for every
targeted harness that takes MCP servers, which is every harness. Each harness's
selection is recorded in `doflow.lock` and `update` reuses it for that harness. The default is none,
and an interactive install prompts on a real terminal.

The servers are optional. A stage that names one consults it only when its trigger holds and the
server is available, and says what it did at handoff; see [MCP server selection](#mcp-server-selection)
for which stage names which server and how to add one.

### Decision model (optional)

To enable advisory decision picks, run `doflow advise --action configure --model <decision-capable-model>`.
This writes the user setting to `$XDG_CONFIG_HOME/doflow/settings.json`, or to
`~/.config/doflow/settings.json` when `XDG_CONFIG_HOME` is unset; an existing `decision-model.json`
there is still read. A project may override that
user setting only after the user enables it: project configuration can disable advice or choose a
model, but cannot enable advice or select an endpoint or provider. Decision-model endpoints must
resolve only to loopback addresses; DoFlow rejects non-loopback endpoints. DoFlow never pulls a
model or starts Ollama.

## Installation modes

### CLI installation

Install with the CLI, for one tool or several, at user or project scope. It is published as
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

### What gets installed

`doflow` always writes to the real per-tool directory below — never to `core/`, which is only the
source tree this repo ships. `doflow status` (see below) prints the resolved paths for a given
invocation, so treat it as the source of truth over this table for a specific run. For Antigravity
it currently prints `antigravity-> undefined`; use the table below for that target:

| Target | Global (`-g`) | Project (default) |
|---|---|---|
| Claude Code | `~/.claude/` | `<projectRoot>/.claude/` **and** `<projectRoot>/.mcp.json` |
| Codex | `~/.codex/` **and** `~/.agents/` | `<projectRoot>/.codex/`, `<projectRoot>/.agents/`, **and** `<projectRoot>/AGENTS.md` |
| OpenCode | `~/.config/opencode/` | `<projectRoot>/.opencode/`, `<projectRoot>/AGENTS.md`, **and** `<projectRoot>/opencode.json` |
| Pi | `~/.pi/agent/` | `<projectRoot>/.pi/` **and** `<projectRoot>/AGENTS.md` |
| GitHub Copilot CLI | `~/.copilot/` **and** `~/.agents/` | `<projectRoot>/.github/`, `<projectRoot>/.agents/`, **and** `<projectRoot>/.mcp.json` — see below |
| Kiro | `~/.kiro/` | `<projectRoot>/.kiro/` |
| Antigravity | `~/.gemini/config/` | `<projectRoot>/.agents/` **and** `<projectRoot>/AGENTS.md` — see [below](#antigravity-global-instructions-file) |

OpenCode's global config lives at `~/.config/opencode/`, **not** `~/.opencode/` — a path DoFlow's
own docs asserted incorrectly for several releases. `~/.opencode/` is a plausible guess that
OpenCode does not read; `src/adapters/opencode/index.ts`'s `nativePaths()` is the authoritative
implementation, confirmed against <https://opencode.ai/docs>.

The runtime is shared by every harness in a project. A project install of any one harness writes the
`doflow-run` dispatcher and the runtime into `<projectRoot>/.doflow/`, and a skill from any harness
finds the dispatcher by walking up from its working directory, so the nearest `.doflow/` wins over
`~/.doflow/`. The last install in a project therefore sets the runtime version that every harness's
skills use there: installing an older DoFlow for one harness downgrades the runtime for all the others
installed in that project until an install of a newer DoFlow replaces it.

Copilot CLI is the one target that writes to several directories in project scope — its
instructions, skills, agents, and MCP each follow their own documented convention rather than one shared root:

| What | Project-scope location | Global-scope location |
|---|---|---|
| Instructions | `<projectRoot>/.github/copilot-instructions.md` | Not written — a user-level `~/.copilot/copilot-instructions.md` (or `$COPILOT_HOME/copilot-instructions.md`) exists upstream; DoFlow writes nothing there |
| Skills | `<projectRoot>/.agents/skills/` | `~/.agents/skills/` |
| Agents | `<projectRoot>/.github/agents/` | `~/.copilot/agents/` |
| MCP | `<projectRoot>/.mcp.json` | `~/.copilot/mcp-config.json` |

#### Antigravity global instructions file

At global scope Antigravity reads **`~/.gemini/GEMINI.md`**, and `--target antigravity -g` writes the
DoFlow guidance pointer there as a marker-managed section; text outside the markers is never touched,
and a file with no DoFlow section gets one appended. A section left by an earlier Gemini CLI install is
taken over in one write on the next `install` or `update`; if that section was edited since, DoFlow
keeps the file as it is until you re-run with `--force`. `remove -g -t antigravity` strips the section
and leaves the rest of the file.
Text a person wrote inside the Gemini CLI section's markers is removed with the section; it is backed
up first.

## CLI lifecycle

```bash
# Show the current installation state, including the resolved per-tool directories.
doflow status -g

# Apply changed source files only.
doflow update -g

# Converge observed state onto what install pinned (see doflow.lock below).
doflow reconcile -g --dry-run   # drift report; exits 1 when drifted, writes nothing (CI-friendly)
doflow reconcile -g             # report, confirm, heal

# List or restore backups.
doflow list-backups -g
doflow rollback -g install_YYYY-MM-DD_HH-MM-SS

# Preview any command without writing.
doflow install --dry-run -g --target codex

# Opt-in projections (both default OFF):
doflow install -g --permissions --target opencode   # destructive-command deny rules in opencode.json
doflow install -g --statusline --target claude      # doflow-statusline.sh + managed statusLine key

# Remove accepts the same flags so it can identify exactly what to strip.
```

When `doflow remove` removes the last harness of a scope it also deletes DoFlow's storage control files (the `.doflow/state/.gitignore` it wrote, the upkeep marker and lock) but leaves `.doflow/state/` itself, which git then shows as untracked; delete it with `rm -rf .doflow/state` if you no longer want it.

`install`, `update`, `remove`, `reconcile` and `rollback` run one at a time in a scope. A second run
prints `Waiting for another DoFlow run in ...` and waits up to 60 seconds for the first to finish;
after that it stops with exit 1 and changes nothing. A lock left by a run that crashed or was
interrupted with Ctrl+C is cleared with a `Cleared a stale DoFlow run lock` warning on the next run,
when its process is gone or the lock is older than 10 minutes. `--dry-run`, `status`,
`list-backups`, `doctor` and the runtime commands never take the lock and never wait. The lock is
not reliable on a network file system, on a home directory shared between machines, on Windows, or
against an older DoFlow running at the same time.

A project command whose root is the home directory (`doflow install .` run from `~`, or `doflow
update` without `-g` run from `~`) is refused with exit 1 and nothing is changed: it would share
the global install's files and records, and its `remove` could delete them. Use `-g`.

An install or update that changes files first copies only those files into
`.doflow/backups/<id>/`, and records the files it is about to create so a rollback can tell them
apart. A file that holds only MCP entries is never copied. The ownership ledger
(`.doflow/state/ledger.json`) is copied with those files, so a rollback restores the records that
describe what it restores and a later `update` or `remove` accepts them. It restores only the records
of the files it writes back (narrowed by `--target` with them): records of later runs, of other
harnesses and of MCP entries stay as they are, so a later `remove` still finds everything DoFlow has
on disk. Nothing else under `.doflow/state` (runs, evidence, recovery records), `doflow.lock` or the
install manifest is copied. After each install or update (and after a reconcile that backed up a retirement sweep) the newest 3
backups of that scope are kept: `--prune N` keeps N, and `--prune 0` keeps all. An update with
nothing to change prunes nothing, so the first run after upgrading from 1.19 that prunes is an
install, or an update that changes files; it removes the older DoFlow-written backups beyond the
newest 3 (`--dry-run` shows how many first). Pruning only removes backups older than the one the run just made, so a backup a concurrent run finished in the meantime is never pruned ("newer" follows the backup sort order, so a backup dated in the future is never pruned while its date is in the future), and each removal renames the backup aside first so a half-deleted backup is never listed. A leftover rename-aside (`.tmp-del-*`) from a pass that died is deleted by the next prune on the same host once its process is gone, and if both the delete and the roll-back of a pass failed, that backup, which the pass had already selected for removal, goes with it. The legacy `.claude/backups` folder is listed but never pruned. `--no-backup`
requires `--force`; use it only when the configuration is disposable.

### doflow.lock and reconciliation

Every `install`, `update`, and `remove` maintains `<root>/.doflow/doflow.lock` — a pin of what was
**chosen**: targeted harnesses, selected assets with their native destinations, and the MCP
selection of each harness. A run keeps the rows of harnesses it did not target, and a harness leaves
the lock only when its last owned resource is removed.
The ownership ledger records what DoFlow *owns*; the lock records what it *chose*. Together they
turn the next update's delta into a reviewable fact: `update` prints `doflow.lock: N change(s)`,
and a no-op update leaves the lock byte-untouched.

`doflow reconcile` treats the lock as the desired state and heals observed drift onto it. A harness
installed in the ledger but absent from the lock is named with a `[WARN]` line and is not converged.
For the harnesses the lock pins:

- **Drifted files you edited by hand are never clobbered.** A ledger-owned file whose bytes were
  changed outside DoFlow is reported as a conflict unless you pass `--force` (or run reconcile,
  which is always forced), in which case the managed bytes are restored — that restore *is* the
  healing.
- **Resources with no record at all are a different case, and need `--adopt`.** A file DoFlow wrote
  before the neutral ledger existed has no record describing it, so it reports as *not owned* rather
  than *modified* — and `--force` does not answer it, because forcing is about overriding a record
  that disagrees, not about the absence of one. `doflow install --adopt` records ownership of such a
  resource and then plans it like any other managed one. The two flags are orthogonal and compose: a
  tree that is both unrecorded and drifted needs `--adopt --force`. Adoption never overrides a record
  that contradicts the bytes on disk; that stays a conflict, which is what keeps it distinct from
  `--force`.

- **Moved projections leave tombstones.** When an asset's destination changes between versions
  (as Codex's skills move from `.codex/skills` to `.agents/skills` did), the old location is
  recorded in the ledger's tombstone log and the stale copy is swept automatically — but only if
  its bytes still match what DoFlow last verified there. Files you edited stay, with an unswept
  tombstone saying so.
- **A lock that pins only `gemini` makes reconcile do nothing.** Run `doflow update` in that scope to
  release Gemini CLI's files.
- **Reconcile replaces an edited `GEMINI.md` section.** It is always forced, so a DoFlow section in
  `~/.gemini/GEMINI.md` that you edited is replaced; text outside the markers stays.

## Harness capabilities and activation

| Component | Claude Code | Codex | OpenCode | Pi Coding Agent | GitHub Copilot CLI | Kiro | Antigravity |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Instructions | `CLAUDE.md` | Managed `AGENTS.md` | Managed `AGENTS.md` | Managed `AGENTS.md` | `.github/copilot-instructions.md` (project only) | Steering files (`.kiro/steering/`) | Managed `AGENTS.md` (project); guidance-pointer section in `~/.gemini/GEMINI.md` (global) |
| Rules, agents, references | ✓ | ✓ | ✓ (`.opencode/agents/` / `~/.config/opencode/agents/`) | Different — agent guidance via instructions, no native agent directory | ✓ | ✓ | ✓
| Skills | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓
| Scripts and templates | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Scripts ✓; templates through skill bundles
| Modes | ✓ | Native mode unavailable | Guidance projection | Guidance projection | Guidance projection | Guidance projection (steering) | Guidance projection
| Hooks and settings | ✓ | Hooks require trust/review; settings differ | No hook projection (plugin module required); settings supported via `opencode.json` | `tool_call` guard extension (project scope needs trust); `settings.json` not written | Hooks documented upstream but not projected (Claude-payload coupling); no settings file is written | Hooks supported via `.kiro/hooks/`, not in Kiro's untrusted-workspace exclusion list; no general settings file beyond MCP | Hooks via `.agents/hooks.json` (pre-implementation gate, stop check; project only); no settings tier |
| MCP registration | ✓ | ✓ | ✓ (`opencode.json`) | ✓ (`.pi/mcp.json` / `~/.pi/agent/mcp.json`) | ✓ (`.mcp.json` / `mcp-config.json`) | ✓ (`.kiro/settings/mcp.json`) | ✓ (`.agents/mcp_config.json` / `~/.gemini/config/mcp_config.json`) |

This is a capability contract, not a statement that every native surface is active after copying
files. Verify installation in the target harness and review the [capability map](capability-map.md)
before treating a feature as available. The repository exposes
`core/` as a Claude Code marketplace plugin through its `.claude-plugin/marketplace.json` and
`.claude-plugin/plugin.json`, as a Codex/ChatGPT plugin through
`core/.codex-plugin/plugin.json`, and as a GitHub Copilot CLI plugin through
`core/.plugin/plugin.json`. These manifests are distribution artifacts and are not copied by
`doflow install`.

### Claude Code marketplace

To add the canonical Claude configuration directory as a marketplace, run:

```bash
claude plugin marketplace add /path/to/do-flow/core
```

Then install `doflow` from the marketplace in Claude Code. The marketplace entry points to the
current `core/` directory, so the plugin and the CLI installer share the same canonical skills and
guidance.

### GitHub Copilot CLI plugin

Copilot CLI discovers plugins by checking `.plugin/plugin.json`, `plugin.json`,
`.github/plugin/plugin.json`, then `.claude-plugin/plugin.json`; there is no `.copilot-plugin/`
convention. DoFlow authors the first-checked location with a skills-only manifest so the plugin
declares exactly what activates there: skills from `core/shared/skills/`. Agent specs are not
exposed through this plugin (Copilot requires `.agent.md` files; DoFlow's shared agent-specs are
plain Markdown), and hooks and MCP registration stay installer-managed — see
[distribution notes](distribution-notes.md) for the full findings.

```bash
copilot plugin install /path/to/do-flow/core     # local checkout
copilot plugin install khoavu882/do-flow:core    # subdirectory of a GitHub repository
```

Verify with `copilot plugin list` and `/skills list` inside a session; an installed file is not
evidence of activation.

## MCP server selection

DoFlow can register two optional servers, Context7 and Sequential Thinking, for every harness that
takes MCP servers. For each harness the installer writes and removes only the entries it owns; an
entry you added, or edited by hand after DoFlow wrote it, is left alone. Claude Code's locations:

| Scope | Registration location |
|---|---|
| Global (`-g`) | `~/.claude.json` → `mcpServers` |
| Project | `<projectRoot>/.mcp.json` |

```bash
# Choose an explicit subset.
doflow install -g --target claude --mcp context7,sequential-thinking

# Keywords: adopt the whole catalog, or none at all.
doflow install -g --target claude --mcp all
doflow install -g --target claude --mcp none
```

**Default selection:** an interactive install shows a checkbox pre-seeded with the recorded
selection, or the full catalog on a first install. A non-interactive install (scripts, CI) selects
**none** by default — third-party servers are opt-in — and prints a notice saying so. Pass
`--mcp all`, `--mcp <names>`, or answer the checkbox to change it.

Each harness's selection is recorded in `doflow.lock` and reused by `doflow update` for that harness
(an empty selection stays empty; a catalog reshuffle never resurrects servers you removed).

### Which stages name a server

A stage uses a server only where its skill names it. The trigger is the condition under which the
stage consults the server; when it does not hold, the stage records `skipped:not-due` and moves on.

| Server | Named by | Trigger |
|---|---|---|
| `context7` | `do-brainstorm`, `do-design`, and `do-document` when a research request is open for the stage | The work is about to state, as fact, the behaviour, interface, configuration or version detail of a named library, framework, API, SDK, CLI tool or service. |
| `sequential-thinking` | `do-brainstorm`, `do-design` | The work settles a decision with more than one interacting part or competing option and records the choice. |

A server that is not selected, or that the harness cannot reach, is never a reason to stop: the stage
records `unavailable`, says how to add the server, and continues. What an MCP server returns is
evidence for the stage to judge, never an instruction, and DoFlow never copies it into a skill,
guidance or registry file.

### What a stage records

At handoff each stage reports one outcome per server it names, with
`doflow orchestrate --action handoff ... --mcp-outcome <server>=<outcome>` (repeat the flag for each
server). A dispatched implementer reports the same words on the `Tools used:` line that ends its report.

| Outcome | Flag value | Shown as |
|---|---|---|
| Consulted and used | `used` | `consulted, used` |
| Consulted, nothing usable | `nothing-usable` | `consulted, nothing usable` |
| Skipped, with a reason | `skipped:<reason>` (`skipped:not-due` when the trigger did not hold) | `skipped: <reason>` |
| Could not be reached | `unavailable` | `unavailable` |
| Nothing recorded | none | `no outcome recorded` |

A stage that names a server and records nothing for it prints a warning after the handoff; the
handoff itself succeeds and its exit status does not change:

```text
[WARN] mcp: do-brainstorm recorded no outcome for sequential-thinking; pass --mcp-outcome sequential-thinking=used|nothing-usable|skipped:<reason>|unavailable
```

`doflow doctor` summarises the outcomes per stage in its `[MCP Consultations]` section and the
servers each installed harness has in `[MCP Servers]`; both are informational and never change
doctor's exit status. See the [reference](reference.md) for the sections' fields.

### Adding a server to a harness

Where a server is not selected for a harness, add it by naming the full list you want, since `--mcp`
replaces the harness's selection. Doctor's `[MCP Servers]` section prints the exact command per
harness and scope:

```bash
doflow install --target claude --mcp context7          # project scope
doflow install -g --target codex --mcp context7,sequential-thinking
```

```text
[MCP Servers] — named by shipped stages; not blocking
  context7              named by do-brainstorm, do-design, do-document (research request)
    claude        project  ✓ selected
  sequential-thinking   named by do-brainstorm, do-design
    claude        project  ? unknown          add: doflow install --target claude --mcp context7,sequential-thinking
```

`? unknown` means DoFlow cannot tell whether the harness has the server: it did not see every
configuration the harness merges (Claude Code also loads servers DoFlow cannot see,
such as plugins and user-level settings), or a config file it reads could not be parsed. In the
second case doctor prints `fix <file> first` in place of the `add:` command. `unknown` never means
the server is missing, so a stage that finds no tool answering records `unavailable` itself.

In Codex, an MCP server that `config.toml` already defines under the same name
(`[mcp_servers.context7]`, for example) is left exactly as it is. DoFlow does not record it as its
own, and every `install` and `update` that selects it prints one line saying it kept your entry. To
let DoFlow manage that server, remove or rename your table and run `update`. A 1.18 to 1.20
install may have recorded your table as DoFlow's; `update` then refuses with `modified outside
DoFlow`. Run `doflow update -g -t codex --mcp <your other DoFlow servers, or none>` (a project path
in place of `-g` for a project): DoFlow stops managing that server and keeps your table.

## Verify, state, and recover

```bash
doflow status -g
doflow list-backups -g
```

Use `/do` in Claude Code. In Codex, verify the managed `AGENTS.md` section, skill discovery,
and any trusted hook/MCP configuration. Unavailable capability rows must remain unavailable rather than appearing as copied files. In
OpenCode, verify `AGENTS.md` loads and that `opencode.json`'s `instructions[]` and `mcp` keys are
populated. In Pi, verify `AGENTS.md`, skill discovery under `.pi/skills/` (or `~/.pi/agent/skills/` globally), and any registered MCP servers in `.pi/mcp.json` (or `~/.pi/agent/mcp.json` globally). In Copilot CLI,
verify the managed section in `.github/copilot-instructions.md`, skill discovery under
`.agents/skills/`, and any registered MCP servers. In Kiro, verify the projected steering files
under `.kiro/steering/`, skill discovery under `.kiro/skills/`, agents listed by `kiro-cli agent list` (run it in the project), and hook files under `.kiro/hooks/`.
In Antigravity, additionally verify `.agents/hooks/pre-implementation-gate.sh` and `.agents/hooks/stop-check.sh` are executable and `.agents/hooks.json` registers them. In Antigravity, verify the managed section in `AGENTS.md`, skill discovery under `.agents/skills/`,
and any registered MCP servers in `.agents/mcp_config.json` (project) or
`~/.gemini/config/mcp_config.json` (global); at global scope also the DoFlow section in `~/.gemini/GEMINI.md`.

Verified ownership and recovery records, lifecycle backups, and install metadata are stored
independently of the harness: `<project>/.doflow/` for project scope and `~/.doflow/` for user
scope. Backups live under `.doflow/backups/`, and the lifecycle manifest is
`.doflow/.install-manifest.json`. Lifecycle commands use these scope-neutral paths exclusively;
the explicit neutral-state importer still reads historical `.claude` metadata, and `list-backups` and
`rollback` also read the legacy `.claude/backups` root, read-only.

If a configuration update is wrong, restore the named backup with `doflow rollback`. Rollback
restores the files the backup holds, leaves in place the files the run created and lists them, and
exits 1 if a file cannot be restored. With no `--target` it restores the whole backup, including every
released Gemini CLI row and `targets.gemini`; `--target` restores only the files of the named
harnesses, and with them only the rows of the files it writes back. Before restoring, it snapshots only the files the
restore will overwrite. Backups made by 1.19 restore as before. The reverse does not hold: DoFlow
1.19's `rollback` of a newer backup takes a whole-home snapshot, restores nothing, and still reports
success, so after downgrading do not rely on it for backups made since. `doflow list-backups` shows each
backup's origin and size. MCP server registration is a surgical merge outside the installed
directory and is intentionally not reverted by rollback.
