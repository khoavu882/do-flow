# Reference

This is the compact lookup for DoFlow. Each skill's `SKILL.md` is the implementation-level source of truth.

## Skills

| Goal | Skill |
|---|---|
| Find the right command | `do`, `do-help`, `do-pm` |
| Understand code or a system | `do-explain`, `do-analyze`, `do-troubleshoot` |
| Shape a feature | `do-brainstorm`, `do-design`, `do-plan`, `do-spec-panel` |
| Implement and refine | `do-implement`, `do-execute-plan`, `do-improve` |
| Validate quality | `do-test`, `do-code-review`, `do-reflect` |
| Build, commit, or estimate | `do-build`, `do-git`, `do-estimate` |
| Research and documentation | `do-research`, `do-document`, `do-index` |
| Set project rules | `do-constitution` |
| Choose available tools | `do-select-tool` |
| Coordinate independent work | `parallel-agents` |
| Apply background safeguards | `confidence-check`, `token-efficiency` |

### Common commands

| Command | Use it for |
|---|---|
| `/do-flow "feature"` | Guided feature delivery with approval gates |
| `/do-implement "task"` | Standalone implementation work |
| `/do-analyze path --focus quality` | Read-only quality, security, performance, or architecture analysis |
| `/do-improve path --type quality` | Scoped cleanup or refactoring |
| `/do-test --type all` | Run the project's test suite |
| `/do-code-review` | Review the current change set |
| `/do-git --smart-commit` | Prepare an accurate commit |
| `/do-document "topic" --type guide` | Create or revise documentation |

The full installed skill set is: `confidence-check`, `do`, `do-analyze`, `do-brainstorm`, `do-build`, `do-code-review`, `do-constitution`, `do-design`, `do-document`, `do-estimate`, `do-execute-plan`, `do-explain`, `do-flow`, `do-git`, `do-help`, `do-implement`, `do-improve`, `do-index`, `do-plan`, `do-pm`, `do-reflect`, `do-research`, `do-select-tool`, `do-spec-panel`, `do-test`, `do-troubleshoot`, `parallel-agents`, and `token-efficiency`.

## Agents

Agents are specialist perspectives used by planning and review workflows. Their definitions live in `core/agents/`.

| Area | Typical perspectives |
|---|---|
| Product and delivery | product manager, business analyst, project manager |
| Architecture and implementation | system architect, backend architect, frontend architect, developer |
| Quality and safety | QA engineer, code reviewer, security reviewer, root-cause analyst |
| Research and communication | researcher, technical writer, documentation specialist |

Ask the relevant workflow to involve a specialist, or use `/do-pm` when the work crosses several areas.

## Hooks

Claude Code hooks add guardrails around sessions and commands.

| Hook family | Purpose |
|---|---|
| Session start | Establish repository context and restore useful session state |
| Before prompt | Classify or enrich a request before it is handled |
| Before tool use | Block unsafe shell patterns and enforce workflow gates |
| After tool use | Capture follow-up context when appropriate |
| Stop / compaction | Preserve concise continuity across a long session |

Hooks are configured for Claude Code; the shared instruction, skill, script, template, and reference sources are also installed for Codex and Gemini CLI.

## MCP and flags

MCP integrations are optional. The short flags select the appropriate capability where supported.

| Flag | Intent |
|---|---|
| `--c7` | Use Context7 documentation support |
| `--seq` | Use sequential reasoning support |
| `--chrome` | Use Chrome DevTools support |
| `--play` | Use Playwright support |
| `--all-mcp` | Allow all configured MCP integrations |
| `--no-mcp` | Keep work to native tools |

See `core/mcp/` for server-specific operating guidance and `core/.mcp.json` for the Claude registration source.

## Rules and behavioral modes

| Source | Governs |
|---|---|
| `core/PRINCIPLES.md` | Baseline collaboration and engineering principles |
| `core/FLAGS.md` | Shared flags and their meaning |
| `core/rules/RULE_01_SAFETY.md` | Safety boundaries |
| `core/rules/RULE_02_WORKFLOW.md` | Delivery workflow |
| `core/rules/RULE_03_QUALITY.md` | Quality expectations |
| `core/rules/RULE_04_QUESTIONS.md` | When and how to ask for clarification |
| `core/modes/` | Optional modes for research, orchestration, brainstorming, and task management |

Installed instruction files load the core rules and point to optional material on demand. Do not duplicate rule text in project documentation; link to the source that owns it.
