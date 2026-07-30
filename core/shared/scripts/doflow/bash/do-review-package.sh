#!/usr/bin/env bash
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
# Emits: {path, commits, bytes, base, head}

set -uo pipefail

task_id=""; base=""; head_ref=""; slug_override=""
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
  printf '%s\n' "${paths:-{\"error\":\"workspace-unresolved\"}}"
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
base7="$(git rev-parse --short "$base")"
head7="$(git rev-parse --short "$head_ref")"
out_rel="$workspace/review-$base7..$head7.diff"
out_abs="$repo_root/$out_rel"

{
  echo "# Review package: $base7..$head7"
  echo
  echo "## Commits"
  git log --oneline "$base..$head_ref"
  echo
  echo "## Files changed"
  git diff --stat "$base..$head_ref"
  echo
  echo "## Diff"
  git diff -U10 "$base..$head_ref"
} > "$out_abs" 2>/dev/null

commits="$(git rev-list --count "$base..$head_ref" 2>/dev/null || echo 0)"
bytes="$(wc -c < "$out_abs" 2>/dev/null | tr -d ' ')"

jq -n \
  --arg path "$out_rel" \
  --argjson commits "${commits:-0}" \
  --argjson bytes "${bytes:-0}" \
  --arg base "$base7" --arg head "$head7" \
  '{path:$path, commits:$commits, bytes:$bytes, base:$base, head:$head}'
exit 0
