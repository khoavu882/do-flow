#!/usr/bin/env bash
# Claude front door: reuse the canonical user-prompt-submit policy with Claude attribution.
# No JSON-shape translation needed — claude/codex's payload and output contracts are identical
# (022-hooks-remaining-duplication).
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/user-prompt-submit.sh"
