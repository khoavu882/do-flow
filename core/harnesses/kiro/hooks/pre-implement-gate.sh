#!/usr/bin/env bash
# Kiro adapter: reuse the canonical pre-implementation-gate policy with Kiro attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
exec bash "$(dirname "$0")/../../shared/hooks/policies/pre-implementation-gate.sh"
