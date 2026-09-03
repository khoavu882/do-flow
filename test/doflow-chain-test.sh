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
   "$BASH_SCRIPTS/do-review-package.sh" "$BASH_SCRIPTS/do-parallel-check.sh" \
   "$BASH_SCRIPTS/render-audit.sh" "$FAKE/scripts/doflow/bash/"
export CLAUDE_CONFIG_DIR="$FAKE"
PATHS="$FAKE/scripts/doflow/bash/do-paths.sh"
PREREQ="$FAKE/scripts/doflow/bash/do-prereqs.sh"
SYNC="$FAKE/scripts/doflow/bash/sync-context.sh"
RENDER_AUDIT="$FAKE/scripts/doflow/bash/render-audit.sh"
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
# Exercises the canonical policy script directly (core/harnesses/shared/hooks/policies/
# pre-implementation-gate.sh), not the claude front door ($GATE): that front door's own
# `source "$(dirname "$0")/../../.doflow/shared/hooks/policies/..."` path only resolves in an
# INSTALLED layout (test/hooks/build-install-mirror.sh sets that up); run from the source
# checkout, as this script does, both the `source` and the `POLICY=` path silently fail to
# resolve, and the front door falls through to its own unconditional `exit 0` regardless of the
# policy's real verdict -- which is exactly how the pre-implementation-gate.sh's own
# structured-layout defect (missing .doflow/ resolver candidates) shipped past a fully "green"
# run of this suite. The front-door JSON-translation layer itself is covered separately by
# test/hooks/test-hooks.sh. The canonical policy speaks exit codes only (0 = allow, non-zero =
# deny) per its own header comment -- never a harness-specific JSON shape -- so this checks the
# exit code directly rather than parsing hookSpecificOutput.
CANONICAL_POLICY="$REPO_ROOT/core/harnesses/shared/hooks/policies/pre-implementation-gate.sh"
decision() {
  local rc
  echo "$1" | bash "$CANONICAL_POLICY" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "allow"; else echo "deny"; fi
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
### Phase C — unowned and groups
- [ ] C.1 [P] [US1] unowned task 1 — files: src/shared_unowned.js
- [ ] C.2 [P] [US1] unowned task 2 — files: src/shared_unowned.js
- [ ] C.3 [P] [US1] single unowned — files: src/solo.js
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
# Group path resolution and traversal rejection
EP_GRP="$("$EXECPATHS" --group=A:backend-architect --tasks=A.1,A.2)"
eq "group exec paths workspace" "$(printf '%s' "$EP_GRP" | jq -r '.workspace')" "agent-docs/doflow/001-auth/exec"
eq "group exec paths brief" "$(printf '%s' "$EP_GRP" | jq -r '.group_brief')" "agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md"
eq "group exec paths reports" "$(printf '%s' "$EP_GRP" | jq -c '.reports')" '["agent-docs/doflow/001-auth/exec/task-A.1-report.md","agent-docs/doflow/001-auth/exec/task-A.2-report.md"]'
"$EXECPATHS" --group=../../etc:evil --tasks=A.1 >/dev/null 2>&1; eq "path traversal in group id -> exit 2" "$?" "2"
"$EXECPATHS" --group=A:backend --tasks=../../etc/passwd >/dev/null 2>&1; eq "path traversal in task id inside group -> exit 2" "$?" "2"

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
# Group mode brief composition
TB_GRP="$("$BRIEF" --group=A:backend-architect --tasks=A.1,A.2)"
eq "group brief traces all tasks" "$(printf '%s' "$TB_GRP" | jq -c '.tasks')" '["A.1","A.2"]'
eq "group brief shared context exists" "$([ -f agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md ] && grep -c '^## Shared context' agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md)" "1"
eq "group brief task order exists" "$(grep -c '^## Task order' agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md)" "1"
eq "group brief has task A.1 block" "$(grep -c '^## Task A.1' agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md)" "1"
eq "group brief has task A.2 block" "$(grep -c '^## Task A.2' agent-docs/doflow/001-auth/exec/group-A-backend-architect-brief.md)" "1"
# Single-task byte-identity invariant (RK1): diff group of 1 against single task brief
"$BRIEF" --task=A.5 >/dev/null 2>&1
"$BRIEF" --group=A:devops-architect --tasks=A.5 >/dev/null 2>&1
eq "single-task byte-identity invariant (RK1)" "$(diff -u agent-docs/doflow/001-auth/exec/task-A.5-brief.md agent-docs/doflow/001-auth/exec/group-A-devops-architect-brief.md | wc -l | tr -d ' ')" "0"

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
# A range that resolves (both refs are real) but contains zero commits — e.g. from a
# single mistyped character in a base SHA that still happens to name a real object —
# must fail loud rather than write a syntactically valid, semantically empty package a
# reviewer could mistake for "no changes, all clear."
EMPTY_PKG_OUT="$("$PACKAGE" --task=A.1 --base="$HEAD_SHA" --head="$HEAD_SHA" 2>&1)"
EMPTY_PKG_EXIT=$?
eq "empty range -> exit 2"            "$EMPTY_PKG_EXIT" "2"
eq "empty range reports empty-range"  "$(printf '%s' "$EMPTY_PKG_OUT" | jq -r '.error')" "empty-range"
eq "empty range writes no package file" \
   "$(find agent-docs/doflow/001-auth/exec -maxdepth 1 -name "review-$(git rev-parse --short "$HEAD_SHA")..$(git rev-parse --short "$HEAD_SHA").diff" 2>/dev/null | wc -l | tr -d ' ')" "0"

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
# Group formation, owner splitting, intra-group safety, and unowned tasks
eq "groups formed by owner split" "$(printf '%s' "$PC" | jq -r '.groups | length')" "2"
eq "group A:backend-architect has all 4 tasks" "$(printf '%s' "$PC" | jq -c '.groups[0].tasks')" '["A.1","A.2","A.3","A.4"]'
eq "group A:devops-architect has verification task" "$(printf '%s' "$PC" | jq -c '.groups[1].tasks')" '["A.5"]'
eq "intra-group same-file safety (group_overlaps empty for Phase A)" "$(printf '%s' "$PC" | jq -c '.group_overlaps')" '[]'
eq "Phase A unowned_tasks empty" "$(printf '%s' "$PC" | jq -c '.unowned_tasks')" '[]'
PCC="$("$PARCHECK" --phase=C)"
eq "Phase C unowned tasks reported" "$(printf '%s' "$PCC" | jq -c '.unowned_tasks')" '["C.1","C.2","C.3"]'
eq "Phase C unowned overlap detected across singleton groups" "$(printf '%s' "$PCC" | jq -c '.group_overlaps[0].groups')" '["C:C.1","C:C.2"]'
eq "Phase C group serialize lists offender groups" "$(printf '%s' "$PCC" | jq -c '.group_serialize')" '["C:C.1","C:C.2"]'

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


# ==============================================================================
# CH1: branch_class resolver field and slug deny-list for release/hotfix
# ==============================================================================
echo "[CH1: branch_class resolver]"
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git checkout -q -B main
eq "main branch -> class trunk" "$($PATHS | jq -r '.branch_class')" "trunk"
git checkout -q -B develop
eq "develop branch -> class trunk" "$($PATHS | jq -r '.branch_class')" "trunk"

# Test new feature and fix branches get correct classes
git checkout -q -b feat/test-001
eq "feat/ branch -> class feature" "$($PATHS | jq -r '.branch_class')" "feature"
git checkout -q -b fix/test-fix
eq "fix/ branch -> class fix" "$($PATHS | jq -r '.branch_class')" "fix"

# Test release/hotfix branches yield null slug and correct class
git checkout -q -b release/v1.0.0
eq "release/* branch -> class release, slug null" "$($PATHS | jq -c '{class: .branch_class, slug: .feature_slug}')" '{"class":"release","slug":null}'
git checkout -q -b hotfix/critical-fix
eq "hotfix/* branch -> class hotfix, slug null" "$($PATHS | jq -c '{class: .branch_class, slug: .feature_slug}')" '{"class":"hotfix","slug":null}'

# Test other branch classes
git checkout -q -b refactor/cleanup
eq "refactor/ branch -> class other" "$($PATHS | jq -r '.branch_class')" "other"
git checkout -q -B main   # Switch back to main


# Verify all existing resolver fields are unchanged (RK1)
# Switch to main and verify the class is trunk
git checkout -q -B main
CURRENT_CLASS="$($PATHS --paths-only | jq -r '.branch_class')"
eq "all existing resolver fields unchanged (RK1) - main branch has trunk class" "$CURRENT_CLASS" "trunk"

# ==============================================================================
# CH2: do-git-state.sh tests
# ==============================================================================
echo "[CH2: do-git-state.sh]"
cp "$BASH_SCRIPTS/do-git-state.sh" "$FAKE/scripts/doflow/bash/"
STATE="$FAKE/scripts/doflow/bash/do-git-state.sh"
git checkout -q -B main  # Ensure trunk branch for predictable state testing
eq "--state on trunk -> class trunk" "$($STATE --state | jq -r '.class')" "trunk"
eq "--state emits feature_slug null" "$($STATE --state | jq -c '.feature_slug // null')" "null"

# Test next-version mode
BASE_TAG="$($STATE --next-version | jq -r '.base_tag')"
eq "--next-version base_tag is null without tags" "$BASE_TAG" "null"
eq "--next-version bump_kind is INITIAL without tags" "$($STATE --next-version | jq -r '.bump_kind')" "INITIAL"

# Regression: a semver pre-release tag (e.g. "v1.0.0-beta.1") used to crash the patch-bump
# arithmetic on the unstripped suffix ("0-beta.1"), raising a bash "invalid arithmetic operator"
# error instead of returning JSON.
#
# That crash fix stripped the suffix and dropped its meaning with it, so a pre-release base was
# bumped as though it were a release: 1.0.0-beta.1 proposed 1.0.1, and the 1.0.0 the beta line was
# building toward could never exist. This block previously pinned "1.0.1" as expected — incidental
# to the crash it was written for, never a decision. Semver orders 1.0.0-beta.1 < 1.0.0 < 1.0.1, so
# promoting the pre-release IS the bump. The expectations below follow node-semver's inc() rules.
git tag v1.0.0-beta.1
NEXT_PRERELEASE="$($STATE --next-version)"
eq "--next-version does not crash on a pre-release base tag" \
   "$(echo "$NEXT_PRERELEASE" | jq -r '.next_version | type')" "string"
eq "--next-version promotes a pre-release rather than incrementing past it" \
   "$(echo "$NEXT_PRERELEASE" | jq -r '.next_version')" "1.0.0"
eq "--next-version flags the base as a pre-release" \
   "$(echo "$NEXT_PRERELEASE" | jq -r '.is_prerelease')" "true"
eq "--next-version also offers continuing the pre-release line" \
   "$(echo "$NEXT_PRERELEASE" | jq -r '.next_prerelease')" "1.0.0-beta.2"
eq "--next-version base_tag reports the pre-release tag as-is" \
   "$(echo "$NEXT_PRERELEASE" | jq -r '.base_tag')" "v1.0.0-beta.1"
git tag -d v1.0.0-beta.1 >/dev/null

# Regression: next_prerelease computed beta.N+1 arithmetically and offered it without checking
# whether that tag existed, proposing v1.0.0-beta.8 while that tag was already on the remote.
# `git describe` finds the nearest *reachable* tag, so a pre-release cut on an unmerged branch is
# invisible to the base-tag lookup and collides here instead.
# The base is chosen by version order, so a *reachable* higher number becomes the base and the
# next one is free. The skip matters for the case that motivated it: a pre-release tagged on a
# branch that was never merged. It is unreachable, so it is never chosen as the base, but the tag
# still occupies the number — which is exactly how v1.0.0-beta.8 collided in this repository.
git tag v1.0.0-beta.1
git checkout -q -b unmerged-line
git commit -q --allow-empty -m "work that never merged"
git tag v1.0.0-beta.2          # taken, but not reachable from the branch we release from
git checkout -q main
TAKEN="$($STATE --next-version)"
eq "--next-version bases on the newest *reachable* tag, ignoring the unmerged one" \
   "$(echo "$TAKEN" | jq -r '.base_tag')" "v1.0.0-beta.1"
eq "--next-version still skips a number an unreachable tag has taken" \
   "$(echo "$TAKEN" | jq -r '.next_prerelease')" "1.0.0-beta.3"
eq "--next-version reports how many taken numbers it stepped over" \
   "$(echo "$TAKEN" | jq -r '.next_prerelease_skipped')" "1"
git tag -d v1.0.0-beta.1 v1.0.0-beta.2 >/dev/null
git branch -q -D unmerged-line

# A pre-release at a non-zero patch, with no feat commits behind it, is a PATCH bump: the patch
# does not increment from a pre-release, so 1.2.3-rc.1 releases as 1.2.3.
git tag v1.2.3-rc.1
NEXT_RC="$($STATE --next-version)"
eq "--next-version releases a pre-release at its own patch on a PATCH bump" \
   "$(echo "$NEXT_RC" | jq -r '.next_version')" "1.2.3"
eq "--next-version increments the pre-release label alongside it" \
   "$(echo "$NEXT_RC" | jq -r '.next_prerelease')" "1.2.3-rc.2"

# The same base with a feat commit behind it is a MINOR bump, and 1.2.0 is already spent — so the
# minor increments rather than promoting, and the suffix falls away with it.
git commit -q --allow-empty -m "feat: something new"
eq "--next-version increments rather than promoting when the target field is spent" \
   "$($STATE --next-version | jq -r '.next_version')" "1.3.0"
git tag -d v1.2.3-rc.1 >/dev/null

# A released base is unaffected by any of the above.
git tag v2.0.0
NEXT_REL="$($STATE --next-version)"
eq "--next-version leaves a released base on the ordinary bump path" \
   "$(echo "$NEXT_REL" | jq -r '.is_prerelease')" "false"
eq "--next-version reports no pre-release alternative for a released base" \
   "$(echo "$NEXT_REL" | jq -r '.next_prerelease')" "null"
git tag -d v2.0.0 >/dev/null

# commits_count counted lines with `printf | wc -l`, which sees no trailing newline and so
# undercounted every range by one.
git tag v3.0.0
git commit -q --allow-empty -m "chore: one"
git commit -q --allow-empty -m "chore: two"
git commit -q --allow-empty -m "chore: three"
eq "--next-version counts every commit in the range, not one fewer" \
   "$($STATE --next-version | jq -r '.commits_count')" "3"
git tag -d v3.0.0 >/dev/null

# Regression: ahead_of_integration measured against refs/heads/<integration>, the local branch, so
# a develop that had not been pulled made every distance wrong by however stale it was — observed
# live reporting 22 against an actual 32. The remote-tracking ref is preferred where it exists.
git checkout -q -B develop
git commit -q --allow-empty -m "integration work 1"
git commit -q --allow-empty -m "integration work 2"
# Fabricate a remote-tracking ref that is ahead of the local integration branch.
git update-ref refs/remotes/origin/develop HEAD
git branch -f develop HEAD~2 2>/dev/null || { git checkout -q -B tmp-holder; git branch -f develop HEAD~2; }
git checkout -q -B feat/stale-probe origin/develop
git commit -q --allow-empty -m "feature work"
STALE_STATE="$($STATE --state)"
eq "--state measures against the remote-tracking integration ref when present" \
   "$(echo "$STALE_STATE" | jq -r '.ahead_of_integration')" "1"
eq "--state names the ref it measured against" \
   "$(echo "$STALE_STATE" | jq -r '.integration_ref_kind')" "remote-tracking"
eq "--state reports how far the local integration branch trails the remote" \
   "$(echo "$STALE_STATE" | jq -r '.integration_local_behind_remote')" "2"
git update-ref -d refs/remotes/origin/develop
NOREMOTE_STATE="$($STATE --state)"
eq "--state falls back to the local integration branch with no remote-tracking ref" \
   "$(echo "$NOREMOTE_STATE" | jq -r '.integration_ref_kind')" "local"
git checkout -q -B main

# Regression: the base tag came from `git describe --tags --abbrev=0`, which answers "nearest
# reachable tag by commit distance" where every version decision needs "newest reachable by
# version". Those coincide only while history is linear, and a release ritual merges twice — after
# v1.0.0 shipped, beta.8 sat 33 commits back and beta.7 sat 31, so describe returned the superseded
# one and every later computation was based on it.
git commit -q --allow-empty -m "older"
git tag v2.0.0                       # newer version, further from HEAD
git commit -q --allow-empty -m "mid"
git commit -q --allow-empty -m "near"
git tag v1.5.0                       # older version, nearer to HEAD
eq "--next-version takes the newest reachable tag by version, not the nearest by distance" \
   "$($STATE --next-version | jq -r '.base_tag')" "v2.0.0"
git tag -d v2.0.0 v1.5.0 >/dev/null

# A tag that is not a version must not win the sort.
git tag nightly
git tag v0.1.0
eq "--next-version ignores a non-version tag when choosing a base" \
   "$($STATE --next-version | jq -r '.base_tag')" "v0.1.0"
git tag -d nightly v0.1.0 >/dev/null

eq "--next-version reports no base in a repository with no version tags" \
   "$($STATE --next-version | jq -r '.base_tag')" "null"

# Test fingerprint mode (deterministic but unique per state)
FINGERPRINT_1="$($STATE --fingerprint)"
FINGERPRINT_2="$($STATE --fingerprint)"
FP1="$(echo "$FINGERPRINT_1" | jq -r '.fingerprint // ""')"
FP2="$(echo "$FINGERPRINT_2" | jq -r '.fingerprint // ""')"
# A non-empty fingerprint string is valid JSON
eq "--fingerprint returns valid JSON fingerprint (non-empty)" "${#FP1}" "64"
eq "--fingerprint is deterministic on stable state" "$FP1" "$FP2"

# Test branch-name mode
# Regression: --class took *branch* classes (feature, fix, release, hotfix) while every DoFlow
# skill holds a *task* class (bug, refactor, dependency-change, trivial-edit). A task class fell
# through a catch-all that prepended it verbatim, so --class=bug produced bug/<slug>, which
# get_class then classified as "other" — the verb suggested a name it could not itself recognise.
for tc in bug refactor dependency-change trivial-edit; do
  eq "--branch-name maps task class $tc onto a recognised prefix" \
     "$($STATE --branch-name --class=$tc --slug=t | jq -r '.name')" "fix/t"
done
eq "--branch-name still maps the feature task class to feat/" \
   "$($STATE --branch-name --class=feature --slug=t | jq -r '.name')" "feat/t"
$STATE --branch-name --class=nonsense --slug=t >/dev/null 2>&1
eq "--branch-name refuses an unknown class instead of prepending it" "$?" "2"
eq "--branch-name names the valid set when it refuses" \
   "$($STATE --branch-name --class=nonsense --slug=t 2>/dev/null | jq -r '.error')" "unknown-class"

eq "--branch-name --class=feature --slug=test produces feat/test" "$($STATE --branch-name --class=feature --slug=test | jq -r '.name')" "feat/test"
eq "--branch-name --class=release --slug=1.0.0 produces release/1.0.0" "$($STATE --branch-name --class=release --slug=1.0.0 | jq -r '.name')" "release/1.0.0"

# Test error cases
$STATE --branch-name 2>/dev/null; eq "--branch-name without class -> exit 2" "$?" "2"
$STATE --branch-name --class=feature 2>/dev/null; eq "--branch-name without slug -> exit 2" "$?" "2"

# ==============================================================================
# E.1: do-paths.sh layout detection (023-structured-feature-trail, FR-007/FR-008)
# ==============================================================================
echo "[E.1: do-paths.sh layout detection]"
git checkout -q -B main

# Legacy layout: only top-level requirement.md/design.md/plan.md, no intention/.
mkdir -p agent-docs/doflow/900-legacy-fixture
echo r > agent-docs/doflow/900-legacy-fixture/requirement.md
echo d > agent-docs/doflow/900-legacy-fixture/design.md
echo p > agent-docs/doflow/900-legacy-fixture/plan.md
eq "legacy layout dir -> layout:legacy" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.layout')" "legacy"
eq "legacy layout -> specs:null" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.specs // "null"')" "null"
eq "legacy layout -> has_specs:false" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.has_specs')" "false"
eq "legacy layout -> audit populated as a path (file need not exist)" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.audit')" "agent-docs/doflow/900-legacy-fixture/audit.md"
eq "legacy layout -> intention_next_round:1" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.intention_next_round')" "1"
eq "legacy layout -> design_next_round:1" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.design_next_round')" "1"
eq "legacy layout -> plan_next_round:1" \
   "$($PATHS --slug=900-legacy-fixture | jq -r '.plan_next_round')" "1"

# Structured layout: intention/requirement.md exists -> requirement/design/specs/plan all resolve
# into their own subdirs, even before design.md/specs.md/plan.md exist.
mkdir -p agent-docs/doflow/901-structured-fixture/intention
echo r > agent-docs/doflow/901-structured-fixture/intention/requirement.md
eq "structured layout dir -> layout:structured" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.layout')" "structured"
eq "structured layout -> requirement resolves into intention/" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.requirement')" \
   "agent-docs/doflow/901-structured-fixture/intention/requirement.md"
eq "structured layout -> design resolves into design/ (even though design.md does not exist yet)" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.design')" \
   "agent-docs/doflow/901-structured-fixture/design/design.md"
eq "structured layout -> specs resolves into design/ (even though specs.md does not exist yet)" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.specs')" \
   "agent-docs/doflow/901-structured-fixture/design/specs.md"
eq "structured layout -> plan resolves into plan/ (even though plan.md does not exist yet)" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.plan')" \
   "agent-docs/doflow/901-structured-fixture/plan/plan.md"

# Round-number scanning: two intention/ rounds -> next round is 3; an empty/absent design/ still
# floors at 1.
echo q1 > agent-docs/doflow/901-structured-fixture/intention/brainstorm-01-question.md
echo q2 > agent-docs/doflow/901-structured-fixture/intention/brainstorm-02-question.md
eq "round scan -> intention_next_round:3 after brainstorm-01/-02" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.intention_next_round')" "3"
eq "round scan -> design_next_round:1 with absent design/" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.design_next_round')" "1"

# M3 regression: --paths-only must not report the misleading floor value 1 for a field it never
# computed -- it must report null (the scan itself is skipped, so "not computed" must never read
# the same as "computed, no rounds yet"), while normal --json mode is unaffected.
eq "--paths-only -> intention_next_round is null, not the stale floor 1" \
   "$($PATHS --paths-only --slug=901-structured-fixture | jq -r '.intention_next_round')" "null"
eq "--paths-only -> design_next_round is also null" \
   "$($PATHS --paths-only --slug=901-structured-fixture | jq -r '.design_next_round')" "null"
eq "--paths-only -> plan_next_round is also null" \
   "$($PATHS --paths-only --slug=901-structured-fixture | jq -r '.plan_next_round')" "null"
eq "normal --json mode is unaffected by the --paths-only fix (still 3)" \
   "$($PATHS --slug=901-structured-fixture | jq -r '.intention_next_round')" "3"

# FR-008 regression: a feature dir shaped exactly like this repo's real
# agent-docs/doflow/022-normalize-hooks (flat top-level, no intention/) must resolve identically
# to before this feature -- the "old feature dirs keep working, no migration" guarantee.
mkdir -p agent-docs/doflow/902-fr008-regression
: > agent-docs/doflow/902-fr008-regression/requirement.md
: > agent-docs/doflow/902-fr008-regression/design.md
: > agent-docs/doflow/902-fr008-regression/plan.md
: > agent-docs/doflow/902-fr008-regression/state.md
eq "FR-008: old-shaped feature dir -> layout:legacy" \
   "$($PATHS --slug=902-fr008-regression | jq -r '.layout')" "legacy"
eq "FR-008: old-shaped feature dir -> requirement path unchanged" \
   "$($PATHS --slug=902-fr008-regression | jq -r '.requirement')" \
   "agent-docs/doflow/902-fr008-regression/requirement.md"
eq "FR-008: old-shaped feature dir -> design path unchanged" \
   "$($PATHS --slug=902-fr008-regression | jq -r '.design')" \
   "agent-docs/doflow/902-fr008-regression/design.md"
eq "FR-008: old-shaped feature dir -> plan path unchanged" \
   "$($PATHS --slug=902-fr008-regression | jq -r '.plan')" \
   "agent-docs/doflow/902-fr008-regression/plan.md"

# ==============================================================================
# E.3: render-audit.sh fixtures (023-structured-feature-trail, FR-004/FR-005/FR-006)
# ==============================================================================
echo "[E.3: render-audit.sh]"

# Seeded orchestration journal with one forced entry among three routine ones.
AUDIT_SLUG="903-audit-fixture"
mkdir -p "agent-docs/doflow/$AUDIT_SLUG" ".doflow/state/orchestration"
cat > ".doflow/state/orchestration/$AUDIT_SLUG.json" <<'JOURNAL'
{
  "version": 1,
  "taskId": "903-audit-fixture",
  "taskClass": "feature",
  "state": "RUNNING",
  "history": [
    {"at": "2026-09-03T03:40:40.139Z", "action": "start", "detail": "task-class=feature"},
    {"at": "2026-09-03T03:40:40.245Z", "node": "discovery", "action": "complete-stage", "note": "requirement.md written, zero open markers", "forced": false},
    {"at": "2026-09-03T03:40:40.395Z", "node": "gate-0", "action": "decide-gate", "detail": "approve", "note": "user approved despite one deferred nit", "forced": true},
    {"at": "2026-09-03T03:40:40.500Z", "node": "design", "action": "complete-stage", "note": "design.md + specs.md written", "forced": false}
  ]
}
JOURNAL
"$RENDER_AUDIT" --slug="$AUDIT_SLUG" >/dev/null 2>&1
eq "seeded journal -> render-audit exits 0" "$?" "0"
AUDIT_MD="agent-docs/doflow/$AUDIT_SLUG/audit.md"
eq "audit.md is written" "$([ -f "$AUDIT_MD" ] && echo yes || echo no)" "yes"
eq "audit.md has one table row per history entry (4)" \
   "$(grep -c '^| 2026-09-03T' "$AUDIT_MD")" "4"
eq "exactly one row carries the FORCED marker" \
   "$(grep -c '⚠ FORCED' "$AUDIT_MD")" "1"
eq "the FORCED marker lands on the gate-0 forced entry's row" \
   "$(grep 'gate-0' "$AUDIT_MD" | grep -c '⚠ FORCED')" "1"
eq "routine rows carry no FORCED marker (discovery row)" \
   "$(grep 'discovery' "$AUDIT_MD" | grep -c '⚠ FORCED')" "0"
eq "audit.md carries the generated-file / do-not-hand-edit warning line" \
   "$(grep -c 'Do not' "$AUDIT_MD")" "1"

# M1 regression: a multi-line --note must not split its table row across physical lines and
# corrupt the generated table -- esc() must collapse embedded newlines/CRs, not just escape pipes.
NL_SLUG="905-newline-note-fixture"
mkdir -p "agent-docs/doflow/$NL_SLUG" ".doflow/state/orchestration"
printf '{"version":1,"taskId":"%s","taskClass":"feature","state":"RUNNING","history":[{"at":"2026-09-03T03:40:40.139Z","action":"start","detail":"task-class=feature"},{"at":"2026-09-03T03:40:40.245Z","node":"discovery","action":"annotate","note":"line one\\nline two with a | pipe","forced":false}]}' \
  "$NL_SLUG" > ".doflow/state/orchestration/$NL_SLUG.json"
"$RENDER_AUDIT" --slug="$NL_SLUG" >/dev/null 2>&1
NL_AUDIT_MD="agent-docs/doflow/$NL_SLUG/audit.md"
eq "multi-line note -> audit.md still has exactly one row per history entry (2)" \
   "$(grep -c '^| 2026-09-03T' "$NL_AUDIT_MD")" "2"
eq "multi-line note -> table has no stray non-row line after the separator" \
   "$(sed -n '8,$p' "$NL_AUDIT_MD" | grep -vc '^| 2026-09-03T')" "0"
eq "multi-line note -> the embedded newline was collapsed, not dropped (both halves present)" \
   "$(grep 'discovery' "$NL_AUDIT_MD" | grep -c 'line one line two')" "1"
eq "multi-line note -> the pipe inside it is still escaped" \
   "$(grep 'discovery' "$NL_AUDIT_MD" | grep -c 'with a \\| pipe')" "1"

# Fail-open: no journal recorded yet -> no audit.md written, exit 0.
mkdir -p agent-docs/doflow/904-no-journal-fixture
"$RENDER_AUDIT" --slug=904-no-journal-fixture >/dev/null 2>&1
eq "no journal -> render-audit exits 0 (fail-open)" "$?" "0"
eq "no journal -> no audit.md written" \
   "$([ -f agent-docs/doflow/904-no-journal-fixture/audit.md ] && echo yes || echo no)" "no"

# F-4 regression: a backfilled entry (catch-up walking a stage/gate the owning skill never ran)
# must carry its own distinct marker, not blend into "no marker at all" the way a routine entry
# does -- a stage nobody ran must never be indistinguishable in audit.md from one that was.
BF_SLUG="906-backfilled-fixture"
mkdir -p "agent-docs/doflow/$BF_SLUG" ".doflow/state/orchestration"
cat > ".doflow/state/orchestration/$BF_SLUG.json" <<'JOURNAL'
{
  "version": 1,
  "taskId": "906-backfilled-fixture",
  "taskClass": "bug",
  "state": "RUNNING",
  "history": [
    {"at": "2026-09-03T03:40:40.139Z", "action": "start", "detail": "task-class=bug"},
    {"at": "2026-09-03T03:40:40.245Z", "node": "reproduction", "action": "complete-stage", "note": "catch-up: backfilled", "backfilled": true},
    {"at": "2026-09-03T03:40:40.500Z", "node": "root-cause", "action": "complete-stage", "note": "actual root-cause writeup", "backfilled": false}
  ]
}
JOURNAL
"$RENDER_AUDIT" --slug="$BF_SLUG" >/dev/null 2>&1
BF_AUDIT_MD="agent-docs/doflow/$BF_SLUG/audit.md"
eq "backfilled entry renders the BACKFILLED marker" \
   "$(grep 'reproduction' "$BF_AUDIT_MD" | grep -c '⚡ BACKFILLED')" "1"
eq "a real (non-backfilled) completion carries neither marker" \
   "$(grep 'root-cause' "$BF_AUDIT_MD" | grep -cE '⚡ BACKFILLED|⚠ FORCED')" "0"

# M4 regression: an unrecognized argument (including the space-separated --slug typo) must error,
# not fall through and silently render the ACTIVE feature's trail.
"$RENDER_AUDIT" --slug "$AUDIT_SLUG" >/dev/null 2>&1
eq "space-separated --slug -> render-audit exits nonzero" "$([ "$?" -ne 0 ] && echo yes || echo no)" "yes"
"$RENDER_AUDIT" --bogus-flag --json >/tmp/render-audit-m4.$$ 2>&1
eq "unrecognized --json flag call -> emits ok:false JSON" \
   "$(grep -c '"ok":false' /tmp/render-audit-m4.$$)" "1"
rm -f /tmp/render-audit-m4.$$

# L1 regression: audit.md must land at 0644 regardless of the caller's umask.
( umask 077; "$RENDER_AUDIT" --slug="$AUDIT_SLUG" >/dev/null 2>&1 )
eq "audit.md is written 0644 even under umask 077" \
   "$(stat -f '%Lp' "$AUDIT_MD" 2>/dev/null || stat -c '%a' "$AUDIT_MD" 2>/dev/null)" "644"

# L2 regression: a literal backslash in a note must round-trip as a doubled backslash, and a
# backslash immediately preceding a pipe must not corrupt the pipe's own escaping.
BS_SLUG="907-backslash-fixture"
mkdir -p "agent-docs/doflow/$BS_SLUG" ".doflow/state/orchestration"
printf '{"version":1,"taskId":"%s","taskClass":"feature","state":"RUNNING","history":[{"at":"2026-09-03T03:40:40.139Z","action":"start","detail":"task-class=feature"},{"at":"2026-09-03T03:40:40.245Z","node":"discovery","action":"annotate","note":"path C:\\\\dir then a | pipe","forced":false}]}' \
  "$BS_SLUG" > ".doflow/state/orchestration/$BS_SLUG.json"
"$RENDER_AUDIT" --slug="$BS_SLUG" >/dev/null 2>&1
BS_AUDIT_MD="agent-docs/doflow/$BS_SLUG/audit.md"
eq "backslash note -> audit.md has exactly one row per history entry (2)" \
   "$(grep -c '^| 2026-09-03T' "$BS_AUDIT_MD")" "2"
eq "backslash note -> the backslash is doubled" \
   "$(grep -c 'C:\\\\dir' "$BS_AUDIT_MD")" "1"
eq "backslash note -> the pipe immediately after it is still escaped as \\| (no stray column break)" \
   "$(grep -c 'dir then a \\| pipe' "$BS_AUDIT_MD")" "1"

# F-5 regression: render-audit must report failure, not a false written:true, when the move into
# place cannot land -- e.g. the feature directory was never created (do-brainstorm's own state
# before its step 4 mkdir).
MV_SLUG="908-move-failed-fixture"
mkdir -p ".doflow/state/orchestration"
cat > ".doflow/state/orchestration/$MV_SLUG.json" <<'JOURNAL'
{"version":1,"taskId":"908-move-failed-fixture","taskClass":"bug","state":"RUNNING","history":[{"at":"2026-09-03T03:40:40.139Z","action":"start","detail":"task-class=bug"}]}
JOURNAL
# Deliberately no `mkdir -p agent-docs/doflow/$MV_SLUG` -- the mv target's parent doesn't exist.
"$RENDER_AUDIT" --slug="$MV_SLUG" --json >/tmp/render-audit-f5.$$ 2>&1
MV_RC=$?
eq "move-failed -> render-audit exits nonzero" "$([ "$MV_RC" -ne 0 ] && echo yes || echo no)" "yes"
eq "move-failed -> reports ok:false, not a false written:true" \
   "$(grep -c '"ok":false' /tmp/render-audit-f5.$$)" "1"
eq "move-failed -> no audit.md left behind anywhere under agent-docs" \
   "$(find agent-docs/doflow -name audit.md -path "*$MV_SLUG*" 2>/dev/null | wc -l | tr -d ' ')" "0"
rm -f /tmp/render-audit-f5.$$

echo ""
echo "[Results] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && { echo "ALL DOFLOW CHAIN TESTS PASSED ✓"; exit 0; } || exit 1
