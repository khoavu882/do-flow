#!/usr/bin/env bash
# mcp-tool-guard.sh — Canonical Policy Library: PreToolUse(mcp_*) hook
#
# Intercepts every MCP tool call and blocks matches against mcp-policy.conf, the
# same TAB-separated pattern<TAB>reason convention pre-bash-guard.sh uses for
# shell commands. Ships with mcp-policy.conf carrying zero active patterns, so
# this is pure infrastructure until real usage data justifies specific deny
# rules — see agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.2.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional; not required to
#          evaluate this policy)
#   stdin  a native payload with envelope v1 under doflow_event; only the
#          envelope's operation and tool fields are used.
#   exit   0 = allow, non-zero = deny with the reason on stderr.
#
# mcp-policy.conf's shape (TAB-separated regex<TAB>reason, '#'-comments,
# blank lines skipped) is identical across every harness that ships one today
# (claude/codex/gemini/kiro) — reconciliation found no divergence to resolve
# there.

set -uo pipefail

INPUT=$(cat)
if [ -f "$(dirname "$0")/contract.sh" ]; then
  . "$(dirname "$0")/contract.sh"
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  doflow_read_envelope() { DF_ENV_CLASS=missing; DF_ENV_CODE=contract-missing; }
  ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure mcp-tool-guard contract-missing ) >/dev/null 2>&1 || true
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then
    printf '[mcp-tool-guard] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2
  else
    printf '[mcp-tool-guard] DoFlow hooks out of step; run: doflow update\n' >&2
  fi
  doflow_decide deny contract-missing
  exit 2
fi
doflow_decision_init mcp-tool-guard 1
command -v jq >/dev/null 2>&1 || {
  doflow_decide error dependency-missing:jq
  ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure mcp-tool-guard dependency-missing:jq ) >/dev/null 2>&1 || true
  exit 0
}
DF_ENV_CLASS=missing DF_ENV_CODE=envelope-missing
doflow_read_envelope || true

TOOL_NAME=""
if [ "$DF_ENV_CLASS" = v1 ]; then
  [ "$DF_ENV_OP" = mcp ] || exit 0
  TOOL_NAME=$DF_ENV_TOOL
elif [ "$DF_ENV_CLASS" = unsupported ]; then
  doflow_decide unsupported envelope-version
  ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure mcp-tool-guard unsupported:envelope-version ) >/dev/null 2>&1 || true
  exit 0
else
  if [ "${DF_ENV_CODE:-envelope-missing}" != contract-missing ]; then
    ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure mcp-tool-guard envelope-missing ) >/dev/null 2>&1 || true
  fi
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then printf '[mcp-tool-guard] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2; else printf '[mcp-tool-guard] DoFlow hooks out of step; run: doflow update\n' >&2; fi
  doflow_decide deny "${DF_ENV_CODE:-envelope-missing}"
  exit 2
fi

POLICY_FILE="$(dirname "$0")/mcp-policy.conf"

# If policy file is missing, allow everything (fail open — don't block the agent).
if [ ! -f "$POLICY_FILE" ]; then
  # The policy file ships with DoFlow, so a missing one means a broken install: record it on this
  # machine (feature 046, IC-018) and fail open exactly as before. Subshell, output discarded.
  ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure mcp-tool-guard policy-file-missing ) >/dev/null 2>&1 || true
  doflow_decide error mcp-policy-missing
  exit 0
fi

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason || [ -n "$pattern" ]; do
  # Skip comments and empty lines
  [ -z "$pattern" ] && continue
  case "$pattern" in \#*) continue ;; esac

  # "--" stops option parsing so a pattern starting with "-" is never
  # mistaken for a grep flag.
  matched=false
  if (echo "$TOOL_NAME" | grep -qiE -- "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [ "$matched" = "true" ]; then
    echo "[mcp-tool-guard] ${reason:-MCP tool call blocked by mcp-tool-guard} (tool: $TOOL_NAME)" >&2
    doflow_decide deny blocked-pattern
    exit 2
  fi
done < "$POLICY_FILE"

# No match — allow
exit 0
