#!/usr/bin/env bash
case $0 in */*) _DOFLOW_POLDIR=${0%/*} ;; *) _DOFLOW_POLDIR=. ;; esac
# user-prompt-submit.sh — Canonical Policy Library: UserPromptSubmit hook
#
# 022-hooks-remaining-duplication: claude and codex's UserPromptSubmit policies share the same
# context-gathering behavior. Gemini has no UserPromptSubmit-equivalent event in its native hook set.
#
# Emission (078 IC-004): this policy reads the payload, records its decisions and runs the nudge
# classifier; doflow_emit_prompt (emission.sh) decides and renders the response. On the first
# prompt of a bootstrap unit that is git context, the scoped prior summary and the prior warning
# in one nested envelope,
#   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":...}}
# with sessionTitle on every harness but Codex unless the payload already carries session_title
# (DEC-030). Later prompts print {} unless the nudge below is earned.
#
# Once per session, the first prompt that reads as a plain code-change request (decided by
# prompt-nudge.jq against the rules in the workflow registry's `promptNudge` key) also carries a
# one-sentence suggestion to use /do: appended to the first-prompt context, or alone in the same
# nested envelope on a later prompt. The nudge is advisory and never blocks or rewrites a prompt.
# Every failure on its path (no registry, no jq regex support, an unwritable state folder, an
# opt-out file, a subagent prompt, a /do-flow already in progress) resolves to silence; see the
# once-per-session marker in lib.sh. The nudge starts no node or doflow-run process.
#
# Multi-session safe: the adapter's one-shot slot is per bootstrap unit (DEC-007).
# Must complete in <100ms. Must NEVER output "decision: block".

set -euo pipefail
# shellcheck source=lib.sh
source "$_DOFLOW_POLDIR/lib.sh"
INPUT=$(cat)
POLICY_DIR=$_DOFLOW_POLDIR
if [ -f "$POLICY_DIR/contract.sh" ]; then
  # shellcheck source=contract.sh
  source "$POLICY_DIR/contract.sh"
  doflow_decision_init user-prompt-submit 1
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure user-prompt-submit contract-missing ) >/dev/null 2>&1 || true
  printf '{}'
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  doflow_decide error dependency-missing:jq
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure user-prompt-submit dependency-missing:jq ) >/dev/null 2>&1 || true
fi
require_jq
# The emission authority (feature 078): the scoped summary store, the compiled rule table and the
# adapter. A missing file leaves its functions
# undefined, which the adapter (or the check below) answers with the silent response and an
# emission-deps capture.
# shellcheck source=summary-store.sh
[ ! -f "$_DOFLOW_POLDIR/summary-store.sh" ] || . "$_DOFLOW_POLDIR/summary-store.sh"
# shellcheck source=emission-rules.sh
[ ! -f "$_DOFLOW_POLDIR/emission-rules.sh" ] || . "$_DOFLOW_POLDIR/emission-rules.sh"
# shellcheck source=emission.sh
[ ! -f "$_DOFLOW_POLDIR/emission.sh" ] || . "$_DOFLOW_POLDIR/emission.sh"
# One jq pass over the payload for every field this hook reads (each pass costs about 8 ms on a
# 20 KB prompt, and the budget is 100 ms), NUL-separated: session_id, cwd and session_title, null
# and false read as empty as json_field does, with any NUL inside a value dropped so no field can
# shift into the next; then `subagent` when agent_id or agent_type holds anything but null or "".
SESSION_ID="" CWD="" PAYLOAD_TITLE="" SUBAGENT="" ENVELOPE_CLASS=missing
{ IFS= read -r -d '' SESSION_ID; IFS= read -r -d '' CWD; IFS= read -r -d '' PAYLOAD_TITLE; IFS= read -r -d '' SUBAGENT; IFS= read -r -d '' ENVELOPE_CLASS; } < <(
  printf '%s' "$INPUT" | jq -j '. as $p
    | [if ($p.session_id | type) == "string" then ($p.session_id | rtrimstr("\n")) else $p.session_id end, $p.cwd, $p.session_title]
    | map(if . == null or . == false then "" elif type == "string" then . else tojson end | split("\u0000") | join(""))
    | . + [if any($p.agent_id, $p.agent_type; . != null and . != "") then "subagent" else "" end]
    | . + [if (($p | type) != "object") or (($p.doflow_event | type) != "object") or (($p.doflow_event | has("version")) | not) then "missing" elif (($p.doflow_event.version | type) == "number") and $p.doflow_event.version == 1 then "v1" else "unsupported" end]
    | join("\u0000") + "\u0000"' 2>/dev/null
) || true
ENVELOPE_CLASS=${ENVELOPE_CLASS:-missing}
if [ ! -f "$POLICY_DIR/contract.sh" ]; then ENVELOPE_CLASS=missing; fi

if [[ "$ENVELOPE_CLASS" == unsupported || "$ENVELOPE_CLASS" == missing ]]; then
  code=envelope-version
  [[ "$ENVELOPE_CLASS" == missing ]] && code=envelope-missing
  [[ -f "$POLICY_DIR/contract.sh" ]] || code=contract-missing
  doflow_decide unsupported "$code"
  if [[ -f "$POLICY_DIR/contract.sh" ]]; then
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure user-prompt-submit "$code" ) >/dev/null 2>&1 || true
  fi
  printf '{}'
  exit 0
fi

[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH="$SESSION_DIR/$SESSION_ID"

# ── Prompt nudge (IC-004 N1-N8) ───────────────────────────────────────────────

# Print the nudge message when this prompt earns it, nothing otherwise. Every gate that stops
# returns 0 with no output; the caller also contains a failure of the whole function, so nothing
# here can change the exit status or the first-prompt output. The prompt only ever travels to jq
# on stdin, with stderr discarded, and is never copied out of INPUT.
nudge_message() {
  local root policy_dir here registry decision message role
  [[ "${DOFLOW_AGENT:-}" == "claude" || "${DOFLOW_AGENT:-}" == "codex" ]] || return 0   # N1
  # The role gate is the rule table's: a role whose prompt.nudge action is skip (a worker) is never
  # nudged, and returning here keeps the classifier from running or marking it (L2-15).
  role=$(doflow_session_role 2>/dev/null) || role=main
  DF_ACTION=skip
  declare -F doflow_emission_rule >/dev/null 2>&1 && doflow_emission_rule prompt.nudge "$role:nudge" 2>/dev/null || DF_ACTION=skip
  [[ "$DF_ACTION" != "skip" ]] || return 0
  nudge_safe_id "$SESSION_ID" || return 0                                               # N2
  root=$(nudge_repo_root "$CWD") || return 0
  [[ "$(nudge_setting "$root")" == "on" ]] || return 0                                  # N3
  [[ ! -e "$STATE_DIR/nudge/$SESSION_ID" ]] || return 0                                 # N4 (IC-008's path, no process)
  # The marker is written after the render (DEC-041), so a folder it cannot be written to would
  # nudge every prompt: an unwritable marker folder (or state folder, before it exists) is silent.
  if [[ -e "$STATE_DIR/nudge" ]]; then [[ -d "$STATE_DIR/nudge" && -w "$STATE_DIR/nudge" ]] || return 0
  elif [[ -e "$STATE_DIR" ]]; then [[ -w "$STATE_DIR" ]] || return 0; fi
  # N5: a subagent prompt carries agent_id or agent_type (read with the other fields above).
  [[ -z "$SUBAGENT" ]] || return 0
  # N6: the policy script's physical directory, found with built-ins (a subshell costs about 4 ms).
  policy_dir=$_DOFLOW_POLDIR
  here="$PWD"
  cd -P -- "$policy_dir" 2>/dev/null || return 0
  policy_dir="$PWD"
  cd -- "$here" 2>/dev/null || return 0
  registry=$(nudge_registry "$policy_dir" "$root") || return 0
  decision=$(printf '%s' "$INPUT" | jq -r --slurpfile R "$registry" -f "$policy_dir/prompt-nudge.jq" 2>/dev/null) || return 0
  if [[ "$decision" == "suppress" ]]; then
    nudge_mark "$SESSION_ID" suppressed || true
    return 0
  fi
  [[ "$decision" == "nudge" ]] || return 0
  if nudge_feature_active "$CWD" "$root" "$SESSION_PATH" || nudge_ledger_active "$CWD" "$SESSION_PATH"; then   # N7
    nudge_mark "$SESSION_ID" suppressed || true
    return 0
  fi
  # N8: a registry without a usable message leaves no marker. The `nudged` marker is written by
  # doflow_emit_prompt once the nudge rendered, so a nudge the budget dropped stays unmarked (DEC-041).
  message=$(jq -r '.promptNudge.message | strings' "$registry" 2>/dev/null) || return 0
  [[ -n "$message" ]] || return 0
  printf '%s' "$message"
  return 0
}

# ── Emission: every prompt, handed to the authority (IC-004) ──────────────────
# The classifier runs first, where its gates allow, and returns the message unmarked.
# doflow_emit_prompt decides everything else (the bootstrap slot, git context, the
# scoped summary, the warning, a grant, the nudge's place in the budget), prints the response and
# marks the session nudged and records `advisory prompt-nudge` itself when the nudge was rendered.

NUDGE=$(nudge_message 2>/dev/null) || NUDGE=""
if ! declare -F doflow_emit_prompt >/dev/null 2>&1; then
  ( . "$POLICY_DIR/capture-failure.sh"; doflow_capture_failure user-prompt-submit emission-deps ) >/dev/null 2>&1 || true
  printf '{}\n'
  exit 0
fi
doflow_emit_prompt "$SESSION_ID" "$CWD" "$PAYLOAD_TITLE" "$SUBAGENT" "$NUDGE"

exit 0
