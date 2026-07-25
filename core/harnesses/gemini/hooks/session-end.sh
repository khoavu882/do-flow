#!/usr/bin/env bash
# Gemini adapter: reuse the shared session closer with Gemini attribution.
set -euo pipefail
export DOFLOW_AGENT=gemini
exec bash "$(dirname "$0")/session-end.impl.sh"
