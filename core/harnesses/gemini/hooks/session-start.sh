#!/usr/bin/env bash
# Gemini adapter: reuse the shared session initializer with Gemini attribution.
set -euo pipefail
export DOFLOW_AGENT=gemini
exec bash "$(dirname "$0")/session-start.impl.sh"
