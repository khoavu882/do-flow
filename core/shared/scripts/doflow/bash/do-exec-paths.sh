#!/usr/bin/env bash
# do-exec-paths.sh — resolve the execution workspace and one task's artifact paths.
#
# The single source of truth for where a task's brief, report, and review packages
# live, so do-task-brief.sh, do-review-package.sh and the dispatching skill cannot
# drift to different directories. Artifacts sit inside the feature's own directory
# (design §5.3) rather than a second workspace concept: the resolver already derives
# that directory, and a third bookkeeping location would only invite confusion with
# the install ledger.
#
# Delegates feature resolution to do-paths.sh — it never re-derives a branch, a slug,
# or a feature number itself. Reads no plan content and touches no git state.
#
# Fail-open like the rest of this layer: on any resolution problem it still emits
# JSON and exits 0, except the explicit no-feature and bad-task gates (exit 2).
#
# Usage:
#   do-exec-paths.sh --task=<id> [--slug=<slug>] [--json]
#
# Emits: {feature_dir, workspace, brief, report, task_id}

set -uo pipefail

task_id=""
slug_override=""
for arg in "$@"; do
  case "$arg" in
    --task=*) task_id="${arg#--task=}" ;;
    --slug=*) slug_override="${arg#--slug=}" ;;
    --json)   ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","workspace":null}\n'
  exit 0
fi

if [ -z "$task_id" ]; then
  jq -n '{error:"missing-task", hint:"pass --task=<id>, e.g. --task=A.1"}'
  exit 2
fi

# A task id becomes a filename, so anything that could escape the workspace or
# collide across directories is rejected rather than sanitized — a silently
# rewritten id would put a brief somewhere its reader does not look.
case "$task_id" in
  */*|*\\*|..*|*..|"") jq -n --arg id "$task_id" '{error:"invalid-task", task_id:$id, hint:"a task id is phase-dotted, e.g. A.1 — no path separators"}'; exit 2 ;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd)"
resolver="$script_dir/do-paths.sh"
if [ ! -f "$resolver" ]; then
  jq -n '{error:"resolver-not-found", hint:"do-paths.sh must sit beside this script"}'
  exit 0
fi

resolved="$(bash "$resolver" --json ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
repo_root="$(printf '%s' "$resolved" | jq -r '.repo_root // empty')"
feature_dir="$(printf '%s' "$resolved" | jq -r '.feature_dir // empty')"

if [ -z "$feature_dir" ]; then
  jq -n '{error:"no-active-feature", hint:"checkout a feat/<NNN-slug> branch, or pass --slug=<slug>"}'
  exit 2
fi

workspace_rel="$feature_dir/exec"
mkdir -p "$repo_root/$workspace_rel" 2>/dev/null

jq -n \
  --arg feature_dir "$feature_dir" \
  --arg workspace "$workspace_rel" \
  --arg brief "$workspace_rel/task-$task_id-brief.md" \
  --arg report "$workspace_rel/task-$task_id-report.md" \
  --arg task_id "$task_id" \
  '{feature_dir:$feature_dir, workspace:$workspace, brief:$brief, report:$report, task_id:$task_id}'
exit 0
