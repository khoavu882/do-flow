#!/usr/bin/env bash
# pre-compact.impl.sh — PreCompact hook (Codex-specific output shape)
#
# Codex's PreCompact output schema (codex-rs/hooks/src/schema.rs::PreCompactCommandOutputWire)
# flattens only HookUniversalOutputWire (continue/stopReason/suppressOutput/systemMessage) and
# rejects unknown fields — there is no additionalContext-style field for PreCompact, and the
# output MUST be valid JSON, unlike Claude's PreCompact hook, which reads a plain string as
# custom_instructions. This script gathers the same git-state context Claude's pre-compact.sh
# does, but emits it as a JSON systemMessage instead — the closest available field, though
# systemMessage's exact downstream effect on compaction content is not confirmed (Claude's
# custom_instructions is fed directly to the compaction LLM call; Codex's docs do not state that
# systemMessage receives the same treatment). Treat this as best-effort context surfacing, not a
# guaranteed compaction-summary injection, until verified against a live Codex session.
#
# Must never exit non-zero or block (PreCompact hooks do not support a block decision in Codex).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
CWD=$(json_field "$INPUT" ".cwd")

BRANCH=""
SHA=""
UNCOMMITTED=0

if [[ -n "$CWD" ]] && run_with_timeout 1 -- git -C "$CWD" rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(run_with_timeout 1 -- git -C "$CWD" branch --show-current 2>/dev/null || echo "")
  SHA=$(run_with_timeout 1 -- git -C "$CWD" rev-parse --short HEAD 2>/dev/null || echo "")
  UNCOMMITTED=$(run_with_timeout 1 -- git -C "$CWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "0")
  RECENT=$(run_with_timeout 1 -- git -C "$CWD" log --format="%h %s" -2 2>/dev/null | paste -sd ' | ' - || echo "")

  MSG=$(printf 'Include in compact summary:\n- git branch: %s sha: %s\n- recent commits: %s\n- uncommitted files: %s\n- cwd: %s\nPreserve: decisions made, files modified, open questions, planned next steps.' \
    "${BRANCH:-unknown}" "${SHA:-unknown}" "${RECENT:-none}" "$UNCOMMITTED" "${CWD:-unknown}")
else
  MSG=$(printf 'Include in compact summary:\n- cwd: %s (not a git repository)\nPreserve: decisions made, files modified, open questions, planned next steps.' \
    "${CWD:-unknown}")
fi

# Hard-cap at 490 chars, matching Claude's script, before JSON-encoding.
MSG="${MSG:0:490}"

jq -n --arg systemMessage "$MSG" '{systemMessage: $systemMessage}'
exit 0
