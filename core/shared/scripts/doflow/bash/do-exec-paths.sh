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
# JSON and exits 0, except the explicit no-feature and bad-input gates (exit 2).
#
# Usage:
#   do-exec-paths.sh --task=<id> [--slug=<slug>] [--json]
#   do-exec-paths.sh --group=<phase>:<owner> --tasks=<id,id,...> [--slug=<slug>] [--json]
#
# Emits for task mode: {feature_dir, workspace, brief, report, task_id}
# Emits for group mode: {feature_dir, workspace, group_id, group_brief, reports[]}

set -uo pipefail

task_id=""
group_id=""
tasks_csv=""
slug_override=""
mode=""
for arg in "$@"; do
  case "$arg" in
    --task=*)
      task_id="${arg#--task=}"
      mode="task"
      ;;
    --group=*)
      group_id="${arg#--group=}"
      mode="group"
      ;;
    --tasks=*)
      tasks_csv="${arg#--tasks=}"
      ;;
    --slug=*) slug_override="${arg#--slug=}" ;;
    --json)   ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","workspace":null}\n'
  exit 0
fi

# Validate mode and required arguments
if [ "$mode" = "group" ]; then
  if [ -z "$group_id" ] || [ -z "$tasks_csv" ]; then
    jq -n '{error:"missing-group-args", hint:"pass --group=<phase>:<owner> and --tasks=<id,id,...>"}'
    exit 2
  fi
elif [ "$mode" = "task" ]; then
  if [ -z "$task_id" ]; then
    jq -n '{error:"missing-task", hint:"pass --task=<id>, e.g. --task=A.1"}'
    exit 2
  fi
else
  jq -n '{error:"missing-mode", hint:"pass either --task=<id> or --group=<phase>:<owner> and --tasks=<id,id,...>"}'
  exit 2
fi

# A task id or group owner becomes part of a filename, so anything that could escape
# the workspace or collide across directories is rejected rather than sanitized.
# This applies to both modes: group_id contains phase:owner, and each task_id does too.
validate_id() {
  local id="$1"
  case "$id" in
    */*|*\\*|..*|*..|"") return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$mode" = "task" ]; then
  if ! validate_id "$task_id"; then
    jq -n --arg id "$task_id" '{error:"invalid-task", task_id:$id, hint:"a task id is phase-dotted, e.g. A.1 — no path separators"}'
    exit 2
  fi
fi

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

if [ "$mode" = "task" ]; then
  # Task mode: unchanged from original behavior
  jq -n \
    --arg feature_dir "$feature_dir" \
    --arg workspace "$workspace_rel" \
    --arg brief "$workspace_rel/task-$task_id-brief.md" \
    --arg report "$workspace_rel/task-$task_id-report.md" \
    --arg task_id "$task_id" \
    '{feature_dir:$feature_dir, workspace:$workspace, brief:$brief, report:$report, task_id:$task_id}'
  exit 0
fi

# Group mode: process group_id and tasks_csv
if ! validate_id "$group_id"; then
  jq -n --arg id "$group_id" '{error:"invalid-group", group_id:$id, hint:"a group id must be phase-dotted with a safe owner name"}'
  exit 2
fi

# Validate each task ID in the CSV
IFS=',' read -ra task_ids <<< "$tasks_csv"
for tid in "${task_ids[@]}"; do
  # Trim whitespace
  tid="${tid// /}"
  if ! validate_id "$tid"; then
    jq -n --arg id "$tid" '{error:"invalid-task", task_id:$id, hint:"a task id is phase-dotted, e.g. A.1 — no path separators"}'
    exit 2
  fi
done

# Build clean task ids
clean_task_ids=()
for tid in "${task_ids[@]}"; do
  tid="${tid// /}"
  [ -n "$tid" ] && clean_task_ids+=("$tid")
done

jq -n \
  --arg feature_dir "$feature_dir" \
  --arg workspace "$workspace_rel" \
  --arg group_id "$group_id" \
  --arg group_brief "$workspace_rel/group-${group_id//:/-}-brief.md" \
  '{
    feature_dir: $feature_dir,
    workspace: $workspace,
    group_id: $group_id,
    group_brief: $group_brief,
    reports: [$ARGS.positional[] | $workspace + "/task-" + . + "-report.md"]
  }' \
  --args "${clean_task_ids[@]}"

exit 0
