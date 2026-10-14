#!/usr/bin/env bash
# Claude front door: user-prompt-submit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then exit 0; fi
doflow_bridge claude UserPromptSubmit user-prompt-submit
exit $?
