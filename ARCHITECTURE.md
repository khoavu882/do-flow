# Architecture

How this repository is structured and how the components relate.

---

## Repository Layout

```
do-flow/
├── core/               # Deployable framework (installed to ~/.claude/)
│   ├── CLAUDE.md       # Session entrypoint — @-includes FLAGS, PRINCIPLES, RULES
│   ├── FLAGS.md        # Behavioral flags and MCP trigger conditions
│   ├── PRINCIPLES.md   # Engineering principles (SOLID, DRY, KISS, YAGNI)
│   ├── settings.json   # Permissions, hooks, model, outputStyle, autocompact
│   ├── keybindings.json
│   ├── .mcp.json       # MCP server registration
│   ├── agents/         # 15 specialist agent definitions
│   ├── skills/         # 37 Claude Code slash-command skills
│   ├── modes/          # 6 behavioral modes (on-demand only)
│   ├── rules/          # 4 rule files (<60 lines each)
│   ├── mcp/            # MCP server documentation
│   ├── hooks/          # Shell hooks for session lifecycle
│   └── reference/      # Domain reference (Java, spec/constitution, research)
├── bin/
│   ├── doflow.js       # Installer (Node, maintained) — deploys core/ to ~/.claude/, ~/.codex/, ~/.gemini/
│   ├── sync.sh         # Deprecation shim — translates sync.sh's flag grammar and delegates to doflow.js
│   ├── sync-legacy.sh  # Original bash implementation, frozen — the independent reference doflow was ported from
│   └── mappings.conf   # Source→destination mapping per AI tool (read by both doflow.js and sync-legacy.sh)
├── src/                # doflow.js's engine modules (mappings/targets/copy/backup/manifest/diff/context/prompt)
├── docs/               # MkDocs site source (GitHub Pages)
├── test/               # All tests: *.test.js (node --test's default discovery path) +
│                       # bash integration suites (cli-parity.sh, verify-hooks.sh, doflow-chain-test.sh,
│                       # hooks/test-hooks.sh), invoked explicitly by path
├── agent-docs/         # Generated analysis and design documents (not deployed)
└── mkdocs.yml          # GitHub Pages configuration
```

---

## `core/` vs `bin/`

**`core/`** contains everything that gets deployed to `~/.claude/` (and subsets to `~/.codex/`, `~/.gemini/`). These are the files the AI reads.

**`bin/` + `src/`** contain the tooling that manages the deployment — `doflow.js`, its shim/legacy siblings, and `mappings.conf`. These are never copied to AI tool directories.

---

## `test/` — one directory, two kinds of test

Node's `node --test` (invoked bare, via `npm test`) auto-discovers `*.test.js` files under `test/`
by convention — no glob or path argument needed. The bash integration suites (`cli-parity.sh`,
`verify-hooks.sh`, `doflow-chain-test.sh`, `hooks/test-hooks.sh`) live in the same directory but
are invoked explicitly by path (`bash test/foo.sh`); Node's discovery only matches `.js`/`.mjs`/
`.cjs` extensions, so it silently ignores the `.sh` files rather than erroring on them. One
directory, zero config conflict.

This repo's own `core/rules/RULE_03_QUALITY.md` ("tests → `tests/`") is written for projects
*consuming* DoFlow — most of which don't have a Node test runner with its own directory
convention to satisfy — so it doesn't dictate this repo's own layout.

---

## Deployment: `doflow.js` + `mappings.conf`

`bin/mappings.conf` is the deployment manifest. Each line maps a source path (relative to repo root) to a destination path (relative to the tool's config directory):

```
[claude]
core/hooks/    : hooks/
core/skills/   : skills/
core/agents/   : agents/
core/settings.json : settings.json
...

[codex]
core/rules/    : rules/
core/agents/   : agents/
core/reference/ : reference/
```

`bin/doflow.js` (backed by `src/copy.js`, `src/backup.js`, `src/manifest.js`) reads these mappings and
copies source files to the appropriate tool directory via `fs.cpSync`, dir-merging like `rsync -a`
would. It maintains an install manifest (`.install-manifest.json`, atomic write) and creates full
`tar.gz` backups before each install. `bin/sync.sh` is a thin deprecation shim that translates its
old flag grammar (`--install`, `--rollback [ID]`, ...) into `doflow`'s subcommand grammar and
delegates; `bin/sync-legacy.sh` is the frozen original bash implementation, kept only as the
independent reference `test/cli-parity.sh` diffs `doflow` against.

**Runtime requirements (doflow.js):** Node >= 18, zero runtime dependencies. **Runtime requirements
(sync-legacy.sh, parity-testing only):** bash 4.0+, jq, rsync. On macOS: `brew install bash jq rsync`
(the system bash is 3.2).

Claude gets everything. Codex and Gemini get the tool-agnostic subset (rules, agents, reference) — they have no equivalent of Claude Code's slash commands or hooks.

**`core/.mcp.json` is deliberately not in `mappings.conf`.** Claude Code never reads a `.mcp.json`
from inside `.claude/` — it resolves MCP servers from `~/.claude.json`'s `mcpServers` key (global
scope) or `<projectRoot>/.mcp.json` (project scope, sibling to `.claude/`). `src/mcp.js` writes
directly to those locations instead of going through the generic copy engine: a read-merge-write
into either file, touching only the server names `core/.mcp.json` defines and leaving everything
else untouched — unrelated top-level state in `~/.claude.json` (history, projects), or a server a
user hand-added to either file under a name doflow doesn't ship. Both writes refuse to proceed if
the existing file is present but fails to parse, rather than silently treating it as empty and
discarding its content. Which servers get installed is selectable via `--mcp <list>` or an
interactive checkbox prompt, and the selection is remembered in `.install-manifest.json` so `doflow
update` doesn't silently revert it. See [docs/setup.md#mcp-servers](docs/setup.md#mcp-servers) for
the CLI details.

---

## Skill Structure

Each skill lives at `core/skills/{name}/SKILL.md`. The frontmatter drives how Claude Code loads and presents it:

```yaml
---
name: do-implement
description: "Execute implementation with agent delegation"
argument-hint: "[spec] [--think-hard] [--c7] [--delegate]"
disable-model-invocation: false
effort: high
---
```

Skills are prompt templates. When a user invokes `/do-implement`, Claude Code expands the SKILL.md content as a system-turn prefix for that interaction. The behavioral flow and key patterns sections shape how Claude responds.

---

## Hook Architecture

Hooks are shell scripts registered in `core/settings.json` under the `hooks` key. Claude Code invokes them at specific lifecycle events by passing JSON via stdin and reading JSON from stdout.

```
SessionStart        → session-start.sh     (write git-context.json to disk)
UserPromptSubmit    → user-prompt-submit.sh (inject git context on first prompt)
PreToolUse(Bash)    → pre-bash-guard.sh    (deny dangerous patterns)
PostToolUse(Edit)   → post-edit-lint.sh    (collect edited paths)
PostToolUse(Write)  → post-edit-lint.sh    (collect edited paths)
Stop                → stop-check.sh        (batch lint + stub detection)
PreCompact          → pre-compact.sh       (enrich compaction with git state)
PostCompact         → post-compact.sh      (save compact summary to disk)
SessionEnd          → session-end.sh       (cleanup + log trim)
```

All hook scripts source `core/hooks/lib.sh` for shared constants (`STATE_DIR`, `SESSION_DIR`, `PROJECTS_DIR`) and helpers (`json_field`, `ensure_session_dir`, `ensure_project_dir`, `require_jq`).

**Multi-session isolation:** Session state is keyed by `session_id` (from hook input JSON). Project state is keyed by `sha256sum` of the working directory path. Multiple Claude Code windows can run simultaneously without conflict.

---

## Settings + Permissions

`core/settings.json` controls three things:

1. **Permissions** — `allow` and `deny` lists for tool invocations. The deny list covers dangerous git/filesystem operations as a secondary safety layer (the primary is `pre-bash-guard.sh`).

2. **Hooks** — The `hooks` section registers each shell script against its event. Once deployed via `doflow` (or the `sync.sh` shim), these take effect at next session start.

3. **Model + behavior** — `outputStyle`, `model`, `alwaysThinkingEnabled`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (set to 75%).

---

## Rule File Constraint

Each file in `core/rules/` is kept under 60 lines. This is intentional: Claude Code loads rule files into the system prompt, and shorter files have better adherence. A 300-line "Safety and Workflow and Quality" monolith tends to have its later sections ignored. Four focused 60-line files (`RULE_01_SAFETY`, `RULE_02_WORKFLOW`, `RULE_03_QUALITY`, `RULE_04_QUESTIONS`) hold attention better.
