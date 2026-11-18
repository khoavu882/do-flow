#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# do-review-package.sh — write one commit range's review package to a file.
#
# Commit list, stat summary, and the diff with extended context, in one file a
# reviewer reads in a single call. The package deliberately never passes through
# the dispatching skill's own context: only the path does. That is the whole point
# — a diff pasted into a prompt stays resident for the rest of the session and is
# re-read on every later turn.
#
# The output file is named per RANGE, not per task, so a re-review after a fix
# round gets a distinct fresh file rather than re-reading the diff the first
# review already saw.
#
# Pass the base recorded BEFORE the implementer ran. `HEAD~1` silently drops
# every commit but the last of a multi-commit task.
#
# Read-only on the repository: it inspects history and writes one file inside the
# feature's own execution workspace.
#
# Usage:
#   do-review-package.sh --task=<id> --base=<sha> --head=<sha> [--slug=<slug>] [--json]
#
# Emits: {path, commits, bytes, base, head}, plus missing[] when the rules block could not be built.
#
# The package is a prompt frame written by `doflow-run prompt-frame`: the header, a role, the commits, the
# stat summary and the diff as input documents, the instructions with the "Rules" block (the mustCarry lines of
# the rule ledger, core/registry/rules.json, as the task and group briefs print them) and the stop rule, and
# the reply format. When the verb cannot run the package is written unframed, first line
# `frame-unavailable: <reason>`, and missing[] names `prompt-frame: <reason>`.

set -uo pipefail

task_id=""; base=""; head_ref=""; slug_override=""
# Shared argument rule: `--flag value` is read like `--flag=value` for the flags named here (do-args.sh).
_da="$(dirname "$0")/do-args.sh"
if [ -r "$_da" ]; then . "$_da"; doflow_normalize_args "--task --base --head --slug" "$@"; set -- ${DOFLOW_ARGS[@]+"${DOFLOW_ARGS[@]}"}; fi
for arg in "$@"; do
  case "$arg" in
    --task=*) task_id="${arg#--task=}" ;;
    --base=*) base="${arg#--base=}" ;;
    --head=*) head_ref="${arg#--head=}" ;;
    --slug=*) slug_override="${arg#--slug=}" ;;
    --json)   ;;
    *) ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","path":null}\n'
  exit 0
fi

for required in task_id base head_ref; do
  if [ -z "${!required}" ]; then
    jq -n --arg missing "$required" '{error:"missing-argument", argument:$missing, hint:"needs --task, --base and --head"}'
    exit 2
  fi
done

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  jq -n '{error:"not-a-git-repo", hint:"a review package is a commit range; there is no history here"}'
  exit 2
fi

for ref in "$base" "$head_ref"; do
  if ! git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    jq -n --arg ref "$ref" '{error:"bad-ref", ref:$ref}'
    exit 2
  fi
done

script_dir="$(cd "$(dirname "$0")" && pwd)"
paths="$(bash "$script_dir/do-exec-paths.sh" --task="$task_id" ${slug_override:+--slug="$slug_override"} 2>/dev/null)"
workspace="$(printf '%s' "$paths" | jq -r '.workspace // empty')"
if [ -z "$workspace" ]; then
  # See do-task-brief.sh: "${paths:-{...}}" terminates at the first unescaped `}`, appending a
  # stray brace to $paths and emitting unparseable JSON on every error passthrough.
  if [ -n "$paths" ]; then
    printf '%s\n' "$paths"
  else
    printf '%s\n' '{"error":"workspace-unresolved"}'
  fi
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
base7="$(git rev-parse --short "$base")"
head7="$(git rev-parse --short "$head_ref")"
out_rel="$workspace/review-$base7..$head7.diff"
out_abs="$repo_root/$out_rel"

# Guard before the write: a range that resolves to a valid-but-empty commit
# span (e.g. a malformed base SHA that still happens to name some ancestor
# commit) must never produce a package file at all — writing one first and
# catching it after would leave a syntactically valid, semantically empty
# file for a caller to stumble on if the guard were ever bypassed.
commits="$(git rev-list --count "$base..$head_ref" 2>/dev/null || echo 0)"
if [ "${commits:-0}" -eq 0 ]; then
  jq -n --arg base "$base7" --arg head "$head7" \
    '{error:"empty-range", base:$base, head:$head, hint:"range resolved but contains no commits — check the base SHA"}'
  exit 2
fi

# The registry file `core/registry/<name>` of the runtime this script belongs to: next to the checkout or
# projected runtime found above this script, else the global projected runtime (as do-task-brief.sh).
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

missing='[]'
rule_lines=""
rules_file="$(registry_file rules.json)"
if [ -z "$rules_file" ]; then
  missing='["brief-rules: core/registry/rules.json is missing"]'
else
  rule_lines="$(jq -r 'if (.mustCarry | type) == "array" and (.mustCarry | length) > 0 and (.mustCarry | all(type == "string")) then .mustCarry[] | "- " + . else empty end' "$rules_file" 2>/dev/null)"
  if [ -z "$rule_lines" ]; then
    missing='["brief-rules: core/registry/rules.json has no mustCarry array"]'
  fi
fi

# The package is a prompt frame (row 173): each body is written to a file in a scratch dir and the
# `prompt-frame` verb reads them by path, so no diff text ever passes through a command line or a JSON
# document. The dispatcher is found as do-task-brief.sh finds it.
tmp="$(mktemp -d 2>/dev/null)" || tmp=""
if [ -z "$tmp" ]; then
  jq -n --arg path "$out_rel" \
    '{error:"write-failed", path:$path, hint:"the review package could not be written — no scratch directory"}'
  exit 2
fi
trap 'rm -rf "$tmp"' EXIT

write_ok=1
printf 'Review package: %s..%s\n' "$base7" "$head7" > "$tmp/header" || write_ok=0
printf 'You are a reviewer of commits `%s..%s`; you read and report, and change nothing.\n' "$base7" "$head7" > "$tmp/role" || write_ok=0
git log --oneline "$base..$head_ref" > "$tmp/commits" 2>/dev/null || write_ok=0
git diff --stat "$base..$head_ref" > "$tmp/stat" 2>/dev/null || write_ok=0
git diff -U10 "$base..$head_ref" > "$tmp/diff" 2>/dev/null || write_ok=0
printf '%s\n' 'Review the diff in input against the rules below and the protocol your dispatch names.' > "$tmp/outcome" || write_ok=0
printf '%s\n' 'Stop when every changed file has been read; a finding needs a file and line.' > "$tmp/stop" || write_ok=0
printf '%s\n' 'The session that dispatched you' > "$tmp/reader" || write_ok=0
printf '%s\n' 'Use the findings format and the closing `Status:` line your dispatch names.' > "$tmp/lines" || write_ok=0
if [ -n "$rule_lines" ]; then printf '%s\n' "$rule_lines" > "$tmp/rules" || write_ok=0; fi

frame_reason=""
if [ "$write_ok" -eq 1 ]; then
  dispatcher="$script_dir/../bin/doflow-run"
  if [ ! -f "$dispatcher" ]; then
    frame_reason="the dispatcher was not found"
  else
    frame_args=(prompt-frame --action render --json --out "$out_abs"
      --part "header=$tmp/header" --part "role=$tmp/role"
      --part "input.doc:id=commits=$tmp/commits"
      --part "input.doc:id=files changed=$tmp/stat"
      --part "input.doc:id=diff=$tmp/diff"
      --part "instructions.outcome=$tmp/outcome")
    if [ -n "$rule_lines" ]; then frame_args+=(--part "instructions.constraint:Rules=$tmp/rules"); fi
    frame_args+=(--part "instructions.stop=$tmp/stop" --part "output_format.reader=$tmp/reader" --part "output_format.lines=$tmp/lines")
    (cd "$repo_root" 2>/dev/null && bash "$dispatcher" "${frame_args[@]}" </dev/null >/dev/null 2>&1)
    frame_rc=$?
    if [ "$frame_rc" -ne 0 ]; then frame_reason="prompt-frame exited $frame_rc"; fi
  fi
  if [ -n "$frame_reason" ]; then
    # Fail open: the package is still written, unframed (the header, then each body in section order,
    # one blank line between), and the loss is named in missing[] — a reviewer with no frame beats none.
    {
      echo "frame-unavailable: $frame_reason"
      cat "$tmp/header"
      for part in role commits stat diff outcome rules stop reader lines; do
        if [ -s "$tmp/$part" ]; then echo; cat "$tmp/$part"; fi
      done
    } > "$out_abs" 2>/dev/null || write_ok=0
    missing="$(printf '%s' "$missing" | jq -c --arg reason "prompt-frame: $frame_reason" '. + [$reason]')"
  fi
fi

# Reporting a path for a file that was never written is worse than failing: the caller
# dispatches a reviewer at nothing, and the reviewer's own fallback re-derives the diff in
# its context — the exact cost this package exists to avoid. A real package always has its
# header, so empty means the write did not survive.
if [ "$write_ok" -eq 0 ] || [ ! -s "$out_abs" ]; then
  jq -n --arg path "$out_rel" \
    '{error:"write-failed", path:$path, hint:"the review package could not be written — check the workspace is writable"}'
  exit 2
fi

bytes="$(wc -c < "$out_abs" 2>/dev/null | tr -d ' ')"

jq -n \
  --arg path "$out_rel" \
  --argjson commits "${commits:-0}" \
  --argjson bytes "${bytes:-0}" \
  --arg base "$base7" --arg head "$head7" \
  --argjson missing "$missing" \
  '{path:$path, commits:$commits, bytes:$bytes, base:$base, head:$head} + (if ($missing | length) > 0 then {missing:$missing} else {} end)'
exit 0
