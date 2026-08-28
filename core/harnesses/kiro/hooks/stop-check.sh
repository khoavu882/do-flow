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
exec bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/stop-check.sh"
