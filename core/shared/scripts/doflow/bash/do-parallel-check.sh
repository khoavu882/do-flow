#!/usr/bin/env bash
# do-parallel-check.sh — verify one phase's [P] siblings really write disjoint files.
#                        Form dispatch groups by (phase, owner) and detect union overlaps.
#
# `[P]` asserts at plan time that a task's `files:` set does not overlap its phase
# siblings'. Nothing verified that assertion, so parallel-by-default rested on an
# unchecked claim: two agents dispatched concurrently onto one file is a lost edit,
# and the loss is silent. This script turns the claim into a check.
#
# Grouping by (phase, owner) lets one agent handle all tasks of the same owner in a phase,
# reducing dispatch overhead. The script forms groups from `owner:` fields, computes union
# file sets per group, and reports overlaps across groups (`group_overlaps[]`).
#
# Advisory by design: it reports overlaps and grouping decisions; the calling skill decides
# to serialize or group dispatch. It never edits the plan and never dispatches anything.
#
# A task whose `files:` value names no real path (a verification-only task) simply
# contributes nothing to compare, rather than being treated as conflicting with
# everything.
#
# Usage:
#   do-parallel-check.sh --phase=<X> [--slug=<slug>] [--json]

set -uo pipefail

phase=""
slug_override=""
for arg in "$@"; do
  case "$arg" in
    --phase=*) phase="${arg#--phase=}" ;;
    --slug=*)  slug_override="${arg#--slug=}" ;;
    --json)    ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","parallel_safe":null}\n'
  exit 0
fi

if [ -z "$phase" ]; then
  jq -n '{error:"missing-phase", hint:"pass --phase=<X>, e.g. --phase=A"}'
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
resolved="$(bash "$script_dir/do-paths.sh" --json ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
repo_root="$(printf '%s' "$resolved" | jq -r '.repo_root // empty')"
plan_rel="$(printf '%s' "$resolved" | jq -r '.plan // empty')"
has_plan="$(printf '%s' "$resolved" | jq -r '.has_plan // false')"

if [ "$has_plan" != "true" ] || [ -z "$plan_rel" ]; then
  jq -n '{error:"no-plan", hint:"this feature has no plan.md to check"}'
  exit 2
fi
plan_abs="$repo_root/$plan_rel"

# Pipeline: awk outputs tab-separated values (one per line), jq reads raw lines as strings,
# aggregates them into an array, then processes each row.
awk -v want="$phase" '
  /^### Phase / {
    inphase = ($3 == want)
    next
  }
  /^### / { inphase = 0; next }
  !inphase { next }
  /^- \[[ x]\] / {
    line = $0
    if (match(line, /^- \[[ x]\] [^ ]+/) == 0) next
    id = substr(line, RSTART + 6, RLENGTH - 6)
    par = (line ~ /^- \[[ x]\] [^ ]+ \[P\]/) ? "P" : "S"
    # Extract only the portion after em-dash for owner:/files: parsing
    dash_pos = index(line, "—")
    if (dash_pos == 0) {
      print id "\t" par "\t\t"
      next
    }
    field_section = substr(line, dash_pos + length("—"))
    owner = ""
    if (match(field_section, /owner:[^;]*/)) {
      owner = substr(field_section, RSTART + 7, RLENGTH - 7)
      gsub(/^[ \t]+|[ \t]+$/, "", owner)
    }
    if (match(field_section, /files:[^;]*/)) {
      files = substr(field_section, RSTART + 6, RLENGTH - 6)
      n = split(files, parts, ",")
      emitted = 0
      for (i = 1; i <= n; i++) {
        f = parts[i]
        gsub(/^[ \t]+|[ \t]+$/, "", f)
        if (f == "" || f ~ /^none/) continue
        print id "\t" par "\t" owner "\t" f
        emitted = 1
      }
      if (!emitted) print id "\t" par "\t" owner "\t"
    } else {
      print id "\t" par "\t" owner "\t"
    }
  }
' "$plan_abs" | jq -R . | jq -s --arg phase "$phase" '
  # Convert array of tab-separated strings to array of objects
  map(split("\t")) |
  map({id: .[0], par: .[1], owner: (.[2] // ""), file: (.[3] // "")}) |
  . as $rows |
  
  # Separate by parallel/sequential
  ([.[] | select(.par == "P") | .id] | unique)   as $par |
  ([.[] | select(.par == "S") | .id] | unique)   as $seq |
  
  # Existing overlaps: per-task file conflicts among [P] tasks
  (
    [.[] | select(.par == "P") | select(.file != "")] |
    group_by(.file) |
    map({path: .[0].file, tasks: ([.[] | .id] | unique)}) |
    map(select(.tasks | length > 1))
  ) as $overlaps |
  
  # Unowned tasks: those with empty owner
  ([.[] | select(.owner == "") | .id] | unique)   as $unowned_ids |
  
  # Form groups preserving first task appearance order
  (
    reduce $rows[] as $row (
      [];
      if $row.id == "" then .
      elif $row.owner == "" then
        # Check if unowned task already added
        if any(.[]; .id == ($phase + ":" + $row.id)) then
          map(if .id == ($phase + ":" + $row.id) then
            .files = (.files + (if $row.file == "" then [] else [$row.file] end) | unique)
          else . end)
        else
          . + [{
            id: ($phase + ":" + $row.id),
            owner: null,
            tasks: [$row.id],
            files: (if $row.file == "" then [] else [$row.file] end)
          }]
        end
      else
        ($row.owner) as $own |
        ($phase + ":" + $own) as $gid |
        if any(.[]; .id == $gid) then
          map(if .id == $gid then
            .tasks = (if (.tasks | index($row.id)) then .tasks else (.tasks + [$row.id]) end) |
            .files = (.files + (if $row.file == "" then [] else [$row.file] end) | unique)
          else . end)
        else
          . + [{
            id: $gid,
            owner: $own,
            tasks: [$row.id],
            files: (if $row.file == "" then [] else [$row.file] end)
          }]
        end
      end
    )
  ) as $final_groups |

  # Create a mapping from task_id to group_id for lookup
  ([$final_groups[] | .tasks[] as $t | {key: $t, value: .id}] | from_entries) as $task_to_group |

  # Group overlaps: paths appearing in tasks assigned to more than one group
  (
    $rows |
    [.[] | select(.par != "") | select(.file != "")] |
    group_by(.file) |
    map({
      path: .[0].file,
      groups: ([.[] | .id as $tid | $task_to_group[$tid]] | unique)
    }) |
    map(select((.groups | length) > 1))
  ) as $final_group_overlaps |
  
  # Serialize list = union of group ids from overlaps
  ([$final_group_overlaps[].groups[]] | unique) as $group_serialize |
  
  {
    phase: $phase,
    parallel_tasks: $par,
    sequential_tasks: $seq,
    overlaps: $overlaps,
    # `null` when the caller named a phase and nothing parsed, true only when BOTH the task-level
    # and the group-level collision sets are empty.
    #
    # This field was `(($overlaps|length) == 0)`, which was wrong twice. A plan whose tasks are not
    # under a `### Phase <X>` heading parses to zero tasks, so zero overlaps, so "safe" — the flag
    # said a collision-free phase where it had read no phase at all. And `$overlaps` counts only
    # `[P]`-to-`[P]` collisions, so a plan could report `parallel_safe: true` in the same object as
    # a non-empty `group_overlaps` naming the very file two groups both write. `do-execute-plan`
    # tells the reader to branch on this field and never on the exit code, so either shape
    # authorises concurrent writes to one file.
    parallel_safe: (if (($par | length) == 0 and ($seq | length) == 0) then null
                    else (($overlaps | length) == 0 and ($final_group_overlaps | length) == 0) end),
    serialize: ([$overlaps[] | .tasks[]] | unique),
    groups: $final_groups,
    group_overlaps: $final_group_overlaps,
    group_serialize: $group_serialize,
    unowned_tasks: $unowned_ids
  }
'
exit 0
