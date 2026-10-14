#!/usr/bin/env bash
# Codex front door: user-prompt-submit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then exit 0; fi
doflow_bridge codex UserPromptSubmit user-prompt-submit
exit $?
