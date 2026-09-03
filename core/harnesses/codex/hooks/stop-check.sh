#!/usr/bin/env bash
# Codex adapter: preserve a blocking exit while returning valid Stop JSON on success.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
if bash "$(dirname "$0")/../../.doflow/shared/hooks/policies/stop-check.sh"; then
  printf '{}\n'
fi
