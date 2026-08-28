#!/usr/bin/env bash
# Codex front door: delegates the pre-implementation-gate decision to the
# Canonical Policy Library, then translates it into the
# hookSpecificOutput.permissionDecision deny contract this script's Codex/Claude
# originals both used — exit code alone is not sufficient here, so this front
# door is a translator, not a bare exec (unlike session-context/stop-check,
# which never need this translation).
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"

command -v jq >/dev/null 2>&1 || exit 0
source "$(dirname "$0")/../../.doflow/shared/hooks/policies/deny-json.sh"

POLICY="$(dirname "$0")/../../.doflow/shared/hooks/policies/pre-implementation-gate.sh"
REASON=$(bash "$POLICY" 2>&1 >/dev/null)
CODE=$?

[ "$CODE" -ne 0 ] && emit_pretooluse_deny_nested "${REASON:-Implementation requires an approved plan.md}"
exit 0
