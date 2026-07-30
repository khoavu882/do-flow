#!/usr/bin/env bash
# doflow-chain-test.sh — self-contained tests for the doflow chain's deterministic
# shell layer: do-paths.sh (resolver), do-prereqs.sh (gate), pre-implement-gate.sh (hook),
# and sync-context.sh (marker writer). Runs in a scratch git repo with a fake install dir;
# touches nothing outside a temp directory. Exit 0 = all pass.
#
# Usage: bash test/doflow-chain-test.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASH_SCRIPTS="$REPO_ROOT/core/shared/scripts/doflow/bash"
HOOKS="$REPO_ROOT/core/harnesses/claude/hooks"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s (got: %s)\n' "$1" "$2"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2"; fi; }

command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git required"; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAKE="$T/claudehome"; mkdir -p "$FAKE/scripts/doflow/bash"
cp "$BASH_SCRIPTS/do-paths.sh" "$BASH_SCRIPTS/do-prereqs.sh" "$BASH_SCRIPTS/sync-context.sh" \
   "$BASH_SCRIPTS/do-exec-paths.sh" "$BASH_SCRIPTS/do-task-brief.sh" \
   "$BASH_SCRIPTS/do-review-package.sh" "$BASH_SCRIPTS/do-parallel-check.sh" "$FAKE/scripts/doflow/bash/"
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

echo "[resolver: constitution_base]"
# do-paths.sh's constitution_base search is script_dir-relative (based on $0, not $PWD), so it must
# actually be invoked from a synthetic .doflow/scripts/doflow/bash/do-paths.sh path to exercise the
# real candidate list, not run in place from core/shared/.
CB="$T/doflowhome"; mkdir -p "$CB/.doflow/scripts/doflow/bash" "$CB/.doflow/guidance/references"
cp "$BASH_SCRIPTS/do-paths.sh" "$CB/.doflow/scripts/doflow/bash/"
CBPATHS="$CB/.doflow/scripts/doflow/bash/do-paths.sh"
echo base > "$CB/.doflow/guidance/references/CONSTITUTION_BASE.md"
eq "constitution_base found via script_dir-relative .doflow candidate" \
   "$("$CBPATHS" --paths-only | jq -r '.constitution_base')" \
   "$CB/.doflow/guidance/references/CONSTITUTION_BASE.md"
rm "$CB/.doflow/guidance/references/CONSTITUTION_BASE.md"
FAKEHOME="$T/fakehome"; mkdir -p "$FAKEHOME/.doflow/guidance/references"
echo global > "$FAKEHOME/.doflow/guidance/references/CONSTITUTION_BASE.md"
eq "constitution_base falls back to \$HOME/.doflow when no local candidate" \
   "$(HOME="$FAKEHOME" "$CBPATHS" --paths-only | jq -r '.constitution_base')" \
   "$FAKEHOME/.doflow/guidance/references/CONSTITUTION_BASE.md"
rm -rf "$FAKEHOME/.doflow"
eq "constitution_base is null when no candidate exists" \
   "$(HOME="$FAKEHOME" "$CBPATHS" --paths-only | jq -r '.constitution_base // "null"')" \
   "null"

echo "[resolver: constitution_local existence]"
# has_constitution_local is repo-scoped, not feature-scoped, and must survive --paths-only. A naive
# present/absent test passes even if the flag were computed inside the feature block or behind the
# --paths-only skip, so both of those placements get their own assertion below.
eq "has_constitution_local false when tier-2 absent" \
   "$("$PATHS" | jq -r '.has_constitution_local')" "false"
eq "constitution_local path still emitted when absent (do-constitution's create path needs it)" \
   "$("$PATHS" | jq -r '.constitution_local')" "agent-docs/constitution.md"
# Anchored to the scratch repo rather than the cwd, matching how every other scratch path in this
# file is built. The assertions above still compare against the *relative* string, because that is
# what the resolver emits.
LOCALCON="$T/repo/agent-docs/constitution.md"
mkdir -p "$(dirname "$LOCALCON")" && echo "# local" > "$LOCALCON"
eq "has_constitution_local true when tier-2 present" \
   "$("$PATHS" | jq -r '.has_constitution_local')" "true"
eq "has_constitution_local survives --paths-only (not behind the cheap-mode skip)" \
   "$("$PATHS" --paths-only | jq -r '.has_constitution_local')" "true"
# Prove repo-scope by asking off a non-feature branch. Save and restore the branch: later tests in
# this file depend on the scratch repo's branch state, and leaking a switch out of this block breaks
# them.
# The slug is empty only on a trunk name (main/master/develop/HEAD) — any other branch name becomes
# a slug, which would leave feature_slug non-empty and defeat the point of this check. Borrow
# `develop`; -B rather than -b so a pre-existing branch of that name is reset instead of erroring.
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git checkout -q -B develop
eq "no active feature on a trunk branch, so the next assertion really tests repo scope" \
   "$("$PATHS" | jq -r '.feature_slug // "null"')" "null"
eq "has_constitution_local correct with no active feature (repo-scoped, not feature-scoped)" \
   "$("$PATHS" | jq -r '.has_constitution_local')" "true"
git checkout -q "$ORIG_BRANCH"
git branch -q -D develop
rm -f "$LOCALCON"

echo "[resolver: non-git root fallback]"
# Reproduces the real bug: doflow installed at a container root above the actual git repos
# (e.g. a multi-service workspace) has no branch to derive feature_slug from at all — resolution
# must fall back to scanning agent-docs/doflow/ directly instead of permanently reporting null.
NG="$T/nongit"; mkdir -p "$NG"; cd "$NG" || exit 1
eq "non-git root, no agent-docs -> is_git_repo false" "$("$PATHS" --json | jq -r '.is_git_repo')" "false"
eq "non-git root, no agent-docs -> slug null"         "$("$PATHS" --json | jq -r '.feature_slug // "null"')" "null"
mkdir -p agent-docs/doflow/001-solo
eq "non-git root, exactly one feature dir -> auto-selected" \
   "$("$PATHS" --json | jq -r '.feature_slug')" "001-solo"
eq "non-git root, one dir -> candidate_slugs empty" \
   "$("$PATHS" --json | jq -c '.candidate_slugs')" "[]"
mkdir -p agent-docs/doflow/002-other
eq "non-git root, two feature dirs -> slug still null" \
   "$("$PATHS" --json | jq -r '.feature_slug // "null"')" "null"
eq "non-git root, two feature dirs -> candidate_slugs lists both" \
   "$("$PATHS" --json | jq -c '.candidate_slugs | sort')" '["001-solo","002-other"]'
"$PATHS" --json --require feature >/dev/null 2>&1; eq "ambiguous + --require feature -> exit 2" "$?" "2"
eq "ambiguous + --require feature -> error is ambiguous-feature (not no-active-feature)" \
   "$("$PATHS" --json --require feature 2>/dev/null | jq -r '.error')" "ambiguous-feature"
eq "--slug override resolves the ambiguity" \
   "$("$PATHS" --json --slug=002-other | jq -r '.feature_slug')" "002-other"
rm -rf agent-docs
"$PATHS" --json --require feature >/dev/null 2>&1; eq "zero feature dirs + --require feature -> exit 2" "$?" "2"
eq "zero feature dirs -> error is no-active-feature (not ambiguous)" \
   "$("$PATHS" --json --require feature 2>/dev/null | jq -r '.error')" "no-active-feature"

# Regression: a stray non-numeric dir under agent-docs/doflow/ (notes/, .archive/, a manual-cleanup
# leftover) must never masquerade as a feature candidate -- candidate scan needs the same
# numeric-prefix filter next_number always used.
mkdir -p agent-docs/doflow/001-real-feature agent-docs/doflow/.archive agent-docs/doflow/notes
eq "non-numeric stray dirs excluded -> single real feature still auto-selects" \
   "$("$PATHS" --json | jq -r '.feature_slug')" "001-real-feature"
eq "non-numeric stray dirs excluded -> candidate_slugs empty (not ambiguous)" \
   "$("$PATHS" --json | jq -c '.candidate_slugs')" "[]"
eq "non-numeric stray dirs excluded -> next_number unaffected by them" \
   "$("$PATHS" --json | jq -r '.next_number')" "002"
rm -rf agent-docs

echo "[prereqs gate: non-git ambiguity + --slug passthrough]"
mkdir -p agent-docs/doflow/001-solo agent-docs/doflow/002-other
echo r > agent-docs/doflow/001-solo/requirement.md
echo d > agent-docs/doflow/001-solo/design.md
echo p > agent-docs/doflow/001-solo/plan.md
"$PREREQ" --require-plan >/dev/null 2>&1; eq "ambiguous non-git -> prereqs exit 2" "$?" "2"
eq "ambiguous non-git -> prereqs error is ambiguous-feature" \
   "$("$PREREQ" --require-plan 2>/dev/null | jq -r '.error')" "ambiguous-feature"
"$PREREQ" --require-plan --slug=001-solo >/dev/null 2>&1; eq "--slug disambiguates -> prereqs exit 0" "$?" "0"
cd "$T/repo" || exit 1

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

EXECPATHS="$FAKE/scripts/doflow/bash/do-exec-paths.sh"
BRIEF="$FAKE/scripts/doflow/bash/do-task-brief.sh"
PACKAGE="$FAKE/scripts/doflow/bash/do-review-package.sh"
PARCHECK="$FAKE/scripts/doflow/bash/do-parallel-check.sh"

cd "$T/repo" || exit 1
git checkout -q feat/001-auth

# Realistic artifacts: brief composition reads named sections of all three, so a fixture of
# `echo r > requirement.md` would make every trace assertion vacuous rather than passing.
cat > agent-docs/doflow/001-auth/requirement.md <<'FIXTURE'
## 2. User Stories
- **US1 (P1):** As a user, I want to log in, so that I can reach my account.
  Continuation line that must survive.
- **US2 (P2):** As an admin, I want an audit trail.
## 3. Functional Requirements
| ID | Requirement | Story | Priority | Status |
|---|---|---|---|---|
| FR-001 | login endpoint | US1 | P1 | Live |
| FR-002 | audit record | US2 | P2 | Live |
**Detail**
- **FR-001:** The system MUST accept a POST with the exact field name `credential`.
- **FR-002:** The system MUST write an audit row.
## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | p95 under 200ms | performance | Live |
**Detail**
- **NFR-001 (Latency):** p95 under 200ms measured at the edge.
## 5. Out of Scope
FIXTURE
cat > agent-docs/doflow/001-auth/design.md <<'FIXTURE'
## 3. Components & Boundaries
| ID | Component | Kind | Serves | Status |
|---|---|---|---|---|
| CMP1 | auth handler | service | FR-001 | Live |
| CMP2 | audit writer | service | FR-002 | Live |
**Detail**
- **CMP1** → owns credential verification; does not own session storage.
- **CMP2** → owns the audit row.
## 4. API / Interface Contracts
FIXTURE
cat > agent-docs/doflow/001-auth/plan.md <<'FIXTURE'
## 1. Approach
Bottom-up: handler first, audit second.
## 7. Validation Strategy
| Requirement | Verified by |
|---|---|
| FR-001 | integration test on the login route |
## 8. Tasks
### Phase A — auth
- [ ] A.1 [P] [US1] build the handler — owner: backend-architect; files: src/auth.js
- [ ] A.2 [P] [US1] also writes auth.js — owner: backend-architect; files: src/auth.js, src/x.js
- [ ] A.3 [P] [US2] disjoint — owner: backend-architect; files: src/audit.js
- [ ] A.4 [US1] sequential, same file — owner: backend-architect; files: src/auth.js
- [ ] A.5 [P] [US1] verification only — owner: devops-architect; files: none (verification only)
### Phase B — later
- [ ] B.1 [US9] traces a story that does not exist — owner: x; files: src/b.js
### Checkpoints
- After Phase A: run the suite; commit `feat: auth`
FIXTURE

echo "[do-exec-paths]"
eq "workspace is exec/ inside the feature dir" \
   "$("$EXECPATHS" --task=A.1 | jq -r '.workspace')" "agent-docs/doflow/001-auth/exec"
eq "brief path is named per task" \
   "$("$EXECPATHS" --task=A.1 | jq -r '.brief')" "agent-docs/doflow/001-auth/exec/task-A.1-brief.md"
eq "report path is named per task" \
   "$("$EXECPATHS" --task=A.1 | jq -r '.report')" "agent-docs/doflow/001-auth/exec/task-A.1-report.md"
eq "workspace is created, not just named" "$([ -d agent-docs/doflow/001-auth/exec ] && echo yes)" "yes"
# A task id becomes a filename, so traversal must be refused rather than sanitized: a silently
# rewritten id writes a brief where its reader does not look.
"$EXECPATHS" --task=../../etc/passwd >/dev/null 2>&1; eq "path traversal in task id -> exit 2" "$?" "2"
eq "traversal reports invalid-task" \
   "$("$EXECPATHS" --task=../../etc/passwd 2>/dev/null | jq -r '.error')" "invalid-task"
"$EXECPATHS" >/dev/null 2>&1; eq "missing --task -> exit 2" "$?" "2"

echo "[do-task-brief]"
eq "traces the story from the task line"   "$("$BRIEF" --task=A.1 | jq -r '.traced.story')" "US1"
eq "traces only FRs of that story"         "$("$BRIEF" --task=A.1 | jq -c '.traced.frs')" '["FR-001"]'
eq "traces the component serving those FRs" "$("$BRIEF" --task=A.1 | jq -c '.traced.components')" '["CMP1"]'
# NFRs bind every task, so all of them are copied regardless of which story the task traces.
eq "copies every NFR as global constraints" "$("$BRIEF" --task=A.1 | jq -c '.traced.nfrs')" '["NFR-001"]'
eq "different story traces different FRs"  "$("$BRIEF" --task=A.3 | jq -c '.traced.frs')" '["FR-002"]'
eq "nothing missing on a complete trace"   "$("$BRIEF" --task=A.1 | jq -c '.missing')" '[]'
# Present, not counted: the exact value legitimately appears in both the requirement detail and the
# component boundary, so pinning a count would fail for a correct brief.
eq "brief carries the exact value verbatim" \
   "$(grep -q 'field name `credential`' agent-docs/doflow/001-auth/exec/task-A.1-brief.md && echo yes)" "yes"
eq "story continuation line survives" \
   "$(grep -c 'must survive' agent-docs/doflow/001-auth/exec/task-A.1-brief.md)" "1"
eq "verification bar is included" \
   "$(grep -c 'integration test on the login route' agent-docs/doflow/001-auth/exec/task-A.1-brief.md)" "1"
# An unresolvable trace must be reported, not silently produce a thin brief that reads complete.
eq "unresolvable story is reported in missing[]" \
   "$("$BRIEF" --task=B.1 | jq -r '.missing | length > 0')" "true"
"$BRIEF" --task=Z.9 >/dev/null 2>&1; eq "unknown task -> exit 3" "$?" "3"

echo "[do-review-package]"
echo change > src_a.txt; git add -A; git commit -q -m "first change"
BASE_SHA="$(git rev-parse HEAD~1)"; HEAD_SHA="$(git rev-parse HEAD)"
PKG="$("$PACKAGE" --task=A.1 --base="$BASE_SHA" --head="$HEAD_SHA")"
eq "package counts the commits in range" "$(printf '%s' "$PKG" | jq -r '.commits')" "1"
eq "package file exists"                 "$([ -f "$(printf '%s' "$PKG" | jq -r '.path')" ] && echo yes)" "yes"
eq "package holds the diff body"          "$(grep -c '^## Diff' "$(printf '%s' "$PKG" | jq -r '.path')")" "1"
# Named per RANGE, not per task: a re-review must not read the diff the first review already saw.
eq "package is named per range" \
   "$(printf '%s' "$PKG" | jq -r '.path' | grep -c "review-$(git rev-parse --short "$BASE_SHA")\.\.$(git rev-parse --short "$HEAD_SHA")\.diff")" "1"
"$PACKAGE" --task=A.1 --base=deadbeef --head="$HEAD_SHA" >/dev/null 2>&1
eq "bad base ref -> exit 2" "$?" "2"
"$PACKAGE" --task=A.1 --base="$BASE_SHA" >/dev/null 2>&1
eq "missing --head -> exit 2" "$?" "2"

echo "[do-parallel-check]"
PC="$("$PARCHECK" --phase=A)"
eq "overlap on a shared file is detected" "$(printf '%s' "$PC" | jq -r '.parallel_safe')" "false"
eq "both overlapping tasks are named"     "$(printf '%s' "$PC" | jq -c '.overlaps[0].tasks')" '["A.1","A.2"]'
eq "the shared path is reported"          "$(printf '%s' "$PC" | jq -r '.overlaps[0].path')" "src/auth.js"
eq "serialize lists exactly the offenders" "$(printf '%s' "$PC" | jq -c '.serialize')" '["A.1","A.2"]'
# A sequential task cannot conflict with a sibling it never runs beside, so A.4 writing the same
# file must NOT be flagged — treating it as a conflict would invent one and serialize needlessly.
eq "sequential task on the same file is not flagged" \
   "$(printf '%s' "$PC" | jq -r '[.overlaps[].tasks[]] | index("A.4") // "absent"')" "absent"
eq "sequential tasks are still reported separately" \
   "$(printf '%s' "$PC" | jq -c '.sequential_tasks')" '["A.4"]'
# files: none contributes nothing to compare rather than colliding with everything.
eq "verification-only task stays parallel" \
   "$(printf '%s' "$PC" | jq -r '.parallel_tasks | index("A.5") != null')" "true"
eq "disjoint-only phase is safe" "$("$PARCHECK" --phase=B | jq -r '.parallel_safe')" "true"
"$PARCHECK" >/dev/null 2>&1; eq "missing --phase -> exit 2" "$?" "2"

echo "[helpers: a failed write is an error, not a success]"
# Both helpers emit a path in their success contract. Reporting one for a file that was never
# written is worse than failing: the caller dispatches a subagent at nothing, and only a bytes/lines
# of 0 hints at it. This is the case that was missed the first time round.
# Remove the artifacts the earlier tests left behind before locking the directory: a read-only
# directory blocks CREATING an entry, but rewriting a file that already exists needs permission on
# the file, not on its directory — so leaving them in place would let the write succeed and make
# these four assertions test nothing.
rm -f agent-docs/doflow/001-auth/exec/task-A.1-brief.md agent-docs/doflow/001-auth/exec/review-*.diff
chmod 500 agent-docs/doflow/001-auth/exec
"$BRIEF" --task=A.1 >/dev/null 2>&1; eq "unwritable workspace: brief -> exit 2" "$?" "2"
eq "unwritable workspace: brief reports write-failed" \
   "$("$BRIEF" --task=A.1 2>/dev/null | jq -r '.error')" "write-failed"
"$PACKAGE" --task=A.1 --base="$BASE_SHA" --head="$HEAD_SHA" >/dev/null 2>&1
eq "unwritable workspace: package -> exit 2" "$?" "2"
eq "unwritable workspace: package reports write-failed" \
   "$("$PACKAGE" --task=A.1 --base="$BASE_SHA" --head="$HEAD_SHA" 2>/dev/null | jq -r '.error')" "write-failed"
chmod 700 agent-docs/doflow/001-auth/exec
eq "writable again: brief succeeds"   "$("$BRIEF" --task=A.1 | jq -r '.traced.story')" "US1"
eq "writable again: package succeeds" "$("$PACKAGE" --task=A.1 --base="$BASE_SHA" --head="$HEAD_SHA" | jq -r '.commits')" "1"

echo ""
echo "[Results] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && { echo "ALL DOFLOW CHAIN TESTS PASSED ✓"; exit 0; } || exit 1
