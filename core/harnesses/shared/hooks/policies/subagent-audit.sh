#!/usr/bin/env bash
_DOFLOW_SRC=${0//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_POLDIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_POLDIR=. ;; esac
# subagent-audit.sh — Canonical Policy Library: SubagentStart + SubagentStop hook
# (pure observability, no deny path)
#
# 022-hooks-remaining-duplication: claude and codex's copies were byte-identical — moved here as
# the single canonical copy.
#
# Appends {timestamp, session_id, event, agent_type, agent_id} to a session-scoped audit log.
# Today there is zero record of which of the installed agents/ specialists actually run, how often, or
# whether one is invoked outside its intended use (e.g. everything routing through general-purpose
# instead of do-code-review/security-engineer) — this hook is the evidence base a future policy
# hook (e.g. an agent-aware pre-bash-guard extension) would need before writing rules on a guess.
# Per agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.1: pure logging, no deny path,
# safe to ship immediately, and the recommended first step before any tighter agent governance.
#
# Multi-session safe: writes only to sessions/{session_id}/subagent-audit.log.
# Must never exit non-zero or block a subagent from starting/stopping.

set -euo pipefail
# shellcheck source=lib.sh
source "$_DOFLOW_POLDIR/lib.sh"
INPUT=$(cat)
POLICY_DIR=$_DOFLOW_POLDIR
if [ -f "$POLICY_DIR/contract.sh" ]; then
  # shellcheck source=contract.sh
  source "$POLICY_DIR/contract.sh"
  doflow_decision_init subagent-audit 1
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure subagent-audit contract-missing ) >/dev/null 2>&1 || true
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  doflow_decide error dependency-missing:jq
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure subagent-audit dependency-missing:jq ) >/dev/null 2>&1 || true
fi
require_jq
SESSION_ID="" ENVELOPE_CLASS=missing
{ IFS= read -r -d '' ENVELOPE_CLASS; IFS= read -r -d '' SESSION_ID; } < <(
  printf '%s' "$INPUT" | jq -j 'if ((. | type) != "object") or ((.doflow_event | type) != "object") or ((.doflow_event | has("version")) | not) then "missing" elif ((.doflow_event.version | type) == "number") and .doflow_event.version == 1 then "v1" else "unsupported" end, "\u0000", (.session_id // "" | if type == "string" then rtrimstr("\n") else tojson end), "\u0000"' 2>/dev/null
) || true
ENVELOPE_CLASS=${ENVELOPE_CLASS:-missing}
if [ ! -f "$POLICY_DIR/contract.sh" ]; then ENVELOPE_CLASS=missing; fi
if [ "$ENVELOPE_CLASS" = unsupported ] || [ "$ENVELOPE_CLASS" = missing ]; then
  code=envelope-version
  [ "$ENVELOPE_CLASS" = missing ] && code=envelope-missing
  [ -f "$POLICY_DIR/contract.sh" ] || code=contract-missing
  doflow_decide unsupported "$code"
  if [ -f "$POLICY_DIR/contract.sh" ]; then
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure subagent-audit "$code" ) >/dev/null 2>&1 || true
  fi
  exit 0
fi

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0
# No config home (lib.sh leaves the state paths empty): no session store to write (086 IC-010).
[[ -n "$SESSION_DIR" ]] || exit 0

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
  >> "$SESSION_PATH/subagent-audit.log" 2>/dev/null || doflow_decide error audit-write-failed

exit 0
