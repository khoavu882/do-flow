#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# Kiro front door: mcp-tool-guard through the shared lifecycle bridge.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
raw=$(cat)
payload=$(kiro_bridge_payload <<<"$raw")
event="PreToolUse"
if command -v jq >/dev/null 2>&1; then event=$(printf '%s' "$raw" | jq -r '.hook_event_name // "PreToolUse"' 2>/dev/null) || event="PreToolUse"; fi
bridge="$here/../../.doflow/shared/hooks/bridge/bridge.sh"
# D1: a missing bridge allows with a warning on stderr. Only strict-1, a person's opt-in, blocks.
bridge_missing=0
[ -f "$bridge" ] || bridge_missing=1
if [ "$bridge_missing" -eq 0 ]; then . "$bridge" 2>/dev/null || bridge_missing=1; fi
if [ "$bridge_missing" -eq 1 ]; then
  printf '%s\n' '[doflow] shared hooks lack the bridge; run: doflow update -t kiro' >&2
  if [ "${DOFLOW_FAULT_PROFILE:-}" = strict-1 ]; then exit 2; fi
  exit 0
fi
if doflow_bridge kiro "$event" mcp-tool-guard <<<"$payload"; then
  status=0
else
  status=$?
fi
if [ "$status" -eq 2 ]; then printf '\n' >&2; fi
exit "$status"
