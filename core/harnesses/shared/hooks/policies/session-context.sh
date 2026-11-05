#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
_DOFLOW_SRC=${0//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_POLDIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_POLDIR=. ;; esac
# session-context.sh — Canonical Policy Library: SessionStart guard policy
#
# Fires when a harness starts a new session. Captures git state into a
# session-scoped file so a harness's user-prompt-submit hook can inject it on
# the first prompt.
#
# Cannot inject into the LLM context from this event — side effects only.
# Must complete in <200ms. Must never exit non-zero or produce unexpected stderr.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional here; DOFLOW_AGENT
#          only affects the "last_agent" field recorded in meta.json)
#   stdin  envelope v1 from the native SessionStart payload, including
#          the session_id and cwd fields used by this policy.
#   exit   this policy never denies — it always exits 0 (side-effect only)
#
# Depends on lib.sh (require_jq, json_field, ensure_session_dir,
# ensure_project_dir, cwd_hash, run_with_timeout, $SESSIONS_LOG) being
# discoverable next to this script when it runs — a front door invoking this
# canonical script is responsible for making lib.sh resolvable via
# the sibling lib.sh, exactly as every harness's own SessionStart script
# already required before this policy moved to a shared location.

set -euo pipefail
# shellcheck source=lib.sh
source "$_DOFLOW_POLDIR/lib.sh"
INPUT=$(cat)
POLICY_DIR=$_DOFLOW_POLDIR
if [ -f "$POLICY_DIR/contract.sh" ]; then
  # shellcheck source=contract.sh
  source "$POLICY_DIR/contract.sh"
  doflow_decision_init session-context 1
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure session-context contract-missing ) >/dev/null 2>&1 || true
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  doflow_decide error dependency-missing:jq
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure session-context dependency-missing:jq ) >/dev/null 2>&1 || true
fi
require_jq
SESSION_ID="" ENVELOPE_CLASS=missing CWD_RAW="" TIMESTAMP=""
# One jq reads the envelope class, session id, cwd and the UTC time. The cwd is taken from here only
# when it is a string without a NUL (flagged "S"); any other present value is flagged "F" and is read
# by json_field below, exactly as before.
{ IFS= read -r -d '' ENVELOPE_CLASS; IFS= read -r -d '' SESSION_ID; IFS= read -r -d '' CWD_RAW; IFS= read -r -d '' TIMESTAMP; } < <(
  printf '%s' "$INPUT" | jq -j 'if ((. | type) != "object") or ((.doflow_event | type) != "object") or ((.doflow_event | has("version")) | not) then "missing" elif ((.doflow_event.version | type) == "number") and .doflow_event.version == 1 then "v1" else "unsupported" end, "\u0000", (.session_id // "" | if type == "string" then rtrimstr("\n") else tojson end), "\u0000", (.cwd // empty | if type == "string" and (contains("\u0000") | not) then "S" + . else "F" end), "\u0000", (try (now | floor | strftime("%Y-%m-%dT%H:%M:%SZ")) catch ""), "\u0000"' 2>/dev/null
) || true
ENVELOPE_CLASS=${ENVELOPE_CLASS:-missing}
if [ ! -f "$POLICY_DIR/contract.sh" ]; then ENVELOPE_CLASS=missing; fi
if [ "$ENVELOPE_CLASS" = unsupported ] || [ "$ENVELOPE_CLASS" = missing ]; then
  code=envelope-version
  [ "$ENVELOPE_CLASS" = missing ] && code=envelope-missing
  [ -f "$POLICY_DIR/contract.sh" ] || code=contract-missing
  doflow_decide unsupported "$code"
  if [ -f "$POLICY_DIR/contract.sh" ]; then
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure session-context "$code" ) >/dev/null 2>&1 || true
  fi
  exit 0
fi
case "$CWD_RAW" in
  S*)
    CWD=${CWD_RAW#S}
    while [[ "$CWD" == *$'\n' ]]; do CWD=${CWD%$'\n'}; done # $(...) drops every trailing newline
    ;;
  "") CWD="" ;;
  *) CWD=$(json_field "$INPUT" ".cwd") ;;
esac

package_verify_async() {
  local home="${HOME:-}" lock run config_dir detach=""
  [ -n "$home" ] || return 0
  lock="$home/.doflow/doflow.lock"
  [ -f "$lock" ] || return 0
  jq -e '(.packages // []) | length > 0' "$lock" >/dev/null 2>&1 || return 0
  config_dir="${CLAUDE_CONFIG_DIR:-$home/.claude}"
  command -v setsid >/dev/null 2>&1 && detach="setsid"
  for run in \
    "$home/.doflow/scripts/doflow/bin/doflow-run" \
    "$config_dir/scripts/doflow/bin/doflow-run"
  do
    [ -x "$run" ] || continue
    ( cd "$home/.doflow" 2>/dev/null && nohup $detach "$run" package --action verify </dev/null >/dev/null 2>&1 ) >/dev/null 2>&1 3>&- 5>&- &
    return 0
  done
  return 0
}

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

# No config home (lib.sh leaves the state paths empty): no session store to write, but the
# storage upkeep still starts (086 IC-010).
if [[ -z "$SESSION_DIR" ]]; then
  package_verify_async
  storage_upkeep_async "$CWD"
  exit 0
fi

# Two git runs (status, log) answer everything below in the common case, started together so their
# start-up overlaps. Any other case (not a work tree, detached HEAD, no ahead/behind line, an
# unexpected log line) falls back to the individual queries, so the recorded values are the ones
# those queries give.
git_state_start() {
  exec 10< <(run_with_timeout 1 -- git -C "$CWD" status --porcelain=v2 --branch --show-stash 2>/dev/null || true)
  exec 11< <(run_with_timeout 1 -- git -C "$CWD" log --oneline -5 2>/dev/null || true)
}

git_state_fast() {
  local status_out="" log_out="" line head="" upstream="" ab="" stash=0 n=0 first
  IFS= read -r -d '' status_out <&10 || true
  IFS= read -r -d '' log_out <&11 || true
  exec 10<&- 11<&-
  [[ -n "$status_out" ]] || return 1
  while IFS= read -r line; do
    case "$line" in
      "# branch.head "*) head=${line#"# branch.head "} ;;
      "# branch.upstream "*) upstream=1 ;;
      "# branch.ab +"*) ab=${line##* -} ;;
      "# stash "*) stash=${line#"# stash "} ;;
      "#"*) ;;
      ?*) n=$((n + 1)) ;;
    esac
  done <<< "$status_out"
  [[ "$head" != "(detached)" && -n "$head" ]] || return 1
  [[ "$stash" =~ ^[0-9]+$ ]] || return 1
  if [[ -n "$upstream" && -z "$ab" ]]; then return 1; fi
  [[ -z "$ab" || "$ab" =~ ^[0-9]+$ ]] || return 1
  while [[ "$log_out" == *$'\n' ]]; do log_out=${log_out%$'\n'}; done # $(...) drops every trailing newline
  if [[ -n "$log_out" ]]; then
    first=${log_out%%$'\n'*}
    first=${first%% *}
    [[ "$first" =~ ^[0-9a-f]{4,64}$ ]] || return 1
    SHA=$first
  fi
  COMMITS_RAW=$log_out
  BRANCH=$head
  UNCOMMITTED=$n
  STASH_COUNT=$stash
  UPSTREAM_BEHIND=${ab:-0}
  return 0
}

if [[ -n "$CWD" ]]; then git_state_start; fi

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

# Clean up stale injected flag from a prior crashed session
if [ -e "$SESSION_PATH/injected" ] || [ -L "$SESSION_PATH/injected" ]; then rm -f "$SESSION_PATH/injected"; fi

[[ -n "$TIMESTAMP" ]] || TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Work that does not need the git results runs while git does. A failed mkdir here is retried, and
# reported, at the point the project directory is used below.
if [[ -n "$CWD" ]]; then
  CWD_HASH=$(cwd_hash "$CWD")
  mkdir -p "$PROJECTS_DIR/$CWD_HASH" 2>/dev/null || true
fi

# ── Git state capture ─────────────────────────────────────────────────────────

IS_GIT_REPO=false
BRANCH=""
SHA=""
COMMITS_RAW=""
UNCOMMITTED=0
STASH_COUNT=0
UPSTREAM_BEHIND=0

if [[ -n "$CWD" ]]; then
  if git_state_fast; then
    IS_GIT_REPO=true
  elif is_git_worktree "$CWD"; then
    IS_GIT_REPO=true

    BRANCH=$(git_branch_of "$CWD" || echo "")
    SHA=$(git_short_sha_of "$CWD" || echo "")

    # Last 5 commits as a JSON array of one-liner strings.
    COMMITS_RAW=$(run_with_timeout 1 -- git -C "$CWD" log --oneline -5 2>/dev/null || true)

    # Count uncommitted (staged + unstaged) files
    UNCOMMITTED=$(git_uncommitted_count_of "$CWD" || echo "0")

    # Count stash entries
    STASH_COUNT=$(run_with_timeout 1 -- git -C "$CWD" stash list 2>/dev/null | wc -l | tr -d ' ' || echo "0")

    # How far behind upstream (0 if no upstream configured)
    # shellcheck disable=SC1083  # @{u} is git upstream ref syntax, not a shell brace expression
    UPSTREAM_BEHIND=$(run_with_timeout 1 -- git -C "$CWD" rev-list --count HEAD..@{u} 2>/dev/null || echo "0")
  fi
fi

# ── Write git-context.json ────────────────────────────────────────────────────

# Use jq -n for full construction — avoids heredoc variable interpolation
# which can produce invalid JSON if numeric fields contain unexpected output.
jq -n \
  --arg     branch       "$BRANCH" \
  --arg     sha          "$SHA" \
  --arg     commits_raw  "$COMMITS_RAW" \
  --argjson uncommitted  "$UNCOMMITTED" \
  --argjson stash        "$STASH_COUNT" \
  --argjson behind       "$UPSTREAM_BEHIND" \
  --argjson is_git       "$IS_GIT_REPO" \
  --arg     cwd          "$CWD" \
  --arg     captured_at  "$TIMESTAMP" \
  '{
    branch:           $branch,
    sha:              $sha,
    commits:          ($commits_raw | split("\n") | map(select(length > 0))),
    uncommitted_count: $uncommitted,
    stash_count:      $stash,
    upstream_behind:  $behind,
    is_git_repo:      $is_git,
    cwd:              $cwd,
    captured_at:      $captured_at
  }' > "$SESSION_PATH/git-context.json"

# ── Write meta.json ───────────────────────────────────────────────────────────

if [[ -n "$CWD" ]]; then
  PROJECT_DIR="$PROJECTS_DIR/$CWD_HASH"
  [ -d "$PROJECT_DIR" ] || mkdir -p "$PROJECT_DIR"
  # Preserve compacted_at from the prior session if present
  PRIOR_COMPACTED_AT=""
  if [[ -f "$PROJECT_DIR/meta.json" ]]; then
    PRIOR_COMPACTED_AT=$(jq -r '.compacted_at // empty' "$PROJECT_DIR/meta.json" 2>/dev/null || echo "")
  fi
  META_TMP=$(mktemp "$PROJECT_DIR/.meta.XXXXXX")
  trap '[ ! -e "$META_TMP" ] || rm -f "$META_TMP" 2>/dev/null || true' EXIT
  jq -n \
    --arg cwd          "$CWD" \
    --arg cwd_hash     "$CWD_HASH" \
    --arg last_agent   "$DOFLOW_AGENT" \
    --arg last_active  "$TIMESTAMP" \
    --arg compacted_at "${PRIOR_COMPACTED_AT:-}" \
    --arg branch       "${BRANCH:-}" \
    '{
      cwd:          $cwd,
      cwd_hash:     $cwd_hash,
      last_agent:   $last_agent,
      last_active:  $last_active,
      compacted_at: (if $compacted_at == "" then null else $compacted_at end),
      branch:       $branch
    }' > "$META_TMP" && mv "$META_TMP" "$PROJECT_DIR/meta.json" \
    || rm -f "$META_TMP" 2>/dev/null || true
fi

# ── Append to sessions.log ────────────────────────────────────────────────────

SESSIONS_LOG_DIR=${SESSIONS_LOG%/*}
[ -d "$SESSIONS_LOG_DIR" ] || mkdir -p "$SESSIONS_LOG_DIR"
echo "$TIMESTAMP START $SESSION_ID ${CWD:-unknown}" >> "$SESSIONS_LOG"

package_verify_async
storage_upkeep_async "$CWD"
exit 0
