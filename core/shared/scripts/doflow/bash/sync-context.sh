#!/usr/bin/env bash
# sync-context.sh — idempotently write a marker-delimited block into an agent context
# file (CLAUDE.md / AGENTS.md / .github/copilot-instructions.md). Used by /do-constitution
# to propagate a pointer to the active constitution without rewriting the whole file.
#
# The block body is read from stdin; markers are added by this script. Re-running with new
# content REPLACES the previous block (idempotent — never duplicates). Deterministic so the
# model never does between-marker text surgery itself. Fail-open: errors exit 0.
#
# Usage:  printf '%s' "<body>" | sync-context.sh --file <context-file>

set -uo pipefail

START="<!-- DOFLOW START -->"
END="<!-- DOFLOW END -->"

file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$file" ] || { echo "sync-context: --file required" >&2; exit 0; }

content="$(cat)"
block="$START
$content
$END"

if [ ! -f "$file" ]; then
  printf '%s\n' "$block" > "$file" && echo "sync-context: created $file"
  exit 0
fi

if grep -qF "$START" "$file" && grep -qF "$END" "$file"; then
  awk -v s="$START" -v e="$END" -v repl="$block" '
    $0==s {print repl; skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file" && echo "sync-context: updated block in $file"
else
  printf '\n%s\n' "$block" >> "$file" && echo "sync-context: appended block to $file"
fi
exit 0
