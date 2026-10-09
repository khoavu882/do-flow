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
#
# Cost: a prompt can be a pasted log of hundreds of KB, and every prompt of a session is
# decided until the session is nudged or suppressed. Work over the whole prompt is limited to
# single regex scans, slicing and splitting, which jq does natively; lowercasing and the line
# test, which jq does one character or one line at a time, touch only bounded pieces. Each
# such shortcut gives the answer IC-005's steps give on the whole prompt (see the differential
# case in test/hooks/prompt-nudge-decision.test.js).

# Whitespace removed from both ends. The trailing match may start only where a whitespace run
# starts: a plain \s+$ retries from every position of a long interior run, which is quadratic
# (a 20 KB run of spaces took 1.7 s). It runs on the last 1024 characters, and on the whole
# text only when those are all whitespace.
def strip_ws:
  sub("^\\s+"; "")
  | length as $n
  | if $n <= 1024 then sub("(?<!\\s)\\s+$"; "")
    else (.[$n - 1024:] | sub("(?<!\\s)\\s+$"; "")) as $tail
    | if $tail != "" then .[0:$n - 1024] + $tail else sub("(?<!\\s)\\s+$"; "") end
    end;

# A list entry with every regex metacharacter escaped. An empty entry is an error rather than
# a pattern that matches anything. Only an entry holding a metacharacter is rebuilt character by
# character; that loop is the costly part of building the patterns on every prompt.
def esc:
  if . == "" then error("promptNudge holds an empty list entry")
  elif test("[.*+?()\\[\\]{}|^$\\\\]") | not then .
  else ("\\.*+?()[]{}|^$" | explode) as $meta
    | explode
    | map(. as $c | if any($meta[]; . == $c) then [92, $c] else [$c] end)
    | add
    | implode
  end;

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

# Each entry as a pattern that matches where the ASCII-lowercased text holds the entry: every
# lowercase ASCII letter becomes [xX], everything else is literal. An entry with an uppercase
# ASCII letter can never occur in lowercased text, so it is left out. One pattern per entry: an
# alternation of [xX]-led entries cannot skip ahead and scans about twice as slowly.
def ascii_ci_patterns($v; $name):
  [string_list($v; $name)[] | (esc | explode) as $e | select(all($e[]; . < 65 or . > 90))
   | $e | map(if 97 <= . and . <= 122 then [91, ., . - 32, 93] else [.] end) | add | implode];

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
    phrases: ascii_ci_patterns($n.excludeContainsPhrases; "excludeContainsPhrases"),
    stallWords: (alt($n.stallWords; "stallWords") | $n.stallWords),
    stallWidth: ([$n.stallWords[] | length] | max),
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
# Step 1: the prompt as a string, carriage returns removed, trimmed. IC-005 states the steps
# on the ASCII-lowercased prompt `lt`; lowercasing costs a jq step per character (about 80 ms
# on 200 KB), so only bounded slices are lowercased and every whole-prompt check below runs on
# `t` in a form that gives the same answer as on `lt`.
| (if type == "object" then .prompt else null end) as $raw
| (if ($raw | type) == "string" then $raw else "" end
   | if contains("\r") then split("\r") | join("") else . end | strip_ws) as $t
# Step 2 runs before the length floor so a short /do-plan also ends evaluation (suppress).
# IC-005's (^|[\s`'"(])/do(-[a-z]+)?\b on lt, as /[dD][oO]\b on t not preceded by a character
# outside that class: the optional -name never changes whether it matches, and a pattern that
# starts with `/` lets the regex engine skip to each slash.
| if ($t | test("(?<![^\\s`'\"(])/[dD][oO]\\b")) then "suppress"
  elif ($t | length) < $re.minChars then ""
  elif any($re.prefixes[]; . as $x | $t | startswith($x)) then ""
  # Step 5: lt is a stall word followed only by punctuation and spaces. Lowercasing touches
  # neither, so the head is lowercased and the rest checked on t.
  elif (($t[0:$re.stallWidth] | ascii_downcase) as $h
        | any($re.stallWords[]; . as $w
              | ($h | startswith($w)) and ($t[($w | length):] | test("\\A[[:punct:]\\s]*\\z")))) then ""
  elif ($t | endswith("?")) then ""
  elif any($re.phrases[]; . as $x | $t | test($x)) then ""
  # Step 8: only the first and the last non-empty lines are judged. t starts and ends with a
  # non-space character, so its first and last lines are the first and last non-empty ones.
  elif ($t | split("\n") | [.[0], .[-1]] | unique
        | any(.[]; strip_ws | line_ok($re))) then "nudge"
  else ""
  end
