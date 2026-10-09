# prompt-nudge.jq — decision program for the standalone-prompt nudge (IC-005)
#
# Invocation, identical in the UserPromptSubmit hook and in the corpus runner:
#   printf '%s' "$INPUT" | jq -r --slurpfile R <registry> -f prompt-nudge.jq
# Input is the hook payload on stdin; $R[0] is core/registry/workflows.json and its
# `promptNudge` object holds every rule (IC-007). Output is one line: `nudge`, `suppress`,
# or empty. jq exits non-zero only on an error, and the caller treats that as silence.
#
# The rules are data; this file is the algorithm. It reads only `.` and $R[0].promptNudge,
# keeps no state, and gives the same output for the same input. A missing or mistyped
# rule, or a pathPattern that does not compile, is an error on every prompt, never a default.
#
# Portability: jq 1.5 built with Oniguruma. No builtin newer than 1.5 (no IN, trim, pick,
# abs, toarray, splits, $__loc__, halt_error), no if without else, no input or environment.
# Only the step 2 pattern and pathPattern are regexes; every list entry is matched literally.
# Whole-prompt anchors use \A and \z so a newline inside the prompt never ends a match.

# Whitespace removed from both ends. The trailing match may start only where a whitespace run
# starts: a plain \s+$ retries from every position of a long interior run, which is quadratic
# (a 20 KB run of spaces took 1.7 s).
def strip_ws: sub("^\\s+"; "") | sub("(?<!\\s)\\s+$"; "");

# A list entry with every regex metacharacter escaped. An empty entry makes `add` null and
# `implode` fail, so an empty entry is an error rather than a pattern that matches anything.
def esc:
  ("\\.*+?()[]{}|^$" | explode) as $meta
  | explode
  | map(. as $c | if any($meta[]; . == $c) then [92, $c] else [$c] end)
  | add
  | implode;

def string_list($v; $name):
  if ($v | type) == "array" and ($v | length) > 0 and all($v[]; type == "string")
  then $v
  else error("promptNudge.\($name) is not a non-empty list of strings")
  end;

def int($v; $name):
  if ($v | type) == "number" and $v == ($v | floor)
  then $v
  else error("promptNudge.\($name) is not an integer")
  end;

# One alternation of literal entries, for use inside (?: ... ).
def alt($v; $name): string_list($v; $name) | map(esc) | join("|");

# The line test: one line, already trimmed and non-empty, judged against the compiled rules.
def line_ok($re):
  .[0:$re.maxScan] as $l
  | ($l | ascii_downcase | sub($re.lead; "")) as $ll
  | ($ll | sub($re.verb; "")) as $after
  | ($ll | test("\\?\\s*$") | not)
    and ($ll | test($re.startWord) | not)
    and ($ll | test($re.verb))
    and ($after | test($re.objectBlocker) | not)
    and ($ll | test($re.contextBlocker) | not)
    and (($after | test($re.noun)) or ($l | test($re.path)));

($R[0].promptNudge) as $n
| if ($n | type) == "object" then . else error("promptNudge is missing or not an object") end
| {
    minChars: int($n.minChars; "minChars"),
    maxScan: int($n.maxScanChars; "maxScanChars"),
    prefixes: string_list($n.excludePrefixes; "excludePrefixes"),
    phrases: string_list($n.excludeContainsPhrases; "excludeContainsPhrases"),
    stall: ("\\A(?:" + alt($n.stallWords; "stallWords") + ")[[:punct:]\\s]*\\z"),
    lead: ("^(?:(?:" + alt($n.leadIns; "leadIns") + "),?\\s+)+"),
    startWord: ("^(?:" + alt($n.excludeStartWords; "excludeStartWords") + ")\\b"),
    verb: ("^(?:" + alt($n.verbs; "verbs") + ")\\b"),
    objectBlocker: ("^\\s+(?:" + alt($n.objectBlockers; "objectBlockers") + ")\\b"),
    contextBlocker: ("\\b(?:" + alt($n.contextBlockers; "contextBlockers") + ")\\b"),
    noun: ("\\b(?:" + alt($n.nouns; "nouns") + ")s?\\b"),
    path: $n.pathPattern
  } as $re
# pathPattern is compiled here on every prompt, so a broken pattern never hides behind an
# early return.
| ("" | test($re.path)) as $path_compiles
# Step 1: the prompt as a string, carriage returns removed, trimmed, ASCII-lowercased.
| (if type == "object" then .prompt else null end) as $raw
| (if ($raw | type) == "string" then $raw else "" end | split("\r") | join("") | strip_ws) as $t
| ($t | ascii_downcase) as $lt
# Step 2 runs before the length floor so a short /do-plan also ends evaluation (suppress).
| if ($lt | test("(^|[\\s`'\"(])/do(-[a-z]+)?\\b")) then "suppress"
  elif ($t | length) < $re.minChars then ""
  elif any($re.prefixes[]; . as $x | $t | startswith($x)) then ""
  elif ($lt | test($re.stall)) then ""
  elif ($lt | endswith("?")) then ""
  elif any($re.phrases[]; . as $x | $lt | contains($x)) then ""
  # Step 8: only the first and the last non-empty lines are judged.
  elif ([$t | split("\n")[] | select(test("\\S"))] | [.[0], .[-1]] | unique
        | any(.[]; strip_ws | line_ok($re))) then "nudge"
  else ""
  end
