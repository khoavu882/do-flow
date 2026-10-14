#!/usr/bin/env bash
# Gemini front door: pre-implementation-gate through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-gemini}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then
  printf '%s\n' '{"decision":"deny","reason":"[doflow] shared hooks lack the bridge; run: doflow update -t gemini"}'
  exit 0
fi
doflow_bridge gemini BeforeTool pre-implementation-gate
exit $?
