#!/usr/bin/env bash
# Kiro adapter: reuse the shared stop-check implementation with Kiro attribution.
#
# Kiro's Stop hook contract only requires a non-zero exit code to block (confirmed:
# kiro.dev/docs/hooks/ — "the tool invocation is blocked... blocked" on non-zero exit); unlike
# Claude/Codex, no specific JSON response shape on success is documented as required, so this
# wrapper does not fabricate one — it just execs the shared implementation and lets its exit
# code (0 = allow stop, 2 = block) speak for itself.
set -euo pipefail
export DOFLOW_AGENT=kiro
exec bash "$(dirname "$0")/stop-check.impl.sh"
