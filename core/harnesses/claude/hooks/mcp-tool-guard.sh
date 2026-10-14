#!/usr/bin/env bash
# Claude front door: mcp-tool-guard through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge claude PreToolUse mcp-tool-guard
exit $?
