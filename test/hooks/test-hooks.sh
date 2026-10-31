#!/usr/bin/env bash
# test/hooks/test-hooks.sh — Regression tests for core/harnesses/claude/hooks/
#
# Tests:
#   1. lib.sh          — utility function correctness
#   2. stop-check.sh   — stub detection pattern (no false positives)
#   3. failure capture — fail-open branches record a failure and change no output
#
# Usage: bash test/hooks/test-hooks.sh
# Run from repository root. Requires: bash 3.2+, jq, POSIX ERE grep (no PCRE needed).

set -uo pipefail
# Hook lines (088) are written to the .doflow found above the cwd; tests default them off.
export DOFLOW_TELEMETRY="${DOFLOW_TELEMETRY:-off}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Front doors resolve the Canonical Policy Library via a path relative to their installed
# location, not their source location — see build-install-mirror.sh for why this mirror exists.
if [[ -z "${HOOKS_DIR:-}" ]]; then
  MIRROR="$REPO_ROOT/tmp/hooks-mirror"
  bash "$REPO_ROOT/test/hooks/build-install-mirror.sh" "$MIRROR"
  HOOKS_DIR="$MIRROR/.claude/hooks"
fi
PASS=0
FAIL=0

# ── Minimal test framework ────────────────────────────────────────────────────

_pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
_fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    _pass "$desc"
  else
    _fail "$desc  (expected='$expected'  got='$actual')"
  fi
}

assert_len() {
  local desc="$1" expected="$2" actual="${#3}"
  assert_eq "$desc" "$expected" "$actual"
}

assert_matches() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -qiE -- "$pattern" 2>/dev/null; then
    _pass "$desc"
  else
    _fail "$desc  (pattern did not match text: '$text')"
  fi
}

assert_no_match() {
  local desc="$1" text="$2" pattern="$3"
  if echo "$text" | grep -qiE -- "$pattern" 2>/dev/null; then
    _fail "$desc  (pattern unexpectedly matched text: '$text')"
  else
    _pass "$desc"
  fi
}

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (sudo apt install jq / brew install jq)"
  exit 1
fi

if [[ ! -f "$HOOKS_DIR/lib.sh" ]]; then
  echo "ERROR: run from repository root — could not find $HOOKS_DIR/lib.sh"
  exit 1
fi

# ── 1. lib.sh — utility functions ────────────────────────────────────────────

echo ""
echo "1. lib.sh — utility functions"
echo "──────────────────────────────"

# Source without running hook logic (lib.sh has no top-level side effects)
# shellcheck source=core/harnesses/claude/hooks/lib.sh
source "$HOOKS_DIR/lib.sh"

# cwd_hash: must return a 16-char stable hex string
HASH_A=$(cwd_hash "/home/user/project-a")
HASH_A2=$(cwd_hash "/home/user/project-a")
HASH_B=$(cwd_hash "/home/user/project-b")

assert_eq  "cwd_hash is 16 chars" "16" "${#HASH_A}"
assert_eq  "cwd_hash is deterministic" "$HASH_A" "$HASH_A2"
[[ "$HASH_A" != "$HASH_B" ]] \
  && _pass "cwd_hash differs for different inputs" \
  || _fail "cwd_hash should differ for different paths"

# json_field: extracts scalar values, returns empty on null/missing
SAMPLE='{"name":"Alice","age":30,"flag":true,"nothing":null}'
assert_eq "json_field: string"          "Alice" "$(json_field "$SAMPLE" ".name")"
assert_eq "json_field: number"          "30"    "$(json_field "$SAMPLE" ".age")"
assert_eq "json_field: bool"            "true"  "$(json_field "$SAMPLE" ".flag")"
assert_eq "json_field: null → empty"   ""      "$(json_field "$SAMPLE" ".nothing")"
assert_eq "json_field: missing → empty" ""     "$(json_field "$SAMPLE" ".nonexistent")"
assert_eq "json_field: bad json → empty" ""    "$(json_field "not-json-at-all" ".field")"

# ensure_session_dir / ensure_project_dir: idempotent, returns path
TMP_STATE=$(mktemp -d)
export STATE_DIR="$TMP_STATE/session-env"
export SESSION_DIR="$STATE_DIR/sessions"
export PROJECTS_DIR="$STATE_DIR/projects"

SID="test-session-123"
SPATH=$(ensure_session_dir "$SID")
assert_eq  "ensure_session_dir: creates dir" "0" "$([ -d "$SPATH" ] && echo 0 || echo 1)"
assert_eq  "ensure_session_dir: returns path" "$SESSION_DIR/$SID" "$SPATH"
SPATH2=$(ensure_session_dir "$SID")
assert_eq  "ensure_session_dir: idempotent"  "$SPATH" "$SPATH2"

PPATH=$(ensure_project_dir "/some/project/path")
assert_eq  "ensure_project_dir: creates dir" "0" "$([ -d "$PPATH" ] && echo 0 || echo 1)"
HASH_P=$(cwd_hash "/some/project/path")
assert_eq  "ensure_project_dir: path uses hash" "$PROJECTS_DIR/$HASH_P" "$PPATH"

rm -rf "$TMP_STATE"
unset STATE_DIR SESSION_DIR PROJECTS_DIR

# canonicalize_path: resolves an existing dir to its physical absolute path
CANON_DIR=$(mktemp -d)
CANON_EXPECTED=$(cd "$CANON_DIR" && pwd -P)
assert_eq "canonicalize_path: resolves existing dir" "$CANON_EXPECTED" "$(canonicalize_path "$CANON_DIR")"

# canonicalize_path: non-existent path is returned unchanged (degrade, not fail)
assert_eq "canonicalize_path: non-existent path unchanged" "/no/such/path-xyz123" \
  "$(canonicalize_path "/no/such/path-xyz123")"

# canonicalize_path: never emits a leading // (POSIX-undefined; Cygwin/MSYS2 reads it as a UNC path)
CANON_ROOT_CHILD=$(canonicalize_path "/tmp")
if [[ "$CANON_ROOT_CHILD" == //* ]]; then
  _fail "canonicalize_path: no leading // for /tmp  (got='$CANON_ROOT_CHILD')"
else
  _pass "canonicalize_path: no leading // for /tmp"
fi

# canonicalize_path: a path starting with '-' isn't parsed as an option
CANON_DASH_BASE=$(mktemp -d)
mkdir -p "$CANON_DASH_BASE/-dashdir"
CANON_DASH_EXPECTED="$(cd "$CANON_DASH_BASE" && pwd -P)/-dashdir"
assert_eq "canonicalize_path: path starting with '-' is not treated as an option" \
  "$CANON_DASH_EXPECTED" "$(cd "$CANON_DASH_BASE" && canonicalize_path "-dashdir")"

# canonicalize_path: ignores CDPATH — must resolve relative to cwd (not a
# same-named dir found via CDPATH) and print exactly one line (a bare `cd`
# under CDPATH can otherwise echo a "found via CDPATH" line to stdout)
CANON_CDPATH_BASE=$(mktemp -d)
mkdir -p "$CANON_CDPATH_BASE/here/foo" "$CANON_CDPATH_BASE/elsewhere/foo"
CANON_CDPATH_EXPECTED=$(cd "$CANON_CDPATH_BASE/here/foo" && pwd -P)
CANON_CDPATH_OUT=$(cd "$CANON_CDPATH_BASE/here" && CDPATH="$CANON_CDPATH_BASE/elsewhere" canonicalize_path foo)
CANON_CDPATH_LINES=$(printf '%s' "$CANON_CDPATH_OUT" | grep -c '^')
if [[ "$CANON_CDPATH_OUT" == "$CANON_CDPATH_EXPECTED" && "$CANON_CDPATH_LINES" == "1" ]]; then
  _pass "canonicalize_path: ignores CDPATH, resolves relative to cwd, single line"
else
  _fail "canonicalize_path: CDPATH handling  (out='$CANON_CDPATH_OUT' expected='$CANON_CDPATH_EXPECTED' lines=$CANON_CDPATH_LINES)"
fi
rm -rf "$CANON_DIR" "$CANON_DASH_BASE" "$CANON_CDPATH_BASE"

# cwd_hash: fallback chain — shasum branch (simulate sha256sum absent).
# Shadows the `command` builtin inside a subshell so the fallback path is
# exercised deterministically without uninstalling sha256sum on this host.
HASH_SHASUM_FALLBACK=$(
  command() { [[ "$1" == -v && "$2" == sha256sum ]] && return 1; builtin command "$@"; }
  cwd_hash "/home/user/project-a"
)
assert_eq "cwd_hash: shasum fallback produces the same hash as sha256sum" "$HASH_A" "$HASH_SHASUM_FALLBACK"

# cwd_hash: fallback chain — cksum branch (simulate sha256sum AND shasum absent)
HASH_CKSUM_FALLBACK=$(
  command() { [[ "$1" == -v && ( "$2" == sha256sum || "$2" == shasum ) ]] && return 1; builtin command "$@"; }
  cwd_hash "/home/user/project-a"
)
if [[ -n "$HASH_CKSUM_FALLBACK" ]]; then
  _pass "cwd_hash: cksum fallback (no sha256sum/shasum) produces a non-empty hash"
else
  _fail "cwd_hash: cksum fallback produced empty output"
fi

# with_file_lock / release_file_lock
LOCK_TMP=$(mktemp -d)
LOCK_FILE="$LOCK_TMP/test.lock"

if with_file_lock "$LOCK_FILE" 5; then
  _pass "with_file_lock: acquires an uncontended lock"
else
  _fail "with_file_lock: failed to acquire an uncontended lock"
fi
assert_eq "with_file_lock: creates the lockdir" "0" "$([ -d "${LOCK_FILE}.d" ] && echo 0 || echo 1)"
assert_eq "with_file_lock: records the holder's own PID" "$$" "$(cat "${LOCK_FILE}.d/pid" 2>/dev/null)"

release_file_lock "$LOCK_FILE"
assert_eq "release_file_lock: removes the lockdir" "1" "$([ -d "${LOCK_FILE}.d" ] && echo 0 || echo 1)"

# release_file_lock is idempotent even when no lock is held
release_file_lock "$LOCK_FILE"
_pass "release_file_lock: idempotent when no lock is held"

# with_file_lock: a lock held by a still-running process is NOT reclaimed —
# waits, then times out (rc=1)
mkdir -p "${LOCK_FILE}.d"
sleep 30 &
LIVE_PID=$!
echo "$LIVE_PID" >"${LOCK_FILE}.d/pid"
if with_file_lock "$LOCK_FILE" 1; then
  _fail "with_file_lock: should NOT acquire a lock held by a live process"
  release_file_lock "$LOCK_FILE"
else
  _pass "with_file_lock: times out (rc=1) when the lock is held by a live process"
fi
kill "$LIVE_PID" 2>/dev/null || true
wait "$LIVE_PID" 2>/dev/null || true
rm -rf "${LOCK_FILE}.d"

# with_file_lock: a lockdir left behind by a now-dead PID is reclaimed
# promptly rather than waiting out the full timeout (regression test for the
# stale-lock finding — a crashed holder must not permanently wedge the lock)
mkdir -p "${LOCK_FILE}.d"
( : ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
echo "$DEAD_PID" >"${LOCK_FILE}.d/pid"
STALE_START=$(date +%s)
if with_file_lock "$LOCK_FILE" 10; then
  STALE_ELAPSED=$(($(date +%s) - STALE_START))
  if (( STALE_ELAPSED < 5 )); then
    _pass "with_file_lock: reclaims a stale lock (dead PID) promptly, not after the full timeout"
  else
    _fail "with_file_lock: reclaimed stale lock but took ${STALE_ELAPSED}s (expected well under the 10s timeout)"
  fi
  release_file_lock "$LOCK_FILE"
else
  _fail "with_file_lock: failed to reclaim a lock left behind by a dead PID"
fi
rm -rf "$LOCK_TMP"

# run_with_timeout: a command that finishes within budget runs normally and
# its own exit code (not a timeout code) is propagated
if run_with_timeout 5 -- true; then
  _pass "run_with_timeout: runs a command that finishes within budget"
else
  _fail "run_with_timeout: unexpected failure running 'true' under a budget"
fi
if run_with_timeout 5 -- false; then
  _fail "run_with_timeout: 'false' unexpectedly reported success"
else
  assert_eq "run_with_timeout: propagates the wrapped command's own exit code" "1" "$?"
fi

# run_with_timeout: enforced-budget termination (rc=124), only asserted when
# this host actually has a GNU-compatible timeout/gtimeout — on a host with
# neither, the function's documented soft-fallback (run directly, no budget)
# applies instead and is not itself a failure.
RWT_HAS_GNU_TIMEOUT=0
if command -v timeout &>/dev/null && timeout --version >/dev/null 2>&1; then
  RWT_HAS_GNU_TIMEOUT=1
elif command -v gtimeout &>/dev/null && gtimeout --version >/dev/null 2>&1; then
  RWT_HAS_GNU_TIMEOUT=1
fi
if [[ "$RWT_HAS_GNU_TIMEOUT" == "1" ]]; then
  if run_with_timeout 1 -- sleep 5; then
    _fail "run_with_timeout: sleep 5 under a 1s budget should have been terminated"
  else
    assert_eq "run_with_timeout: terminates a command that exceeds its budget (rc=124)" "124" "$?"
  fi
else
  _pass "run_with_timeout: no GNU timeout/gtimeout on this host — soft-fallback path applies, skipping rc=124 assertion"
fi

# run_with_timeout: never trusts a non-GNU 'timeout' shadowing PATH (e.g.
# Windows' native timeout.exe, reachable via Git Bash inheriting System32 on
# PATH) — regression test for the Windows-shadowing finding. A fake
# non-GNU `timeout` that rejects --version is placed first on PATH; if the
# GNU-ness probe were skipped, this fake binary would "eat" the command
# instead of it ever running.
RWT_FAKEBIN=$(mktemp -d)
cat >"$RWT_FAKEBIN/timeout" <<'FAKEEOF'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "ERROR: not GNU" >&2
  exit 1
fi
echo "FAKE-WINDOWS-TIMEOUT-EXE-INVOKED" >&2
exit 99
FAKEEOF
chmod +x "$RWT_FAKEBIN/timeout"
RWT_FAKE_OUT=$(PATH="$RWT_FAKEBIN:$PATH" run_with_timeout 5 -- echo "real-command-ran")
assert_eq "run_with_timeout: never trusts a non-GNU 'timeout' shadowing PATH (e.g. Windows timeout.exe)" \
  "real-command-ran" "$RWT_FAKE_OUT"
rm -rf "$RWT_FAKEBIN"

# canonicalize_path / cwd_hash: must be byte-identical across the two
# harnesses' lib.sh copies (with_file_lock/release_file_lock/run_with_timeout
# are intentionally harness-specific and are NOT asserted here).
CLAUDE_LIB="$HOOKS_DIR/lib.sh"
CODEX_LIB="core/harnesses/codex/hooks/lib.sh"

for FN in canonicalize_path cwd_hash; do
  CLAUDE_FN=$(awk "/^${FN}\(\)/,/^}/" "$CLAUDE_LIB")
  CODEX_FN=$(awk "/^${FN}\(\)/,/^}/" "$CODEX_LIB")
  if [[ -z "$CLAUDE_FN" || -z "$CODEX_FN" ]]; then
    _fail "$FN(): could not extract function body from one or more lib.sh files"
  elif [[ "$CLAUDE_FN" == "$CODEX_FN" ]]; then
    _pass "$FN(): byte-identical across claude/codex lib.sh"
  else
    _fail "$FN(): differs across claude/codex lib.sh (should be byte-identical)"
  fi
done

# ── 2. stop-check.sh — stub detection pattern ────────────────────────────────

echo ""
echo "2. stop-check.sh — stub detection pattern"
echo "──────────────────────────────────────────"

# Load the pattern directly from the script. 022-normalize-hooks moved the actual pattern into
# the Canonical Policy Library (core/harnesses/shared/hooks/policies/) — $HOOKS_DIR/stop-check.sh
# is now a thin dispatcher with no pattern of its own, so that is the true single source of truth.
CANONICAL_STOP_CHECK="core/harnesses/shared/hooks/policies/stop-check.sh"
STUB_PATTERN=$(sed -n "s/.*STUB_PATTERN='\([^']*\)'.*/\1/p" "$CANONICAL_STOP_CHECK" | head -1)

if [[ -z "$STUB_PATTERN" ]]; then
  _fail "could not extract STUB_PATTERN from stop-check.sh"
else
  _pass "STUB_PATTERN extracted from stop-check.sh"

  # Should match — code comment stubs
  assert_matches "detects: # TODO"                "# TODO implement this"              "$STUB_PATTERN"
  assert_matches "detects: # TODO:"               "# TODO: refactor this function"     "$STUB_PATTERN"
  assert_matches "detects: // TODO"               "// TODO implement this"             "$STUB_PATTERN"
  assert_matches "detects: // TODO:"              "// TODO: fix edge case"             "$STUB_PATTERN"
  assert_matches "detects: # FIXME"               "# FIXME broken"                    "$STUB_PATTERN"
  assert_matches "detects: // FIXME:"             "// FIXME: wrong logic here"        "$STUB_PATTERN"
  assert_matches "detects: raise NotImplementedError" "raise NotImplementedError"     "$STUB_PATTERN"
  assert_matches "detects: throw new Error Not impl"  "throw new Error('Not implemented')" "$STUB_PATTERN"
  assert_matches "detects: throw new Error not impl"  "throw new Error('not implemented yet')" "$STUB_PATTERN"
  assert_matches "detects: # stub"                "# stub"                            "$STUB_PATTERN"
  assert_matches "detects: // stub"               "// stub"                           "$STUB_PATTERN"
  assert_matches "detects: # stub (with text)"    "# stub — replace with real impl"   "$STUB_PATTERN"

  # Should NOT match — explanatory prose (false positive prevention)
  assert_no_match "ignores: prose 'TODO' mid-sentence"   "I have removed the TODO comment" "$STUB_PATTERN"
  assert_no_match "ignores: prose 'FIXME was addressed'" "The FIXME was addressed in PR #42" "$STUB_PATTERN"
  assert_no_match "ignores: 'TODO' at sentence start"    "TODO list: first item is done"    "$STUB_PATTERN"
  assert_no_match "ignores: 'FIXME' in English prose"    "FIXME is now resolved"            "$STUB_PATTERN"
fi

# ── 3. failure capture — a broken install is recorded, nothing the policy says changes ────────
# (feature 046, IC-018). The shipped policy folder is copied to a scratch directory so its policy
# file can be removed, and every run pins HOME and XDG_CONFIG_HOME to scratch folders so nothing
# reaches the real failure list.

echo ""
echo "3. failure capture (fail-open branches)"
echo "────────────────────────────────────────"

CAP_TMP="$(mktemp -d)"
CAP_POLICIES="$CAP_TMP/policies"
CAP_HOME="$CAP_TMP/home"
CAP_XDG="$CAP_TMP/xdg"
CAP_EVENTS="$CAP_XDG/doflow/failures/events.jsonl"
mkdir -p "$CAP_HOME" "$CAP_XDG"
cp -R "$REPO_ROOT/core/harnesses/shared/hooks/policies" "$CAP_POLICIES"
rm -f "$CAP_POLICIES/mcp-policy.conf"

# cap_run <capture value> <policy> <stdin> -> CAP_RESULT="<exit>|<stdout>|<stderr>" (HOME and XDG pinned)
cap_run() {
  local mode="$1" policy="$2" input="$3" code=0
  case "$input" in
    ''|'not json at all') CAP_ENCODED="$input" ;;
    *) CAP_POLICY_ID="${policy%.sh}"; CAP_ENCODED=$(printf '%s\n' "$input" | jq -c --arg harness claude --arg event PreToolUse --arg policy "$CAP_POLICY_ID" -f "$REPO_ROOT/core/harnesses/shared/hooks/bridge/envelope.jq") ;;
  esac
  # `|| code=$?`: lib.sh, sourced above, leaves errexit on, and a deny exits non-zero.
  printf '%s' "$CAP_ENCODED" | env HOME="$CAP_HOME" XDG_CONFIG_HOME="$CAP_XDG" DOFLOW_FAILURE_CAPTURE="$mode" \
    bash "$CAP_POLICIES/$policy" >"$CAP_TMP/out" 2>"$CAP_TMP/err" || code=$?
  CAP_RESULT="$code|$(cat "$CAP_TMP/out")|$(cat "$CAP_TMP/err")"
}
cap_lines() { if [[ -f "$CAP_EVENTS" ]]; then wc -l <"$CAP_EVENTS" | tr -d ' '; else echo 0; fi; }

MCP_CALL='{"tool_name":"mcp__srv__tool"}'
MCP_CALL_V1=$(printf '%s\n' "$MCP_CALL" | jq -c --arg harness claude --arg event PreToolUse --arg policy mcp-tool-guard -f "$REPO_ROOT/core/harnesses/shared/hooks/bridge/envelope.jq")

for CASE in "mcp-tool-guard.sh|$MCP_CALL|mcp call"; do
  CAP_POLICY="${CASE%%|*}"; CAP_REST="${CASE#*|}"; CAP_INPUT="${CAP_REST%%|*}"; CAP_NAME="${CAP_REST#*|}"
  rm -rf "$CAP_XDG/doflow"
  cap_run off "$CAP_POLICY" "$CAP_INPUT"; CAP_OFF="$CAP_RESULT"
  assert_eq "capture off: $CAP_POLICY $CAP_NAME writes nothing" "no" "$([[ -e "$CAP_XDG/doflow" ]] && echo yes || echo no)"
  cap_run "" "$CAP_POLICY" "$CAP_INPUT"; CAP_ON="$CAP_RESULT"
  assert_eq "capture on: $CAP_POLICY $CAP_NAME output and exit status identical to capture off" "$CAP_OFF" "$CAP_ON"
  assert_eq "capture on: $CAP_POLICY $CAP_NAME records one line" "1" "$(cap_lines)"
done

rm -rf "$CAP_XDG/doflow"
cap_run "" mcp-tool-guard.sh "$MCP_CALL"
assert_eq "mcp-tool-guard records policy-file-missing as a hook line" "hook|mcp-tool-guard|policy-file-missing|null" \
  "$(jq -r '[.source,.command,.kind,(.exit|tostring)]|join("|")' "$CAP_EVENTS")"

# DEC-033: malformed and empty stdin are out of step and blocking policies exit 2 with the refresh reason.
for BAD_INPUT in "not json at all" ""; do
  rm -rf "$CAP_XDG/doflow"
  cap_run off mcp-tool-guard.sh "$BAD_INPUT"; CAP_OFF="$CAP_RESULT"
  cap_run "" mcp-tool-guard.sh "$BAD_INPUT"; CAP_ON="$CAP_RESULT"
  assert_eq "malformed stdin '$BAD_INPUT': output identical with capture on and off" "$CAP_OFF" "$CAP_ON"
  assert_eq "malformed stdin '$BAD_INPUT': exits with out-of-step block" "2" "${CAP_ON%%|*}"
  assert_eq "malformed stdin '$BAD_INPUT': records one out-of-step failure" "1" "$(cap_lines)"
  assert_matches "malformed stdin '$BAD_INPUT': asks for harness refresh" "${CAP_ON#*|}" 'DoFlow hooks out of step; run: doflow update'
done

# HOME unset and no XDG_CONFIG_HOME: capture is skipped and the guard answers as before.
rm -rf "$CAP_XDG/doflow"
CAP_NOHOME_ON="$(printf '%s' "$MCP_CALL_V1" | env -u HOME -u XDG_CONFIG_HOME bash "$CAP_POLICIES/mcp-tool-guard.sh" 2>&1; echo "exit=$?")"
CAP_NOHOME_OFF="$(printf '%s' "$MCP_CALL_V1" | env -u HOME -u XDG_CONFIG_HOME DOFLOW_FAILURE_CAPTURE=off bash "$CAP_POLICIES/mcp-tool-guard.sh" 2>&1; echo "exit=$?")"
assert_eq "HOME unset: guard output and exit status identical with capture on and off" "$CAP_NOHOME_OFF" "$CAP_NOHOME_ON"
assert_eq "HOME unset: nothing is written" "0" "$(cap_lines)"

rm -rf "$CAP_TMP"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
printf "Results: %d/%d passed\n" "$PASS" "$TOTAL"
if [[ $FAIL -gt 0 ]]; then
  printf "%d test(s) FAILED\n" "$FAIL"
  exit 1
fi
echo "All tests passed."
