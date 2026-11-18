#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
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
#   component boundary design.md "Components & Boundaries" detail for components serving those FRs
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
# Every brief is a prompt frame written by `doflow-run prompt-frame` (row 173, design §6): a header, a role, the
# context, the requirement, constraint, boundary and contract text as input documents, the instructions
# (the task, its write set, success criteria, rules, tools and stop rule) and the reply format. Each part is
# written to a scratch file and passed by path. The tier, tools, rules and report lines come from the
# `brief-tools` verb, called once per brief; this script reads the task line's `owner:` and `tier:`, writes the
# `*-brief.json` record (IC-018) beside the brief, and names no tool, provider, server or tier.
# It fails open twice (IC-019). When `brief-tools` cannot answer (no dispatcher, a non-zero exit, output that is
# not the expected JSON) the Tools text says "Not generated", the rules are read from the rule ledger
# (`core/registry/rules.json`) and the report lines are static; no record is written. When `prompt-frame` cannot
# run, the brief is written unframed (first line `frame-unavailable: <reason>`, the header, then each body in
# section order). Either way `missing[]` names the loss and the exit status is what the brief would have had.
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
req_rel="$(printf '%s' "$resolved" | jq -r '.requirement // empty')"
des_rel="$(printf '%s' "$resolved" | jq -r '.design // empty')"
specs_rel="$(printf '%s' "$resolved" | jq -r '.specs // empty')"
req_abs="$repo_root/$req_rel"
des_abs="$repo_root/$des_rel"
specs_abs="$repo_root/$specs_rel"
has_specs="$(printf '%s' "$resolved" | jq -r '.has_specs // false')"
brief_abs="$repo_root/$brief_rel"
record_rel="$(printf '%s' "$paths" | jq -r '.brief_record // empty')"
feature_slug="$(printf '%s' "$resolved" | jq -r '.feature_slug // empty')"

# The preamble names specs.md only when this feature actually has one: a brief for a feature
# without a specs.md stays byte-identical to what it was before specs.md existed, rather than
# advertising a source the reader will not find a section for.
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

# ── text of each source section, as the brief's parts carry it ───────────────
why_text() { # why_text <story id>: the story's line and its continuation, from requirement.md section 2
  section "$req_abs" '^## 2[.]' | awk -v s="$1" '
    $0 ~ ("^- \\*\\*" s "([^0-9]|$)") { inside = 1; sub(/^- /, ""); print; next }
    inside && /^- \*\*/ { exit }
    inside { print }'
}

req_text() { # req_text <FR ids>: the detail of each FR, requirement.md section 3
  local fr
  for fr in $1; do detail_for "$req_abs" '^## 3[.]' "$fr"; done
}

nfr_text() { # every NFR detail: requirement.md section 4 binds every task
  section "$req_abs" '^## 4[.]' | awk '/^- \*\*NFR-/ { p = 1 } p' | sed '/^$/d'
}

comp_text() { # comp_text <component ids, one per line>: their detail from design.md Components
  local cmp
  printf '%s\n' "$1" | while read -r cmp; do
    [ -n "$cmp" ] && detail_for "$des_abs" '^## [0-9]+[.] Component' "$cmp"
  done
}

# specs.md §1 IN FULL, deliberately unfiltered: an IC-### entry carries no FR or component linkage field,
# so there is nothing to filter it by the way comp_text filters design.md Components rows on the FRs they name.
specs_text() {
  section "$specs_abs" '^## 1[.]' | awk 'NF { p = 1 } p'
}

bar_rows() { # bar_rows <FR ids> <phase letter>: plan.md section 7 rows of those FRs, then the phase's checkpoint line
  local fr
  for fr in $1; do section "$plan_abs" '^## 7[.]' | grep -F "| $fr |" || true; done
  if [ -n "$2" ]; then grep -F "After Phase $2:" "$plan_abs" | sed 's/^- //' || true; fi
}

task_text() { # task_text <task line>: the line without its checkbox
  printf '%s\n' "$1" | sed -E 's/^- \[[ x]\] //'
}

# ── tier, tools and report format (IC-017 to IC-019) ─────────────────────────
# A task line field is "; <name>: <value>" or "— <name>: <value>"; the value is one safe word.
task_field() { # task_field <task line> <name>
  printf '%s' "$1" | sed -nE "s/.*(; |— )$2: *([A-Za-z0-9_-]+).*/\\2/p"
}

# Sets bt_parts (the verb's header, rules, tools and report) and bt_record on success, bt_reason on
# every failure; never exits.
bt_verb() { # bt_verb <owner> <tier> <heading level> <task ids>
  bt_parts=""; bt_record=""; bt_reason=""
  local dispatcher="$script_dir/../bin/doflow-run" out rc
  if [ -z "$1" ]; then bt_reason="the task line names no owner"; return 0; fi
  if [ ! -f "$dispatcher" ]; then bt_reason="the dispatcher was not found"; return 0; fi
  out="$(cd "${repo_root:-.}" 2>/dev/null && bash "$dispatcher" brief-tools --json --owner "$1" \
    ${2:+--tier "$2"} ${harness:+--harness "$harness"} ${feature_slug:+--slug "$feature_slug"} \
    --heading-level "$3" ${4:+--tasks "$4"} </dev/null 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then bt_reason="brief-tools exited $rc"; return 0; fi
  if ! printf '%s' "$out" | jq -e '(.parts.header | type == "array") and (.parts.rules | type == "array") and (.parts.tools | type == "string" and length > 0) and (.parts.report | type == "array" and length > 0) and (.record | type == "object")' >/dev/null 2>&1; then
    bt_reason="brief-tools printed unparseable output"; return 0
  fi
  bt_parts="$(printf '%s' "$out" | jq -c '.parts')"
  bt_record="$(printf '%s' "$out" | jq -c '.record')"
  return 0
}

# The registry file `core/registry/<name>` of the runtime this script belongs to: next to the checkout or
# projected runtime found above this script, else the global projected runtime. Empty when none exists.
registry_file() { # registry_file <name>
  local d="$script_dir" c
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    for c in "$d/core/registry/$1" "$d/runtime/core/registry/$1"; do
      if [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
    done
    d="$(dirname "$d")"
  done
  c="${HOME:-}/.doflow/runtime/core/registry/$1"
  if [ -f "$c" ]; then printf '%s' "$c"; fi
  return 0
}

# Sets bt_rules to the lines of the Rules block ("- <rule>"): the verb's own when it answered, else the
# mustCarry lines of the rule ledger (as src/runtime/brief-rules.ts renders them); names the reason in
# missing[] when the ledger cannot be read. Never exits.
bt_rules_load() {
  bt_rules=""
  if [ -n "$bt_parts" ]; then
    bt_rules="$(printf '%s' "$bt_parts" | jq -r '.rules[] | "- " + .')"
    return 0
  fi
  local file lines
  file="$(registry_file rules.json)"
  if [ -z "$file" ]; then missing+=("brief-rules: core/registry/rules.json is missing"); return 0; fi
  lines="$(jq -r 'if (.mustCarry | type) == "array" and (.mustCarry | length) > 0 and (.mustCarry | all(type == "string")) then .mustCarry[] | "- " + . else empty end' "$file" 2>/dev/null)"
  if [ -z "$lines" ]; then missing+=("brief-rules: core/registry/rules.json has no mustCarry array"); return 0; fi
  bt_rules="$lines"
}

# The tier and tools, the rules and the report format the task line's owner and tier give.
bt_call() { # bt_call <owner> <tier> <heading level> <task ids>
  bt_verb "$@"
  bt_rules_load
}

# ── the brief as a prompt frame (row 173) ────────────────────────────────────
# Each part is written to a file in a scratch directory and the `prompt-frame` verb reads them by path, so no
# requirement text ever passes through a command line or a JSON document. The dispatcher is found as bt_verb finds it.
bf_dir=""; bf_args=(); bf_order=()
bf_start() { # a scratch directory for the parts, removed on exit; false when none can be made
  bf_dir="$(mktemp -d 2>/dev/null)" || bf_dir=""
  [ -n "$bf_dir" ] || return 1
  trap 'rm -rf "$bf_dir"' EXIT
  bf_args=(); bf_order=()
}

bf_part() { # bf_part <key> <file name in the scratch dir>: a part with a body is passed to the verb; an empty one is left out
  [ -s "$bf_dir/$2" ] || return 0
  bf_args+=(--part "$1=$bf_dir/$2"); bf_order+=("$bf_dir/$2")
}

# The header lines of the verb's answer (Tier, Model, Decision model); none when the verb did not answer.
bt_header_lines() {
  if [ -n "$bt_parts" ]; then printf '%s' "$bt_parts" | jq -r '.header[] | "\(.[0]): \(.[1])"'; fi
}

# Writes the rules, tools and report parts of the tools block into the scratch dir: the verb's, or the
# fallback (no tool names): the rules, "Not generated" and the static report lines.
bt_parts_write() { # bt_parts_write <heading level>
  [ -z "$bt_rules" ] || printf '%s\n' "$bt_rules" > "$bf_dir/rules"
  if [ -n "$bt_parts" ]; then
    printf '%s' "$bt_parts" | jq -r '.tools' > "$bf_dir/tools"
    printf '%s' "$bt_parts" | jq -r '.report[]' > "$bf_dir/report"
    return 0
  fi
  local who="your report"
  if [ "$1" = "3" ]; then who="each task's report"; fi
  printf 'Not generated: `%s`. Name the tier and tools in the dispatch.\n' "$bt_reason" > "$bf_dir/tools"
  {
    printf '%s\n' "If this brief's scope was wrong or missed something, add one line \`Brief feedback: <what>\` before the tools line; leave it out otherwise."
    printf '%s\n' 'Put one line naming every tool and MCP server you used just before the final status line:'
    printf '%s\n' '`Tools used: <name>[=used|nothing-usable|unavailable|skipped:<reason>], ...`'
    printf 'End %s with one line `Status: <status>`, where the status is one of `done`, `done-with-concerns`, `needs-context`, `blocked`.\n' "$who"
  } > "$bf_dir/report"
}

# The parts every brief ends with, in section order: the outcome's task text is the caller's, the rest is common.
bf_close() { # bf_close: stop rule, reader and report lines
  printf '%s\n' 'Stop when the success criteria hold, or when a blocker needs the dispatcher; then write the report.' > "$bf_dir/stop"
  printf '%s\n' 'The session that dispatched you' > "$bf_dir/reader"
  bf_part "instructions.constraint:Rules" rules
  bf_part "instructions.constraint:Tools" tools
  bf_part "instructions.stop" stop
  bf_part "output_format.reader" reader
  bf_part "output_format.lines" report
}

# Frames the parts into $1. When the verb cannot run (no dispatcher, a non-zero exit) the brief is still written,
# unframed: first line `frame-unavailable: <reason>`, the header, then each part's body in section order, one blank
# line between; the loss is named in missing[] and the exit status is what it would have been (IC-019's fail-open).
bf_render() { # bf_render <brief file>
  local dispatcher="$script_dir/../bin/doflow-run" reason="" rc part
  if [ ! -f "$dispatcher" ]; then
    reason="the dispatcher was not found"
  else
    (cd "${repo_root:-.}" 2>/dev/null && bash "$dispatcher" prompt-frame --action render --json --out "$1" \
      --part "header=$bf_dir/header" "${bf_args[@]}" </dev/null >/dev/null 2>&1)
    rc=$?
    if [ "$rc" -ne 0 ]; then reason="prompt-frame exited $rc"; fi
  fi
  [ -n "$reason" ] || return 0
  {
    echo "frame-unavailable: $reason"
    cat "$bf_dir/header"
    for part in "${bf_order[@]}"; do echo; cat "$part"; done
  } > "$1" 2>/dev/null || return 1
  missing+=("prompt-frame: $reason")
}

# The task brief (design §6.1) of one task; the one-task group brief is this same call.
compose_task_brief() { # compose_task_brief <id> <task line> <phase heading> <phase letter> <story> <files> <FR ids> <components> <owner>
  local id="$1" line="$2" phase="$3" letter="$4" story="$5" files="$6" frs="$7" comps="$8" owner="$9"
  bf_start || return 1
  {
    echo "Brief: task $id${feature_slug:+ of $feature_slug}"
    echo "Composed from: $composed_from"
    bt_header_lines
  } > "$bf_dir/header"
  printf 'You are %simplementing task `%s`%s.\n' "${owner:+the \`$owner\` }" "$id" "${feature_slug:+ of feature \`$feature_slug\`}" > "$bf_dir/role"
  {
    if [ -n "$phase" ]; then echo "Phase: ${phase#\#\#\# }"; fi
    section "$plan_abs" '^## 1[.]' | sed '/^$/d' | head -8
    if [ -n "$story" ] && [ -f "$req_abs" ]; then why_text "$story" | sed '1s/^/Why: /'; fi
  } > "$bf_dir/context"
  if [ -n "$frs" ]; then req_text "$frs" > "$bf_dir/requirements"; fi
  if [ -f "$req_abs" ]; then nfr_text > "$bf_dir/nfr"; fi
  if [ -n "$comps" ]; then comp_text "$comps" > "$bf_dir/boundary"; fi
  if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then specs_text > "$bf_dir/contracts"; fi
  {
    task_text "$line"
    echo 'Use the values in input verbatim; this brief carries every value the task needs, so the plan need not be opened.'
  } > "$bf_dir/outcome"
  bar_rows "$frs" "$letter" > "$bf_dir/success"
  if [ -n "$files" ]; then printf "Edit only these files, because the task's review compares the diff with them: %s\n" "$files" > "$bf_dir/writeset"; fi
  bt_parts_write 2

  bf_part role role
  bf_part context context
  bf_part "input.doc:path=$req_rel" requirements
  bf_part "input.doc:path=$req_rel#4" nfr
  bf_part "input.doc:path=$des_rel" boundary
  bf_part "input.doc:path=$specs_rel#1" contracts
  bf_part "instructions.outcome" outcome
  bf_part "instructions.success" success
  bf_part "instructions.constraint:Write set" writeset
  bf_close
  bf_render "$brief_abs"
}

# The group brief (design §6.2) of two or more tasks: shared documents once, one Task block per task.
compose_group_brief() { # compose_group_brief <phase> <owner> <task ids, comma-joined>
  local phase="$1" owner="$2" ids="$3" idx tid t_line t_story t_files rows
  bf_start || return 1
  {
    echo "Brief: group $group_id${feature_slug:+ of $feature_slug}"
    echo "Composed from: $composed_from"
    bt_header_lines
  } > "$bf_dir/header"
  printf 'You are %simplementing tasks `%s` of phase `%s`, one after another in the order given.\n' "${owner:+the \`$owner\` }" "$ids" "$phase" > "$bf_dir/role"
  {
    section "$plan_abs" '^## 1[.]' | sed '/^$/d' | head -8
    if [ -f "$req_abs" ]; then
      for idx in "${!task_ids[@]}"; do
        if [ -n "${task_stories[$idx]}" ]; then why_text "${task_stories[$idx]}" | sed "1s/^/Why ${task_ids[$idx]}: /"; fi
      done
    fi
  } > "$bf_dir/context"
  if [ -f "$req_abs" ]; then nfr_text > "$bf_dir/nfr"; fi
  if [ -n "$all_comps_raw" ]; then comp_text "$all_comps_raw" > "$bf_dir/boundary"; fi
  if [ "$has_specs" = "true" ] && [ -f "$specs_abs" ]; then specs_text > "$bf_dir/contracts"; fi
  printf 'Build tasks `%s` in this order; each task writes its own report before the next starts.\n' "$ids" > "$bf_dir/outcome"
  bt_parts_write 3

  bf_part role role
  bf_part context context
  bf_part "input.doc:path=$req_rel#4" nfr
  bf_part "input.doc:path=$des_rel" boundary
  bf_part "input.doc:path=$specs_rel#1" contracts
  for idx in "${!task_ids[@]}"; do
    if [ -n "${task_fr_lists[$idx]}" ]; then req_text "${task_fr_lists[$idx]}" > "$bf_dir/requirements-$idx"; fi
    bf_part "input.doc:path=$req_rel" "requirements-$idx"
  done
  bf_part "instructions.outcome" outcome
  for idx in "${!task_ids[@]}"; do
    tid="${task_ids[$idx]}"; t_line="${task_lines[$idx]}"; t_files="${task_files[$idx]}"
    [ -n "$t_line" ] || continue
    rows="$(bar_rows "${task_fr_lists[$idx]}" "${task_phase_letters[$idx]}")"
    {
      task_text "$t_line"
      if [ -n "$t_files" ]; then echo "Files you own: $t_files"; fi
      if [ -n "$rows" ]; then echo 'Verification:'; printf '%s\n' "$rows" | sed 's/^/- /'; fi
    } > "$bf_dir/task-$idx"
    bf_part "instructions.constraint:Task $tid" "task-$idx"
  done
  bf_close
  bf_render "$brief_abs"
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
      section "$des_abs" '^## [0-9]+[.] Component' | awk -F'|' -v fr="$fr" '
        /^\| *(CMP|C[0-9]+)/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
    done | sort -u)"
  fi

  bt_call "$(task_field "$task_line" owner)" "$(task_field "$task_line" tier)" 2 "$task_id"
  [ -z "$bt_reason" ] || missing+=("brief-tools: $bt_reason")

  # Compose brief
  write_ok=1
  compose_task_brief "$task_id" "$task_line" "$phase_heading" "$phase_letter" "$story" "$files_field" "$frs" "$components" \
    "$(task_field "$task_line" owner)" || write_ok=0

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
      section "$des_abs" '^## [0-9]+[.] Component' | awk -F'|' -v fr="$fr" '
        /^\| *(CMP|C[0-9]+)/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
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
        section "$des_abs" '^## [0-9]+[.] Component' | awk -F'|' -v fr="$fr" '
          /^\| *(CMP|C[0-9]+)/ { if ($5 ~ fr) { id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); print id } }'
      done | sort -u)"
    fi

    compose_task_brief "$t_id" "$t_line" "$t_phase" "$t_phase_let" "$t_story" "$t_files" "$t_frs" "$t_comps" "$group_owner" || write_ok=0

  else
    # Multi-task group: the shared documents once, one block per task
    task_ids_list=""
    for tid in "${task_ids[@]}"; do task_ids_list="${task_ids_list:+$task_ids_list, }$tid"; done
    compose_group_brief "${group_id%%:*}" "$group_owner" "$task_ids_list" || write_ok=0
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
