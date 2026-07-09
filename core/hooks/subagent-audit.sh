#!/usr/bin/env bash
# subagent-audit.sh — SubagentStart + SubagentStop hook (pure observability, no deny path)
#
# Appends {timestamp, session_id, event, agent_type, agent_id} to a session-scoped audit log.
# Today there is zero record of which of core/agents/'s specialists actually run, how often, or
# whether one is invoked outside its intended use (e.g. everything routing through general-purpose
# instead of code-reviewer/security-engineer) — this hook is the evidence base a future policy
# hook (e.g. an agent-aware pre-bash-guard extension) would need before writing rules on a guess.
# Per agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.1: pure logging, no deny path,
# safe to ship immediately, and the recommended first step before any tighter agent governance.
#
# Multi-session safe: writes only to sessions/{session_id}/subagent-audit.log.
# Must never exit non-zero or block a subagent from starting/stopping.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

EVENT=$(json_field "$INPUT" ".hook_event_name")
AGENT_TYPE=$(json_field "$INPUT" ".agent_type")
AGENT_ID=$(json_field "$INPUT" ".agent_id")
TIMESTAMP=$(date -u +%FT%TZ)

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

jq -nc \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg event "$EVENT" \
  --arg agent_type "$AGENT_TYPE" \
  --arg agent_id "$AGENT_ID" \
  '{timestamp: $ts, session_id: $session, event: $event, agent_type: $agent_type, agent_id: $agent_id}' \
  >> "$SESSION_PATH/subagent-audit.log" 2>/dev/null || true

exit 0
