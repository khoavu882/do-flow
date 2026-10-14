#!/usr/bin/env bash
# post-compact.sh — PostCompact hook (IC-011)
#
# Records the AI-generated compact_summary (from stdin JSON) in the summary scope of the session
# that produced it: summaries/<worktreeKey>/<run>/<lineage>/summary.md, through
# doflow_summary_write. Rule compact-store.summary decides whether this session records at all (a
# `solo` lineage records nothing, DEC-013); rule compact-meta.meta decides whether meta.json's
# compacted_at is updated (the default main lineage only). The retired project-level
# last-compact-summary.md is never written.
#
# Atomic write: the store writes a .summary.XXXXXX temp file in the scope, then renames it.
# Must complete in <200ms. Must never exit non-zero or block.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)

SESSION_ID=$(json_field "$INPUT" ".session_id")
CWD=$(json_field "$INPUT" ".cwd")
TRIGGER=$(json_field "$INPUT" ".trigger")
COMPACT_SUMMARY=$(json_field "$INPUT" ".compact_summary")

# Guard: nothing useful to save if we don't know where we are
[[ -z "$CWD" ]] && exit 0

# Guard: an empty summary would write a frontmatter-only file that would be
# injected as empty context on the next session's first prompt — useless noise, skip it.
[[ -z "$COMPACT_SUMMARY" ]] && exit 0

# The identity, the rule table and the store come from the Canonical Policy Library. An install
# missing any of them records nothing: a broken install cannot write a summary to the wrong scope.
POLICIES="$(dirname "$0")/../../.doflow/shared/hooks/policies"
declare -F doflow_identity >/dev/null 2>&1 || exit 0
[[ -f "$POLICIES/emission-rules.sh" && -f "$POLICIES/summary-store.sh" ]] || exit 0
# shellcheck source=/dev/null
. "$POLICIES/emission-rules.sh"
# shellcheck source=/dev/null
. "$POLICIES/summary-store.sh"

doflow_identity "$SESSION_ID" "$CWD"

DF_ACTION=skip
doflow_emission_rule compact-store.summary "$DF_ID_ROLE:$DF_ID_KIND"
[[ "$DF_ACTION" == write ]] || exit 0

# Read current branch for frontmatter metadata (best-effort, empty is fine)
BRANCH=$(run_with_timeout 5 -- git -C "$CWD" branch --show-current 2>/dev/null || echo "")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

doflow_summary_write "$DF_ID_WORKTREE" "$DF_ID_RUN" "$DF_ID_LINEAGE" "${DF_ID_ATTEMPT:-}" \
  "$TIMESTAMP" "$SESSION_ID" "$TRIGGER" "$BRANCH" "$DF_ID_ROLE" "$COMPACT_SUMMARY" || exit 0

DF_ACTION=skip
doflow_emission_rule compact-meta.meta "$DF_ID_ROLE:$DF_ID_KIND"
[[ "$DF_ACTION" == write ]] || exit 0

PROJECT_DIR=$(ensure_project_dir "$CWD")
META_TMP=""
_cleanup() { rm -f "$META_TMP" 2>/dev/null || true; }
trap _cleanup EXIT

# Update meta.json compacted_at (field-merge — do not overwrite other fields)
if [[ -f "$PROJECT_DIR/meta.json" ]]; then
  META_TMP=$(mktemp "$PROJECT_DIR/.meta.XXXXXX")
  if jq --arg ts "$TIMESTAMP" '.compacted_at = $ts' "$PROJECT_DIR/meta.json" > "$META_TMP"; then
    mv "$META_TMP" "$PROJECT_DIR/meta.json"
    META_TMP=""  # already moved; _cleanup should not attempt to rm it
  fi
fi

exit 0
