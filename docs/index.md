# DoFlow

**Give your AI a persistent brain, specialist expertise, and production-grade guardrails — across Claude, Codex, and Gemini.**

A configuration layer for AI coding assistants. Install it and your AI gets session memory, 14 specialist agents, 28 structured skills, 8 safety hooks, and cross-tool consistency — from one config.

---

## The Problem

| Problem | Without This | With This |
|---------|-------------|-----------|
| **Groundhog Day sessions** | Re-explain your stack every time | Hooks capture git state at session start and inject it on the first prompt |
| **Wrong expert** | Generic answers to specialized questions | 14 agents: security engineer, backend architect, root-cause analyst, quality engineer... |
| **Dangerous commands** | `git push --force` runs unchallenged | `pre-bash-guard.sh` blocks it permanently — no confirmation needed |
| **Multi-tool chaos** | Each AI has different standards | Same rules enforced across Claude, Codex, and Gemini |

---

## What You Get

| Capability | Details |
|-----------|---------|
| **Session memory** | Git branch, last commit, and prior-context hints injected on the first prompt |
| **14 specialist agents** | Security engineer, backend architect, root-cause analyst, quality engineer, and more |
| **28 project skills** | `/do-brainstorm`, `/do-code-review`, `/do-execute-plan`, `/do-implement`, `/do-analyze`, `/parallel-agents`, and more |
| **8 safety hooks** | Blocks `git push --force`, `git reset --hard`, `rm -rf /`, `DROP TABLE`, unscoped `DELETE`, and `curl|bash` patterns |
| **4 MCP servers** | Context7 (docs), Sequential (reasoning), Playwright, Chrome DevTools |
| **Cross-tool sync** | Same engineering rules deployed to Claude, Codex, and Gemini via `doflow` |

---

## Navigate

- **[Quick Start](quickstart.md)** — Get running in under 5 minutes
- **[Setup](setup.md)** — Full installation guide with all options
- **[Overview](overview.md)** — How session memory, hooks, and agents work together
- **[Guide](guide.md)** — Real workflows: feature development, bug investigation, code quality
- **[Reference](reference.md)** — Complete skills, agents, flags, hooks, and rules reference
