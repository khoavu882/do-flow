#!/usr/bin/env bash
# Claude front door: reuse the canonical subagent-audit policy with Claude attribution.
# No JSON-shape translation needed — claude/codex's copies were byte-identical
# (022-hooks-remaining-duplication).
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/subagent-audit.sh"
