#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
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
# Owner and files are read from the whole task block: the task line and a `Verify:` line under it. A task
# that declares no `files:` (`files: none` is a declaration), or declares different sets, is named in
# `files_missing[]` / `files_conflict[]`, and while one exists `parallel_safe` is `null`, never `true`.
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
# Shared argument rule: `--flag value` is read like `--flag=value` for the flags named here (do-args.sh).
_da="$(dirname "$0")/do-args.sh"
if [ -r "$_da" ]; then . "$_da"; doflow_normalize_args "--phase --slug" "$@"; set -- ${DOFLOW_ARGS[@]+"${DOFLOW_ARGS[@]}"}; fi
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
resolved_rc=$?
# An unsafe slug is refused with the resolver's own error object (IC-009), not read as an empty feature.
if [ "$resolved_rc" -eq 2 ] && [ "$(printf '%s' "$resolved" | jq -r '.error // empty' 2>/dev/null)" = "invalid-slug" ]; then
  printf '%s\n' "$resolved"; exit 2
fi
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
#
# A task is its whole block: the `- [ ] <id>` line and the indented lines under it, up to the next task or
# heading. `owner:` and `files:` are read from the task line and from a `Verify:` line (the layout plans
# written with a verification line use); each is the text after the line's first em dash. A task that
# declares files twice must declare the same set twice: a different set is `conflict`, and a task that
# declares none is `missing`. `files: none` is a declaration of an empty set, not a missing one.
awk -v want="$phase" '
  # Sorted, de-duplicated, comma-joined form of a comma list, so two spellings of one set compare equal.
  function normalize(list,    n, parts, i, j, t, out, last) {
    n = split(list, parts, ",")
    for (i = 1; i <= n; i++) { gsub(/^[ \t]+|[ \t]+$/, "", parts[i]) }
    for (i = 2; i <= n; i++) {
      t = parts[i]
      for (j = i - 1; j >= 1 && parts[j] > t; j--) parts[j + 1] = parts[j]
      parts[j + 1] = t
    }
    out = ""; last = "\001"
    for (i = 1; i <= n; i++) {
      if (parts[i] == "" || parts[i] ~ /^none/ || parts[i] == last) continue
      out = out (out == "" ? "" : ",") parts[i]
      last = parts[i]
    }
    return out
  }
  # Reads one line'"'"'s owner:/files: fields into the current task.
  function declare(line,    dash_pos, section, o, f) {
    dash_pos = index(line, "—")
    if (dash_pos == 0) return
    section = substr(line, dash_pos + length("—"))
    if (match(section, /owner:[^;]*/)) {
      o = substr(section, RSTART + 7, RLENGTH - 7)
      gsub(/^[ \t]+|[ \t]+$/, "", o)
      if (o != "") {
        if (owner == "") owner = o
        else if (owner != o) conflict = 1
      }
    }
    if (match(section, /files:[^;]*/)) {
      f = substr(section, RSTART + 6, RLENGTH - 6)
      gsub(/^[ \t]+|[ \t]+$/, "", f)
      if (f == "") return
      declared++
      set = normalize(f)
      if (declared == 1) first = set
      else if (set != first) conflict = 1
      m = split(set, items, ",")
      for (k = 1; k <= m; k++) if (items[k] != "" && !(items[k] in seen)) { seen[items[k]] = 1; order[++norder] = items[k] }
    }
  }
  function flush(    status, k) {
    if (id == "") return
    status = conflict ? "conflict" : (declared == 0 ? "missing" : "ok")
    if (norder == 0) print id "\t" par "\t" owner "\t\t" status
    for (k = 1; k <= norder; k++) print id "\t" par "\t" owner "\t" order[k] "\t" status
    id = ""
  }
  function start(line) {
    id = substr(line, RSTART + 6, RLENGTH - 6)
    par = (line ~ /^- \[[ x]\] [^ ]+ \[P\]/) ? "P" : "S"
    owner = ""; declared = 0; conflict = 0; first = ""; norder = 0
    delete seen; delete order
    declare(line)
  }
  /^#+ / { flush() }
  /^### Phase / {
    inphase = ($3 == want)
    next
  }
  /^### / { inphase = 0; next }
  !inphase { next }
  /^- \[[ x]\] / {
    flush()
    if (match($0, /^- \[[ x]\] [^ ]+/) == 0) next
    start($0)
    next
  }
  id != "" && /^[ \t]*[-*]?[ \t]*\**Verify\**:/ { declare($0) }
  END { flush() }
' "$plan_abs" | jq -R . | jq -s --arg phase "$phase" '
  # Convert array of tab-separated strings to array of objects
  map(split("\t")) |
  map({id: .[0], par: .[1], owner: (.[2] // ""), file: (.[3] // ""), meta: (.[4] // "missing")}) |
  . as $rows |

  # Tasks whose file metadata cannot establish anything: none declared, or declarations that disagree
  ([.[] | select(.meta == "missing") | .id] | unique) as $files_missing |
  ([.[] | select(.meta == "conflict") | .id] | unique) as $files_conflict |
  
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
    #
    # A task with no `files:` (or two that disagree) has an unknown write set, so a phase containing one
    # is never reported safe: `null` (unknown, run serially) unless a real overlap already makes it `false`.
    parallel_safe: (if (($par | length) == 0 and ($seq | length) == 0) then null
                    elif (($overlaps | length) > 0 or ($final_group_overlaps | length) > 0) then false
                    elif (($files_missing | length) > 0 or ($files_conflict | length) > 0) then null
                    else true end),
    files_missing: $files_missing,
    files_conflict: $files_conflict,
    serialize: ([$overlaps[] | .tasks[]] | unique),
    groups: $final_groups,
    group_overlaps: $final_group_overlaps,
    group_serialize: $group_serialize,
    unowned_tasks: $unowned_ids
  }
'
exit 0
