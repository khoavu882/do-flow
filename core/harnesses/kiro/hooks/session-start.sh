#!/usr/bin/env bash
# Kiro adapter: reuse the canonical session-context policy with Kiro attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/session-context.sh"
