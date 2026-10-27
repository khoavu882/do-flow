#!/usr/bin/env bash
# Copilot CLI front door: pre-implementation-gate through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-copilot}"
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=doflow-lib.sh
. "$here/doflow-lib.sh"
copilot_front_door "$here" PreToolUse pre-implementation-gate deny
exit $?
