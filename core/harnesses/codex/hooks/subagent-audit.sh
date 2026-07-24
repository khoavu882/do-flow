#!/usr/bin/env bash
# Codex adapter: SubagentStop requires JSON on successful output.
set -euo pipefail
export DOFLOW_AGENT=codex
bash "$(dirname "$0")/subagent-audit.impl.sh"
printf '{}\n'
