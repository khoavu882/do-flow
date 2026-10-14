#!/usr/bin/env bash
# Claude front door: user-prompt-submit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge claude UserPromptSubmit user-prompt-submit
exit $?
