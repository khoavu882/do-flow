# Enterprise governance: what DoFlow installs, and what only your organization can enforce

DoFlow installs guidance, skills, hooks and settings into eight AI coding harnesses. Some governance
controls cannot be installed that way at all — not because DoFlow lacks the feature, but because the
property that makes them enforceable is that they come from your organization rather than from a
project. This page draws that line so you can tell which half DoFlow already gives you and which half
is an administrator's deployment task.

It is written for the person who has to answer "can we run this under our policy".

## The structural point, and it holds for every harness

DoFlow writes at **project scope or user scope**, for all eight harnesses. Every settings or config
path its registry declares is one or the other:

| Harness | What DoFlow writes |
|---|---|
| Claude Code | `<repo>/.claude/settings.json` |
| Codex | `<repo>/.codex/config.toml` |
| Gemini | `<repo>/.gemini/settings.json` |
| OpenCode | `opencode.json` (project), `~/.config/opencode/opencode.json` (user) |
| Pi | `.pi/settings.json` (project), `.pi/agent/settings.json` (user) |
| GitHub Copilot CLI | no settings or config path declared |
| Kiro | no settings or config path declared |
| Antigravity | no settings or config path declared |

For the last three DoFlow projects no settings file at all, so there is nothing there for a settings
policy to reach in either direction — what it installs for them is instructions, skills and hooks.

Two rows share one surface: Gemini and Antigravity have the same config directory, `.agents` in the
project and `~/.gemini/config` for the user, and differ only in their instruction file. A policy you
write against that directory therefore governs both, and a count of "seven tools" that merges them is
counting products where this table counts adapters.

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

Plus an allow-list of ordinary build and test commands, and hook scripts on thirteen lifecycle events
including `PermissionDenied` and `PreToolUse`. The hook layer is where DoFlow's own enforcement lives:
hooks are deterministic and run on every matching action, which is why a blocked command produces a
reason rather than a silent refusal.

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
