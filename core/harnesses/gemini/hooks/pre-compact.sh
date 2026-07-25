#!/usr/bin/env bash
# pre-compact.sh — PreCompress hook
#
# Gemini's PreCompress output schema (docs/hooks/reference.md) accepts a
# "systemMessage" field, displayed to the user before compression — no
# additionalContext-style field that feeds compaction content directly, same
# limitation as Codex's PreCompact. Gathers the same git-state summary Claude's/
# Codex's pre-compact scripts do, surfaced as a systemMessage instead.
#
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
  RECENT=$(timeout 1 git -C "$CWD" log --format="%h %s" -2 2>/dev/null | paste -sd ' | ' - || echo "")

  MSG=$(printf 'Compacting session — git branch: %s sha: %s, recent commits: %s, uncommitted files: %s, cwd: %s' \
    "${BRANCH:-unknown}" "${SHA:-unknown}" "${RECENT:-none}" "$UNCOMMITTED" "${CWD:-unknown}")
else
  MSG=$(printf 'Compacting session — cwd: %s (not a git repository)' "${CWD:-unknown}")
fi

MSG="${MSG:0:490}"
jq -n --arg systemMessage "$MSG" '{systemMessage: $systemMessage}'
exit 0
