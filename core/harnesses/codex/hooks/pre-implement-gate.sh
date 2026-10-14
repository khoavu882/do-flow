#!/usr/bin/env bash
# Codex front door: pre-implementation-gate through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge codex PreToolUse pre-implementation-gate
exit $?
