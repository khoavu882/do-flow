# Multi-harness capability map

This map is generated in intent from `core/registry/harnesses.yaml`: it records the capability
contract that adapters must honor. A `supported` row means the native harness has a documented
surface; it does **not** mean a file copy has activated it. Each installation still needs the
listed verification and any prerequisite.

The currently released CLI remains compatible with its legacy mappings while the registry
lifecycle migration is completed. Use `doflow status` and the native harness to verify an actual
installation; do not infer activation from this table alone.

## Capability matrix

| Capability | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| Instructions | Supported — `CLAUDE.md` | Supported — managed `AGENTS.md` | Supported — `GEMINI.md` |
| Skills | Supported | Supported | Supported |
| Agents | Supported | Supported | Different: shared prompt projection, with native limits |
| Scripts | Supported | Supported | Unavailable: report rather than copy |
| Templates | Supported | Supported | Unavailable: report rather than copy |
| Modes | Supported | Unavailable: no native mode is rendered | Different: expose as instruction guidance |
| Settings | Supported | Different: reconciled TOML in a trusted project | Different: adapter-supported settings only |
| Hooks | Supported | Supported after project trust and hook review | Supported — merged into a `hooks` key in `settings.json` |
| MCP | Supported | Supported | Different: native registration differs |
| Plugin / extension | Supported | Supported after user activation | Different: host extension workflow |

“Different” is a compatibility boundary, not a weaker form of “supported.” The adapter must use
the target's own file format and verification process. “Unavailable” means DoFlow records the
gap and offers guidance instead of installing a non-functional approximation.


## Hook event matrix

Per-event support, from `capabilities.hooks.events` in `core/registry/harnesses.yaml`. A gap is
recorded explicitly with the reason no equivalent exists — never left out, which would be
indistinguishable from an oversight. `test/guards/registry.test.js` enforces both directions:
an event declared supported must be in the harness contract, and an unavailable one must carry
a reason.

| Event | Claude Code | Codex | Gemini CLI | Why unavailable |
|---|---|---|---|---|
| `AfterTool` | — | — | Supported |  |
| `BeforeTool` | — | — | Supported |  |
| `ConfigChange` | Supported | — | — |  |
| `PermissionDenied` | Supported | Unavailable | Unavailable | Codex exposes no permission-decision event. |
| `PostCompact` | Supported | — | — |  |
| `PostToolUse` | Supported | Supported | — |  |
| `PostToolUseFailure` | Supported | Unavailable | Unavailable | No Codex event fires only on tool failure; PostToolUse cannot distinguish the two. |
| `PreCompact` | Supported | Supported | — |  |
| `PreCompress` | — | — | Supported |  |
| `PreToolUse` | Supported | Supported | — |  |
| `SessionEnd` | Supported | Supported | Supported |  |
| `SessionStart` | Supported | Supported | Supported |  |
| `Stop` | Supported | Supported | Unavailable | No Gemini equivalent at matching semantics. |
| `SubagentStart` | Supported | Supported | Unavailable | BeforeAgent/AfterAgent are turn-scoped, not subagent-scoped. |
| `SubagentStop` | Supported | Supported | Unavailable | BeforeAgent/AfterAgent are turn-scoped, not subagent-scoped. |
| `UserPromptSubmit` | Supported | Supported | Unavailable | No Gemini equivalent; BeforeAgent fires at full-turn granularity, not per prompt. |

## Native verification and prerequisites

| Harness | Verify | Prerequisites / boundary |
|---|---|---|
| Claude Code | Confirm `CLAUDE.md` loads, a skill is discoverable, one hook event runs, and selected MCP servers appear in status. | Preserve user text outside the managed instruction section and foreign MCP entries. |
| Codex | Confirm managed `AGENTS.md`, discover a skill, exercise an approved hook, and connect selected MCP servers. | Settings and hooks require a trusted project; hooks require review; plugin enablement remains user-controlled. |
| Gemini CLI | Confirm `GEMINI.md` loads, skills are discoverable, an installed hook event runs, and any adapter-supported MCP/settings action works. | Agents, modes, MCP, and extensions have target-specific behavior. Hooks merge into a key inside `settings.json` DoFlow does not fully own — never a full-file replace. No Gemini event maps `UserPromptSubmit`, `Stop`, or `SubagentStart`/`SubagentStop` (`BeforeAgent`/`AfterAgent` fire at full-turn granularity, not matching semantics) — reported as unavailable, not approximated. Scripts and templates **are** installed: Gemini CLI documents an executable `scripts/` directory in its own skill layout and a shell-execution tool to run it. That declaration rests on first-party documentation rather than an exercised install — confirm `run_shell_command` reaches an installed helper before relying on it. |

## Evidence

The registry links each capability to its primary product documentation. These links establish
surface availability, not a guarantee that a local configuration has been accepted by the host.

| Harness | Official evidence |
|---|---|
| Claude Code | [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [settings](https://code.claude.com/docs/en/settings), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), [plugins](https://code.claude.com/docs/en/plugins) |
| Codex | [customization](https://developers.openai.com/codex/concepts/customization), [advanced configuration](https://developers.openai.com/codex/config-advanced), [hooks](https://developers.openai.com/codex/config-advanced#hooks), [MCP servers](https://developers.openai.com/codex/config-advanced#mcp-servers), [subagents](https://developers.openai.com/codex/subagents), [plugins](https://developers.openai.com/codex/concepts/plugins) |
| Gemini CLI | [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), [skills](https://geminicli.com/docs/cli/skills/), [configuration](https://geminicli.com/docs/cli/configuration/), [hooks](https://geminicli.com/docs/hooks/), [MCP](https://geminicli.com/docs/tools/mcp/), [extensions](https://geminicli.com/docs/extensions/), [Gemini CLI source](https://github.com/google-gemini/gemini-cli) |

See [Architecture](architecture.md) for registry ownership and [Setup](setup.md) for installation,
recovery, and verification procedures.

## Codex capability detail

The capability matrix above uses one uniform 10-row taxonomy across all three harnesses. Codex has
several additional native-workflow distinctions that don't collapse into that shared taxonomy
without losing meaning — they're recorded here rather than folded into the matrix above.

**Status key:** **Supported** means Codex documents a native surface DoFlow can use. **Different**
means the outcome exists but configuration, ownership, or host behavior differs. **Unavailable**
means there is no direct, installer-owned Codex equivalent in scope. A supported surface may still
require a user action or a trusted project before it takes effect.

| Surface | Claude baseline in DoFlow | Codex-native behavior | Status | Prerequisite / ownership boundary | Verification | Official evidence |
|---|---|---|---|---|---|---|
| Project and personal configuration | Claude settings and hooks are currently installed for Claude. | `~/.codex/config.toml` supplies user defaults; trusted `.codex/config.toml` layers supply project overrides. CLI flags and `--config` are one-off overrides. | **Different** | Project config, hooks, and local rules are ignored until the project is trusted. Reconcile only named DoFlow keys; never replace the whole file. | Inspect the expected user/project file, then start Codex in a trusted project and confirm the intended setting is effective. | [Config basics: precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence), [Advanced config: project files](https://learn.chatgpt.com/docs/config-file/config-advanced#project-config-files-codexconfigtoml) |
| Durable multi-agent defaults | Claude has its own agent execution conventions. | `[agents]` in `config.toml` configures enablement, concurrency, default model, reasoning effort, and interruption messages. | **Supported** | Treat model, permissions, and concurrent-thread limits as user/project policy; do not silently weaken them. | Inspect the active config layer and run a deliberate delegated task. | [Subagents: global settings](https://learn.chatgpt.com/docs/agent-configuration/subagents#global-settings) |
| Hook event equivalence | Claude exposes product-specific hook semantics. | Codex event names and payloads differ; map only equivalent intent (for example `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, and `Stop`). Matching hooks across sources run concurrently. | **Different** | Do not claim order-dependent or unsupported handler behavior. `prompt` and `agent` handlers are parsed but not run; hook trust is not bypassed by installation. | Compare each managed mapping with Codex's event/input contract and perform an event-specific manual test. | [Hooks: event list and behavior](https://learn.chatgpt.com/docs/hooks#hooks), [Hooks: configuration limitations](https://learn.chatgpt.com/docs/hooks#config-shape) |
| Unmapped Claude guardrails | Claude-only hooks currently cover all installed guardrails. | No exact Codex mapping is asserted where event semantics or handler behavior do not match. Preserve the policy as `AGENTS.md`/skill guidance or record it as a gap. | **Unavailable** | Never simulate enforcement with undocumented configuration or silently represent guidance as a hook. | Capability review shows a row-level gap and the relevant guidance location. | [Hooks](https://learn.chatgpt.com/docs/hooks), [Customization overview](https://learn.chatgpt.com/docs/customization/overview) |
| Custom slash commands | Claude commands are supplied by its command model. | Markdown custom prompts under `~/.codex/prompts/` are available in Codex CLI and IDE, but this feature is documented as deprecated in favor of skills. | **Different** | Do not use custom prompts as the primary DoFlow workflow distribution surface. | Restart/reload the client and confirm the `/prompts:<name>` entry appears. | [Custom prompts](https://learn.chatgpt.com/docs/customization/custom-prompts) |
| Automations / scheduled tasks | Claude-oriented automation assets may exist as hooks or workflow guidance. | Scheduled tasks are a host-managed capability: available in ChatGPT web/desktop when enabled; Codex CLI and IDE do not provide the management interface. They can use skills/plugins where available. | **Unavailable** to the direct installer | No local installer-owned automation file or schedule is created. Users/workspaces create and manage schedules in supported hosts, subject to availability and permission policy. | In an eligible web/desktop workspace, create and inspect a scheduled task; CLI/IDE verification is intentionally N/A. | [Scheduled tasks](https://learn.chatgpt.com/docs/automations) |
| CLI, desktop app, and IDE workflow | DoFlow supports its selected Claude workflow surfaces. | Codex CLI, desktop app, and IDE share configuration layers; skills are available across them. Availability of plugins, scheduled tasks, and management UIs is surface-dependent. | **Different** | Verify the selected host rather than inferring support from another host. | CLI: inspect config and `/mcp`/`/hooks`; desktop/IDE: confirm the corresponding project and settings UI recognizes the installed assets. | [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic), [Customization: skills](https://learn.chatgpt.com/docs/customization/overview#skills), [Scheduled tasks](https://learn.chatgpt.com/docs/automations) |
| Approvals and sandbox policy | Claude has its own approval and execution policy. | Codex separates approval policy from sandbox mode, and project configuration cannot override certain machine-local/provider/telemetry settings. | **Different** | DoFlow must not relax approval, sandbox, network, or credential controls. These settings are user/admin policy, not a parity payload. | Inspect the active `config.toml` policy and confirm commands/MCP actions request approval as configured. | [Advanced config: approval policies and sandbox modes](https://learn.chatgpt.com/docs/config-file/config-advanced#approval-policies-and-sandbox-modes) |

Re-check this appendix against the linked official documentation when Codex changes — availability
here is never inferred from the presence of a DoFlow source file alone.
