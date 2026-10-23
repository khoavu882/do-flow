#!/usr/bin/env bash
# pre-compact.impl.sh — PreCompact hook (Codex-specific output shape)
#
# Codex's PreCompact output schema (codex-rs/hooks/src/schema.rs::PreCompactCommandOutputWire)
# flattens only HookUniversalOutputWire (continue/stopReason/suppressOutput/systemMessage) and
# rejects unknown fields — there is no additionalContext-style field for PreCompact, and the
# output MUST be valid JSON, unlike Claude's PreCompact hook, whose plain stdout was observed in
# Claude Code 2.1.304 and 2.1.308 to be read as custom_instructions, undocumented (FU-w563w2). This script
# gathers the same git-state context Claude's pre-compact.sh does, but emits it as a JSON
# systemMessage instead — the closest available field, though systemMessage's exact downstream
# effect on compaction content is not confirmed (that Claude's custom_instructions reach the
# compaction LLM call is observed in Claude Code 2.1.304 and 2.1.308, undocumented (FU-w563w2); Codex's docs
# do not state that systemMessage receives the same treatment). Treat this as best-effort context
# surfacing, not a guaranteed compaction-summary injection, until verified against a live Codex
# session.
# The shared compaction text comes from compact-text.sh (IC-001/IC-002).
#
# Must never exit non-zero or block (PreCompact hooks do not support a block decision in Codex).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
CWD=$(json_field "$INPUT" ".cwd")

# Rule compact-instructions.instructions (DEC-023) decides whether this hook emits; it is
# `include` for both roles, so the output below is unchanged. The role comes from the shared
# identity.sh, read silently: this hook never wrote the role diagnostic and does not start now.
POLICIES="$(dirname "$0")/../../.doflow/shared/hooks/policies"
[[ -f "$POLICIES/emission-rules.sh" ]] || POLICIES="$(dirname "$0")/../../shared/hooks/policies"
_DF_ROLE=worker
if declare -F _doflow_role_resolve >/dev/null 2>&1; then _doflow_role_resolve 2>/dev/null; fi
DF_ACTION=skip
if [[ -f "$POLICIES/emission-rules.sh" ]]; then
  # shellcheck source=/dev/null
  . "$POLICIES/emission-rules.sh"
  doflow_emission_rule compact-instructions.instructions "$_DF_ROLE"
fi
[[ "$DF_ACTION" == include ]] || exit 0

[[ -f "$POLICIES/compact-text.sh" ]] || exit 0
# shellcheck source=/dev/null
source "$POLICIES/compact-text.sh"
doflow_compact_text "$CWD"
jq -n --arg systemMessage "$DF_COMPACT_TEXT" '{systemMessage: $systemMessage}'
exit 0
