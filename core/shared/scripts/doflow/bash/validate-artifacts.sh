#!/usr/bin/env bash
# validate-artifacts.sh — advisory consistency checker for doflow chain artifacts.
#
# Checks that an artifact's index tables agree with the detail beside them. This is a CONSISTENCY
# checker, not a CONFORMANCE checker: it never asks whether an index had to exist, only whether one
# that does exist matches its detail. That is what lets artifacts written before this convention —
# which have no index tables at all — pass without any version marker or detection logic.
#
# Rules:
#   parity     index IDs and Detail IDs match, in both directions
#   status     every Status is "Live" or "Superseded -> <ref>"
#   supersede  an ID-shaped <ref> resolves to an ID present in the same artifact
#   history    a superseded ID has an entry in the History section
#   rollup     plan.md's phase rollup counts match its task checklist
#
# Grammar (see guidance/references/ARTIFACT_FORMAT.md) — deliberately prefix-agnostic, so
# FR/NFR/C/D/A and any future prefix work with no change here:
#   indexed section  a table whose first header cell is "ID", followed in the same "## " section
#                    by a "**Detail**" marker
#   index ID         first cell of each table body row
#   Status           the cell under the header column literally named "Status" (located by name,
#                    never by position, so a column added to the right cannot shift the check)
#   detail entry     a line starting "- **<ID>", where <ID> is the leading token inside the bold;
#                    "- **FR-001:**" and "- **NFR-001 (qualifier):**" are both valid
#
# Usage: validate-artifacts.sh [--json] [--slug=<slug>] [<path>...]
#   No <path> → resolve the active feature via do-paths.sh and check every artifact present.
#
# Exit: 0 = clean, 1 = violations found (ADVISORY — no hook consumes this exit code),
#       0 + printed note = could not run (fail-open, matching do-prereqs.sh).

set -uo pipefail

emit_json=false
slug_override=""
targets=()
for a in "$@"; do
  case "$a" in
    --json)   emit_json=true ;;
    --slug=*) slug_override="${a#--slug=}" ;;
    -*)       ;;                       # unknown flag: ignore rather than fail the caller
    *)        targets+=("$a") ;;
  esac
done

# Fail-open: always say why nothing was checked — an unrunnable checker must never be mistaken for
# a clean bill of health — but never obstruct the caller.
note() {
  if [ "$emit_json" = true ]; then
    printf '{"ok":true,"note":"%s","findings":[]}\n' "$1"
  else
    printf 'validate-artifacts: %s (nothing checked)\n' "$1"
  fi
  exit 0
}

# ── locate targets ────────────────────────────────────────────────────────────────────────────
if [ "${#targets[@]}" -eq 0 ]; then
  command -v jq >/dev/null 2>&1 || note "jq-absent"

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  RESOLVER="$script_dir/do-paths.sh"
  [ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
  [ -f "$RESOLVER" ] || note "resolver-absent"

  resolver_args=(--json)
  [ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
  json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || note "resolver-error"

  root=$(printf '%s' "$json" | jq -r '.repo_root // empty')
  [ -n "$(printf '%s' "$json" | jq -r '.feature_slug // empty')" ] || note "no-active-feature"

  for key in requirement design plan; do
    p=$(printf '%s' "$json" | jq -r ".$key // empty")
    [ -n "$p" ] && [ -f "$root/$p" ] && targets+=("$root/$p")
  done
  [ "${#targets[@]}" -gt 0 ] || note "no-artifacts-present"
fi

# ── check each target ─────────────────────────────────────────────────────────────────────────
# Findings accumulate as: <file>\t<rule>\t<id>\t<message>
findings=""
for f in "${targets[@]}"; do
  if [ ! -f "$f" ]; then
    findings="${findings}${f}"$'\t'"io"$'\t'"-"$'\t'"file not found"$'\n'
    continue
  fi
  out=$(awk -v is_plan="$([ "$(basename "$f")" = "plan.md" ] && echo 1 || echo 0)" '
    # Inline markup is presentation, not value: "**Superseded → X**" and "`Live`" mean the same as
    # their bare forms, so emphasis is stripped before any comparison.
    function trim(s) { gsub(/[`*]/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    function is_id(s) { return s ~ /^[A-Za-z]+-?[0-9]+$/ }
    function finding(rule, id, msg) { print rule "\t" id "\t" msg }

    BEGIN { sec = 0; in_table = 0; in_rollup = 0; status_col = 0; phase = "" }

    # ── section boundaries ───────────────────────────────────────────────────────────────────
    /^## / {
      sec++
      in_table = 0; in_rollup = 0; status_col = 0
      is_hist[sec] = ($0 ~ /[Hh]istory/) ? 1 : 0
      next
    }

    # ── "### Phase X" headings drive the rollup task count; any other ### clears the phase, so
    #    checkboxes under "Completion criteria" are never counted as tasks ──────────────────────
    # "### Task Summary" holds the rollup table and is not a phase; "Summary" is carved out
    # explicitly so a heading written as "### Phase Summary" cannot be read as a phase named
    # "Summary".
    /^### / {
      in_table = 0; in_rollup = 0
      if ($0 ~ /^### Phase / && $3 != "Summary") { phase = $3; phase_seen[phase] = 1 } else { phase = "" }
      next
    }

    # ── tables ───────────────────────────────────────────────────────────────────────────────
    /^[ \t]*\|/ {
      n = split($0, cell, "|")
      if ($0 ~ /^[ \t]*\|[ :|-]*$/) next                       # separator row

      if (!in_table && !in_rollup) {
        first = trim(cell[2])
        if (first == "ID") {
          in_table = 1; has_index[sec] = 1; status_col = 0
          for (i = 2; i <= n; i++) if (trim(cell[i]) == "Status") status_col = i
          next
        }
        if (is_plan && first == "Phase") {
          rollup_col = 0
          for (i = 2; i <= n; i++) if (trim(cell[i]) == "Tasks") rollup_col = i
          if (rollup_col) { in_rollup = 1; saw_rollup = 1 }
          next
        }
        next
      }

      if (in_rollup) {
        p = trim(cell[2]); c = trim(cell[rollup_col])
        if (p != "" && c ~ /^[0-9]+$/) { rollup[p] = c + 0; rollup_seen[p] = 1 }
        next
      }

      id = trim(cell[2])
      if (id == "") next
      idx[sec, id] = 1; ids[sec] = ids[sec] " " id; all[id] = 1
      if (status_col) status[sec, id] = trim(cell[status_col])
      if (is_hist[sec]) hist[id] = 1
      next
    }
    { in_table = 0; in_rollup = 0 }                            # any non-table line ends a table

    /^\*\*Detail\*\*/ { has_detail[sec] = 1; next }

    # The ID is the LEADING token inside the bold, not the whole of it. Real entries look like
    # "- **FR-001:** ..." and "- **NFR-001 (No new hard gate — CRITICAL):** ..." — so match the ID
    # prefix and ignore whatever qualifier follows it.
    /^- \*\*[A-Za-z]+-?[0-9]+/ {
      line = $0; sub(/^- \*\*/, "", line)
      if (match(line, /^[A-Za-z]+-?[0-9]+/)) {
        id = substr(line, 1, RLENGTH)
        det[sec, id] = 1; dids[sec] = dids[sec] " " id; all[id] = 1
        if (is_hist[sec]) hist[id] = 1
      }
      next
    }

    # ── task checklist lines feed the rollup comparison ──────────────────────────────────────
    is_plan && phase != "" && /^- \[[ xX]\] / { actual[phase]++ }

    END {
      for (s = 1; s <= sec; s++) {
        if (!has_index[s] || !has_detail[s]) continue          # not an indexed section — skip

        ni = split(ids[s], a, " ")
        for (i = 1; i <= ni; i++) {
          id = a[i]; if (id == "") continue
          if (!((s, id) in det)) finding("parity", id, "appears in the index but has no Detail entry")

          st = status[s, id]
          if (st == "" || st == "Live") continue
          if (st ~ /^Superseded/) {
            ref = st; sub(/^Superseded/, "", ref); gsub(/^[^A-Za-z0-9]+/, "", ref); ref = trim(ref)
            sup[id] = 1
            if (ref == "") finding("supersede", id, "is Superseded but names no replacement")
            else if (is_id(ref) && !(ref in all)) finding("supersede", id, "is Superseded -> " ref ", which does not exist in this artifact")
          } else {
            finding("status", id, "Status \"" st "\" is not Live or Superseded -> <ref>")
          }
        }
        nd = split(dids[s], b, " ")
        for (i = 1; i <= nd; i++) {
          id = b[i]; if (id == "") continue
          if (!((s, id) in idx)) finding("parity", id, "appears in Detail but has no index row")
        }
      }

      for (id in sup) if (!(id in hist)) finding("history", id, "is superseded but has no History entry")

      # Consistency, not conformance: a plan with no rollup table at all has nothing to be
      # inconsistent with, so the check is skipped rather than reported. This is the same rule that
      # lets indexless sections pass, applied to the rollup.
      if (is_plan && saw_rollup) {
        for (p in rollup_seen) {
          if (!(p in phase_seen)) { finding("rollup", "Phase " p, "is in the rollup but has no checklist section"); continue }
          got = (p in actual) ? actual[p] : 0
          if (got != rollup[p]) finding("rollup", "Phase " p, "rollup states " rollup[p] " tasks; the checklist has " got)
        }
        for (p in phase_seen) if (!(p in rollup_seen)) finding("rollup", "Phase " p, "has a checklist section but no rollup row")
      }
    }
  ' "$f" 2>/dev/null)
  awk_status=$?
  # A failed parse must never look like a clean file. Empty output is indistinguishable from "no
  # violations", so the exit status is what separates "checked and clean" from "never checked" —
  # for instance if this runs under an awk that rejects a construct used above.
  if [ "$awk_status" -ne 0 ]; then
    findings="${findings}${f}"$'\t'"io"$'\t'"-"$'\t'"could not be parsed (awk exit ${awk_status}) — this file was NOT checked"$'\n'
    continue
  fi
  if [ -n "$out" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && findings="${findings}${f}"$'\t'"${line}"$'\n'
    done <<< "$out"
  fi
done

# ── report ────────────────────────────────────────────────────────────────────────────────────
if [ -z "$findings" ]; then
  if [ "$emit_json" = true ]; then
    printf '{"ok":true,"findings":[]}\n'
  else
    printf 'validate-artifacts: %d artifact(s) checked, no violations\n' "${#targets[@]}"
  fi
  exit 0
fi

if [ "$emit_json" = true ]; then
  # Escape backslash then double quote, in that order — reversing it would re-escape the
  # backslashes this step introduces. Findings legitimately contain quotes (a status message
  # names the offending value), and a path may contain either.
  json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  printf '{"ok":false,"findings":['
  first=1
  while IFS=$'\t' read -r file rule id msg; do
    [ -z "$file" ] && continue
    [ $first -eq 0 ] && printf ','
    printf '{"file":"%s","rule":"%s","id":"%s","message":"%s"}' \
      "$(json_escape "$file")" "$rule" "$(json_escape "$id")" "$(json_escape "$msg")"
    first=0
  done <<< "$findings"
  printf ']}\n'
else
  last=""
  while IFS=$'\t' read -r file rule id msg; do
    [ -z "$file" ] && continue
    if [ "$file" != "$last" ]; then printf '%s\n' "$file"; last="$file"; fi
    printf '  %-10s %s %s\n' "$rule" "$id" "$msg"
  done <<< "$findings"
  printf '\n%d finding(s) — advisory; the chain continues regardless.\n' \
    "$(printf '%s' "$findings" | grep -c .)"
fi
exit 1
