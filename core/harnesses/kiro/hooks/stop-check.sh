#!/usr/bin/env bash
# Kiro adapter: run the canonical stop-check policy and translate its verdict to the Kiro engine.
#
# The policy exits 2 to deny the stop. Kiro engines read a Stop hook differently:
#   - Kiro CLI V3 / IDE (payload carries session_id): exit 0 finishes the turn; exit 0 with stdout
#     JSON {"decision":"block","reason":"..."} starts another turn with that reason; exit 1 also
#     starts another turn; other codes finish without forwarding output. Exit 2 does NOT block.
#     So a policy deny becomes the JSON block on stdout with exit 0.
#   - Kiro CLI 2.x (payload has no session_id): exit 0 succeeded, any other code shows stderr to the
#     user as a warning. A policy deny is passed through as stderr with exit 2.
# Every other policy outcome exits 0, never 1: V3 treats exit 1 as "continue another turn".
# The policy blocks a given message once, so the continuation turn is not blocked again.
# Docs: https://kiro.dev/docs/hooks/types/ , https://kiro.dev/docs/cli/v3/hooks-migration/
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
set +e # lib.sh enables errexit; the policy exit code is handled explicitly below

raw=$(cat)
# Translate Kiro's payload (tool names, KIRO_SESSION_ID, assistant_response) to the canonical one.
payload=$(kiro_bridge_payload <<<"$raw")

# V3 and the IDE send session_id in the payload; 2.x does not (the bridge injects it from the env).
raw_sid=""
if command -v jq >/dev/null 2>&1; then
  raw_sid=$(printf '%s' "$raw" | jq -r '.session_id // empty' 2>/dev/null) || raw_sid=""
fi

# Capture the policy's stderr (stdout discarded) and its exit code without a temp file.
errtext=$(bash "$here/../../.doflow/shared/hooks/policies/stop-check.sh" <<<"$payload" 2>&1 >/dev/null)
rc=$?

if [ "$rc" -eq 2 ]; then
  if [ -n "$raw_sid" ] && command -v jq >/dev/null 2>&1; then
    jq -n --arg reason "$errtext" '{decision: "block", reason: $reason}'
    exit 0
  fi
  printf '%s\n' "$errtext" >&2
  exit 2
fi
exit 0
