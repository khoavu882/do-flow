#!/usr/bin/env bash
# user-prompt-submit.sh — Canonical Policy Library: UserPromptSubmit hook
#
# 022-hooks-remaining-duplication: claude and codex's UserPromptSubmit policies share the same
# context-gathering behavior. Gemini has no UserPromptSubmit-equivalent event in its native hook set.
#
# On the FIRST prompt of a session: injects lightweight git context into the harness's LLM
# context. Claude and Codex receive one nested envelope,
#   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":...}}
# because Claude Code ignores a top-level additionalContext. Claude's object also carries
# sessionTitle for window identification, unless the payload's session_title shows the user
# already titled the session; Codex rejects unknown fields, so its object never does.
#
# On subsequent prompts: prints {} (clean, no token waste), unless the nudge below is earned.
#
# Once per session, the first prompt that reads as a plain code-change request (decided by
# prompt-nudge.jq against the rules in the workflow registry's `promptNudge` key) also carries a
# one-sentence suggestion to use /do: appended to the first-prompt context, or alone in the same
# nested envelope on a later prompt. The nudge is advisory and never blocks or rewrites a prompt.
# Every failure on its path (no registry, no jq regex support, an unwritable state folder, an
# opt-out file, a subagent prompt, a /do-flow already in progress) resolves to silence; see the
# once-per-session marker in lib.sh. The nudge starts no node or doflow-run process.
#
# Multi-session safe: uses session_id-scoped `injected` flag — no shared state.
# Must complete in <100ms. Must NEVER output "decision: block".

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
# One jq pass over the payload for the three fields this hook reads (each pass costs about 8 ms on a
# 20 KB prompt, and the budget is 100 ms): NUL-separated, null and false read as empty, as json_field does.
SESSION_ID="" CWD="" PAYLOAD_TITLE=""
{ IFS= read -r -d '' SESSION_ID; IFS= read -r -d '' CWD; IFS= read -r -d '' PAYLOAD_TITLE; } < <(
  printf '%s' "$INPUT" | jq -j '[.session_id, .cwd, .session_title]
    | map(if . == null or . == false then "" elif type == "string" then . else tojson end)
    | join("\u0000") + "\u0000"' 2>/dev/null
) || true

[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH="$SESSION_DIR/$SESSION_ID"
INJECTED_FLAG="$SESSION_PATH/injected"

# ── Prompt nudge (IC-004 N1-N8) ───────────────────────────────────────────────

# Print the nudge message when this prompt earns it, nothing otherwise. Every gate that stops
# returns 0 with no output; the caller also contains a failure of the whole function, so nothing
# here can change the exit status or the first-prompt output. The prompt only ever travels to jq
# on stdin, with stderr discarded, and is never copied out of INPUT.
nudge_message() {
  local root policy_dir here registry decision message agents
  [[ "${DOFLOW_AGENT:-}" == "claude" || "${DOFLOW_AGENT:-}" == "codex" ]] || return 0   # N1
  nudge_safe_id "$SESSION_ID" || return 0                                               # N2
  root=$(nudge_repo_root "$CWD") || return 0
  [[ "$(nudge_setting "$root")" == "on" ]] || return 0                                  # N3
  [[ ! -e "$STATE_DIR/nudge/$SESSION_ID" ]] || return 0                                 # N4 (IC-008's path, no process)
  # N5: a subagent prompt carries agent_id or agent_type. Only a payload that names either key
  # is parsed, so the common prompt costs no process here.
  if [[ "$INPUT" == *'"agent_id"'* || "$INPUT" == *'"agent_type"'* ]]; then
    agents=$(printf '%s' "$INPUT" | jq -r '[(.agent_id | strings), (.agent_type | strings)] | join("")' 2>/dev/null) || agents=""
    [[ -z "$agents" ]] || return 0
  fi
  # N6: the policy script's physical directory, found with built-ins (a subshell costs about 4 ms).
  case "$0" in */*) policy_dir="${0%/*}" ;; *) policy_dir="." ;; esac
  here="$PWD"
  cd -P -- "$policy_dir" 2>/dev/null || return 0
  policy_dir="$PWD"
  cd -- "$here" 2>/dev/null || return 0
  registry=$(nudge_registry "$policy_dir" "$root") || return 0
  decision=$(printf '%s' "$INPUT" | jq -r --slurpfile R "$registry" -f "$policy_dir/prompt-nudge.jq" 2>/dev/null) || return 0
  if [[ "$decision" == "suppress" ]]; then
    nudge_mark "$SESSION_ID" suppressed || true
    return 0
  fi
  [[ "$decision" == "nudge" ]] || return 0
  if nudge_feature_active "$CWD" "$root" "$SESSION_PATH" || nudge_ledger_active "$CWD" "$SESSION_PATH"; then   # N7
    nudge_mark "$SESSION_ID" suppressed || true
    return 0
  fi
  # N8: the message is read and checked before the marker is created, so a registry without a
  # usable message leaves no marker; a failed create (unwritable folder, a racing prompt) is silent.
  message=$(jq -r '.promptNudge.message | strings' "$registry" 2>/dev/null) || return 0
  [[ -n "$message" ]] || return 0
  nudge_mark "$SESSION_ID" nudged || return 0
  printf '%s' "$message"
  return 0
}

# One nested envelope for both harnesses (IC-002): $1 is the additionalContext; $2 the session
# title, omitted when empty.
emit_envelope() {
  jq -n --arg ctx "$1" --arg title "$2" \
    '{"hookSpecificOutput": ({"hookEventName": "UserPromptSubmit", "additionalContext": $ctx}
      + (if $title != "" then {"sessionTitle": $title} else {} end))}'
}

# ── Subsequent prompts: no injection, unless the nudge is earned ──────────────

if [[ -f "$INJECTED_FLAG" ]]; then
  NUDGE=$(nudge_message 2>/dev/null) || NUDGE=""
  if [[ -n "$NUDGE" ]]; then
    emit_envelope "$NUDGE" ""
  else
    echo "{}"
  fi
  exit 0
fi

# ── First prompt: build context ───────────────────────────────────────────────

GIT_CONTEXT_FILE="$SESSION_PATH/git-context.json"

# Fallback if session-start.sh didn't run or failed
if [[ ! -f "$GIT_CONTEXT_FILE" ]]; then
  ensure_session_dir "$SESSION_ID" >/dev/null
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
  # Any other session claims the file with an atomic rename first (a summary written meanwhile
  # is a new file and survives), reads a bounded prefix of the claimed copy and removes it. No
  # step here may fail the hook: on any error the summary is simply not injected.

  PROJECT_DIR=$(ensure_project_dir "$CWD")
  COMPACT_FILE="$PROJECT_DIR/last-compact-summary.md"
  COMPACT_CLAIM="$PROJECT_DIR/.last-compact-summary.claimed.$SESSION_ID"
  COMPACT_CAP=4000
  COMPACT_READ=65536   # bytes: enough for the cap even at four bytes per character
  compact_field() {
    printf '%s\n' "$COMPACT_HEAD" | awk -v k="$1:" '/^---$/{n++; if (n == 2) exit; next} n == 1 && index($0, k) == 1 {sub(/^[^:]*:[ ]*/, ""); print; exit}' || true
  }
  if [[ -f "$COMPACT_FILE" && ! -L "$COMPACT_FILE" ]]; then
    COMPACT_HEAD=$(head -c "$COMPACT_READ" "$COMPACT_FILE" 2>/dev/null | tr -d '\r') || COMPACT_HEAD=''
    if [[ "$(compact_field session_id)" != "$SESSION_ID" ]] && mv "$COMPACT_FILE" "$COMPACT_CLAIM" 2>/dev/null; then
      COMPACT_SIZE=$(wc -c < "$COMPACT_CLAIM" 2>/dev/null) || COMPACT_SIZE=0
      COMPACT_HEAD=$(head -c "$COMPACT_READ" "$COMPACT_CLAIM" 2>/dev/null | tr -d '\r') || COMPACT_HEAD=''
      rm -f "$COMPACT_CLAIM"
      # Strip the YAML frontmatter (between the first two `---` lines) and the blank line after it;
      # keep the summary body only.
      COMPACT_BODY=$(printf '%s\n' "$COMPACT_HEAD" | awk '/^---$/ && n < 2 {n++; next} n >= 2 && (started || $0 != "") {started = 1; print}') || COMPACT_BODY=''
      COMPACT_LEN=''
      if [[ -n "$COMPACT_BODY" ]]; then
        # --rawfile, not stdin or --arg: jq 1.7's raw stdin reader miscounts multibyte text across
        # buffer boundaries, and --arg would hit the per-argument size limit on a large summary.
        COMPACT_LEN=$(jq -n --rawfile b <(printf '%s' "$COMPACT_BODY") '$b | length' 2>/dev/null) || COMPACT_BODY=''
      fi
      if [[ -n "$COMPACT_BODY" && "$COMPACT_LEN" -gt "$COMPACT_CAP" ]]; then
        COMPACT_BODY=$(jq -nr --rawfile b <(printf '%s' "$COMPACT_BODY") "\$b[0:$COMPACT_CAP]" 2>/dev/null) || COMPACT_BODY=''
        COMPACT_MORE=''
        [[ "$COMPACT_SIZE" -gt "$COMPACT_READ" ]] && COMPACT_MORE='at least '
        [[ -n "$COMPACT_BODY" ]] && COMPACT_BODY+=$'\n'"[summary truncated: first ${COMPACT_CAP} of ${COMPACT_MORE}${COMPACT_LEN} characters]"
      fi
      if [[ -n "$COMPACT_BODY" ]]; then
        COMPACT_AT=$(compact_field compacted_at); COMPACT_AT=${COMPACT_AT//]/}
        COMPACT_BRANCH=$(compact_field branch); COMPACT_BRANCH=${COMPACT_BRANCH//]/}
        COMPACT_HEADER="Prior session summary"
        [[ -n "$COMPACT_AT" && "$COMPACT_AT" != "unknown" ]] && COMPACT_HEADER+=", compacted ${COMPACT_AT}"
        [[ -n "$COMPACT_BRANCH" && "$COMPACT_BRANCH" != "unknown" ]] && COMPACT_HEADER+=" on branch ${COMPACT_BRANCH}"
        CONTEXT+=$'\n\n'"[${COMPACT_HEADER}]"$'\n'"$COMPACT_BODY"
      fi
    fi
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

# The nudge, when earned, follows the context after a blank line.
NUDGE=$(nudge_message 2>/dev/null) || NUDGE=""
if [[ -n "$NUDGE" ]]; then
  CONTEXT+=$'\n\n'"$NUDGE"
fi

# sessionTitle: not on Codex, only when a title was built, and only when the user has not already
# titled the session.
TITLE_ARG=""
if [[ "${DOFLOW_AGENT:-}" != "codex" && -n "${SESSION_TITLE:-}" && -z "$PAYLOAD_TITLE" ]]; then
  TITLE_ARG="$SESSION_TITLE"
fi
emit_envelope "$CONTEXT" "$TITLE_ARG"

exit 0
