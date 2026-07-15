#!/usr/bin/env bash
# doflow-chain-test.sh — self-contained tests for the doflow chain's deterministic
# shell layer: do-paths.sh (resolver), do-prereqs.sh (gate), pre-implement-gate.sh (hook),
# and sync-context.sh (marker writer). Runs in a scratch git repo with a fake install dir;
# touches nothing outside a temp directory. Exit 0 = all pass.
#
# Usage: bash test/doflow-chain-test.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASH_SCRIPTS="$REPO_ROOT/core/scripts/doflow/bash"
HOOKS="$REPO_ROOT/core/hooks"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s (got: %s)\n' "$1" "$2"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2"; fi; }

command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git required"; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAKE="$T/claudehome"; mkdir -p "$FAKE/scripts/doflow/bash"
cp "$BASH_SCRIPTS/do-paths.sh" "$BASH_SCRIPTS/do-prereqs.sh" "$BASH_SCRIPTS/sync-context.sh" "$FAKE/scripts/doflow/bash/"
export CLAUDE_CONFIG_DIR="$FAKE"
PATHS="$FAKE/scripts/doflow/bash/do-paths.sh"
PREREQ="$FAKE/scripts/doflow/bash/do-prereqs.sh"
SYNC="$FAKE/scripts/doflow/bash/sync-context.sh"
GATE="$HOOKS/pre-implement-gate.sh"

mkdir -p "$T/repo"; cd "$T/repo" || exit 1
git init -q; git config user.email t@t; git config user.name t; git commit -q --allow-empty -m init
git branch -m master

echo "[resolver]"
eq "trunk branch -> slug null"        "$("$PATHS" | jq -r '.feature_slug // "null"')" "null"
git checkout -q -b feat/001-auth
eq "feat branch -> slug"              "$("$PATHS" | jq -r '.feature_slug')" "001-auth"
mkdir -p agent-docs/doflow/003-x agent-docs/doflow/007-y
eq "numbering = max(dirs,branch)+1"   "$("$PATHS" | jq -r '.next_number')" "008"
mkdir -p agent-docs/doflow/001-auth
eq "has_requirement false pre-file"   "$("$PATHS" | jq -r '.has_requirement')" "false"
echo r > agent-docs/doflow/001-auth/requirement.md
eq "has_requirement true post-file"   "$("$PATHS" | jq -r '.has_requirement')" "true"
eq "has_design false pre-file"        "$("$PATHS" | jq -r '.has_design')" "false"
echo d > agent-docs/doflow/001-auth/design.md
eq "has_design true post-file"        "$("$PATHS" | jq -r '.has_design')" "true"

echo "[prereqs gate]"
"$PREREQ" --require-plan >/dev/null 2>&1; eq "missing plan -> exit 2" "$?" "2"
echo p > agent-docs/doflow/001-auth/plan.md
"$PREREQ" --require-plan >/dev/null 2>&1; eq "prereqs met -> exit 0" "$?" "0"
rm agent-docs/doflow/001-auth/design.md
"$PREREQ" --require-plan >/dev/null 2>&1; eq "requirement+plan present, design missing -> exit 2" "$?" "2"
echo d > agent-docs/doflow/001-auth/design.md

echo "[pre-implement-gate hook]"
ROOT="$(pwd -P)"
decision() {
  # A PreToolUse hook that exits 0 with no JSON = allow. jq on empty stdin emits nothing,
  # so normalize empty -> "allow" here (the deny path prints a decision).
  local d; d=$(echo "$1" | bash "$GATE" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  echo "${d:-allow}"
}
# remove design.md so the feature is started-but-incomplete (widened gate: requirement+design+plan all required)
rm agent-docs/doflow/001-auth/design.md
eq "in-flow source edit, requirement+plan present but design missing -> deny" \
   "$(decision "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ROOT/src/A.java\"}}")" "deny"
eq "agent-docs edit -> allow" \
   "$(decision "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ROOT/agent-docs/doflow/001-auth/requirement.md\"}}")" "allow"
eq "outside-repo edit -> allow" \
   "$(decision "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/etc/hosts\"}}")" "allow"
eq "non-edit tool -> allow" \
   "$(decision "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}")" "allow"
echo d > agent-docs/doflow/001-auth/design.md
eq "prereqs met -> allow" \
   "$(decision "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ROOT/src/A.java\"}}")" "allow"
git checkout -q master
eq "not-in-flow (trunk) -> allow" \
   "$(decision "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ROOT/src/A.java\"}}")" "allow"

echo "[sync-context marker writer]"
CTX="$T/CLAUDE.md"; printf '# Ctx\n\nkeep me\n' > "$CTX"
printf 'pointer v1' | "$SYNC" --file "$CTX" >/dev/null
printf 'pointer v2' | "$SYNC" --file "$CTX" >/dev/null
eq "single marker block (idempotent)" "$(grep -c 'DOFLOW START' "$CTX")" "1"
eq "block updated to v2"               "$(grep -c 'pointer v2' "$CTX")" "1"
eq "original content preserved"        "$(grep -c 'keep me' "$CTX")" "1"

echo ""
echo "[Results] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && { echo "ALL DOFLOW CHAIN TESTS PASSED ✓"; exit 0; } || exit 1
