#!/usr/bin/env bash
# do-task-brief.sh — compose one task's brief or a group's brief into files the implementer reads.
#
# A doflow task is a single checklist line, and plan.md has no "global constraints"
# section, so a brief cannot be sliced out of one place the way it can when tasks are
# prose sections. It is COMPOSED from six sources (design §5.2), plus specs.md when the
# feature has one:
#
#   where this fits    plan.md §1 Approach + the task's own "### Phase X" heading
#   requirements       requirement.md §3 FR detail for the FRs the task's [US#] traces
#   why                requirement.md §2 story text for that [US#]
#   global constraints requirement.md §4 — ALL NFR detail; NFRs bind every task
#   component boundary design.md §3 detail for components serving those FRs
#   verification bar   plan.md §7 rows for those FRs + the phase's Checkpoints line
#   interface contracts specs.md §1 in full — only when the resolver reports has_specs
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
# Every brief also closes with a tier, tools and report-format block (IC-017) that the
# `brief-tools` verb composes from the registries and this machine's probes; this script reads the
# task line's `owner:` and `tier:`, calls the dispatcher once per brief and writes the block plus
# the `*-brief.json` record (IC-018) beside the brief. It names no tool, provider, server or tier.
# It fails open (IC-019): a missing dispatcher, a non-zero exit or output that is not the expected
# JSON gives a "Not generated" line and a static report-format block, a `missing[]` note, no
# record, and the exit status the brief would otherwise have had.
#
# Usage:
#   do-task-brief.sh --task=<id> [--harness=<id>] [--slug=<slug>] [--json]
#   do-task-brief.sh --group=<phase>:<owner> --tasks=<id,id,...> [--harness=<id>] [--slug=<slug>] [--json]
#
# Emits for task mode:  {path, lines, record, traced:{story, frs[], nfrs[], components[]}, missing[]}
# Emits for group mode: {path, lines, record, tasks[], traced:{frs[], nfrs[], components[]}, missing[]}

set -uo pipefail

task_id=""
group_id=""
tasks_csv=""
slug_override=""
harness=""
mode=""

# Shared argument rule: `--flag value` is read like `--flag=value` for the flags named here (do-args.sh).
_da="$(dirname "$0")/do-args.sh"
if [ -r "$_da" ]; then . "$_da"; doflow_normalize_args "--task --group --tasks --slug --harness" "$@"; set -- ${DOFLOW_ARGS[@]+"${DOFLOW_ARGS[@]}"}; fi
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
    --harness=*)
      harness="${arg#--harness=}"
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
  # Not "${paths:-{...}}": bash ends the expansion at the first unescaped `}`, so the default word
  # is `{"error":"paths-unresolved"` and the final `}` is emitted *outside* it — appending a stray
  # brace to $paths whenever $paths is non-empty. Every error passthrough here (a rejected task id,
  # or simply running with no active feature) therefore produced JSON that `jq` refuses to parse.
  if [ -n "$paths" ]; then
    printf '%s\n' "$paths"
  else
    printf '%s\n' '{"error":"paths-unresolved"}'
  fi
  exit 2
fi

resolved="$(bash "$script_dir/do-paths.sh" --json ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
repo_root="$(printf '%s' "$resolved" | jq -r '.repo_root // empty')"
plan_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.plan // empty')"
req_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.requirement // empty')"
des_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.design // empty')"
specs_abs="$repo_root/$(printf '%s' "$resolved" | jq -r '.specs // empty')"
has_specs="$(printf '%s' "$resolved" | jq -r '.has_specs // false')"
brief_abs="$repo_root/$brief_rel"
record_rel="$(printf '%s' "$paths" | jq -r '.brief_record // empty')"
feature_slug="$(printf '%s' "$resolved" | jq -r '.feature_slug // empty')"

# The preamble names specs.md only when this feature actually has one: a legacy-layout brief
# stays byte-identical to what it was before specs.md existed, rather than advertising a source
# the reader will not find a section for.
composed_from="plan.md, requirement.md and design.md"
if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then
  composed_from="plan.md, requirement.md, design.md and specs.md"
fi

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

# ── tier, tools and report format (IC-017 to IC-019) ─────────────────────────
# A task line field is "; <name>: <value>" or "— <name>: <value>"; the value is one safe word.
task_field() { # task_field <task line> <name>
  printf '%s' "$1" | sed -nE "s/.*(; |— )$2: *([A-Za-z0-9_-]+).*/\\2/p"
}

# Sets bt_md and bt_record on success, bt_reason on every failure; never exits.
bt_call() { # bt_call <owner> <tier> <heading level> <task ids>
  bt_md=""; bt_record=""; bt_reason=""
  local dispatcher="$script_dir/../bin/doflow-run" out rc
  if [ -z "$1" ]; then bt_reason="the task line names no owner"; return 0; fi
  if [ ! -f "$dispatcher" ]; then bt_reason="the dispatcher was not found"; return 0; fi
  out="$(cd "${repo_root:-.}" 2>/dev/null && bash "$dispatcher" brief-tools --json --owner "$1" \
    ${2:+--tier "$2"} ${harness:+--harness "$harness"} ${feature_slug:+--slug "$feature_slug"} \
    --heading-level "$3" ${4:+--tasks "$4"} </dev/null 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then bt_reason="brief-tools exited $rc"; return 0; fi
  if ! printf '%s' "$out" | jq -e '(.markdown | type == "string" and length > 0) and (.record | type == "object")' >/dev/null 2>&1; then
    bt_reason="brief-tools printed unparseable output"; return 0
  fi
  bt_md="$(printf '%s' "$out" | jq -r '.markdown')"
  bt_record="$(printf '%s' "$out" | jq -c '.record')"
  return 0
}

# The block for the brief: the verb's markdown, or the static fallback (no tool names).
bt_emit() { # bt_emit <heading level>
  local h="##" who="your report"
  if [ "$1" = "3" ]; then h="###"; who="each task's report"; fi
  if [ -n "$bt_md" ]; then
    printf '%s\n' "$bt_md"
    return 0
  fi
  printf '%s Tier and tools\n\nNot generated: %s. Name the tier and tools in the dispatch.\n\n' "$h" "$bt_reason"
  printf '%s Report format\n\nEnd %s with one line naming every tool and MCP server you used:\n' "$h" "$who"
  printf '%s\n' '`Tools used: <name>[=used|nothing-usable|unavailable|skipped:<reason>], ...`'
}

# Writes the record beside the brief with its tasks filled in; sets record_out to its path, or to ""
# when there is nothing to write or the write failed.
record_out=""
bt_write_record() { # bt_write_record <tasks json>
  record_out=""
  [ -n "$bt_record" ] || return 0
  [ -n "$record_rel" ] || { missing+=("brief-tools: no record path from do-exec-paths.sh"); return 0; }
  if printf '%s' "$bt_record" | jq --argjson tasks "$1" '. + {tasks: $tasks}' > "$repo_root/$record_rel" 2>/dev/null; then
    record_out="$record_rel"
  else
    rm -f "$repo_root/$record_rel" 2>/dev/null
    missing+=("brief-tools: the record could not be written")
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

  bt_call "$(task_field "$task_line" owner)" "$(task_field "$task_line" tier)" 2 "$task_id"
  [ -z "$bt_reason" ] || missing+=("brief-tools: $bt_reason")

  # Compose brief
  write_ok=1
  {
    echo "# Task brief: $task_id"
    echo
    echo "> Composed from $composed_from. This brief is your requirements —"
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

    if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then
      echo "## Interface contracts"
      echo
      # §1 IN FULL, deliberately unfiltered: an IC-### entry carries no FR or component
      # linkage field, so there is nothing to filter it by the way "component boundary"
      # above filters design.md §3 rows on the FRs they name.
      section "$specs_abs" '^## 1[.]' | awk 'NF { p = 1 } p'
      echo
    fi

    echo "## Verification bar"
    echo
    for fr in $frs; do
      section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true
    done
    [ -n "$phase_letter" ] && grep -F "After Phase $phase_letter:" "$plan_abs" || true
    echo
    bt_emit 2
  } > "$brief_abs" || write_ok=0

  if [ "${write_ok:-1}" -eq 0 ] || [ ! -s "$brief_abs" ]; then
    jq -n --arg path "$brief_rel" \
      '{error:"write-failed", path:$path, hint:"the task brief could not be written — check the workspace is writable"}'
    exit 2
  fi

  lines="$(wc -l < "$brief_abs" | tr -d ' ')"

  bt_write_record "$(jq -nc --arg id "$task_id" --arg report "$(printf '%s' "$paths" | jq -r '.report // empty')" '[{id:$id, report:$report}]')"

  jq -n \
    --arg path "$brief_rel" \
    --arg record "$record_out" \
    --argjson lines "${lines:-0}" \
    --arg story "$story" \
    --argjson frs "$(to_json_array "$frs")" \
    --argjson nfrs "$(to_json_array "$nfrs")" \
    --argjson components "$(to_json_array "$components")" \
    --argjson missing "$(to_json_array "$(printf '%s\n' "${missing[@]+"${missing[@]}"}" | sed '/^$/d')")" \
    '{path:$path, lines:$lines, record:(if $record=="" then null else $record end),
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

  # The group's owner is the part of --group after the phase; its tier is the tasks' shared tier.
  group_owner=""
  case "$group_id" in *:*) group_owner="${group_id#*:}" ;; esac
  group_tier=""
  for idx in "${!task_ids[@]}"; do
    t_tier="$(task_field "${task_lines[$idx]}" tier)"
    if [ "$idx" -eq 0 ]; then group_tier="$t_tier"
    elif [ "$t_tier" != "$group_tier" ]; then group_tier=""; break; fi
  done
  bt_level=3
  [ "$num_tasks" -eq 1 ] && bt_level=2
  bt_call "$group_owner" "$group_tier" "$bt_level" "$(IFS=,; printf '%s' "${task_ids[*]}")"
  [ -z "$bt_reason" ] || missing+=("brief-tools: $bt_reason")

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
      echo "> Composed from $composed_from. This brief is your requirements —"
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

      if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then
        echo "## Interface contracts"
        echo
        # §1 IN FULL, deliberately unfiltered — see the --task= path above: an IC-### entry
        # carries no FR or component linkage field to filter it by.
        section "$specs_abs" '^## 1[.]' | awk 'NF { p = 1 } p'
        echo
      fi

      echo "## Verification bar"
      echo
      for fr in $t_frs; do
        section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true
      done
      [ -n "$t_phase_let" ] && grep -F "After Phase $t_phase_let:" "$plan_abs" || true
      echo
      bt_emit 2
    } > "$brief_abs" || write_ok=0

  else
    # Multi-task group: shared preamble once + one block per task
    {
      echo "# Group brief: $group_id"
      echo
      echo "> Composed from $composed_from. This brief covers multiple tasks that share an owner."
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

      if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then
        echo "### Interface contracts"
        echo
        # §1 IN FULL, deliberately unfiltered — see the --task= path above: an IC-### entry
        # carries no FR or component linkage field to filter it by. Shared context, since
        # every task in the group is bound by the same contracts.
        section "$specs_abs" '^## 1[.]' | awk 'NF { p = 1 } p'
        echo
      fi

      bt_emit 3
      echo

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

  bt_write_record "$(jq -nc --argjson reports "$(printf '%s' "$paths" | jq -c '.reports // []')" \
    '$ARGS.positional as $ids | [range(0; $ids | length) | {id: $ids[.], report: ($reports[.] // null)}]' \
    --args "${task_ids[@]}")"

  jq -n \
    --arg path "$brief_rel" \
    --arg record "$record_out" \
    --argjson lines "${lines:-0}" \
    --argjson frs "$(to_json_array "$all_frs")" \
    --argjson nfrs "$(to_json_array "$nfrs")" \
    --argjson components "$(to_json_array "$all_comps_raw")" \
    --argjson missing "$(to_json_array "$(printf '%s\n' "${missing[@]+"${missing[@]}"}" | sed '/^$/d')")" \
    '{path:$path, lines:$lines, record:(if $record=="" then null else $record end), tasks:$ARGS.positional,
      traced:{frs:$frs, nfrs:$nfrs, components:$components},
      missing:$missing}' \
    --args "${task_ids[@]}"
  exit 0
fi
