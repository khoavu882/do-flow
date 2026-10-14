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

BRANCH=""
SHA=""
UNCOMMITTED=0

if [[ -n "$CWD" ]] && is_git_worktree "$CWD"; then
  BRANCH=$(git_branch_of "$CWD" || echo "")
  SHA=$(git_short_sha_of "$CWD" || echo "")
  UNCOMMITTED=$(git_uncommitted_count_of "$CWD" || echo "0")

  # Last 2 commits (short SHA only for brevity) — keeps output under 500 chars
  RECENT=$(run_with_timeout 1 -- git -C "$CWD" log --format="%h %s" -2 2>/dev/null \
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
