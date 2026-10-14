#!/usr/bin/env bash
# Gemini front door: session-context through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-gemini}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge gemini SessionStart session-context
exit $?
