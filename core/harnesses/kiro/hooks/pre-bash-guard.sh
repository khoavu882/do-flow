#!/usr/bin/env bash
# Kiro adapter: reuse the canonical pre-bash-guard policy with Kiro attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
exec bash "$(dirname "$0")/../../shared/hooks/policies/pre-bash-guard.sh"
