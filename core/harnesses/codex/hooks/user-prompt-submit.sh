#!/usr/bin/env bash
# Codex front door: reuse the canonical user-prompt-submit policy with Codex attribution.
# The shared script's additionalContext response is Codex-compatible as-is
# (022-hooks-remaining-duplication: claude/codex's copies were byte-identical).
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/user-prompt-submit.sh"
