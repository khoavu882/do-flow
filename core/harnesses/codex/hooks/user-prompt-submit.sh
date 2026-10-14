#!/usr/bin/env bash
# Codex front door: user-prompt-submit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge codex UserPromptSubmit user-prompt-submit
exit $?
