#!/usr/bin/env bash
# Codex front door: reuse the canonical context policy with the Codex output envelope.
# The shared policy selects Codex's hookSpecificOutput shape from this attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/user-prompt-submit.sh"
