# emission.jq — one-pass renderer of the prompt segments and the hook response (078 IC-002, IC-004
# step 7). renderEmission() in src/runtime/context/arbitrate.ts is the reference; both must give
# expected.text, bytes, refused and dropped of test/fixtures/emission/render-corpus.json byte for
# byte (IC-022, RK7).
#
# Invocation (IC-004 step 7), one process:
#   jq -n -r -f emission.jq --argjson plan "$PLAN" \
#     --rawfile git <git-context.json> --rawfile summary <claimed summary> \
#     --rawfile grant <claimed grant> --arg warning "$WARNING" --arg nudge "$NUDGE"
#
# All four names are always bound (jq refuses an undefined $name); emission.sh binds $warning with
# --arg, because the warning claim renames the file and reads it before the render. A file that does not
# exist is passed as /dev/null and its name listed in plan.absent; an empty existing file is not
# absent (an empty warning still renders, an empty git capture is "Not a git repository.").
#
# plan:
#   actions       IC-001 actions by segment; only git, summary, warning, grant and nudge render here
#   maxBytes      positive integer, the IC-002 byte budget
#   harness       the harness name (DOFLOW_AGENT); sessionTitle is added on every harness but
#                 "codex", whose envelope rejects unknown fields (DEC-030)
#   title         true when a title may be set (the payload carries no session_title)
#   absent        names among git, summary, grant, warning whose file does not exist (default [])
#   summaryBytes  the claimed summary file's full size, which can exceed the bounded read; it
#                 defaults to the UTF-8 size of $summary
#   mode          "response" (default) prints the hook response; "render" prints
#                 {text, bytes, refused, dropped, segments}, the renderEmission() result, for parity;
#                 "hook" (emission.sh, run with -r) prints one first line holding the dropped
#                 segment names joined with tabs (possibly empty), then the hook response
#
# Response bytes (jq's default pretty print): emission is
#   {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ...}}
# with sessionTitle on every harness but Codex (DEC-030), when plan.title holds and the git action built a title
# ("{branch?unknown} — {sha?unknown}", or "no-git" outside a repository; none when the capture
# file is missing). Nothing rendered prints {} and a newline. Any error exits non-zero and the
# caller answers with the silent response.
#
# Counting (design R1): characters are code points (jq string length and slices), budgets are
# UTF-8 bytes (utf8bytelength). Portability: jq 1.6+ built with Oniguruma; utf8bytelength is the
# one builtin newer than 1.5. No index/rindex on strings (byte offsets in 1.6) and no 1.7-only
# builtin (trim, ltrim, rtrim, abs, pick, toarray, have_decnum). Every regex is anchored
# with \A or \z, never ^ or $, which Oniguruma reads per line.

def summary_cap: 4000;
def summary_read: 65536;

# Trailing newlines removed, as $(...) does.
def rstrip_nl: sub("\n+\\z"; "");
def no_cr: split("\r") | join("");

# `jq -r '<field> // empty'` in a $(...): null and false are empty, other scalars print as JSON.
def jq_field:
  if . == null or . == false then ""
  elif type == "string" then rstrip_nl
  else tojson | rstrip_nl
  end;

# A summary or grant record: \r removed, trailing newlines dropped, frontmatter keys from the lines
# between the first two `---` lines (first match wins, spaces after `key:` stripped), body from the
# first non-empty line after the second `---`, trailing newlines dropped. Fewer than two `---`
# lines give an empty body.
def parse_record:
  (no_cr | rstrip_nl | split("\n"))
  | reduce .[] as $line ({fences: 0, started: false, fields: {}, body: []};
      if .fences < 2 and $line == "---" then .fences += 1
      elif .fences == 1 then
        ($line | split(":")) as $parts
        | if ($parts | length) > 1 and ($parts[0] | length) > 0 and (.fields | has($parts[0]) | not)
          then .fields[$parts[0]] = ($parts[1:] | join(":") | sub("\\A +"; ""))
          else . end
      elif .fences >= 2 and (.started or $line != "") then .started = true | .body += [$line]
      else . end)
  | {fields: .fields, body: (.body | join("\n") | rstrip_nl)};

# A bracketed header value: `]` removed, then empty when it is "unknown".
def known: (. // "") | split("]") | join("") | if . == "unknown" then "" else . end;

def header_tail:
  (.compacted_at | known) as $at | (.branch | known) as $branch
  | (if $at != "" then ", compacted \($at)" else "" end)
    + (if $branch != "" then " on branch \($branch)" else "" end);

# The git capture as an object; anything unparseable or not an object reads as {}.
def capture($raw):
  (try ($raw | fromjson) catch null) | if type == "object" then . else {} end;

def is_repo: (.is_git_repo | jq_field) == "true";

def render_git($raw; $missing):
  if $missing then "Git context unavailable for this session."
  else capture($raw)
    | if is_repo | not then "Not a git repository."
      else
        ((if (.commits | type) == "array" then .commits else [] end)
          | map(jq_field) | map(select(. != "")) | .[0:5] | join(" · ")) as $commits
        | (.stash_count | jq_field) as $stash
        | "Git context — branch: \(.branch | jq_field | if . == "" then "unknown" else . end) | \(.sha | jq_field | if . == "" then "unknown" else . end)\n"
          + "Last commits: \(if $commits == "" then "none" else $commits end)\n"
          + "Uncommitted files: \(.uncommitted_count | jq_field | if . == "" then "0" else . end)"
          + (if ($stash | test("\\A[0-9]+\\z")) and ($stash | tonumber) > 0 then " | Stashed: \($stash)" else "" end)
      end
  end;

def git_title($raw; $missing):
  if $missing then null
  else capture($raw)
    | if is_repo then
        "\(.branch | jq_field | if . == "" then "unknown" else . end) — \(.sha | jq_field | if . == "" then "unknown" else . end)"
      else "no-git" end
  end;

# null when the body is empty: an empty summary renders nothing.
def render_summary($size):
  parse_record
  | if .body == "" then null
    else (.body | length) as $n
      | (if $n > summary_cap
          then .body[0:summary_cap] + "\n[summary truncated: first \(summary_cap) of \(if $size > summary_read then "at least " else "" end)\($n) characters]"
          else .body end) as $shown
      | "\n\n[Prior session summary\(.fields | header_tail)]\n\($shown)"
    end;

def render_grant: "[Granted summary from lineage \(.fields.from_lineage // "")\(.fields | header_tail)]\n\(.body)";

def render_pointer($max): "[Granted summary \(.fields.summary_id // "") withheld: \(.body | utf8bytelength) bytes exceed the \($max)-byte context budget]";

def join_order: ["git", "summary", "warning", "grant", "nudge"];

# IC-002 join: summary drops its leading blank line when nothing precedes it; grant and nudge gain
# one when something does.
def join_segments:
  . as $p
  | reduce (join_order[] | select($p[.] != null)) as $s ("";
      if $s == "summary" then (if . == "" then . + ($p[$s] | .[2:]) else . + $p[$s] end)
      elif $s == "grant" or $s == "nudge" then (if . == "" then "" else . + "\n\n" end) + $p[$s]
      else . + $p[$s] end);

def render($plan; $in):
  ($plan.actions // {}) as $a
  | $plan.maxBytes as $max
  | if ($max | type) != "number" or $max <= 0 or ($max | floor) != $max then error("plan.maxBytes must be a positive integer") else . end
  | ($plan.absent // []) as $absent
  | def present($k): ($absent | map(select(. == $k)) | length) == 0;
    ({}
      | if $a.git == "include" then .git = render_git($in.git; present("git") | not) else . end
      | if $a.summary == "truncate" and present("summary")
        then ($in.summary | render_summary($plan.summaryBytes // ($in.summary | utf8bytelength))) as $s
          | if $s != null then .summary = $s else . end
        else . end
      | if $a.warning == "include" and present("warning") then .warning = "\n[Prior session warning: \($in.warning | rstrip_nl)]" else . end
      | if $a.nudge == "include" and ($in.nudge | type) == "string" and $in.nudge != "" then .nudge = $in.nudge else . end
    ) as $optional
    | (if ($a.grant == "whole" or $a.grant == "pointer") and present("grant")
        then ($in.grant | parse_record) as $r
          | ($r | render_grant) as $whole
          | if $a.grant == "whole" and ($whole | utf8bytelength) <= $max
            then {selected: {grant: $whole}, refused: false}
            else {selected: {grant: ($r | render_pointer($max))}, refused: true} end
        else {selected: {}, refused: false} end)
    | . + {dropped: []}
    | reduce ("git", "summary", "warning", "nudge") as $s (.;
        if $optional[$s] == null then .
        elif (.selected + {($s): $optional[$s]} | join_segments | utf8bytelength) <= $max then .selected[$s] = $optional[$s]
        else .dropped += [$s] end)
    | (.selected | join_segments) as $text
    | {
        text: (if $text == "" then null else $text end),
        bytes: ($text | utf8bytelength),
        refused: .refused,
        dropped: .dropped,
        segments: [join_order[] as $s | select(.selected[$s] != null) | $s]
      };

def response($plan; $in; $result):
  if $result.text == null then {}
  else
    (if $plan.harness != "codex" and $plan.title == true and ($plan.actions // {}).git == "include"
      then git_title($in.git; ($plan.absent // []) | map(select(. == "git")) | length > 0) else null end) as $title
    | {"hookSpecificOutput": ({"hookEventName": "UserPromptSubmit", "additionalContext": $result.text}
        + (if $title != null and $title != "" then {"sessionTitle": $title} else {} end))}
  end;

{git: $git, summary: $summary, grant: $grant, warning: $warning, nudge: $nudge} as $in
| render($plan; $in) as $result
| ($plan.mode // "response") as $mode
| if $mode == "render" then $result
  elif $mode == "hook" then ($result.dropped | join("\t")), response($plan; $in; $result)
  else response($plan; $in; $result) end
