#!/usr/bin/env bash
# user-prompt-submit.sh — UserPromptSubmit hook
#
# On the FIRST prompt of a session: injects lightweight git context into Claude's
# LLM context via additionalContext. Sets sessionTitle for window identification.
#
# On subsequent prompts: outputs nothing (clean, no token waste).
#
# Multi-session safe: uses session_id-scoped `injected` flag — no shared state.
# Must complete in <100ms. Must NEVER output "decision: block".

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
CWD=$(json_field "$INPUT" ".cwd")

[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH="$SESSION_DIR/$SESSION_ID"
INJECTED_FLAG="$SESSION_PATH/injected"

# ── Subsequent prompts: no injection ─────────────────────────────────────────

if [[ -f "$INJECTED_FLAG" ]]; then
  echo "{}"
  exit 0
fi

# ── First prompt: build context ───────────────────────────────────────────────

GIT_CONTEXT_FILE="$SESSION_PATH/git-context.json"

# Fallback if session-start.sh didn't run or failed
if [[ ! -f "$GIT_CONTEXT_FILE" ]]; then
  touch "$INJECTED_FLAG"
  printf '{"additionalContext":"Git context unavailable for this session."}\n'
  exit 0
fi

GIT_JSON=$(cat "$GIT_CONTEXT_FILE")
IS_GIT=$(json_field "$GIT_JSON" ".is_git_repo")

if [[ "$IS_GIT" == "true" ]]; then
  BRANCH=$(json_field "$GIT_JSON" ".branch")
  SHA=$(json_field "$GIT_JSON" ".sha")
  UNCOMMITTED=$(json_field "$GIT_JSON" ".uncommitted_count")
  STASH=$(json_field "$GIT_JSON" ".stash_count")

  # Build commit list as a single line (· separated)
  COMMITS=$(echo "$GIT_JSON" | jq -r '.commits[]? // empty' | head -5 | paste -sd ' · ' -)

  CONTEXT="Git context — branch: ${BRANCH:-unknown} | ${SHA:-unknown}"$'\n'
  CONTEXT+="Last commits: ${COMMITS:-none}"$'\n'
  CONTEXT+="Uncommitted files: ${UNCOMMITTED:-0}"
  [[ "${STASH:-0}" -gt 0 ]] && CONTEXT+=" | Stashed: ${STASH}"

  SESSION_TITLE="${BRANCH:-unknown} — ${SHA:-unknown}"
else
  CONTEXT="Not a git repository."
  SESSION_TITLE="no-git"
fi

# ── Prior compact summary: read and inject directly, no manual restore step ───

PROJECT_DIR=$(ensure_project_dir "$CWD")
COMPACT_FILE="$PROJECT_DIR/last-compact-summary.md"
if [[ -f "$COMPACT_FILE" ]]; then
  # Strip the YAML frontmatter (between the two `---` lines); keep the summary body only.
  COMPACT_BODY=$(awk '/^---$/{n++; next} n>=2' "$COMPACT_FILE")
  if [[ -n "$COMPACT_BODY" ]]; then
    CONTEXT+=$'\n\n'"[Prior session summary]"$'\n'"$COMPACT_BODY"
  fi
fi

# Check for uncommitted warning from prior session (one-time: delete after read —
# nothing else in the framework reassigns this cleanup, so it happens here)
if [[ -f "$PROJECT_DIR/uncommitted-warning.txt" ]]; then
  WARNING=$(cat "$PROJECT_DIR/uncommitted-warning.txt")
  CONTEXT+=$'\n'"[Prior session warning: ${WARNING}]"
  rm -f "$PROJECT_DIR/uncommitted-warning.txt"
fi

# ── Write injected flag ────────────────────────────────────────────────────────

touch "$INJECTED_FLAG"

# ── Output JSON ───────────────────────────────────────────────────────────────

# sessionTitle is included speculatively — may be unsupported by Claude Code.
# If unsupported it is silently ignored; no harm caused.
jq -n \
  --arg ctx "$CONTEXT" \
  --arg title "$SESSION_TITLE" \
  '{"additionalContext": $ctx, "sessionTitle": $title}'

exit 0
