#!/usr/bin/env bash
# Kiro adapter: reuse the shared session initializer with Kiro attribution.
set -euo pipefail
export DOFLOW_AGENT=kiro
exec bash "$(dirname "$0")/session-start.impl.sh"
