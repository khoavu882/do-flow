# Quick Start

Get the framework running in under 5 minutes.

---

## Prerequisites

- **Git**
- **Claude Code** — [install guide](https://code.claude.com/docs)
- **Node.js 18+** — for MCP servers
- **jq** — `sudo apt-get install jq` / `brew install jq`

---

## Option A — Claude Code Only

Clone directly into `~/.claude`. Claude Code reads this directory automatically.

```bash
git clone git@github.com:khoavu882/claude-code-agent-workflow.git ~/.claude
chmod +x ~/.claude/hooks/*.sh
```

Then install the MCP servers:

```bash
# Library documentation lookup
npx -y @upstash/context7-mcp

# Structured multi-step reasoning
npx -y @modelcontextprotocol/server-sequential-thinking

# Browser performance and debugging
npx -y chrome-devtools-mcp@latest
```

Open Claude Code. Type `/do-help` to verify everything loaded.

---

## Option B — All Tools (Claude + Codex + Gemini)

Clone to a working directory (not directly to `~/.claude`), then deploy via `doflow`.

```bash
git clone git@github.com:khoavu882/claude-code-agent-workflow.git ~/agent-workflow
cd ~/agent-workflow

# Puts `doflow` on your PATH via a symlink to bin/doflow.js — no publish/global install needed.
npm link

# Preview changes without writing anything
doflow install --dry-run -g

# Install to all tools
doflow install -g

# Or install specific tools only
doflow install -g --target claude,codex
```

See [setup.md](setup.md) for the full CLI reference.

---

## Verify

After opening Claude Code:

```
/do-help
```

You should see the DoFlow skill reference. If skills respond and the status line is visible, the install is complete.

---

## First Session

```bash
# Restore any prior session context (run this after any /compact)
/do-load

# Try a specialist agent
@agent-security "review this function for vulnerabilities: [paste code]"

# Start a structured workflow
/do-brainstorm "add user authentication with JWT"

# Save the agreed requirements to spec.md, then plan and execute
/do-plan --strategy systematic
/do-execute-plan --dry-run

# Or auto-chain the whole spec-driven flow (constitution -> spec -> plan -> tasks -> implement -> review)
# instead of invoking each phase manually — pauses only at defined approval gates
/do-flow "add user authentication with JWT"
```

The `SessionStart` hook has already captured git state; `UserPromptSubmit` injects branch, commit, and prior-context hints on the first prompt, so no manual re-onboarding is needed.

---

## Next Steps

- [Setup](setup.md) — full installation options, MCP config, and troubleshooting
- [Guide](guide.md) — complete development workflows with examples
- [Reference](reference.md) — all skills, agents, flags, and hooks
