#!/usr/bin/env bash
# Codex adapter: reuse shared cleanup with Codex attribution.
set -euo pipefail
export DOFLOW_AGENT=codex
exec bash "$(dirname "$0")/session-end.impl.sh"
