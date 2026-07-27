#!/usr/bin/env bash
# Codex adapter: pre-compact.impl.sh is Codex-specific, NOT a shared/impl-reuse of Claude's
# script — Codex's PreCompact output schema (PreCompactCommandOutputWire) only accepts the
# universal fields (continue/stopReason/suppressOutput/systemMessage) as JSON, with unknown
# fields rejected; it has no additionalContext-equivalent and Claude's plain-string output would
# not parse. See pre-compact.impl.sh for the adapted implementation.
set -euo pipefail
export DOFLOW_AGENT=codex
exec bash "$(dirname "$0")/pre-compact.impl.sh"
