#!/usr/bin/env bash
# Kiro adapter: reuse the canonical pre-bash-guard policy with Kiro attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# Translate Kiro's payload (tool names, KIRO_SESSION_ID, assistant_response) to the canonical one.
payload=$(kiro_bridge_payload)
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/pre-bash-guard.sh" <<<"$payload"
