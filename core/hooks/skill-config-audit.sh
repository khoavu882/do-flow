#!/usr/bin/env bash
# skill-config-audit.sh — ConfigChange(skills) hook (pure observability, no deny path)
#
# Logs skill-file mutations regardless of which tool made them (a subagent's Bash heredoc-to-file
# write, an MCP filesystem tool, a plugin) — not just the Edit/Write tools pre-implement-gate.sh
# already watches for the doflow chain's own narrower purpose. Appends
# {timestamp, session_id, event} to a session-scoped log, same convention as subagent-audit.sh.
#
# Per agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.4: the do-flow repo edits its
# own skill files (core/skills/*/SKILL.md in its source tree) intentionally during development, so
# a naive hard-block on skill-file
# change would fight the repo's actual purpose — `decision: "block"` is deliberately NOT used here.
# This ships pure-logging only; a stricter follow-on (only once the log shows what "normal" skill
# churn looks like in practice) is a separate, later decision.
#
# Multi-session safe: writes only to sessions/{session_id}/skill-config-audit.log.
# Must never exit non-zero or block a config change.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

TIMESTAMP=$(date -u +%FT%TZ)
SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

jq -nc \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  '{timestamp: $ts, session_id: $session, event: "ConfigChange", source: "skills"}' \
  >> "$SESSION_PATH/skill-config-audit.log" 2>/dev/null || true

exit 0
