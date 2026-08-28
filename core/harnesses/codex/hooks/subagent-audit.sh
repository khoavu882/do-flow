#!/usr/bin/env bash
# Codex front door: reuse the canonical subagent-audit policy with Codex attribution, then emit
# the empty-JSON SubagentStop requires on success (022-hooks-remaining-duplication: claude/codex's
# copies were byte-identical; only this trailing JSON requirement is Codex-specific).
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/subagent-audit.sh"
printf '{}\n'
