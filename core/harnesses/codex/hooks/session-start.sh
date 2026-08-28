#!/usr/bin/env bash
# Codex adapter: reuse the canonical session-context policy with Codex attribution.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
exec bash "$(dirname "$0")/../../shared/hooks/policies/session-context.sh"
