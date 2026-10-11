#!/usr/bin/env bash
# Kiro adapter: reuse the canonical stop-check policy with Kiro attribution.
#
# Kiro's Stop hook contract only requires a non-zero exit code to block (confirmed:
# kiro.dev/docs/hooks/ — "the tool invocation is blocked... blocked" on non-zero exit); unlike
# Claude/Codex, no specific JSON response shape on success is documented as required, so this
# wrapper does not fabricate one — it just execs the canonical policy script and lets its exit
# code (0 = allow stop, 2 = block) speak for itself.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# Translate Kiro's payload (tool names, KIRO_SESSION_ID, assistant_response) to the canonical one.
payload=$(kiro_bridge_payload)
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/stop-check.sh" <<<"$payload"
