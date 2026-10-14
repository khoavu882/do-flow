#!/usr/bin/env bash
# Claude front door: subagent-audit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge claude SubagentStart subagent-audit
exit $?
