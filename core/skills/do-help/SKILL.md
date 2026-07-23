---
name: do-help
description: "List all available DoFlow skills and their functionality"
disable-model-invocation: true
effort: low
---

# do-help

Skill discovery — lists every skill currently in `core/skills/`, not a fixed/cached list.

## Invocation
```text
/do-help
```

## Behavioral Flow
1. **Enumerate** — `ls core/skills/` (or the installed `.claude/skills/` if running outside this
   repo) rather than reciting a hardcoded table, so a skill added or removed since this file was
   last edited still shows up correctly.
2. **Read each skill's frontmatter** (`description`) to build the summary column — don't
   paraphrase from memory, since a description can change independently of this file.
3. **Group and present**: doflow-chain skills (`do-brainstorm` → `do-design` → `do-plan` →
   `do-execute-plan` → `do-code-review`, plus `do-constitution`) first, since they're the primary
   delivery path; the rest grouped by invocation mode (manual command / hybrid read-only /
   auto-loaded policy / forked research) per `docs/reference.md`'s Invocation Modes table.
4. **Flag drift**: if the skill count found in step 1 doesn't match a count stated in
   `README.md`/`ARCHITECTURE.md`/`docs/index.md`, say so — this repo's own `CLAUDE.md` documents
   that these counts drift silently when skills are added/removed without updating every doc.

## Current skill list (as of this file's last edit — step 1 re-derives this live)

| Skill | Description |
|---|---|
| `/do` | DoFlow command dispatcher, session announcement, and skill recommendation |
| `/do-analyze` | Read-only, multi-domain code analysis (quality/security/performance/architecture) |
| `/do-brainstorm` | Interactive requirements discovery through Socratic dialogue; seeds requirement.md |
| `/do-build` | Detect and run the project's own build system |
| `/do-code-review` | Automated code-quality review across 13 languages |
| `confidence-check` | Auto-loaded pre-implementation confidence gate |
| `/do-constitution` | Create or amend the per-repo constitution |
| `/do-design` | System-shape architecture/API/component design; writes design.md |
| `/do-document` | Documentation for one component/function/API/feature |
| `/do-estimate` | Read-only, confidence-banded development estimates |
| `/do-execute-plan` | Execute plan.md's task checklist via pm-agent orchestration |
| `/do-explain` | No-artifact educational explanation of code/concepts/behavior |
| `/do-flow` | Auto-chain the doflow spec-driven flow, pausing at approval gates |
| `/do-git` | Git operations with safety checks and smart commit messages |
| `/do-help` | This skill — list all available DoFlow skills |
| `/do-implement` | Standalone feature/component implementation (outside the doflow chain) |
| `/do-improve` | Refactor or clean up existing code (quality/performance/style/cleanup) |
| `/do-index` | Whole-project documentation/knowledge-base generation |
| `/do-pm` | Classify an ambiguous/multi-part request and route it to the right skill/agent |
| `/do-plan` | Implementation plan (HOW) + task checklist from requirement.md + design.md |
| `/do-reflect` | Post-task self-review against what was asked |
| `/do-research` | Deep web research in an isolated forked context |
| `/do-select-tool` | Native vs. MCP tool routing decision |
| `/do-spec-panel` | Multi-expert specification review via named lenses |
| `/do-test` | Run the project's own existing test suite |
| `/do-troubleshoot` | Diagnose an active, reproducing issue (diagnosis-first) |
| `parallel-agents` | Fan out 2+ independent tasks concurrently |
| `token-efficiency` | Compressed communication when context usage is high |

## Boundaries
**Will:** enumerate the live skill set from `core/skills/` and its frontmatter; flag count drift
against other docs.
**Will Not:** execute any listed skill; edit any file; treat this file's own table as
authoritative over a live `ls` if they disagree — the live count always wins.
