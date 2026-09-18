#!/usr/bin/env bash
# Claude front door: reuse the canonical context policy with Claude's output envelope.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/user-prompt-submit.sh"
