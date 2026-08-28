#!/usr/bin/env bash
# Claude adapter: reuse the shared stop-completion check with Claude attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
exec bash "$(dirname "$0")/../../shared/hooks/policies/stop-check.sh"
