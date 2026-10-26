---
description: Which governance controls DoFlow installs and which only an organization can enforce.
---
# Enterprise governance: what DoFlow installs, and what only your organization can enforce

DoFlow installs guidance, skills, hooks and settings into seven AI coding harnesses. Some governance
controls cannot be installed that way at all — not because DoFlow lacks the feature, but because the
property that makes them enforceable is that they come from your organization rather than from a
project. This page draws that line so you can tell which half DoFlow already gives you and which half
is an administrator's deployment task.

It is written for the person who has to answer "can we run this under our policy".

## The structural point, and it holds for every harness

DoFlow writes at **project scope or user scope**, for all seven harnesses. Every settings or config
path its registry declares is one or the other:

| Harness | What DoFlow writes |
|---|---|
| Claude Code | `.claude/settings.json` (project), `~/.claude/settings.json` (user) |
| Codex | `.codex/config.toml` (project), `~/.codex/config.toml` (user) |
| OpenCode | `opencode.json` (project), `~/.config/opencode/opencode.json` (user) |
| Pi | nothing: the registry declares `.pi/settings.json` (project) and `~/.pi/agent/settings.json` (user), but the adapter leaves both untouched |
| GitHub Copilot CLI | no settings file; only MCP config: `.mcp.json` (project), `~/.copilot/mcp-config.json` (user) |
| Kiro | no settings file; only MCP config, `.kiro/settings/mcp.json` (project and user) |
| Antigravity | no settings file; only MCP config, `.agents/mcp_config.json` (project) or `~/.gemini/config/mcp_config.json` (user), and `.agents/hooks.json` (project); its global instruction file is `~/.gemini/GEMINI.md` |

For the last three DoFlow writes no harness settings file, so there is nothing there for a settings
policy to reach in either direction — what it installs for them is instructions, skills, agents and
MCP config, plus hooks for Kiro and Antigravity.

Nowhere in that table is a system-level or organization-level path, and that is the whole point. A
harness that offers an organization-enforced tier puts it **above** project and user scope by design, so
that nothing a project sets can override it. DoFlow is a project installer; it sits below that line.
Whatever your harness calls its enforced tier, DoFlow cannot write it, and a control that belongs there
written into project settings instead is either ignored or keeps the shape of a policy while losing the
enforcement that made it worth setting.

So the division is the same whichever harness you use:

- **DoFlow's half** — anything valid at project or user scope. It ships some of these and you can
  extend them.
- **Your organization's half** — whatever your harness enforces from above. No installer delivers it.

What differs per harness is only the vocabulary and the file path. The rest of this page works one
harness through in detail, because that is the one whose surface is verified here.

## Worked example: Claude Code

Claude Code reads settings from several sources and applies them in a fixed precedence. Highest wins:

| Precedence | Source | Who owns it |
|---|---|---|
| 1 | Managed settings: `managed-settings.json`, MDM policy, or the claude.ai console | Your organization |
| 2 | Command line: `claude --settings` | You, this session |
| 3 | Project local: `.claude/settings.local.json` | You, this project |
| 4 | Shared project: `.claude/settings.json` | Everyone in the project |
| 5 | User: `~/.claude/settings.json` | You, every project |

DoFlow writes levels 4 and 5. Level 1 is the enforced tier, and Anthropic's documentation is explicit
that no user, project, local or `--settings` value overrides it.

### What DoFlow ships today

A destructive-command blocklist, authored in exactly one place so it cannot drift between harnesses
that derive from it:

```json
"permissions": {
  "deny": [
    "Bash(git push --force*:*)",
    "Bash(git reset --hard*:*)",
    "Bash(git clean -fd*:*)"
  ]
}
```

Two separate guard mechanisms enforce safety: the static Claude `permissions.deny` configuration shown above, and the dynamic hook policy (`pre-bash-guard.sh`). The static Claude permissions block commands unconditionally and are role-blind, so wherever that deny list is installed, Claude workers stay blocked by it regardless of the hook exemption. Only the hook policy knows session roles and worktree boundaries.

Plus an allow-list of ordinary build and test commands, and hook scripts on thirteen lifecycle events
including `PermissionDenied` and `PreToolUse`. The hook layer is where DoFlow's own enforcement lives:
hooks are deterministic and run on every matching action, which is why a blocked command produces a
reason rather than a silent refusal.

#### Worker exemptions and guard scoping

The pre-bash guard distinguishes between main interactive sessions and subagent worker sessions:

- **Worker git reset and clean exemptions:** The hook checks exact `worker` role, an absolute path to an existing canonical dispatch worktree (`<project>/.doflow/state/dispatch-worktrees/d-<12 hex>`), and a native hook cwd (`DF_ENV_CWD`) equal to or inside that worktree. It rejects set `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_COUNT` variables, and any `GIT_CONFIG_KEY_*` variable. For a shape-matched reset or clean command, it runs one `git rev-parse --path-format=absolute --git-dir --show-toplevel` from the cwd under a clean environment; the top level must be the dispatch worktree and its git directory must resolve below `<project>/.git/worktrees/` for that worktree. This rejects a planted `.git` file or a nested repository whose `core.worktree` points at the project. The shape check accepts one terminal LF or CRLF before matching. A reset must match the bare reset form, include `--hard`, and may include `-q` or `--quiet` flags and one revision token. Clean option groups match `(-[dfqxX]+|--force|--quiet)+` and contain exactly one `f` in total; short groups may be split, as in `git clean -d -f -x`. Wrappers, compounds, and main sessions do not receive the exemption.
- **Codex sandbox measurements and residual:** Codex CLI 0.163 probes used `codex sandbox -P :workspace`. When the project was outside sandbox-writable roots (not under `/tmp` or `$TMPDIR`, and not the command cwd), the sandbox denied `git reset --hard` in a dispatch worktree, `git clean` and writes in the main checkout, and writes to `<project>/.doflow/settings.json`. With the project under `/tmp` or `$TMPDIR`, those operations succeeded. The production launch flag `-s workspace-write` was not probed separately. Codex `exec_command`'s per-command working directory is not visible to the hook, so an exempt `git clean -f...` can act in any repository under a sandbox-writable root. The clean exemption remains for Codex because without it the feature has no effect for Codex workers.
- **Raw-command SQL text allow-list:** The hook skips only the three shipped SQL pattern rows when the raw command fully matches an accepted text-writing form. These are: `git commit -m` with single-quoted or safe double-quoted literal text; `git commit -F -` with a single-quoted heredoc; the exact `git commit -m "$(cat <<'W' ... W)"` idiom; `echo` or `printf` with one literal, optionally redirected with `>` or `>>` to a path with no dot-led segment; `cat` with a single-quoted heredoc, optionally redirected with `>` to such a path; and `gh pr|issue create|comment|edit` with `--body` and one single-quoted literal, or `--body-file -` with a single-quoted heredoc. Heredoc delimiters are single-quoted identifiers and must close exactly once on the final line. Safe double-quoted literals contain no `$`, backtick, or backslash. Every other raw command keeps its prior SQL verdict. Compared with the first version, `tee`, `mkdir`/`cd` chains, double quotes containing `$`, and redirects into dot-led paths such as `.git/` and dotfiles are no longer text-only. Text written to a file that something else later executes (for example, a script outside a dot-led path) is outside this guard.
- **Project-scoped drop-database relaxation:** The settings key `guard.workerDropDatabases` specifies a space-separated list of lowercase database names (`[a-z][a-z0-9_]{0,62}`, at most 32 names, at most 1 KiB, all-or-nothing); each name is at most 63 characters. Its scope is `project-only`: only the project configuration layer (`<project>/.doflow/settings.json` or `.doflow/settings.local.json`) is recognized; global configuration values are ignored, and no environment variable or CLI flag can set it (default is none). At worker launch, the launcher resolves and validates this list for the owning project root and exports a single environment variable: `DOFLOW_GUARD_DROP_DATABASES`. The hook reads only that variable. An unset, empty, or invalid list grants no relaxation. Exactly one command shape is relaxed, for worker sessions only: a single `psql -c` or `mysql -e` executing `DROP DATABASE [IF EXISTS] <listed name>` and nothing else. `DROP TABLE`, `TRUNCATE`, `DELETE`, an unlisted database name, compound commands, and main sessions remain denied.
- **Residual risk (FU-gxbryp):** Codex workers' ability to write `<project>/.doflow/settings.json` is measured only within the sandbox scope above: the `-P :workspace` probes denied that write when the project was outside writable roots and allowed it when under `/tmp` or `$TMPDIR`. The production `-s workspace-write` launch was not probed separately. FU-gxbryp tracks the possibility of a worker under a sandbox-writable root planting a database name for a later launch; the launch snapshot blocks self-authorisation during the same run. The hook also cannot verify which physical host or port a database client reaches when configured through environment variables or connection service files.

### Settings only your organization can enforce

These four are documented as managed-settings only. Deploy them yourself; nothing DoFlow installs
substitutes for them.

| Key | Type | What it does |
|---|---|---|
| `allowManagedHooksOnly` | boolean | Run only the hooks your organization deploys |
| `disableSideloadFlags` | boolean | Reject the CLI flags that sideload plugins, subagents and MCP servers |
| `strictKnownMarketplaces` | array | Allowlist the marketplace sources users can add and install from |
| `requiredMinimumVersion` | string | Refuse to start on a version older than your organization requires |

Two interact with DoFlow directly, and the interaction is worth knowing before you deploy:

- **`allowManagedHooksOnly` turns DoFlow's hooks off.** DoFlow installs its hooks into project or user
  settings, which is not a managed source. Under this key only your organization's hooks run, so the
  pre-implement gate, the bash guard, the MCP guard and the audit hooks all stop firing. If you want
  both, deploy DoFlow's hook scripts through your managed channel rather than expecting the installer's
  copies to survive. The same reasoning applies to any harness with an equivalent control.
- **`disableSideloadFlags` and `strictKnownMarketplaces` bound how DoFlow is installed**, since it ships
  skills, agents and MCP configuration. Decide whether DoFlow's install path is on your allowlist
  before rolling it out, not after.

`requiredMinimumVersion` refuses to start an outdated binary and does not end a session already
running, so it is the least disruptive of the four to introduce.

### Where the managed file goes

| Platform | Path |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL | `/etc/claude-code/managed-settings.json` |

MDM policy and the claude.ai console are the other two delivery mechanisms. Anthropic's documentation
covers choosing between them, how Claude Code combines multiple managed sources, and how to verify that
a setting is applying — read that before deploying, because this page deliberately does not restate it.

### Settings DoFlow could adopt

Both are valid at any scope, so DoFlow projecting them is a decision rather than a limitation. Neither
is shipped today.

| Key | Type | What it does |
|---|---|---|
| `sandbox` | object | Isolate Bash commands from your filesystem and network on macOS, Linux and WSL2 |
| `permissions.disableBypassPermissionsMode` | boolean | Prevent anyone from entering bypassPermissions mode |

`sandbox` is the one the AI-native SDLC playbook calls mandatory for high autonomy, on the grounds that
OS-level isolation closes gaps a permission list cannot. DoFlow does not ship a profile because one that
suits a given toolchain breaks another, and an installer-supplied profile would be wrong more often than
right. Configure it per project.

## The other seven harnesses

This page verifies Claude Code's surface and no other. For the remaining seven, what is established
here is only what the table above states: DoFlow writes at project or user scope, or writes no settings
file at all. Whether that harness offers an organization-enforced tier, what it is called and how it is
delivered is **not established here** — read that vendor's own documentation, and expect the same shape
of answer rather than the same key names.

Contributions that work one of them through to the same level of detail are worth more than a guess
here would be.

## What this page is not

It is not a compliance statement. DoFlow verifies no enforced setting on any harness, makes no claim
about any regulatory regime, and cannot tell you whether your policy is satisfied. It tells you which
controls live outside an installer's reach so that you look for them in the right place.

## Sources

The per-harness table is taken from DoFlow's own `core/registry/harnesses.json`. Every Claude Code key,
scope and path is taken from Anthropic's documentation rather than from DoFlow's behaviour:

- Settings files and precedence, including the five-level table: <https://code.claude.com/docs/en/settings>
- Managed settings, their delivery mechanisms, and the statement that no user, project, local or
  `--settings` value overrides them: <https://code.claude.com/docs/en/managed-settings>
- Per-key types, descriptions and scopes, including which keys are managed-only:
  <https://code.claude.com/docs/en/settings-reference>

Accessed 2026-09-10. A harness's settings surface changes; re-read those pages rather than trusting
this table if a deployment depends on it.
