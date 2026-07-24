#!/usr/bin/env bash
# Codex adapter: the shared hook's additionalContext response is Codex-compatible.
set -euo pipefail
export DOFLOW_AGENT=codex
exec bash "$(dirname "$0")/user-prompt-submit.impl.sh"
