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
#   history    a superseded ID has an entry in the History section (or in the archive file that
#              the History section's "Earlier entries:" pointer names)
#   stale      a line outside History and HTML comments cites a superseded DEC-### from the
#              feature's decision register without also naming a decision that replaced it. Inert
#              when the feature has no decisions/register.json.
#   unknown    a line outside History, comments and code fences cites a DEC-### that is not in the
#              feature's decision register. Inert without a register.
#   rollup     plan.md's phase rollup counts match its task checklist
#
# Grammar (see guidance/references/ARTIFACT_FORMAT.md) — deliberately prefix-agnostic, so
# FR/NFR/C/D/A and any future prefix work with no change here:
#   indexed section  a table whose first header cell is "ID", followed in the same "## " section
#                    by a "**Detail**" marker
#   index ID         first cell of each table body row
#   Status           the cell under the header column literally named "Status" (located by name,
#                    never by position, so a column added to the right cannot shift the check)
#   detail entry     either of two forms, both valid in the same artifact, neither deprecated:
#                    bullet form  a line starting "- **<ID>", where <ID> is the leading token
#                                 inside the bold; "- **FR-001:**" and
#                                 "- **NFR-001 (qualifier):**" both parse
#                    heading form a line matching "#### <ID>: <text>", counted as a detail entry
#                                 only when <ID> also appears in the first column of that
#                                 section's index table. An ID-shaped heading with no matching
#                                 index row is not a detail entry and is ignored, so an unrelated
#                                 heading cannot invent a parity finding of its own
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

# The resolver refuses a slug that could name a path (IC-009). That refusal is the caller's mistake,
# not an unrunnable checker, so it is passed on as the refusal it is — exit 2 with the resolver's
# own error object — rather than folded into the fail-open notes above.
refuse_invalid_slug() {
  [ "$(printf '%s' "$1" | jq -r '.error // empty' 2>/dev/null)" = "invalid-slug" ] || return 0
  if [ "$emit_json" = true ]; then
    printf '%s\n' "$1"
  else
    printf 'validate-artifacts: %s\n' "$(printf '%s' "$1" | jq -r '.message')" >&2
  fi
  exit 2
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
  rc=0; json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || rc=$?
  [ "$rc" -eq 2 ] && refuse_invalid_slug "$json"
  [ "$rc" -eq 0 ] || note "resolver-error"

  root=$(printf '%s' "$json" | jq -r '.repo_root // empty')
  [ -n "$(printf '%s' "$json" | jq -r '.feature_slug // empty')" ] || note "no-active-feature"

  # data-model.md is a default target only for a feature that has a decision register, so a folder
  # from before the register validates exactly as it always did (FR-016).
  keys="requirement design specs plan"
  [ "$(printf '%s' "$json" | jq -r '.has_decisions // false')" = "true" ] && keys="requirement design specs data_model plan"
  for key in $keys; do
    p=$(printf '%s' "$json" | jq -r ".$key // empty")
    [ -n "$p" ] && [ -f "$root/$p" ] && targets+=("$root/$p")
  done
  [ "${#targets[@]}" -gt 0 ] || note "no-artifacts-present"
elif command -v jq >/dev/null 2>&1; then
  # Explicit paths skip discovery, but the stale rule still needs the feature's register. Resolve
  # quietly: any failure here only leaves the rule inert, never changes what was asked for.
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  RESOLVER="$script_dir/do-paths.sh"
  [ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
  json=""
  if [ -f "$RESOLVER" ]; then
    resolver_args=(--json)
    [ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
    rc=0; json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || rc=$?
    [ "$rc" -eq 2 ] && refuse_invalid_slug "$json"
    [ "$rc" -eq 0 ] || json=""
  fi
  root=$(printf '%s' "$json" | jq -r '.repo_root // empty' 2>/dev/null)
fi

# ── decision register (stale rule) ──────────────────────────────────────────────────────────────
# stale_map is "<id>:<successor>,<successor>;..." — every superseded decision with its chain, the
# live end last. Empty when there is no register, so the rule is inert; a register jq cannot read
# also leaves it empty (fail-open).
stale_map=""; known_ids=""; reg_ok=0; feat_abs=""
# The feature folder is canonicalised physically: the resolver reports a logical root in a non-git
# directory, while each file below is compared by its physical path. A symlink or /tmp vs
# /private/tmp on one side only would make the containment test silently fail.
if [ -n "${json:-}" ] && [ -n "$(printf '%s' "$json" | jq -r '.feature_dir // empty' 2>/dev/null)" ]; then
  feat_abs=$(cd "$root/$(printf '%s' "$json" | jq -r '.feature_dir')" 2>/dev/null && pwd -P) || feat_abs=""
fi
if [ -n "$feat_abs" ] && [ "$(printf '%s' "$json" | jq -r '.has_decisions // false' 2>/dev/null)" = "true" ]; then
  reg_file="$root/$(printf '%s' "$json" | jq -r '.decisions_register')"
  # limit() bounds each chain at the decision count, so a hand-edited register whose supersededBy
  # links form a cycle still terminates; a decision is never its own successor.
  stale_map=$(jq -r '
    .decisions as $d
    | ($d | map({key: .id, value: .supersededBy}) | from_entries) as $next
    | [ $d[] | select(.status == "superseded") | .id as $id
        | {id: $id, chain: ([ limit($d | length; $id | recurse($next[.] // empty)) ] | .[1:] | map(select(. != $id)))} ]
    | map(select(.chain | length > 0) | .id + ":" + (.chain | join(",")))
    | join(";")' "$reg_file" 2>/dev/null) || stale_map=""
  # Every id the register holds, as numbers ("1,2,3"): the unknown rule needs the whole set, and is
  # active only when the register could be read.
  if known_ids=$(jq -r '[.decisions[].id | ltrimstr("DEC-") | tonumber] | join(",")' "$reg_file" 2>/dev/null); then
    reg_ok=1
  else
    known_ids=""
  fi
fi

# ── check each target ─────────────────────────────────────────────────────────────────────────
# Findings accumulate as: <file>\t<rule>\t<id>\t<message>
findings=""
for f in "${targets[@]}"; do
  if [ ! -f "$f" ]; then
    findings="${findings}${f}"$'\t'"io"$'\t'"-"$'\t'"file not found"$'\n'
    continue
  fi
  # The register belongs to one feature: an explicit path outside that feature folder must not be
  # checked against it.
  file_stale_map=""; file_reg_ok=0; file_known_ids=""; hist_root=""
  if [ -n "$feat_abs" ]; then
    case "$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)/" in
      "$feat_abs"/*)
        file_stale_map="$stale_map"; file_reg_ok="$reg_ok"; file_known_ids="$known_ids"
        # The only place a History pointer may lead: the feature's own archive directory.
        hist_root=$(cd "$feat_abs/decisions/history" 2>/dev/null && pwd -P) || hist_root=""
        ;;
    esac
  fi
  # Paths reach awk through the environment: -v would process backslash escapes inside them.
  out=$(DF_ART_DIR="$(dirname "$f")" DF_HIST_ROOT="$hist_root" awk -v is_plan="$([ "$(basename "$f")" = "plan.md" ] && echo 1 || echo 0)" \
    -v stale_map="$file_stale_map" -v reg_ok="$file_reg_ok" -v known_ids="$file_known_ids" -v sq="'" '
    # Inline markup is presentation, not value: "**Superseded → X**" and "`Live`" mean the same as
    # their bare forms, so emphasis is stripped before any comparison.
    function trim(s) { gsub(/[`*]/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    function is_id(s) { return s ~ /^[A-Za-z]+-?[0-9]+$/ }
    function finding(rule, id, msg) { print rule "\t" id "\t" msg }

    # Blanks the parts of a line that sit inside an HTML comment, tracking comments that span
    # lines, so a comment block is never read as artifact text. Mirrors the compactor: only a
    # comment opening at the start of a line continues past it.
    function strip_comments(s,   out, p, rest) {
      out = ""
      while (s != "") {
        if (in_comment) {
          p = index(s, "-->")
          if (!p) return out
          s = substr(s, p + 3); in_comment = 0
        } else {
          p = index(s, "<!--")
          if (!p) return out s
          rest = substr(s, p + 4)
          if (out == "" && substr(s, 1, p - 1) ~ /^[ \t]*$/) {
            # A comment that starts the line may run on over later lines.
            s = rest; in_comment = 1
          } else if (index(rest, "-->")) {
            # Mid-line, it counts only when it also closes on this line; a lone `<!--` quoted in
            # prose is text and must not hide the rest of the file.
            out = out substr(s, 1, p - 1); s = substr(rest, index(rest, "-->") + 3)
          } else return out s
        }
      }
      return out
    }

    # One `unknown` finding per DEC-### the register does not hold, then one `stale` finding per
    # superseded DEC-### on the line, unless the same line also names a decision
    # later in that decision chain (the line is then about the change, not a stale statement).
    # awk has no \b, so a token counts only when no word character touches either end.
    function check_stale(text, lineno,   pos, s, l, tok, before, after, num, cn, i, j, order, cited, named, flagged, ok, word, ws, we) {
      split("", order); split("", cited); split("", named); split("", flagged); cn = 0; pos = 1
      while (pos <= length(text) && match(substr(text, pos), /DEC-[0-9]+/)) {
        s = pos + RSTART - 1; l = RLENGTH
        tok = substr(text, s, l)
        before = (s > 1) ? substr(text, s - 1, 1) : ""
        after = substr(text, s + l, 1)
        pos = s + l
        if (before ~ /[A-Za-z0-9_]/ || after ~ /[A-Za-z_]/) continue
        # A token in a URL, a file path or a file name is not prose and cites nothing, so neither
        # `stale` nor `unknown` reports it. Three shapes: its whitespace-delimited word holds "://"
        # (https://x.test?id=DEC-095); a letter follows a "." (DEC-094.md, [n](DEC-097.md)); or a "/"
        # precedes it, unless the segment before that slash is itself a DEC token (DEC-001/DEC-002 is
        # prose and every half is checked). A sentence-final "DEC-099." is still a citation.
        if (before == "/") {
          word = substr(text, 1, s - 2); sub(/^.*[\/ \t]/, "", word); sub(/^[(\[{"`<*_]+/, "", word)
          if (word !~ /^DEC-[0-9]+$/) continue
        }
        if (after == "." && substr(text, s + l + 1, 1) ~ /[A-Za-z]/) continue
        ws = s; while (ws > 1 && substr(text, ws - 1, 1) !~ /[ \t]/) ws--
        we = s + l; while (we <= length(text) && substr(text, we, 1) !~ /[ \t]/) we++
        if (index(substr(text, ws, we - ws), "://")) continue
        num = substr(tok, 5) + 0
        named[num] = 1
        if (reg_ok && !(num in known) && !(num in flagged)) {
          flagged[num] = 1
          finding("unknown", tok, "line " lineno " cites " tok ", which is not in the decision register")
        }
        if ((num in chain_end) && !(num in cited)) { cited[num] = tok; order[++cn] = num }
      }
      for (i = 1; i <= cn; i++) {
        num = order[i]; ok = 0
        for (j = 1; j <= chain_n[num]; j++) if (chain_m[num, j] in named) ok = 1
        if (!ok) finding("stale", cited[num], "line " lineno " cites " cited[num] ", superseded by " chain_end[num])
      }
    }

    # The pointer line in History names an archive file (relative to this artifact). IDs that
    # moved there still count as History entries for the history rule.
    # True when the directory holding `path` resolves, physically, inside <feature>/decisions/history.
    # A pointer is data from the artifact; it must not make the validator read arbitrary files.
    function under_hist_root(path,   d, cmd, real) {
      if (hist_root == "" || index(path, sq)) return 0
      d = path; sub(/\/[^\/]*$/, "", d)
      if (d == "") d = "/"
      cmd = "cd " sq d sq " 2>/dev/null && pwd -P"
      real = ""
      cmd | getline real
      close(cmd)
      return real != "" && index(real "/", hist_root "/") == 1
    }

    function load_archive(line,   target, path, l, c, first) {
      if (!match(line, /\]\([^)]+\)/)) return
      target = substr(line, RSTART + 2, RLENGTH - 3)
      path = (target ~ /^\//) ? target : dir "/" target
      if (!under_hist_root(path)) return
      while ((getline l < path) > 0) {
        if (l ~ /^[ \t]*\|/) {
          if (l ~ /^[ \t]*\|[ :|-]*$/) continue
          split(l, c, "|"); first = trim(c[2])
          if (is_id(first)) hist[first] = 1
        } else if (l ~ /^- \*\*[A-Za-z]+-?[0-9]+/) {
          sub(/^- \*\*/, "", l)
          if (match(l, /^[A-Za-z]+-?[0-9]+/)) hist[substr(l, 1, RLENGTH)] = 1
        }
      }
      close(path)
    }

    BEGIN {
      dir = ENVIRON["DF_ART_DIR"]; hist_root = ENVIRON["DF_HIST_ROOT"]
      sec = 0; in_table = 0; in_rollup = 0; status_col = 0; phase = ""; in_comment = 0; cur_hist = 0; fence_ch = ""; fence_len = 0
      if (reg_ok) {
        nk = split(known_ids, kn, ",")
        for (k = 1; k <= nk; k++) if (kn[k] != "") known[kn[k] + 0] = 1
      }
      if (stale_map != "") {
        nrec = split(stale_map, recs, ";")
        for (r = 1; r <= nrec; r++) {
          split(recs[r], kv, ":"); num = substr(kv[1], 5) + 0
          nc = split(kv[2], ch, ",")
          chain_end[num] = ch[nc]; chain_n[num] = nc
          for (j = 1; j <= nc; j++) chain_m[num, j] = substr(ch[j], 5) + 0
        }
      }
    }

    # Runs on every line, before the structural rules below (which consume lines with "next").
    # Fenced code is an example, not artifact text: it neither opens a section nor cites anything.
    # Fence rules follow the compactor: a run of 3+ backticks or tildes, up to 3 spaces in, closed by
    # a bare run of the same character at least as long.
    {
      in_fence = 0
      t = $0; sub(/[ \t]+$/, "", t)
      if (fence_ch != "") {
        in_fence = 1
        if (t ~ /^ ? ? ?(`+|~+)$/) {
          sub(/^ +/, "", t)
          if (substr(t, 1, 1) == fence_ch && length(t) >= fence_len) fence_ch = ""
        }
      } else if (t ~ /^ ? ? ?(```|~~~)/) {
        in_fence = 1
        sub(/^ +/, "", t); fence_ch = substr(t, 1, 1); fence_len = 0
        while (substr(t, fence_len + 1, 1) == fence_ch) fence_len++
      }
      if (!in_fence) {
        vis = strip_comments($0)
        if ($0 ~ /^## /) cur_hist = ($0 ~ /[Hh]istory/) ? 1 : 0
        else if (cur_hist && vis ~ /^Earlier entries: \[decisions\/history\/[a-z-]+\.md\]/) load_archive(vis)
        if ((stale_map != "" || reg_ok) && !cur_hist && vis != "") check_stale(vis, NR)
      }
    }

    # With a register the fence state above gates every structural rule below: a heading, table row,
    # detail entry or checklist line inside a fenced example is an example, so a quoted
    # "## 9. History" or "### Phase A" cannot open a section or change a count. The fenced line still
    # ends a table. Without a register the structural tracking is exactly what it always was.
    reg_ok && in_fence { in_table = 0; in_rollup = 0; next }

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

    # The heading form of the same entry: "#### IC-002: <summary>". It counts only when the ID is
    # already an index row of this section, which is decidable here because a section states its
    # index table before its "**Detail**" marker, so idx is populated by the time a heading under
    # that marker is read. Everything else that looks ID-shaped — "#### C4 Level 1: System Context",
    # "#### Family: Checking" — matches no index row and is ignored outright: it neither satisfies a
    # row nor reports an orphan of its own. Section tracking is untouched, since sec advances on
    # "## " headings only.
    /^#### [A-Za-z]+-?[0-9]+:/ {
      line = $0; sub(/^#### /, "", line)
      if (match(line, /^[A-Za-z]+-?[0-9]+/)) {
        id = substr(line, 1, RLENGTH)
        # Only an id the index already carries counts. Two statements the bullet rule needs are
        # deliberately absent here: "all[id] = 1" is already set for every indexed id, and
        # "hist[id] = 1" is redundant here in both shapes a History section can take. Under the
        # documented Date-first table its ids never enter idx, so this branch is not reached at all;
        # under an ID-first table the index rule above has already set hist[id] from the row. Either
        # way the heading form is not the form to use in a History section -- see ARTIFACT_FORMAT.md
        # section 1, which says History detail uses the bullet form.
        if ((sec, id) in idx) { det[sec, id] = 1; dids[sec] = dids[sec] " " id }
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
