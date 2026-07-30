#!/usr/bin/env bash
# do-task-brief.sh — compose one task's brief into a file the implementer reads once.
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
#
# Emits: {path, lines, traced:{story, frs[], nfrs[], components[]}, missing[]}

set -uo pipefail

task_id=""; slug_override=""
for arg in "$@"; do
  case "$arg" in
    --task=*) task_id="${arg#--task=}" ;;
    --slug=*) slug_override="${arg#--slug=}" ;;
    --json)   ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","path":null}\n'
  exit 0
fi
if [ -z "$task_id" ]; then
  jq -n '{error:"missing-task", hint:"pass --task=<id>, e.g. --task=A.1"}'
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
paths="$(bash "$script_dir/do-exec-paths.sh" --task="$task_id" ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
brief_rel="$(printf '%s' "$paths" | jq -r '.brief // empty')"
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

# ── the task line and its phase ───────────────────────────────────────────────
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

# ── section extractor: by heading TEXT, stopping at the next same-level heading ─
section() { # section <file> <heading-regex>
  awk -v want="$2" '
    $0 ~ want { inside = 1; next }
    inside && /^## / { exit }
    inside { print }
  ' "$1"
}

# ── FRs traced to this story (requirement §3 index rows, Story column) ─────────
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

detail_for() { # detail_for <file> <section-regex> <id>
  section "$1" "$2" | awk -v id="$3" '
    $0 ~ "^- \\*\\*" id "([^A-Za-z0-9]|$)" { inside = 1; print; next }
    inside && /^- \*\*/ { exit }
    inside { print }
  '
}

# ── compose ───────────────────────────────────────────────────────────────────
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
    # A story spans continuation lines, so capture the whole bullet rather than its first
    # line — a story truncated mid-sentence is worse than none: it reads as complete.
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

  if [ -n "$frs" ] && [ -f "$des_abs" ]; then
    echo "## Component boundary"
    echo
    for fr in $frs; do
      section "$des_abs" '^## 3[.]' | awk -F'|' -v fr="$fr" '
        /^\| *CMP/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
    done | sort -u | while read -r cmp; do
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
} > "$brief_abs"

lines="$(wc -l < "$brief_abs" | tr -d ' ')"
components="$(if [ -n "$frs" ] && [ -f "$des_abs" ]; then
  for fr in $frs; do
    section "$des_abs" '^## 3[.]' | awk -F'|' -v fr="$fr" '
      /^\| *CMP/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
  done | sort -u
fi)"
nfrs="$(if [ -f "$req_abs" ]; then section "$req_abs" '^## 4[.]' | grep -o '^| *NFR-[0-9]*' | tr -d '| ' ; fi)"

to_json_array() { if [ -z "$1" ]; then echo '[]'; else printf '%s\n' "$1" | jq -R . | jq -s .; fi; }

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
