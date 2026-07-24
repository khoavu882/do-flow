#!/usr/bin/env bash
# post-compact.sh — PostCompact hook
#
# Saves the AI-generated compact_summary (from stdin JSON) to a project-scoped
# file. user-prompt-submit.sh reads and injects it directly on the next session's
# first prompt — no manual restore command required.
#
# Atomic write: mktemp → populate → mv ensures readers never see partial content.
# Multi-session safe: project directory is keyed by cwd hash, not session_id.
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

PROJECT_DIR=$(ensure_project_dir "$CWD")

# Read current branch for frontmatter metadata (best-effort, empty is fine)
BRANCH=$(timeout 1 git -C "$CWD" branch --show-current 2>/dev/null || echo "")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Single cleanup function covers both temp files — a second trap() call would
# silently replace the first, leaving the earlier temp file unguarded on failure.
TMP=""
META_TMP=""
_cleanup() { rm -f "$TMP" "$META_TMP" 2>/dev/null || true; }
trap _cleanup EXIT

# Atomic write: write to a temp file then rename.
TMP=$(mktemp "$PROJECT_DIR/.last-compact-summary.XXXXXX")
cat > "$TMP" <<EOF
---
compacted_at: ${TIMESTAMP}
session_id: ${SESSION_ID:-unknown}
trigger: ${TRIGGER:-unknown}
branch: ${BRANCH:-unknown}
---

${COMPACT_SUMMARY}
EOF
mv "$TMP" "$PROJECT_DIR/last-compact-summary.md"
TMP=""  # already moved; _cleanup should not attempt to rm it

# Update meta.json compacted_at (field-merge — do not overwrite other fields)
if [[ -f "$PROJECT_DIR/meta.json" ]]; then
  META_TMP=$(mktemp "$PROJECT_DIR/.meta.XXXXXX")
  if jq --arg ts "$TIMESTAMP" '.compacted_at = $ts' "$PROJECT_DIR/meta.json" > "$META_TMP"; then
    mv "$META_TMP" "$PROJECT_DIR/meta.json"
    META_TMP=""  # already moved; _cleanup should not attempt to rm it
  fi
fi

exit 0
