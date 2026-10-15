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
  RECENT=$(run_with_timeout 1 -- git -C "$CWD" log --format="%h %s" -2 2>/dev/null | paste -sd ' | ' - || echo "")

  MSG=$(printf 'Compacting session — git branch: %s sha: %s, recent commits: %s, uncommitted files: %s, cwd: %s' \
    "${BRANCH:-unknown}" "${SHA:-unknown}" "${RECENT:-none}" "$UNCOMMITTED" "${CWD:-unknown}")
else
  MSG=$(printf 'Compacting session — cwd: %s (not a git repository)' "${CWD:-unknown}")
fi

MSG="${MSG:0:490}"
jq -n --arg systemMessage "$MSG" '{systemMessage: $systemMessage}'
exit 0
