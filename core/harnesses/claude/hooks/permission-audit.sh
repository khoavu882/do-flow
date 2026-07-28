#!/usr/bin/env bash
# permission-audit.sh — PermissionDenied hook (pure observability, no deny path)
#
# The decision has already been made by the time this fires; there is nothing to
# block. Its purpose is completeness of the audit trail: without it the record
# shows only what was permitted, which makes "this agent never tried X" and "this
# agent was refused X" indistinguishable after the fact.
#
# subagent-audit.sh deliberately does NOT serve this event: it records
# agent_type/agent_id, which a permission decision does not carry, and would
# write empty rows into the log it exists to keep meaningful.
#
# Appends {timestamp, session_id, event, tool_name, reason} to a session-scoped
# log. Fields beyond the common envelope are best-effort — an absent key yields
# empty rather than failing the hook.
#
# Multi-session safe: writes only to sessions/{session_id}/permission-audit.log.
# Must complete in <20ms. Must never exit non-zero.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

EVENT=$(json_field "$INPUT" ".hook_event_name")
TOOL_NAME=$(json_field "$INPUT" ".tool_name")
REASON=$(json_field "$INPUT" ".permission_decision_reason")
TIMESTAMP=$(date -u +%FT%TZ)

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

jq -nc \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  --arg reason "$REASON" \
  '{timestamp: $ts, session_id: $session, event: $event, tool_name: $tool, reason: $reason}' \
  >> "$SESSION_PATH/permission-audit.log" 2>/dev/null || true

exit 0
