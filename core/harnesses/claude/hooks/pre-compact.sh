#!/usr/bin/env bash
# pre-compact.sh — PreCompact hook
#
# Outputs a plain string to stdout that Claude Code passes as custom_instructions
# to the compaction LLM call. This enriches the compact summary with git state
# so the summary preserves branch/commit context for the next session.
#
# Output is a plain string — NOT JSON.
# Must be under ~500 chars (Claude Code may truncate longer strings).
# Must never exit non-zero or block.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
CWD=$(json_field "$INPUT" ".cwd")

BRANCH=""
SHA=""
UNCOMMITTED=0

if [[ -n "$CWD" ]] && timeout 1 git -C "$CWD" rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(timeout 1 git -C "$CWD" branch --show-current 2>/dev/null || echo "")
  SHA=$(timeout 1 git -C "$CWD" rev-parse --short HEAD 2>/dev/null || echo "")
  UNCOMMITTED=$(timeout 1 git -C "$CWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "0")

  # Last 2 commits (short SHA only for brevity) — keeps output under 500 chars
  RECENT=$(timeout 1 git -C "$CWD" log --format="%h %s" -2 2>/dev/null \
    | paste -sd ' | ' - || echo "")

  # Build output and hard-cap at 490 chars to stay within Claude Code's limit
  OUT=$(printf 'Include in compact summary:\n- git branch: %s sha: %s\n- recent commits: %s\n- uncommitted files: %s\n- cwd: %s\nPreserve: decisions made, files modified, open questions, planned next steps.' \
    "${BRANCH:-unknown}" "${SHA:-unknown}" "${RECENT:-none}" "$UNCOMMITTED" "${CWD:-unknown}")
  printf '%s' "${OUT:0:490}"
else
  OUT=$(printf 'Include in compact summary:\n- cwd: %s (not a git repository)\nPreserve: decisions made, files modified, open questions, planned next steps.' \
    "${CWD:-unknown}")
  printf '%s' "${OUT:0:490}"
fi

exit 0
