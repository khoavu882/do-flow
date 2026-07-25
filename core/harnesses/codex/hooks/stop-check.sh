#!/usr/bin/env bash
# Codex adapter: preserve a blocking exit while returning valid Stop JSON on success.
set -euo pipefail
export DOFLOW_AGENT=codex
if bash "$(dirname "$0")/stop-check.impl.sh"; then
  printf '{}\n'
fi
