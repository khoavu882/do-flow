#!/usr/bin/env bash
# session-context.sh — Canonical Policy Library: SessionStart guard policy
#
# Fires when a harness starts a new session. Captures git state into a
# session-scoped file so a harness's user-prompt-submit hook can inject it on
# the first prompt.
#
# Cannot inject into the LLM context from this event — side effects only.
# Must complete in <200ms. Must never exit non-zero or produce unexpected stderr.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional here; DOFLOW_AGENT
#          only affects the "last_agent" field recorded in meta.json)
#   stdin  the harness's native SessionStart JSON payload — must expose at
#          least ".session_id" and ".cwd"
#   exit   this policy never denies — it always exits 0 (side-effect only)
#
# Depends on lib.sh (require_jq, json_field, ensure_session_dir,
# ensure_project_dir, cwd_hash, run_with_timeout, $SESSIONS_LOG) being
# discoverable next to this script when it runs — a front door invoking this
# canonical script is responsible for making lib.sh resolvable via
# "$(dirname "$0")/lib.sh", exactly as every harness's own SessionStart script
# already required before this policy moved to a shared location.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
CWD=$(json_field "$INPUT" ".cwd")

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

# Clean up stale injected flag from a prior crashed session
rm -f "$SESSION_PATH/injected"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Git state capture ─────────────────────────────────────────────────────────

IS_GIT_REPO=false
BRANCH=""
SHA=""
COMMITS_JSON="[]"
UNCOMMITTED=0
STASH_COUNT=0
UPSTREAM_BEHIND=0

if [[ -n "$CWD" ]] && is_git_worktree "$CWD"; then
  IS_GIT_REPO=true

  BRANCH=$(git_branch_of "$CWD" || echo "")
  SHA=$(git_short_sha_of "$CWD" || echo "")

  # Last 5 commits as a JSON array of one-liner strings
  COMMITS_JSON=$(run_with_timeout 1 -- git -C "$CWD" log --oneline -5 2>/dev/null \
    | jq -R . | jq -s . 2>/dev/null || echo "[]")

  # Count uncommitted (staged + unstaged) files
  UNCOMMITTED=$(git_uncommitted_count_of "$CWD" || echo "0")

  # Count stash entries
  STASH_COUNT=$(run_with_timeout 1 -- git -C "$CWD" stash list 2>/dev/null | wc -l | tr -d ' ' || echo "0")

  # How far behind upstream (0 if no upstream configured)
  # shellcheck disable=SC1083  # @{u} is git upstream ref syntax, not a shell brace expression
  UPSTREAM_BEHIND=$(run_with_timeout 1 -- git -C "$CWD" rev-list --count HEAD..@{u} 2>/dev/null || echo "0")
fi

# ── Write git-context.json ────────────────────────────────────────────────────

# Use jq -n for full construction — avoids heredoc variable interpolation
# which can produce invalid JSON if numeric fields contain unexpected output.
jq -n \
  --arg     branch       "$BRANCH" \
  --arg     sha          "$SHA" \
  --argjson commits      "$COMMITS_JSON" \
  --argjson uncommitted  "$UNCOMMITTED" \
  --argjson stash        "$STASH_COUNT" \
  --argjson behind       "$UPSTREAM_BEHIND" \
  --argjson is_git       "$IS_GIT_REPO" \
  --arg     cwd          "$CWD" \
  --arg     captured_at  "$TIMESTAMP" \
  '{
    branch:           $branch,
    sha:              $sha,
    commits:          $commits,
    uncommitted_count: $uncommitted,
    stash_count:      $stash,
    upstream_behind:  $behind,
    is_git_repo:      $is_git,
    cwd:              $cwd,
    captured_at:      $captured_at
  }' > "$SESSION_PATH/git-context.json"

# ── Write meta.json ───────────────────────────────────────────────────────────

if [[ -n "$CWD" ]]; then
  PROJECT_DIR=$(ensure_project_dir "$CWD")
  # Preserve compacted_at from the prior session if present
  PRIOR_COMPACTED_AT=""
  if [[ -f "$PROJECT_DIR/meta.json" ]]; then
    PRIOR_COMPACTED_AT=$(jq -r '.compacted_at // empty' "$PROJECT_DIR/meta.json" 2>/dev/null || echo "")
  fi
  META_TMP=$(mktemp "$PROJECT_DIR/.meta.XXXXXX")
  trap 'rm -f "$META_TMP" 2>/dev/null || true' EXIT
  jq -n \
    --arg cwd          "$CWD" \
    --arg cwd_hash     "$(cwd_hash "$CWD")" \
    --arg last_agent   "$DOFLOW_AGENT" \
    --arg last_active  "$TIMESTAMP" \
    --arg compacted_at "${PRIOR_COMPACTED_AT:-}" \
    --arg branch       "${BRANCH:-}" \
    '{
      cwd:          $cwd,
      cwd_hash:     $cwd_hash,
      last_agent:   $last_agent,
      last_active:  $last_active,
      compacted_at: (if $compacted_at == "" then null else $compacted_at end),
      branch:       $branch
    }' > "$META_TMP" && mv "$META_TMP" "$PROJECT_DIR/meta.json" \
    || rm -f "$META_TMP" 2>/dev/null || true
fi

# ── Append to sessions.log ────────────────────────────────────────────────────

mkdir -p "$(dirname "$SESSIONS_LOG")"
echo "$TIMESTAMP START $SESSION_ID ${CWD:-unknown}" >> "$SESSIONS_LOG"

exit 0
