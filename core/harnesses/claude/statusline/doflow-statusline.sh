#!/usr/bin/env bash
# doflow-statusline — Claude Code status line fed by DoFlow's neutral state.
#
# Claude Code pipes one session-state JSON document to stdin; whatever this script prints becomes
# the persistent status row. Everything here is best-effort: any failure prints the static prefix
# and exits 0, because a broken status line must never break the session.
#
# Rendered segments (space-separated, dash-joined):
#   branch   — current git branch, when stdin carries a git-capable cwd
#   task     — active task id from .doflow/state/orchestration/ (project scope)
#   readiness— last recorded readiness verdict for that task

set -euo pipefail

input=$(cat)

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
branch=""
task=""

if [[ -n "$cwd" && -d "$cwd/.git" ]] || git -C "${cwd:-.}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "${cwd:-.}" branch --show-current 2>/dev/null || true)
fi

state_root=".doflow/state"
if [[ -n "$cwd" && -d "$cwd/$state_root" ]]; then
  state_root="$cwd/$state_root"
elif [[ ! -d "$state_root" ]]; then
  state_root=""
fi

if [[ -n "$state_root" ]]; then
  cursor=$(ls -t "$state_root"/orchestration/*.json 2>/dev/null | head -1 || true)
  if [[ -n "$cursor" ]]; then
    task=$(jq -r '.taskId // empty' "$cursor" 2>/dev/null || true)
  fi
fi

segments=()
[[ -n "$branch" ]] && segments+=("$branch")
[[ -n "$task" ]] && segments+=("task:$task")

if [[ ${#segments[@]} -eq 0 ]]; then
  echo "doflow"
else
  printf 'doflow '
  printf '%s ' "${segments[@]:-}"
  printf '\n'
fi
