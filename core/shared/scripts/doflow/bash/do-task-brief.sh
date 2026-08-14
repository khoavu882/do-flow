#!/usr/bin/env bash
# do-task-brief.sh — compose one task's brief or a group's brief into files the implementer reads.
#
# A doflow task is a single checklist line, and plan.md has no "global constraints"
# section, so a brief cannot be sliced out of one place the way it can when tasks are
# prose sections. It is COMPOSED from six sources (design §5.2):
#
#   where this fits    plan.md §1 Approach + the task's own "### Phase X" heading
#   requirements       requirement.md §3 FR detail for the FRs the task's [US#] traces
#   why                requirement.md §2 story text for that [US#]
#   global constraints requirement.md §4 — ALL NFR detail; NFRs bind every task
#   component boundary design.md §3 detail for components serving those FRs
#   verification bar   plan.md §7 rows for those FRs + the phase's Checkpoints line
#
# The brief becomes the single source of the task's exact values, so no subagent needs
# to open the plan — which is what keeps the context discipline real rather than
# aspirational.
#
# Sections are located by HEADING TEXT, never by ordinal, so inserting a section does
# not silently shift the parse. Anything that could not be resolved is reported in
# `missing[]` rather than yielding a quietly thin brief the implementer cannot tell
# is incomplete.
#
# Usage:
#   do-task-brief.sh --task=<id> [--slug=<slug>] [--json]
#   do-task-brief.sh --group=<phase>:<owner> --tasks=<id,id,...> [--slug=<slug>] [--json]
#
# Emits for task mode:  {path, lines, traced:{story, frs[], nfrs[], components[]}, missing[]}
# Emits for group mode: {path, lines, tasks[], traced:{frs[], nfrs[], components[]}, missing[]}

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
    --slug=*)
      slug_override="${arg#--slug=}"
      ;;
    --json)   ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","path":null}\n'
  exit 0
fi

validate_id() {
  local id="$1"
  case "$id" in
    */*|*\\*|..*|*..|"") return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$mode" = "group" ]; then
  if [ -z "$group_id" ] || [ -z "$tasks_csv" ]; then
    jq -n '{error:"missing-group-args", hint:"pass --group=<phase>:<owner> and --tasks=<id,id,...>"}'
    exit 2
  fi
  if ! validate_id "$group_id"; then
    jq -n --arg id "$group_id" '{error:"invalid-group", group_id:$id, hint:"a group id must be phase-dotted with a safe owner name"}'
    exit 2
  fi
elif [ "$mode" = "task" ]; then
  if [ -z "$task_id" ]; then
    jq -n '{error:"missing-task", hint:"pass --task=<id>, e.g. --task=A.1"}'
    exit 2
  fi
  if ! validate_id "$task_id"; then
    jq -n --arg id "$task_id" '{error:"invalid-task", task_id:$id, hint:"a task id is phase-dotted, e.g. A.1 — no path separators"}'
    exit 2
  fi
else
  jq -n '{error:"missing-task", hint:"pass --task=<id>, e.g. --task=A.1"}'
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
paths=""
if [ "$mode" = "group" ]; then
  paths="$(bash "$script_dir/do-exec-paths.sh" --group="$group_id" --tasks="$tasks_csv" ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
  brief_rel="$(printf '%s' "$paths" | jq -r '.group_brief // empty')"
else
  paths="$(bash "$script_dir/do-exec-paths.sh" --task="$task_id" ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
  brief_rel="$(printf '%s' "$paths" | jq -r '.brief // empty')"
fi

if [ -z "$brief_rel" ]; then
  printf '%s\n' "${paths:-{\"error\":\"paths-unresolved\"}}"
  exit 2
fi

resolved="$(bash "$script_dir/do-paths.sh" --json ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
repo_root="$(printf '%s' "$resolved" | jq -r '.repo_root // empty')"
plan_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.plan // empty')"
req_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.requirement // empty')"
des_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.design // empty')"
brief_abs="$repo_root/$brief_rel"

missing=()
[ -f "$plan_abs" ] || missing+=("plan.md not readable")
[ -f "$req_abs" ]  || missing+=("requirement.md not readable")
[ -f "$des_abs" ]  || missing+=("design.md not readable")

if [ ! -f "$plan_abs" ]; then
  jq -n --arg p "$brief_rel" '{error:"no-plan", path:$p, hint:"a brief is composed from plan.md; there is nothing to compose"}'
  exit 2
fi

# ── section extractor: by heading TEXT, stopping at the next same-level heading ─
section() { # section <file> <heading-regex>
  awk -v want="$2" '
    $0 ~ want { inside = 1; next }
    inside && /^## / { exit }
    inside { print }
  ' "$1"
}

detail_for() { # detail_for <file> <section-regex> <id>
  section "$1" "$2" | awk -v id="$3" '
    $0 ~ "^- \\*\\*" id "([^A-Za-z0-9]|$)" { inside = 1; print; next }
    inside && /^- \*\*/ { exit }
    inside { print }
  '
}

to_json_array() {
  local input="${1:-}"
  if [ -z "$input" ]; then
    echo '[]'
  else
    printf '%s\n' "$input" | sed '/^$/d' | jq -R . | jq -s 'if length == 0 then [] else . end'
  fi
}

nfrs=""
if [ -f "$req_abs" ]; then
  nfrs="$(section "$req_abs" '^## 4[.]' | grep -o '^| *NFR-[0-9]*' | tr -d '| ')"
fi

# Parse task list
task_ids=()
if [ "$mode" = "group" ]; then
  IFS=',' read -ra raw_task_ids <<< "$tasks_csv"
  for tid in "${raw_task_ids[@]}"; do
    tid="$(echo "$tid" | tr -d ' ')"
    [ -n "$tid" ] && task_ids+=("$tid")
  done
else
  task_ids=("$task_id")
fi

# In single task mode: check if task exists
if [ "$mode" = "task" ]; then
  task_line="$(awk -v id="$task_id" '
    $0 ~ "^- \\[[ x]\\] " id "([^0-9]|$)" { print; exit }' "$plan_abs")"
  if [ -z "$task_line" ]; then
    jq -n --arg id "$task_id" '{error:"task-not-found", task_id:$id, hint:"no \"- [ ] <id>\" line in plan.md section 8"}'
    exit 3
  fi
  phase_heading="$(awk -v id="$task_id" '
    /^### Phase / { h = $0 }
    $0 ~ "^- \\[[ x]\\] " id "([^0-9]|$)" { print h; exit }' "$plan_abs")"
  phase_letter="$(printf '%s' "$phase_heading" | awk '{print $3}')"

  story="$(printf '%s' "$task_line" | grep -o '\[US[0-9]\+\]' | head -1 | tr -d '[]')"
  files_field="$(printf '%s' "$task_line" | sed -n 's/.*files: \([^;]*\).*/\1/p')"
  [ -n "$story" ] || missing+=("task line carries no [US#] trace")

  frs=""
  if [ -n "$story" ] && [ -f "$req_abs" ]; then
    frs="$(section "$req_abs" '^## 3[.]' | awk -F'|' -v s="$story" '
      /^\| *FR-/ {
        id = $2; sto = $4
        gsub(/^[ \t]+|[ \t]+$/, "", id); gsub(/^[ \t]+|[ \t]+$/, "", sto)
        if (sto == s) print id
      }')"
  fi
  [ -n "$frs" ] || missing+=("no FR in requirement.md section 3 traces to ${story:-this task}")

  components=""
  if [ -n "$frs" ] && [ -f "$des_abs" ]; then
    components="$(for fr in $frs; do
      section "$des_abs" '^## 3[.]' | awk -F'|' -v fr="$fr" '
        /^\| *CMP/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
    done | sort -u)"
  fi

  # Compose brief
  write_ok=1
  {
    echo "# Task brief: $task_id"
    echo
    echo "> Composed from plan.md, requirement.md and design.md. This brief is your requirements —"
    echo "> use the exact values it gives, verbatim. You do not need to open the plan."
    echo
    echo "## The task"
    echo
    echo "${task_line#- \[ \] }"
    echo
    [ -n "$phase_heading" ] && { echo "Phase: ${phase_heading#\#\#\# }"; echo; }
    [ -n "$files_field" ] && { echo "Files you own: $files_field"; echo; }

    echo "## Where this fits"
    echo
    section "$plan_abs" '^## 1[.]' | sed '/^$/d' | head -8
    echo

    if [ -n "$story" ] && [ -f "$req_abs" ]; then
      echo "## Why (user story)"
      echo
      section "$req_abs" '^## 2[.]' | awk -v s="$story" '
        $0 ~ ("^- \\*\\*" s "([^0-9]|$)") { inside = 1; sub(/^- /, ""); print; next }
        inside && /^- \*\*/ { exit }
        inside { print }' || true
      echo
    fi

    if [ -n "$frs" ]; then
      echo "## Requirements — build exactly these"
      echo
      for fr in $frs; do detail_for "$req_abs" '^## 3[.]' "$fr"; done
      echo
    fi

    if [ -f "$req_abs" ]; then
      echo "## Global constraints — these bind every task"
      echo
      section "$req_abs" '^## 4[.]' | awk '/^- \*\*NFR-/ { p = 1 } p' | sed '/^$/d'
      echo
    fi

    if [ -n "$components" ]; then
      echo "## Component boundary"
      echo
      printf '%s\n' "$components" | while read -r cmp; do
        [ -n "$cmp" ] && detail_for "$des_abs" '^## 3[.]' "$cmp"
      done
      echo
    fi

    echo "## Verification bar"
    echo
    for fr in $frs; do
      section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true
    done
    [ -n "$phase_letter" ] && grep -F "After Phase $phase_letter:" "$plan_abs" || true
    echo
  } > "$brief_abs" || write_ok=0

  if [ "${write_ok:-1}" -eq 0 ] || [ ! -s "$brief_abs" ]; then
    jq -n --arg path "$brief_rel" \
      '{error:"write-failed", path:$path, hint:"the task brief could not be written — check the workspace is writable"}'
    exit 2
  fi

  lines="$(wc -l < "$brief_abs" | tr -d ' ')"

  jq -n \
    --arg path "$brief_rel" \
    --argjson lines "${lines:-0}" \
    --arg story "$story" \
    --argjson frs "$(to_json_array "$frs")" \
    --argjson nfrs "$(to_json_array "$nfrs")" \
    --argjson components "$(to_json_array "$components")" \
    --argjson missing "$(to_json_array "$(printf '%s\n' "${missing[@]+"${missing[@]}"}" | sed '/^$/d')")" \
    '{path:$path, lines:$lines,
      traced:{story:(if $story=="" then null else $story end), frs:$frs, nfrs:$nfrs, components:$components},
      missing:$missing}'
  exit 0

else
  # Group mode
  num_tasks="${#task_ids[@]}"
  
  # For each task in group, collect details into arrays
  declare -a task_lines=()
  declare -a task_phases=()
  declare -a task_phase_letters=()
  declare -a task_stories=()
  declare -a task_files=()
  declare -a task_fr_lists=()
  all_frs_raw=""
  all_comps_raw=""

  for tid in "${task_ids[@]}"; do
    t_line="$(awk -v id="$tid" '
      $0 ~ "^- \\[[ x]\\] " id "([^0-9]|$)" { print; exit }' "$plan_abs")"
    if [ -z "$t_line" ]; then
      missing+=("$tid: task line not found in plan.md")
      task_lines+=("")
      task_phases+=("")
      task_phase_letters+=("")
      task_stories+=("")
      task_files+=("")
      task_fr_lists+=("")
      continue
    fi

    t_phase="$(awk -v id="$tid" '
      /^### Phase / { h = $0 }
      $0 ~ "^- \\[[ x]\\] " id "([^0-9]|$)" { print h; exit }' "$plan_abs")"
    t_phase_let="$(printf '%s' "$t_phase" | awk '{print $3}')"
    t_files="$(printf '%s' "$t_line" | sed -n 's/.*files: \([^;]*\).*/\1/p')"
    t_story="$(printf '%s' "$t_line" | grep -o '\[US[0-9]\+\]' | head -1 | tr -d '[]')"

    [ -n "$t_story" ] || missing+=("$tid: task line carries no [US#] trace")

    t_frs=""
    if [ -n "$t_story" ] && [ -f "$req_abs" ]; then
      t_frs="$(section "$req_abs" '^## 3[.]' | awk -F'|' -v s="$t_story" '
        /^\| *FR-/ {
          id = $2; sto = $4
          gsub(/^[ \t]+|[ \t]+$/, "", id); gsub(/^[ \t]+|[ \t]+$/, "", sto)
          if (sto == s) print id
        }')"
    fi
    [ -n "$t_frs" ] || missing+=("$tid: no FR in requirement.md section 3 traces to ${t_story:-this task}")

    for f in $t_frs; do
      all_frs_raw="${all_frs_raw}${f}"$'\n'
    done

    task_lines+=("$t_line")
    task_phases+=("$t_phase")
    task_phase_letters+=("$t_phase_let")
    task_stories+=("$t_story")
    task_files+=("$t_files")
    task_fr_lists+=("$t_frs")
  done

  # Union of FRs
  all_frs="$(printf '%s' "$all_frs_raw" | sed '/^$/d' | sort -u)"

  # Union of components serving those FRs
  if [ -n "$all_frs" ] && [ -f "$des_abs" ]; then
    all_comps_raw="$(for fr in $all_frs; do
      section "$des_abs" '^## 3[.]' | awk -F'|' -v fr="$fr" '
        /^\| *CMP/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
    done | sort -u)"
  fi

  write_ok=1
  if [ "$num_tasks" -eq 1 ]; then
    # Single-task group: byte-identical output to --task=
    t_id="${task_ids[0]}"
    t_line="${task_lines[0]}"
    t_phase="${task_phases[0]}"
    t_phase_let="${task_phase_letters[0]}"
    t_story="${task_stories[0]}"
    t_files="${task_files[0]}"
    t_frs="${task_fr_lists[0]}"

    t_comps=""
    if [ -n "$t_frs" ] && [ -f "$des_abs" ]; then
      t_comps="$(for fr in $t_frs; do
        section "$des_abs" '^## 3[.]' | awk -F'|' -v fr="$fr" '
          /^\| *CMP/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
      done | sort -u)"
    fi

    {
      echo "# Task brief: $t_id"
      echo
      echo "> Composed from plan.md, requirement.md and design.md. This brief is your requirements —"
      echo "> use the exact values it gives, verbatim. You do not need to open the plan."
      echo
      echo "## The task"
      echo
      echo "${t_line#- \[ \] }"
      echo
      [ -n "$t_phase" ] && { echo "Phase: ${t_phase#\#\#\# }"; echo; }
      [ -n "$t_files" ] && { echo "Files you own: $t_files"; echo; }

      echo "## Where this fits"
      echo
      section "$plan_abs" '^## 1[.]' | sed '/^$/d' | head -8
      echo

      if [ -n "$t_story" ] && [ -f "$req_abs" ]; then
        echo "## Why (user story)"
        echo
        section "$req_abs" '^## 2[.]' | awk -v s="$t_story" '
          $0 ~ ("^- \\*\\*" s "([^0-9]|$)") { inside = 1; sub(/^- /, ""); print; next }
          inside && /^- \*\*/ { exit }
          inside { print }' || true
        echo
      fi

      if [ -n "$t_frs" ]; then
        echo "## Requirements — build exactly these"
        echo
        for fr in $t_frs; do detail_for "$req_abs" '^## 3[.]' "$fr"; done
        echo
      fi

      if [ -f "$req_abs" ]; then
        echo "## Global constraints — these bind every task"
        echo
        section "$req_abs" '^## 4[.]' | awk '/^- \*\*NFR-/ { p = 1 } p' | sed '/^$/d'
        echo
      fi

      if [ -n "$t_comps" ]; then
        echo "## Component boundary"
        echo
        printf '%s\n' "$t_comps" | while read -r cmp; do
          [ -n "$cmp" ] && detail_for "$des_abs" '^## 3[.]' "$cmp"
        done
        echo
      fi

      echo "## Verification bar"
      echo
      for fr in $t_frs; do
        section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true
      done
      [ -n "$t_phase_let" ] && grep -F "After Phase $t_phase_let:" "$plan_abs" || true
      echo
    } > "$brief_abs" || write_ok=0

  else
    # Multi-task group: shared preamble once + one block per task
    {
      echo "# Group brief: $group_id"
      echo
      echo "> Composed from plan.md, requirement.md and design.md. This brief covers multiple tasks that share an owner."
      echo
      echo "## Shared context"
      echo
      echo "### Where this fits"
      echo
      section "$plan_abs" '^## 1[.]' | sed '/^$/d' | head -8
      echo

      if [ -f "$req_abs" ]; then
        echo "### Global constraints — these bind every task"
        echo
        section "$req_abs" '^## 4[.]' | awk '/^- \*\*NFR-/ { p = 1 } p' | sed '/^$/d'
        echo
      fi

      if [ -n "$all_comps_raw" ]; then
        echo "### Component boundary"
        echo
        printf '%s\n' "$all_comps_raw" | while read -r cmp; do
          [ -n "$cmp" ] && detail_for "$des_abs" '^## 3[.]' "$cmp"
        done
        echo
      fi

      echo "## Task order"
      echo
      task_order=""
      for tid in "${task_ids[@]}"; do
        if [ -n "$task_order" ]; then
          task_order="$task_order → $tid"
        else
          task_order="$tid"
        fi
      done
      echo "$task_order   (write each task's report before starting the next)"
      echo

      for idx in "${!task_ids[@]}"; do
        tid="${task_ids[$idx]}"
        t_line="${task_lines[$idx]}"
        t_phase="${task_phases[$idx]}"
        t_phase_let="${task_phase_letters[$idx]}"
        t_story="${task_stories[$idx]}"
        t_files="${task_files[$idx]}"
        t_frs="${task_fr_lists[$idx]}"

        echo "## Task $tid"
        echo
        echo "${t_line#- \[ \] }"
        echo

        if [ -n "$t_story" ] && [ -f "$req_abs" ]; then
          echo "### Why (user story)"
          echo
          section "$req_abs" '^## 2[.]' | awk -v s="$t_story" '
            $0 ~ ("^- \\*\\*" s "([^0-9]|$)") { inside = 1; sub(/^- /, ""); print; next }
            inside && /^- \*\*/ { exit }
            inside { print }' || true
          echo
        fi

        if [ -n "$t_frs" ]; then
          echo "### Requirements — build exactly these"
          echo
          for fr in $t_frs; do detail_for "$req_abs" '^## 3[.]' "$fr"; done
          echo
        fi

        if [ -n "$t_files" ]; then
          echo "### Files you own"
          echo
          echo "$t_files"
          echo
        fi

        echo "### Verification bar"
        echo
        for fr in $t_frs; do
          section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true
        done
        [ -n "$t_phase_let" ] && grep -F "After Phase $t_phase_let:" "$plan_abs" || true
        echo
      done
    } > "$brief_abs" || write_ok=0
  fi

  if [ "${write_ok:-1}" -eq 0 ] || [ ! -s "$brief_abs" ]; then
    jq -n --arg path "$brief_rel" \
      '{error:"write-failed", path:$path, hint:"the task brief could not be written — check the workspace is writable"}'
    exit 2
  fi

  lines="$(wc -l < "$brief_abs" | tr -d ' ')"

  jq -n \
    --arg path "$brief_rel" \
    --argjson lines "${lines:-0}" \
    --argjson frs "$(to_json_array "$all_frs")" \
    --argjson nfrs "$(to_json_array "$nfrs")" \
    --argjson components "$(to_json_array "$all_comps_raw")" \
    --argjson missing "$(to_json_array "$(printf '%s\n' "${missing[@]+"${missing[@]}"}" | sed '/^$/d')")" \
    '{path:$path, lines:$lines, tasks:$ARGS.positional,
      traced:{frs:$frs, nfrs:$nfrs, components:$components},
      missing:$missing}' \
    --args "${task_ids[@]}"
  exit 0
fi
