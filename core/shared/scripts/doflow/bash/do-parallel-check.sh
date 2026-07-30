#!/usr/bin/env bash
# do-parallel-check.sh — verify one phase's [P] siblings really write disjoint files.
#
# `[P]` asserts at plan time that a task's `files:` set does not overlap its phase
# siblings'. Nothing verified that assertion, so parallel-by-default rested on an
# unchecked claim: two agents dispatched concurrently onto one file is a lost edit,
# and the loss is silent. This script turns the claim into a check.
#
# Advisory by design: it reports the overlaps and the safe grouping, and the calling
# skill decides to serialize. It never edits the plan and never dispatches anything.
#
# A task whose `files:` value names no real path (a verification-only task) simply
# contributes nothing to compare, rather than being treated as conflicting with
# everything.
#
# Usage:
#   do-parallel-check.sh --phase=<X> [--slug=<slug>] [--json]
#
# Emits: {phase, parallel_tasks[], sequential_tasks[], overlaps[{path, tasks[]}],
#         parallel_safe, serialize[]}

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

# One record per (task, file): id \t P|S \t file. Scoped to the requested phase only —
# `[P]` means parallel-safe with PHASE siblings, so comparing across phases would
# invent conflicts between tasks that never run together.
records="$(awk -v want="$phase" '
  /^### Phase / {
    # "### Phase A — name" → the phase letter is the third whitespace-separated field
    inphase = ($3 == want)
    next
  }
  /^### / { inphase = 0; next }
  !inphase { next }
  /^- \[[ x]\] / {
    line = $0
    # task id is the first token after the checkbox
    if (match(line, /^- \[[ x]\] [^ ]+/) == 0) next
    id = substr(line, RSTART + 6, RLENGTH - 6)
    par = (line ~ /^- \[[ x]\] [^ ]+ \[P\]/) ? "P" : "S"
    if (match(line, /files:[^;]*/) == 0) { print id "\t" par "\t"; next }
    files = substr(line, RSTART + 6, RLENGTH - 6)
    n = split(files, parts, ",")
    emitted = 0
    for (i = 1; i <= n; i++) {
      f = parts[i]
      gsub(/^[ \t]+|[ \t]+$/, "", f)
      if (f == "" || f ~ /^none/) continue
      print id "\t" par "\t" f
      emitted = 1
    }
    if (!emitted) print id "\t" par "\t"
  }
' "$plan_abs")"

if [ -z "$records" ]; then
  jq -n --arg phase "$phase" \
    '{phase:$phase, parallel_tasks:[], sequential_tasks:[], overlaps:[], parallel_safe:true, serialize:[],
      note:"no tasks found under this phase heading"}'
  exit 0
fi

printf '%s\n' "$records" | jq -R -s --arg phase "$phase" '
  [ split("\n")[] | select(length > 0) | split("\t") | {id: .[0], par: .[1], file: (.[2] // "")} ]
  | . as $rows
  | ([$rows[] | select(.par == "P") | .id] | unique)   as $par
  | ([$rows[] | select(.par == "S") | .id] | unique)   as $seq
  # Only [P] rows can conflict: a sequential task never runs beside a sibling.
  | ([$rows[] | select(.par == "P") | select(.file != "")]
      | group_by(.file)
      | map({path: .[0].file, tasks: ([.[] | .id] | unique)})
      | map(select(.tasks | length > 1)))                as $overlaps
  | {
      phase: $phase,
      parallel_tasks: $par,
      sequential_tasks: $seq,
      overlaps: $overlaps,
      parallel_safe: ($overlaps | length) == 0,
      serialize: ([$overlaps[] | .tasks[]] | unique)
    }'
exit 0
