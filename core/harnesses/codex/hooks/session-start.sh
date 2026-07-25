#!/usr/bin/env bash
# Codex adapter: reuse the shared session initializer with Codex attribution.
set -euo pipefail
export DOFLOW_AGENT=codex
exec bash "$(dirname "$0")/session-start.impl.sh"
