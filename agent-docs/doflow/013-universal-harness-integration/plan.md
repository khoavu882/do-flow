# Implementation Plan: Universal Harness Integration (Antigravity, Claude Code, Codex, Gemini, OpenCode, Pi)

**Feature:** 013-universal-harness-integration · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-19

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Approach

This implementation delivers reference-tier universal harness integration across Google Antigravity, Anthropic Claude Code, OpenAI Codex CLI, Google Gemini CLI, OpenCode AI, and Pi Coding Agent.

The technical approach executes in five focused phases:
1. **Antigravity & Gemini Dual Distribution & JSON Streaming Hooks:** Package `plugins/doflow/` (with `plugin.json`, `hooks.json`, `mcp_config.json`, `rules/`, `skills/`) and project root `.agents/`, accompanied by `stream-hook-runner.js` translating Antigravity stdin/stdout JSON streaming events (`PreToolUse`, `Stop`) into DoFlow quality gate decisions (`allow`, `deny`, `ask`, `overwrite`).
2. **Claude Code 13-Event Hook Engine & Subagents:** Deploy full 13-event lifecycle hook registrations in `settings.json`, declarative `.claude/agents/*.md` specifications, and `.claude-plugin/plugin.json`.
3. **OpenAI Codex Surgical TOML & Standalone Hooks:** Enhance `src/adapters/codex/config.js` to guarantee 100% comment and whitespace preservation, materialize `.codex/hooks.json`, and project declarative `.codex/agents/*.toml` subagent specs with `sandbox_mode` controls.
4. **OpenCode AI & Pi Agent Parity:** Implement additive `instructions` array union and MCP dictionary handling in `opencode.json`, enforce strict `~/.pi/agent/` scope isolation for Pi, and materialize skills.
5. **Central Registry Synchronization & End-to-End Validation:** Synchronize `core/registry/` (`assets.yaml`, `harnesses.yaml`, `mcp.yaml`) and execute end-to-end integration tests verifying distribution parity and sub-50ms gate enforcement across all harnesses.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence — you reconcile them yourself;
> nothing merges them for you. Any violation = STOP and revise the approach before continuing.
> (Advisory by default; not the hard hook gate.)

- [x] Complies with P1 (Safety over speed): All configuration reconcilers are non-destructive and preserve user comments/settings; hook gating prevents destructive bash commands and unapproved edits.
- [x] Complies with P2 (Evidence over assumptions): Every harness capability and lifecycle event was verified against active research reports (`agent-docs/research/*`) and authoritative documentation.
- [x] Complies with P3 (Finish what you start): Complete production implementations with zero TODO stubs or mock placeholders across all six adapters and hook runners.
- [x] Complies with P4 (Scope discipline / YAGNI): Targets strictly the six researched harnesses without modifying host agent binaries or introducing third-party cloud dependencies.
- [x] Complies with P5 (Parallel by default): Tasks are partitioned into disjoint file sets with parallel execution markers `[P]`.
- [x] Complies with P6 (Professional honesty): Clean status reporting with transparent capability matrices and explicit verification steps.

**Result:** PASS — All 6 constitution principles satisfied; no tier-2 overrides present.

## 3. Research & Decisions

- **D1:** *Antigravity Distribution Model* — Implements dual projection (`plugins/doflow/` self-contained plugin package alongside root `.agents/` projection) to provide seamless compatibility with both Antigravity IDE and CLI. Rationale: Antigravity documentation and research in `antigravity_integration_2026-08-19.md`.
- **D2:** *Lifecycle Hook Protocol Handling* — Implements a lightweight `stream-hook-runner.js` bridge that parses JSON on stdin, checks active feature gates (`pre-implement-gate.sh`), and outputs `{ "decision": "allow" | "deny" }` on stdout for Antigravity/Gemini, while keeping standard exit-code execution for Claude Code, Codex, and Kiro. Rationale: Sub-20ms evaluation overhead satisfying NFR-003.
- **D3:** *Codex TOML Reconciler Invariant* — Uses line-level regex surgical editing in `src/adapters/codex/config.js` instead of standard lossy TOML stringifiers to preserve developer comments and third-party tables. Rationale: Avoids corrupting developer configuration files.
- **D4:** *Subagent Specification Normalization* — Employs a single source-of-truth in `core/shared/agent-specs/` and utilizes copy-tree layout renderers to output `.md` (Claude/Antigravity/Copilot/Kiro), `.toml` (Codex), and instructions (OpenCode/Pi). Rationale: Eliminates drift across specialist definitions.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Antigravity plugin manifest, hooks, and MCP config | `core/.antigravity-plugin/plugin.json`, `core/.antigravity-plugin/hooks.json`, `core/.antigravity-plugin/mcp_config.json` | A | Live |
| CH2 | JSON streaming lifecycle hook runner | `core/harnesses/shared/hooks/stream-hook-runner.js`, `core/harnesses/shared/hooks/hooks.json` | A | Live |
| CH3 | Gemini & Antigravity adapter dual projection | `src/adapters/gemini/index.js`, `src/adapters/gemini/hooks.js` | A | Live |
| CH4 | Claude Code 13-event hooks & plugin packaging | `src/adapters/claude/index.js`, `core/harnesses/claude/settings/adapter-defaults.json` | B | Live |
| CH5 | Declarative subagent Markdown specifications | `core/shared/agent-specs/*.md` | B | Live |
| CH6 | Codex surgical TOML reconciler comment preservation | `src/adapters/codex/config.js` | C | Live |
| CH7 | Codex standalone hooks & declarative TOML subagents | `src/adapters/codex/index.js`, `src/adapters/codex/hooks.js`, `src/adapters/codex/agents.js` | C | Live |
| CH8 | OpenCode instructions union & MCP config | `src/adapters/opencode/index.js` | D | Live |
| CH9 | Pi Agent scope isolation & MCP adapter | `src/adapters/pi/index.js` | D | Live |
| CH10 | Central MCP and asset registry synchronization | `core/registry/mcp.yaml`, `core/registry/harnesses.yaml`, `core/registry/assets.yaml` | E | Live |
| CH11 | Multi-harness end-to-end integration test suite | `test/install/universal-harness.test.js`, `test/adapters/*.test.js` | E | Live |

**Detail**

- **CH1:** Authors `plugin.json`, `hooks.json`, and `mcp_config.json` inside `core/.antigravity-plugin/` enabling discovery as a standalone Antigravity plugin bundle.
- **CH2:** Builds `stream-hook-runner.js` to read stdin JSON streams, execute DoFlow prerequisite checks (`pre-implement-gate.sh`, `stop-check.sh`), and write decision JSON to stdout.
- **CH3:** Updates `src/adapters/gemini/index.js` and `hooks.js` to manage dual projection (`plugins/doflow/` and `.agents/`) and generate Antigravity-compliant `hooks.json`.
- **CH4:** Updates `src/adapters/claude/index.js` to register all 13 supported lifecycle hooks in `settings.json` and package `.claude-plugin/plugin.json`.
- **CH5:** Updates shared specialist agent specs in `core/shared/agent-specs/` for `system-architect`, `core-implementer`, `quality-guardian`, and `research-writer`.
- **CH6:** Hardens `src/adapters/codex/config.js` with comprehensive surgical key reconciliation test cases verifying comment preservation across multi-table TOML files.
- **CH7:** Updates `src/adapters/codex/index.js` to project standalone `.codex/hooks.json` and generate `.codex/agents/*.toml` specs with `sandbox_mode` parameters.
- **CH8:** Updates `src/adapters/opencode/index.js` to perform non-destructive array union for `instructions` in `opencode.json` and configure stdio `mcp` servers.
- **CH9:** Updates `src/adapters/pi/index.js` to ensure project `.pi/` and global `~/.pi/agent/` scopes are isolated, projecting skills and `pi-mcp-adapter` settings.
- **CH10:** Reconciles `core/registry/mcp.yaml`, `harnesses.yaml`, and `assets.yaml` to declare uniform MCP tools (`context7`, `semble`, `graphify`, `sequential-thinking`) and capabilities across all harnesses.
- **CH11:** Implements a comprehensive test suite in `test/install/` verifying multi-harness materialization, hook execution, gate blocking, and clean removal.

## 5. Data / Contracts

- **Manifest Schemas:** Antigravity `plugin.json`, Claude `.claude-plugin/plugin.json`, Codex `config.toml`, OpenCode `opencode.json`, Pi `settings.json`.
- **Hook JSON Stream Protocol:** Stdin `{ "toolCall": { "name": "...", "args": { ... } }, "conversationId": "..." }` &rarr; Stdout `{ "decision": "allow" | "deny" | "ask" | "force_ask", "reason": "...", "overwrite": { ... } }`.
- **Registry Assets Schema:** `core/registry/assets.yaml` version 1, `core/registry/harnesses.yaml` version 1, `core/registry/mcp.yaml` version 1.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Hook JSON parsing failure in high-frequency tool loops | Safe fallback with `{ "decision": "allow" }` and stderr logging | Live |
| RK2 | TOML comment corruption in complex user `config.toml` files | Comprehensive regex line parsing and snapshot tests in `test/adapters/codex.test.js` | Live |
| RK3 | Divergent skill versions across harness projections | Centralized `copy-tree.js` engine ensuring identical byte fingerprints across all target folders | Live |

**Detail**

- **RK1:** If `stream-hook-runner.js` receives malformed JSON or encounters an unhandled runtime exception, it logs the error to stderr and emits an allow decision rather than hanging or crashing the host agent session.
- **RK2:** Codex `config.toml` files often contain multi-line comments and nested tables. The reconciler targets only specific managed keys (`features.hooks`, `[mcp_servers]`), leaving surrounding text untouched.
- **RK3:** All skills are sourced exclusively from `core/shared/skills/` and deployed via `copy-tree.js`, guaranteeing zero content drift between `.agents/skills/`, `.claude/skills/`, `.codex/skills/`, `.opencode/skills/`, and `.pi/skills/`.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 (Antigravity Plugin & Root Projection) | `test/adapters/gemini.test.js` & `doflow doctor` |
| FR-002 (JSON Streaming Hook Runner) | Unit tests in `test/hooks/stream-hook-runner.test.js` exercising allow/deny/overwrite |
| FR-003 (Claude Code 13-Event Hooks & Plugin) | `test/adapters/claude.test.js` & `.claude/settings.json` schema validation |
| FR-004 (Claude Declarative Subagents) | Inspect `.claude/agents/*.md` frontmatter & instructions |
| FR-005 (Codex Surgical TOML Reconciler) | `test/adapters/codex.test.js` asserting comment & whitespace preservation |
| FR-006 (Codex Standalone Hooks) | Inspect `.codex/hooks.json` and verify `features.hooks = true` |
| FR-007 (Codex Declarative Subagents) | Inspect `.codex/agents/*.toml` `sandbox_mode` settings |
| FR-008 (OpenCode Additive Instructions & MCP) | `test/adapters/opencode.test.js` verifying array union in `opencode.json` |
| FR-009 (Pi Scope Isolation & MCP Adapter) | `test/adapters/pi.test.js` asserting `~/.pi/agent/` target resolution |
| FR-010 (Universal Specialist Matrix) | Check `system-architect`, `core-implementer`, `quality-guardian`, `research-writer` across formats |
| FR-011 (Universal MCP Catalog) | Validate `core/registry/mcp.yaml` against generated configs |
| FR-012 (Quality Gate Enforcement) | Run Gate C and Stop Gate tests with active/inactive feature states |
| NFR-003 (Sub-50ms Hook Latency) | Benchmark hook execution times (<20ms actual) |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`, or they are not parallel-safe. `[US#]` = traces to a
> user story in requirement.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact.

### Repo Branch Plan

N/A: single-repo feature

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 3 | Antigravity plugin manifest, streaming hook runner, and Gemini adapter dual projection | yes |
| B | 2 | Claude Code 13-event hooks, plugin packaging, and declarative subagent specifications | yes |
| C | 2 | Codex surgical TOML reconciler, standalone hooks, and declarative subagent TOML specs | yes |
| D | 2 | OpenCode additive instructions merge and Pi Agent scope isolation | yes |
| E | 2 | Central MCP catalog synchronization and multi-harness integration test suite | yes |

### Phase A — Antigravity Plugin Packaging & JSON Streaming Hooks

- [x] A.1 [P] [US1] Author Antigravity plugin manifest, skills, rules, hooks, and MCP definitions in `core/.antigravity-plugin/` — owner: system-architect; files: `core/.antigravity-plugin/plugin.json`, `core/.antigravity-plugin/hooks.json`, `core/.antigravity-plugin/mcp_config.json`
- [x] A.2 [P] [US1] Build JSON streaming lifecycle hook runner (`stream-hook-runner.js`) translating Antigravity stdin/stdout JSON protocol to DoFlow stage gates — owner: core-implementer; files: `core/harnesses/shared/hooks/stream-hook-runner.js`, `core/harnesses/shared/hooks/hooks.json`
- [x] A.3 [US1] Update Gemini & Antigravity adapter (`src/adapters/gemini/index.js`, `src/adapters/gemini/hooks.js`) to support dual projection (`plugins/doflow/` and root `.agents/`) and streaming hooks — owner: core-implementer; files: `src/adapters/gemini/index.js`, `src/adapters/gemini/hooks.js`

### Phase B — Claude Code 13-Event Hook Engine & Subagents

- [x] B.1 [P] [US2] Update Claude Code adapter (`src/adapters/claude/index.js`) to generate full 13-event hooks in `settings.json` and validate `.claude-plugin/plugin.json` — owner: core-implementer; files: `src/adapters/claude/index.js`, `core/harnesses/claude/settings/adapter-defaults.json`
- [x] B.2 [P] [US2] Update declarative specialist subagent specs in `core/shared/agent-specs/` with tool whitelists for all 4 roles (`system-architect`, `core-implementer`, `quality-guardian`, `research-writer`) — owner: system-architect; files: `core/shared/agent-specs/system-architect.md`, `core/shared/agent-specs/core-implementer.md`, `core/shared/agent-specs/quality-guardian.md`, `core/shared/agent-specs/research-writer.md`

### Phase C — OpenAI Codex Surgical TOML & Standalone Hooks

- [x] C.1 [P] [US3] Enhance Codex surgical TOML reconciler (`src/adapters/codex/config.js`) to ensure comment, whitespace, and custom table preservation during config mutations — owner: core-implementer; files: `src/adapters/codex/config.js`
- [x] C.2 [P] [US3] Update Codex adapter (`src/adapters/codex/index.js`, `src/adapters/codex/hooks.js`, `src/adapters/codex/agents.js`) to generate standalone `.codex/hooks.json` and declarative `.codex/agents/*.toml` subagent specs with `sandbox_mode` controls — owner: core-implementer; files: `src/adapters/codex/index.js`, `src/adapters/codex/hooks.js`, `src/adapters/codex/agents.js`

### Phase D — OpenCode AI & Pi Agent Parity

- [x] D.1 [P] [US4] Update OpenCode adapter (`src/adapters/opencode/index.js`) to perform additive array union for `instructions` in `opencode.json` and configure local stdio `mcp` servers — owner: core-implementer; files: `src/adapters/opencode/index.js`
- [x] D.2 [P] [US4] Update Pi adapter (`src/adapters/pi/index.js`) to enforce strict `~/.pi/agent/` scope isolation, project skills, and write configuration for `pi-mcp-adapter` — owner: core-implementer; files: `src/adapters/pi/index.js`

### Phase E — Central Registry & Multi-Harness Validation Suite

- [x] E.1 [P] [US5] Update central MCP catalog (`core/registry/mcp.yaml`) and harness registry (`core/registry/harnesses.yaml`, `core/registry/assets.yaml`) declaring uniform MCP tools and capabilities across all 6 harnesses — owner: system-architect; files: `core/registry/mcp.yaml`, `core/registry/harnesses.yaml`, `core/registry/assets.yaml`
- [x] E.2 [US5] Implement cross-harness test suite verifying end-to-end installation, hook execution, gate blocking, and zero-defect parity across all 6 harnesses — owner: quality-guardian; files: `test/install/universal-harness.test.js`, `test/adapters/gemini.test.js`, `test/adapters/claude.test.js`, `test/adapters/codex.test.js`, `test/adapters/opencode.test.js`, `test/adapters/pi.test.js`

### Checkpoints

- After Phase A: `npm test test/adapters/gemini.test.js`; commit `feat(antigravity): add plugin packaging and streaming hook runner`
- After Phase B: `npm test test/adapters/claude.test.js`; commit `feat(claude): support 13-event hooks and declarative subagents`
- After Phase C: `npm test test/adapters/codex.test.js`; commit `feat(codex): add surgical toml reconciler and standalone hooks`
- After Phase D: `npm test test/adapters/opencode.test.js test/adapters/pi.test.js`; commit `feat(opencode,pi): update instructions merging and scope isolation`
- After Phase E: `npm test`; commit `feat(registry): synchronize universal harness registry and test suite`

### Completion criteria

- [x] All 11 tasks checked
- [x] All unit and integration tests pass (`npm test`)
- [x] Artifact consistency check passes (`validate-artifacts.sh`)
- [x] `state.md` updated with completed feature milestones

## 9. History

None — initial version.
