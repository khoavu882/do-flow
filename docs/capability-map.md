# Multi-harness capability map

This map is generated in intent from `core/registry/harnesses.yaml`: it records the capability
contract that adapters must honor. A `supported` row means the native harness has a documented
surface; it does **not** mean a file copy has activated it. Each installation still needs the
listed verification and any prerequisite.

The currently released CLI remains compatible with its legacy mappings while the registry
lifecycle migration is completed. Use `doflow status` and the native harness to verify an actual
installation; do not infer activation from this table alone.

## Capability matrix

| Capability | Claude Code | Codex | Gemini CLI | OpenCode | Pi Coding Agent | GitHub Copilot CLI | Kiro | Antigravity |
|---|---|---|---|---|---|---|---|---|
| Instructions | Supported — `CLAUDE.md` | Supported — `AGENTS.md` | Supported — `GEMINI.md` | Supported — `AGENTS.md` | Supported — `AGENTS.md` | Supported — `.github/copilot-instructions.md` | Supported — `.kiro/steering/` | Supported — `AGENTS.md`  |
| Skills | Supported | Supported | Supported | Supported | Supported | Supported | Supported — `.kiro/skills` | Supported — `.agents/skills`  |
| Agents | Supported | Supported — `.codex/agents/*.toml` | Different | Different | Different | Supported — `.github/agents` | Supported — `.kiro/agents` | Supported — `.agents/agents`  |
| Scripts | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Supported |
| Templates | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Different |
| Modes | Supported | Unavailable | Different | Different | Different | Different | Different | Different  |
| Settings | Supported — `settings.json` | Different — `.codex/config.toml` | Different | Supported — `opencode.json` | Supported — `.pi/settings.json` | Unavailable | Unavailable | Unavailable |
| Hooks | Supported — `settings.json` | Supported — `.codex/hooks.json` | Supported — `settings.json` | Different | Different | Different | Supported — `.kiro/hooks` | Different |
| MCP | Supported — `.mcp.json` | Supported — `.codex/config.toml` | Different | Supported — `opencode.json` | Different | Supported — `.mcp.json` | Supported — `.kiro/settings/mcp.json` | Supported — `.agents/mcp_config.json`  |
| Plugin / extension | Supported | Supported | Different | Different | Different | Unavailable | Unavailable | Different |

This table is generated from `capabilities` in `core/registry/harnesses.yaml`; the registry is the
source of truth and a hand edit here will drift from it. Where a harness declares a native target
for a capability, it is shown inline.

“Different” is a compatibility boundary, not a weaker form of “supported.” The adapter must use
the target's own file format and verification process. “Unavailable” means DoFlow records the
gap and offers guidance instead of installing a non-functional approximation.

For OpenCode and Pi, several rows read “Different” because those harnesses expect **registration**
rather than projection: DoFlow points their settings at its existing skills directory instead of
copying a second tree, and their hook and plugin surfaces take JS/TS modules rather than the shell
scripts DoFlow ships.

Copilot CLI and Kiro read “Unavailable” for a few rows for a different reason than OpenCode/Pi's
“Different”: no documented native surface exists at all for those capabilities. Copilot CLI has no
general settings file, hook surface, or plugin/marketplace mechanism beyond its custom-agent and
MCP surfaces. Kiro has no general settings file separate from its MCP config, and no
plugin/extension marketplace is documented in its steering, hooks, or MCP sources.

## Runtime seam projection

The `Scripts` row above reads Supported for all seven harnesses, but that is a statement about the
capability, not about which script assets each harness receives. Two distinct assets in
`core/registry/assets.yaml` use it, and they do **not** claim the same set of harnesses. The
difference decides whether a given install can reach the DoFlow runtime at all, so it is recorded
here rather than left to be inferred from the row.

| Asset | Ships | `appliesTo` | `nativeDir` |
|---|---|---|---|
| `locator.doflow` | `core/harnesses/shared/locator/doflow-run` — a verb-free shim that finds and `exec`s the dispatcher | All seven harnesses | `bin`, inside each harness's own directory (for Claude: `.claude/bin/doflow-run` at project scope, `~/.claude/bin/doflow-run` at global scope) |
| `scripts.doflow` | `core/shared/scripts/doflow/` — the dispatcher itself plus every shell helper it serves verbs from | `claude`, `codex`, `gemini` | `../.doflow/scripts`, so all three project into the **same** shared tree at `<config>/.doflow/scripts` |

Three consequences follow, all of them intentional:

- **A harness can hold a locator with nothing behind it.** Installing only for OpenCode, Pi, Copilot
  CLI, or Kiro projects the locator but no dispatcher. The locator then searches
  `$DOFLOW_CONFIG_DIR`, the nearest `.doflow/` above the working directory, and `$HOME/.doflow`, and
  exits 2 with one message naming all three. That is the designed failure — one actionable error
  rather than a silently broken skill — and it resolves as soon as any project-local or global
  install of the shared tree exists.
- **The shared tree is co-owned.** Claude, Codex, and Gemini project the dispatcher to one
  destination, so it is not owned by whichever harness was installed last. Removing a single target
  must reclaim only what no other installed harness still claims.
- **The locator deliberately does not live in the shared tree.** It is the one asset whose
  `nativeDir` must stay inside the harness's own directory;
  `test/guards/runtime-unification.test.js` fails if any locator `nativeDir` escapes into
  `../.doflow`. Skills do not call it either — a relative path in a skill's shell snippet resolves
  against the user's project root, not the skill's directory — so a skill inlines the same walk-up
  the locator performs. The shim exists for callers that *can* name a path correct for themselves,
  such as a harness hook or a person at a terminal.

Verification is the same on every harness: run one verb through the locator and check the exit code
and JSON, e.g. `doflow-run paths --json` from a project root. `test/e2e/install-shapes.test.js` performs
real installs for all seven harnesses into temporary directories and executes the projected locator
and dispatcher in source-checkout, project-local, and global shapes rather than asserting against a
mock.

## Hook event matrix

Per-event support, from `capabilities.hooks.events` in `core/registry/harnesses.yaml`. A gap is
recorded explicitly with the reason no equivalent exists — never left out, which would be
indistinguishable from an oversight. `test/guards/registry.test.js` enforces both directions:
an event declared supported must be in the harness contract, and an unavailable one must carry
a reason.

**Supported** means DoFlow installs a hook for that event. **Different** means the harness fires an
equivalent event but DoFlow does not wire it — OpenCode and Pi both implement handlers as JS/TS code
modules rather than command strings, so DoFlow's shell hooks have nothing to attach to. Wiring those
would mean shipping executable code into the user's agent, which is a distribution decision rather
than a projection. **Unavailable** means no equivalent event exists at matching semantics.

A dash means the harness has no such event name in DoFlow's taxonomy and none was claimed. Copilot
CLI has no hook surface at all (its `hooks` capability status is Unavailable), so every event is a
dash for it. Kiro's `hooks` capability is Supported — DoFlow projects a real `.kiro/hooks/*.json`
file wiring `SessionStart`, two `PreToolUse` hooks, and `Stop` — but the registry does not yet break
that support down into a per-event map, so Kiro's column here is also a dash pending that data;
see the `hooks` capability note in `core/registry/harnesses.yaml` and the verification row below for
Kiro's actual wired events instead of this table.

| Event | Claude Code | Codex | Gemini CLI | OpenCode | Pi Coding Agent | GitHub Copilot CLI | Kiro | Notes |
|---|---|---|---|---|---|---|---|---|
| `AfterTool` | — | — | Supported | — | — | — | — |  |
| `BeforeTool` | — | — | Supported | — | — | — | — |  |
| `ConfigChange` | Supported | — | — | Unavailable | Unavailable | — | — | **OpenCode:** installation.updated tracks OpenCode upgrades, not configuration edits. **Pi Coding Agent:** Pi reloads configuration via /reload, surfaced as session_start with reason "reload", not as a distinct config event. |
| `PermissionDenied` | Supported | Unavailable | Unavailable | Different | Unavailable | — | — | **Codex:** Codex exposes no permission-decision event. **Gemini CLI:** Gemini exposes no permission-decision event. **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: permission.replied, whose payload carries the decision. **Pi Coding Agent:** Pi has no permission-decision event; extensions run with full permissions rather than gating them. **GitHub Copilot CLI:** No deny-side event; permissionRequest carries the decision instead. |
| `PostCompact` | Supported | — | — | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: session.compacted. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: compaction_end. |
| `PostToolUse` | Supported | Supported | — | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: tool.execute.after. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: tool_execution_end, exposed through session.subscribe rather than pi.on. **GitHub Copilot CLI:** Native postToolUse can rewrite results/inject context; not projected. |
| `PostToolUseFailure` | Supported | Unavailable | Unavailable | Unavailable | Unavailable | — | — | **Codex:** No Codex event fires only on tool failure; PostToolUse cannot distinguish the two. **Gemini CLI:** AfterTool fires regardless of outcome; failure cannot be isolated. **OpenCode:** tool.execute.after fires for both outcomes; no failure-only event exists. **Pi Coding Agent:** tool_execution_end reports both outcomes; no failure-only event exists. **GitHub Copilot CLI:** Native postToolUseFailure exists — a failure-only event Claude lacks a direct name for. |
| `PreCompact` | Supported | Supported | — | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: experimental.session.compacting. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: session_before_compact, which may cancel or supply a summary. **GitHub Copilot CLI:** Native preCompact exists. |
| `PreCompress` | — | — | Supported | — | — | — | — |  |
| `PreToolUse` | Supported | Supported | — | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: tool.execute.before. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: tool_execution_start, exposed through session.subscribe rather than pi.on. **GitHub Copilot CLI:** Blocking contract matches ({permissionDecision} on stdout) but tool names differ from Claude's Edit|Write|MultiEdit and the gate reads CLAUDE_* envs. |
| `SessionEnd` | Supported | Supported | Supported | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: session.idle / session.deleted. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: session_shutdown. **GitHub Copilot CLI:** Native sessionEnd exists; same payload-schema caveat. |
| `SessionStart` | Supported | Supported | Supported | Different | Different | — | — | **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: session.created. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: session_start, which carries reason:"reload" on /reload. **GitHub Copilot CLI:** Native sessionStart exists; DoFlow's script reads Claude's .session_id/.cwd stdin fields. |
| `Stop` | Supported | Supported | Unavailable | Different | Different | — | — | **Gemini CLI:** No Gemini equivalent at matching semantics. **OpenCode:** DoFlow projects shell hooks; OpenCode requires a code module, so no hook is installed. Native equivalent: session.idle. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: agent_end. **GitHub Copilot CLI:** Native agentStop forces continuation via stdout {decision:'block'} (8-block runaway cap), unlike Claude's exit-2 semantics; stop-check relies on .transcript_path. |
| `SubagentStart` | Supported | Supported | Unavailable | Unavailable | Unavailable | — | — | **Gemini CLI:** BeforeAgent/AfterAgent are turn-scoped, not subagent-scoped. **OpenCode:** OpenCode publishes no subagent lifecycle event. **Pi Coding Agent:** Pi publishes no subagent lifecycle event. **GitHub Copilot CLI:** Native subagentStart/subagentStop exist. |
| `SubagentStop` | Supported | Supported | Unavailable | Unavailable | Unavailable | — | — | **Gemini CLI:** BeforeAgent/AfterAgent are turn-scoped, not subagent-scoped. **OpenCode:** OpenCode publishes no subagent lifecycle event. **Pi Coding Agent:** Pi publishes no subagent lifecycle event. **GitHub Copilot CLI:** Native subagentStart/subagentStop exist. |
| `UserPromptSubmit` | Supported | Supported | Unavailable | Unavailable | Different | — | — | **Gemini CLI:** No Gemini equivalent; BeforeAgent fires at full-turn granularity, not per prompt. **OpenCode:** OpenCode exposes message.updated rather than a pre-submission prompt event, so a hook could not gate a prompt before the model sees it. **Pi Coding Agent:** DoFlow projects shell hooks; Pi requires a code module, so no hook is installed. Native equivalent: input, which fires before skill expansion. **GitHub Copilot CLI:** Natives are userPromptSubmitted and userPromptTransformed; pre-submission gating semantics unverified. |

## Native verification and prerequisites

Each row covers the harness's own surfaces. The runtime seam is verified the same way everywhere and
is covered in [Runtime seam projection](#runtime-seam-projection) instead of repeated per harness.

| Harness | Verify | Prerequisites / boundary |
|---|---|---|
| Claude Code | Confirm `CLAUDE.md` loads, a skill is discoverable, one hook event runs, and selected MCP servers appear in status. | Preserve user text outside the managed instruction section and foreign MCP entries. |
| Codex | Confirm managed `AGENTS.md`, discover a skill, exercise an approved hook, and connect selected MCP servers. | Settings and hooks require a trusted project; hooks require review; plugin enablement remains user-controlled. |
| Gemini CLI | Confirm `GEMINI.md` loads, skills are discoverable, an installed hook event runs, and any adapter-supported MCP/settings action works. | Agents, modes, MCP, and extensions have target-specific behavior. Hooks merge into a key inside `settings.json` DoFlow does not fully own — never a full-file replace. |
| OpenCode | Confirm `AGENTS.md` loads, skills are discovered in `.opencode/skills/` (project) or `~/.config/opencode/skills/` (global), and MCP servers connect via `opencode.json`. | Native JSON configuration with progressive skill discovery. Global config lives under `~/.config/opencode/`, not `~/.opencode/`. |
| Pi Coding Agent | Confirm `AGENTS.md` loads, skills discover in `.pi/skills/` (project) or `~/.pi/agent/skills/` (global), and MCP connects via `pi-mcp-adapter`. | Minimalist terminal harness; extensions manage external tools. |
| GitHub Copilot CLI | Confirm `.github/copilot-instructions.md` loads, a skill is discoverable from `.agents/skills` (project) or `~/.agents/skills` (global), a custom agent under `.github/agents` (or `~/.copilot/agents`) is selectable, and selected MCP servers appear via `.mcp.json` (project) or `~/.copilot/mcp-config.json` (global). | Settings (`~/.copilot/settings.json`, `.github/copilot/settings.json`), hooks (`.github/hooks/`, `~/.copilot/hooks/`), and a plugin marketplace are now documented upstream; DoFlow projects none of them — those three capabilities are recorded as unprojected rather than as host gaps. |
| Kiro | Confirm the DoFlow guidance tree is discoverable as steering files under `.kiro/steering/` (workspace) or `~/.kiro/steering/` (global), a skill is discoverable under `.kiro/skills/`, a custom agent under `.kiro/agents` is discoverable, a projected hook file exists under `.kiro/hooks/` with the expected trigger names and actually blocks on a non-zero exit, and selected MCP servers appear in `.kiro/settings/mcp.json`. | No general Kiro settings file exists separate from `.kiro/settings/mcp.json`, so the `settings` capability is a recorded gap; no plugin/extension marketplace is documented either. |

## Evidence

The registry links each capability to its primary product documentation. These links establish
surface availability, not a guarantee that a local configuration has been accepted by the host.

| Harness | Official evidence |
|---|---|
| Claude Code | [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [settings](https://code.claude.com/docs/en/settings), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), [plugins](https://code.claude.com/docs/en/plugins) |
| Codex | [customization](https://developers.openai.com/codex/concepts/customization), [advanced configuration](https://developers.openai.com/codex/config-advanced), [hooks](https://developers.openai.com/codex/config-advanced#hooks), [MCP servers](https://developers.openai.com/codex/config-advanced#mcp-servers), [subagents](https://developers.openai.com/codex/subagents), [plugins](https://developers.openai.com/codex/concepts/plugins) |
| Gemini CLI | [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), [skills](https://geminicli.com/docs/cli/skills/), [configuration](https://geminicli.com/docs/cli/configuration/), [hooks](https://geminicli.com/docs/hooks/), [MCP](https://geminicli.com/docs/tools/mcp/), [extensions](https://geminicli.com/docs/extensions/), [Gemini CLI source](https://github.com/google-gemini/gemini-cli) |
| OpenCode | [documentation](https://opencode.ai/docs), [skills](https://opencode.ai/docs/skills), [agents](https://opencode.ai/docs/agents), [config](https://opencode.ai/docs/config), [rules](https://opencode.ai/docs/rules), [mcp servers](https://opencode.ai/docs/mcp-servers), [plugins](https://opencode.ai/docs/plugins) |
| Pi Coding Agent | [pi.dev](https://pi.dev), [quickstart](https://pi.dev/docs/latest/quickstart), [skills](https://pi.dev/docs/latest/skills), [settings](https://pi.dev/docs/latest/settings), [extensions](https://pi.dev/docs/latest/extensions), [packages](https://pi.dev/packages), [github](https://github.com/earendil-works/pi-coding-agent) |
| GitHub Copilot CLI | [customize Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot), [add skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), [create custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli), [custom agents configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration) |
| Kiro | [steering](https://kiro.dev/docs/steering/), [skills](https://kiro.dev/docs/skills/), [custom agents configuration reference](https://kiro.dev/docs/custom-agents/configuration-reference/), [hooks](https://kiro.dev/docs/hooks/), [hook actions](https://kiro.dev/docs/hooks/actions/), [MCP configuration](https://kiro.dev/docs/mcp/configuration/) |

See [Architecture](architecture.md) for registry ownership and [Setup](setup.md) for installation,
recovery, and verification procedures.

## Codex capability detail

The capability matrix above uses one uniform 10-row taxonomy across all seven harnesses it lists.
All seven — Claude Code, Codex, Gemini CLI, OpenCode, Pi Coding Agent, GitHub Copilot CLI, and
Kiro — are declared in `core/registry/harnesses.yaml` and driven by their own dedicated adapter
(`src/adapters/claude/`, `src/adapters/codex/`, `src/adapters/gemini/`, `src/adapters/opencode/`,
`src/adapters/pi/`, `src/adapters/copilot/`, `src/adapters/kiro/`). Each adapter exposes the same
six-function contract (`discover`, `render`, `plan`, `apply`, `remove`, `verify`) through a uniform
`create<Name>Adapter()` factory (e.g. `createClaudeAdapter`, `createCodexAdapter`,
`createGeminiAdapter`). Codex alone has several additional native-workflow distinctions that don't
collapse into that shared taxonomy without losing meaning — they're recorded here rather than
folded into the matrix above.

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
