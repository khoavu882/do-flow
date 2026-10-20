#!/usr/bin/env bash
# IC-001 (feature 116): shared PreCompact text builder; sourced, not executed.

doflow_compact_text() {
  local CWD="${1:-}"
  local preserve branch sha uncommitted recent text

  preserve='Preserve: decisions made, files modified, open questions, planned next steps, acceptance criteria and pending verification of the active task.'

  if [[ -n "$CWD" ]] && is_git_worktree "$CWD"; then
    branch=$(git_branch_of "$CWD" || echo "")
    sha=$(git_short_sha_of "$CWD" || echo "")
    uncommitted=$(git_uncommitted_count_of "$CWD" || echo "0")
    recent=$(run_with_timeout 1 -- git -C "$CWD" log --format="%h %s" -2 2>/dev/null \
      | awk 'NR>1{printf " | "}{printf "%s",$0}' || echo "")

    text=$(printf '%s\nInclude in compact summary:\n- git branch: %s sha: %s\n- uncommitted files: %s\n- cwd: %s\n- recent commits: %s' \
      "$preserve" "${branch:-unknown}" "${sha:-unknown}" "$uncommitted" "${CWD:-unknown}" "${recent:-none}")
  else
    text=$(printf '%s\nInclude in compact summary:\n- cwd: %s (not a git repository)' \
      "$preserve" "${CWD:-unknown}")
  fi

  DF_COMPACT_TEXT="${text:0:490}"
  return 0
}
