#!/usr/bin/env bash
# sync-context.sh — idempotently write a marker-delimited block into an agent context
# file (CLAUDE.md / AGENTS.md / .github/copilot-instructions.md). Used by /do-constitution
# to propagate a pointer to the active constitution without rewriting the whole file.
#
# The block body is read from stdin; markers are added by this script. Re-running with new
# content REPLACES the previous block (idempotent — never duplicates). Deterministic so the
# model never does between-marker text surgery itself.
#
# Exit codes follow the dispatcher's uniform contract (design.md §4.2): 0 success, 1 the write
# did not land, 2 a usage error. This script used to exit 0 on a missing --file and on a failed
# write, which made every failure indistinguishable from success to its one caller
# (/do-constitution) — the skill is responsible for reporting whether the pointer landed, and it
# cannot report what it cannot observe.
#
# Usage:  printf '%s' "<body>" | sync-context.sh --file <context-file>

set -uo pipefail

START="<!-- DOFLOW START -->"
END="<!-- DOFLOW END -->"

file=""
while [ $# -gt 0 ]; do
  case "$1" in
    # `shift 2` fails when --file is the last argument, leaving $# unchanged and the loop
    # spinning forever; consume the flag first so the value shift is always safe.
    --file) shift; file="${1:-}"; [ $# -gt 0 ] && shift ;;
    *) shift ;;
  esac
done
[ -n "$file" ] || { echo "sync-context: --file required" >&2; exit 2; }

content="$(cat)"
block="$START
$content
$END"

if [ ! -f "$file" ]; then
  printf '%s\n' "$block" > "$file" || { echo "sync-context: could not create $file" >&2; exit 1; }
  echo "sync-context: created $file"
  exit 0
fi

if grep -qF "$START" "$file" && grep -qF "$END" "$file"; then
  # $block contains embedded newlines; passing it via awk -v triggers "newline in string" on
  # BSD awk (macOS). Route it through ENVIRON instead — env-var access bypasses -v's
  # argument-parsing grammar on both GNU and BSD awk.
  export SYNC_CONTEXT_BLOCK="$block"
  awk -v s="$START" -v e="$END" '
    $0==s {
      n = split(ENVIRON["SYNC_CONTEXT_BLOCK"], lines, "\n")
      for (i = 1; i <= n; i++) print lines[i]
      skip=1; next
    }
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file" ||
    { rm -f "$file.tmp"; echo "sync-context: could not update the block in $file" >&2; exit 1; }
  echo "sync-context: updated block in $file"
else
  printf '\n%s\n' "$block" >> "$file" ||
    { echo "sync-context: could not append the block to $file" >&2; exit 1; }
  echo "sync-context: appended block to $file"
fi
exit 0
