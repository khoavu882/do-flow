#!/usr/bin/env bash
# Gemini adapter: reuse the Canonical Policy Library's session-context policy.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-gemini}"
exec bash "$(dirname "$0")/../../shared/hooks/policies/session-context.sh"
