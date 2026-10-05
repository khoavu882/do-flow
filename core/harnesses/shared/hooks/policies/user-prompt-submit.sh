#!/usr/bin/env bash
# user-prompt-submit.sh — Canonical Policy Library: UserPromptSubmit hook
#
# 022-hooks-remaining-duplication: claude and codex's UserPromptSubmit policies share the same
# context-gathering behavior, while their native output envelopes differ. Gemini has no
# UserPromptSubmit-equivalent event in its native hook set.
#
# On the FIRST prompt of a session: injects lightweight git context into the harness's LLM
# context via additionalContext. Claude also receives sessionTitle for window identification;
# Codex receives its additionalContext under hookSpecificOutput with an explicit event name.
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
  CONTEXT="Git context unavailable for this session."
  SESSION_TITLE=""
else
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

  # ── Prior compact summary: injected once into the next session, then consumed ─
  # post-compact.sh writes this file for the session that follows a compaction. The session
  # that compacted already holds the summary, so it skips the file and leaves it in place.

  PROJECT_DIR=$(ensure_project_dir "$CWD")
  COMPACT_FILE="$PROJECT_DIR/last-compact-summary.md"
  COMPACT_CAP=4000
  frontmatter_value() {
    awk -v k="$1:" '/^---$/{n++; if (n == 2) exit; next} n == 1 && index($0, k) == 1 {sub(/^[^:]*:[ ]*/, ""); print; exit}' "$COMPACT_FILE"
  }
  if [[ -f "$COMPACT_FILE" && "$(frontmatter_value session_id)" != "$SESSION_ID" ]]; then
    # Strip the YAML frontmatter (between the first two `---` lines) and the blank line after it;
    # keep the summary body only.
    COMPACT_BODY=$(awk '/^---$/ && n < 2 {n++; next} n >= 2 && (started || $0 != "") {started = 1; print}' "$COMPACT_FILE")
    if [[ -n "$COMPACT_BODY" ]]; then
      # --rawfile, not stdin or --arg: jq 1.7's raw stdin reader miscounts multibyte text across
      # buffer boundaries, and --arg would hit the per-argument size limit on a large summary.
      COMPACT_LEN=$(jq -n --rawfile b <(printf '%s' "$COMPACT_BODY") '$b | length')
      if [[ "$COMPACT_LEN" -gt "$COMPACT_CAP" ]]; then
        COMPACT_BODY=$(jq -nr --rawfile b <(printf '%s' "$COMPACT_BODY") "\$b[0:$COMPACT_CAP]")
        COMPACT_BODY+=$'\n'"[summary truncated: first ${COMPACT_CAP} of ${COMPACT_LEN} characters]"
      fi
      COMPACT_AT=$(frontmatter_value compacted_at)
      COMPACT_BRANCH=$(frontmatter_value branch)
      COMPACT_HEADER="Prior session summary"
      [[ -n "$COMPACT_AT" && "$COMPACT_AT" != "unknown" ]] && COMPACT_HEADER+=", compacted ${COMPACT_AT}"
      [[ -n "$COMPACT_BRANCH" && "$COMPACT_BRANCH" != "unknown" ]] && COMPACT_HEADER+=" on branch ${COMPACT_BRANCH}"
      CONTEXT+=$'\n\n'"[${COMPACT_HEADER}]"$'\n'"$COMPACT_BODY"
    fi
    rm -f "$COMPACT_FILE"
  fi

  # Check for uncommitted warning from prior session (one-time: delete after read —
  # nothing else in the framework reassigns this cleanup, so it happens here)
  if [[ -f "$PROJECT_DIR/uncommitted-warning.txt" ]]; then
    WARNING=$(cat "$PROJECT_DIR/uncommitted-warning.txt")
    CONTEXT+=$'\n'"[Prior session warning: ${WARNING}]"
    rm -f "$PROJECT_DIR/uncommitted-warning.txt"
  fi
fi

# ── Write injected flag ────────────────────────────────────────────────────────

touch "$INJECTED_FLAG"

# ── Output JSON ───────────────────────────────────────────────────────────────

if [[ "${DOFLOW_AGENT:-}" == "codex" ]]; then
  jq -n \
    --arg ctx "$CONTEXT" \
    '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
elif [[ -n "${SESSION_TITLE:-}" ]]; then
  jq -n \
    --arg ctx "$CONTEXT" \
    --arg title "$SESSION_TITLE" \
    '{"additionalContext": $ctx, "sessionTitle": $title}'
else
  jq -n --arg ctx "$CONTEXT" '{"additionalContext": $ctx}'
fi

exit 0
