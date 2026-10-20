#!/usr/bin/env bash
# emission.sh — Canonical Policy Library: the hook emission adapter and the emission ledger
# (feature 078, IC-004, IC-015; DEC-015, DEC-016, DEC-017).
#
# The prompt path's emission, from the state bits to the response bytes. arbitrate() in
# src/runtime/context/arbitrate.ts is the reference for the rules; this file reads the compiled
# table (emission-rules.sh), claims through summary-store.sh and renders with one jq process running
# emission.jq. It starts no Node or doflow-run process.
#
# Sourcing this file defines functions only: no option, no variable, no trap, no output. bash 3.2
# safe and safe under the caller's `set -euo pipefail`. The caller has sourced lib.sh (which sources
# identity.sh), summary-store.sh and emission-rules.sh; a missing one is a fault.
#
# Store, under SESSION_DIR (lib.sh; session-env/sessions; empty with no config home, which prints
# the silent response with reason silent:no-home):
#   <unitId>/injected   one-shot bootstrap slot, created exclusively (set -C) by the first caller
#   <unitId>/emitted    the IC-015 ledger: <ISO-8601 UTC>\t<kind>\t<key>\t<outcome>\t<caller>, one
#                       line per (kind, key, outcome), appended only when that triple is absent
#
# Faults: any claim or render failure prints the silent response ({} and a newline) and records
# `doflow_capture_failure user-prompt-submit emission-<point>`, point one of deps, unit, slot,
# summary, grant, warning, render; a failed ledger append records emission-ledger and keeps the
# rendered response. A fault after the slot claim releases the slot this call created, so the next
# prompt bootstraps again (DEC-038); a fault in a later claim renames the summary, grant and warning
# already claimed back into place (`mv -n`, never over a newer file). A claim that fails because its
# source vanished (another caller won it) is no fault: that segment counts as absent and the
# bootstrap continues. A claimed summary or grant whose render fails is not restored.
#
# Ledger outcomes besides refused:mandatory-over-budget: `optional-dropped <key> over-budget`, one
# per optional segment the budget dropped (key: the summary id for summary, else the segment name;
# DEC-041). A dropped nudge leaves the session unmarked, so a later prompt can nudge.

# _doflow_em_capture <point>: one failure-capture line, never on stdout or stderr.
_doflow_em_capture() {
  local dir
  case ${BASH_SOURCE[0]} in */*) dir=${BASH_SOURCE[0]%/*} ;; *) dir=. ;; esac
  if declare -F doflow_capture_failure >/dev/null 2>&1; then
    ( doflow_capture_failure user-prompt-submit "emission-$1" ) >/dev/null 2>&1 || true
  else
    ( . "$dir/capture-failure.sh" && doflow_capture_failure user-prompt-submit "emission-$1" ) >/dev/null 2>&1 || true
  fi
  return 0
}

# _doflow_em_restore <claimed> <original>: rename a claimed file back unless a newer one took its
# place, in which case the claimed copy is the older and is removed.
_doflow_em_restore() {
  [ -n "$1" ] && [ -e "$1" ] || return 0
  mv -n "$1" "$2" 2>/dev/null || true
  [ ! -e "$1" ] || rm -f "$1" 2>/dev/null || true
  return 0
}

# _doflow_em_release: undo this call's claims before a fault response, from the caller's locals
# (made, dir, sumfile, sumsrc, claimed_grant, grantsrc, warnclaimed, warnfile). The slot goes last.
_doflow_em_release() {
  [ "$sumfile" = /dev/null ] || _doflow_em_restore "$sumfile" "$sumsrc"
  [ -z "$claimed_grant" ] || _doflow_em_restore "$claimed_grant" "$grantsrc"
  [ -z "$warnclaimed" ] || _doflow_em_restore "$warnclaimed" "$warnfile"
  sumfile=/dev/null claimed_grant="" warnclaimed=""
  if [ "$made" = 1 ]; then rm -f "$dir/injected" 2>/dev/null || true; made=0; fi
  return 0
}

# _doflow_em_measure <response> <digest>: for the response printed as `printf '%s\n'`, DF_EMIT_BYTES
# (its byte length under LC_ALL=C, newline included) and DF_EMIT_DIGEST (the renderer's digest
# header line when it is 8 lowercase hex, else empty). Rider R1 (091): metadata for the hook line
# only; builtins only, no response byte leaves this function, and nothing reaches stdout.
_doflow_em_measure() {
  local LC_ALL=C
  DF_EMIT_BYTES=$(( ${#1} + 1 ))
  DF_EMIT_DIGEST=""
  case "${2:-}" in
    [0123456789abcdef][0123456789abcdef][0123456789abcdef][0123456789abcdef][0123456789abcdef][0123456789abcdef][0123456789abcdef][0123456789abcdef]) DF_EMIT_DIGEST=$2 ;;
  esac
  return 0
}

# _doflow_em_silent <point>: the fault response.
_doflow_em_silent() {
  _doflow_em_capture "$1"
  DF_EMIT_REASON="fault:$1"
  printf '{}\n'
  return 0
}

# _doflow_em_seen <ledger file> <kind> <key> <outcome>: 0 when the triple is already recorded.
_doflow_em_seen() {
  local ts kind key outcome caller
  [ -f "$1" ] || return 1
  {
    while IFS=$'\t' read -r ts kind key outcome caller || [ -n "$ts" ]; do
      if [ "$kind" = "$2" ] && [ "$key" = "$3" ] && [ "$outcome" = "$4" ]; then return 0; fi
      ts=""
    done
  } 2>/dev/null <"$1"
  return 1
}

# _doflow_em_ledger_add <unit dir> <kind> <key> <outcome> <caller>: append one IC-015 line unless
# (kind, key, outcome) is already recorded. Returns 1 when the line could not be written.
_doflow_em_ledger_add() {
  local file="$1/emitted" ts
  if _doflow_em_seen "$file" "$2" "$3" "$4"; then return 0; fi
  mkdir -p "$1" 2>/dev/null || return 1
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || return 1
  printf '%s\t%s\t%s\t%s\t%s\n' "$ts" "$2" "$3" "$4" "$5" >>"$file" 2>/dev/null || return 1
  return 0
}

# _doflow_em_rule <event.segment> <vector>: prints nothing; sets DF_ACTION (skip on any failure).
_doflow_em_rule() {
  DF_ACTION=skip
  doflow_emission_rule "$1" "$2" || DF_ACTION=skip
  return 0
}

# _doflow_em_actions: the prompt segments' actions from the caller's state locals (role, kind,
# bootstrapped, subagent, own, grant, refused, warning, nudge_state), vectors in IC-002 order.
_doflow_em_actions() {
  _doflow_em_rule prompt.slot "$bootstrapped"; a_slot=$DF_ACTION
  _doflow_em_rule prompt.git "$role:$bootstrapped"; a_git=$DF_ACTION
  _doflow_em_rule prompt.summary "$role:$kind:$subagent:$bootstrapped:$own"; a_summary=$DF_ACTION
  _doflow_em_rule prompt.warning "$role:$subagent:$bootstrapped:$warning"; a_warning=$DF_ACTION
  _doflow_em_rule prompt.grant "$subagent:$grant:$refused"; a_grant=$DF_ACTION
  _doflow_em_rule prompt.nudge "$role:$nudge_state"; a_nudge=$DF_ACTION
  return 0
}

# doflow_emit_prompt <session_id> <cwd> <payload_title> <subagent> <nudge_text>
# IC-004 steps 2 to 8 for one UserPromptSubmit event; prints the response on stdout and returns 0.
#   session_id     the payload session_id; empty prints nothing (the 0fcd973 early exit)
#   cwd            the payload cwd
#   payload_title  the payload session_title; non-empty suppresses sessionTitle
#   subagent       non-empty when the payload is a native subagent prompt (agent_id or agent_type)
#   nudge_text     the nudge message when the classifier earned it, else empty; the session is
#                  marked nudged here, only once the nudge rendered (DEC-041)
# Reads DOFLOW_AGENT (harness; sessionTitle on every harness but codex, DEC-030),
# DOFLOW_CONTEXT_MAX_BYTES (budget, default DF_RULES_MAX_BYTES_DEFAULT or 16384), SESSION_DIR and the
# launcher variables through doflow_identity. Sets DF_ID_* (doflow_identity), DF_EMIT_REASON (emit,
# refused:mandatory-over-budget, silent:already-bootstrapped, silent:unchanged, silent:no-home or
# fault:<point>), DF_EMIT_BYTES and DF_EMIT_DIGEST (_doflow_em_measure for emit and refused:*, else 0
# and empty) and DF_EMIT_NUDGE (rendered or empty); when the nudge was rendered it calls
# `nudge_mark <session> nudged` and, when contract.sh is loaded, `doflow_decide advisory prompt-nudge`.
doflow_emit_prompt() {
  local session="${1:-}" cwd="${2:-}" payload_title="${3:-}" nudge="${5:-}"
  local subagent=false nudge_state=none role kind bootstrapped=false own=none grant=none refused=false
  local warning=false legacy=false a_slot a_git a_summary a_warning a_grant a_nudge
  local sessions dir unit max harness here renderer project="" warnfile="" warntext="" had_c=0 made=0
  local gitfile sumfile=/dev/null grantfile=/dev/null claimed_grant="" absent="" plan out
  local refusal=refused:mandatory-over-budget title=false sumsrc="" sumid="" grantsrc="" warnclaimed=""
  local dropped rest seg key digest=false
  DF_EMIT_REASON=""
  DF_EMIT_BYTES=0
  DF_EMIT_DIGEST=""
  DF_EMIT_NUDGE=""
  [ -n "$session" ] || return 0
  [ -z "${4:-}" ] || subagent=true
  [ -z "$nudge" ] || nudge_state=nudge
  if ! declare -F doflow_identity doflow_emission_rule doflow_summary_peek doflow_summary_claim \
    doflow_grant_peek doflow_grant_claim doflow_summary_adopt_legacy doflow_summary_legacy_present ensure_project_dir >/dev/null 2>&1; then
    _doflow_em_silent deps
    return 0
  fi
  case ${BASH_SOURCE[0]} in */*) here=${BASH_SOURCE[0]%/*} ;; *) here=. ;; esac
  # The renderer beside the entry policy when it set _DOFLOW_POLDIR, else beside this file.
  renderer=$here/emission.jq
  [ -z "${_DOFLOW_POLDIR:-}" ] || [ ! -f "$_DOFLOW_POLDIR/emission.jq" ] || renderer=$_DOFLOW_POLDIR/emission.jq

  # Step 2: identity, and the unit whose slot and ledger this event uses. The session id names
  # git-context.json's directory for every lineage kind, so it is a path segment or a fault (DEC-042).
  if ! [[ $session =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    _doflow_em_silent unit
    return 0
  fi
  doflow_identity "$session" "$cwd"
  role=$DF_ID_ROLE
  kind=$DF_ID_KIND
  unit=$DF_ID_UNIT
  if ! [[ $unit =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    _doflow_em_silent unit
    return 0
  fi
  # IC-010: lib.sh's SESSION_DIR is empty with no config home; there is no store, so nothing is
  # claimed, rendered or recorded (src/runtime/context/arbitrate.ts answers silent:no-home too).
  sessions="${SESSION_DIR:-}"
  if [ -z "$sessions" ]; then
    DF_EMIT_REASON=silent:no-home
    printf '{}\n'
    return 0
  fi
  dir="$sessions/$unit"
  max="${DOFLOW_CONTEXT_MAX_BYTES:-}"
  [[ $max =~ ^[1-9][0-9]{0,9}$ ]] || max="${DF_RULES_MAX_BYTES_DEFAULT:-16384}"
  harness="${DOFLOW_AGENT:-}"
  [[ $harness =~ ^[A-Za-z0-9._-]{0,40}$ ]] || harness=unknown

  # Step 3: state bits. The project directory, the legacy file, the warning and the owner summary
  # only matter before the bootstrap, so a later prompt reads none of them.
  if [ -e "$dir/injected" ] || [ -L "$dir/injected" ]; then bootstrapped=true; fi
  if [ "$bootstrapped" = false ]; then
    if [ -n "$cwd" ]; then project=$(ensure_project_dir "$cwd" 2>/dev/null) || project=""; fi
    if [ -n "$project" ]; then
      if doflow_summary_legacy_present "$cwd"; then legacy=true; fi
      warnfile="$project/uncommitted-warning.txt"
      if [ -f "$warnfile" ]; then warning=true; fi
    fi
    doflow_summary_peek "$DF_ID_WORKTREE" "$DF_ID_RUN" "$DF_ID_LINEAGE" "$session"
    own=$DF_SUMMARY_OWN
  fi
  # Grants are addressed to launched units only: local, solo and main lineages are shared by
  # unrelated sessions (DEC-039).
  if [ "$kind" = launched ]; then
    doflow_grant_peek "$DF_ID_RUN" "$DF_ID_LINEAGE" "$max"
    grant=$DF_GRANT
  fi
  if [ "$grant" = over ] && _doflow_em_seen "$dir/emitted" grant "$DF_GRANT_ID" "$refusal"; then refused=true; fi

  # Step 4: the legacy adoption, then the owner summary bit again.
  _doflow_em_rule legacy-adopt.legacy "$role:$kind:$subagent:$bootstrapped:$legacy"
  if [ "$DF_ACTION" = adopt ]; then
    doflow_summary_adopt_legacy "$cwd" "$DF_ID_WORKTREE" || true
    doflow_summary_peek "$DF_ID_WORKTREE" "$DF_ID_RUN" "$DF_ID_LINEAGE" "$session"
    own=$DF_SUMMARY_OWN
  fi

  # Step 5: one lookup per segment.
  _doflow_em_actions

  # Step 6: claims in the order slot, summary, grant, warning. EEXIST on the slot means another
  # caller bootstrapped this unit: the segments are looked up again as bootstrapped, which makes
  # every bootstrap-only one skip.
  if [ "$a_slot" = claim ]; then
    if ! mkdir -p "$dir" 2>/dev/null; then
      _doflow_em_silent slot
      return 0
    fi
    case $- in *C*) had_c=1 ;; esac
    set -C
    { : >"$dir/injected"; } 2>/dev/null && made=1
    [ "$had_c" = 1 ] || set +C
    if [ "$made" = 0 ]; then
      if [ -e "$dir/injected" ] || [ -L "$dir/injected" ]; then
        bootstrapped=true
        _doflow_em_actions
      else
        _doflow_em_silent slot
        return 0
      fi
    fi
  fi
  # A lost claim (the source gone, or no longer a pending summary) makes that segment absent and the
  # segments are looked up again; only a failure with the source still in place is a fault.
  if [ "$a_summary" = truncate ]; then
    if doflow_summary_claim "$DF_ID_WORKTREE" "$DF_ID_RUN" "$DF_ID_LINEAGE" "$unit" "$session"; then
      sumfile=$DF_SUMMARY_CLAIMED
      sumsrc=$DF_SUMMARY_SCOPE/summary.md
      sumid=$DF_SUMMARY_SID
    else
      doflow_summary_peek "$DF_ID_WORKTREE" "$DF_ID_RUN" "$DF_ID_LINEAGE" "$session"
      if [ "$DF_SUMMARY_OWN" = pending ]; then
        _doflow_em_release
        _doflow_em_silent summary
        return 0
      fi
      own=none
      _doflow_em_actions
    fi
  fi
  if [ "$a_grant" = whole ]; then
    grantsrc=$DF_GRANT_FILE
    if doflow_grant_claim "$DF_ID_RUN" "$DF_ID_LINEAGE" "$unit" "$max"; then
      grantfile=$DF_GRANT_CLAIMED
      claimed_grant=$grantfile
      grantsrc=$DF_GRANT_FILE
    elif [ -n "$grantsrc" ] && [ -f "$grantsrc" ]; then
      _doflow_em_release
      _doflow_em_silent grant
      return 0
    else
      grant=none
      _doflow_em_actions
    fi
  elif [ "$a_grant" = pointer ]; then
    # An over-budget grant is never claimed: it renders as its pointer from where it lies.
    grantfile=$DF_GRANT_FILE
  fi
  # The warning is claimed by rename, so two first prompts deliver it once (DEC-040); read -d ''
  # returns non-zero at EOF, which is accepted only once the claimed file is known to be readable.
  if [ "$a_warning" = include ]; then
    if mv "$warnfile" "$warnfile.claimed.$unit" 2>/dev/null; then
      warnclaimed=$warnfile.claimed.$unit
      if [ -r "$warnclaimed" ] && [ -f "$warnclaimed" ]; then
        IFS= read -r -d '' warntext 2>/dev/null <"$warnclaimed" || true
      else
        _doflow_em_release
        _doflow_em_silent warning
        return 0
      fi
    elif [ -e "$warnfile" ] || [ -L "$warnfile" ]; then
      _doflow_em_release
      _doflow_em_silent warning
      return 0
    else
      warning=false
      _doflow_em_actions
    fi
  fi

  # Nothing that renders: silence without a jq process.
  case "$a_git $a_summary $a_warning $a_grant $a_nudge" in
    *include* | *truncate* | *whole* | *pointer*) ;;
    *)
      if [ "$bootstrapped" = true ]; then DF_EMIT_REASON=silent:already-bootstrapped; else DF_EMIT_REASON=silent:unchanged; fi
      printf '{}\n'
      return 0
      ;;
  esac

  # Step 7: one jq process. A missing file is /dev/null and named in plan.absent.
  gitfile="$sessions/$session/git-context.json"
  if [ ! -f "$gitfile" ]; then gitfile=/dev/null; absent='"git"'; fi
  [ "$sumfile" != /dev/null ] || absent="${absent:+$absent,}\"summary\""
  [ "$grantfile" != /dev/null ] || absent="${absent:+$absent,}\"grant\""
  [ "$a_warning" = include ] || absent="${absent:+$absent,}\"warning\""
  [ -n "$payload_title" ] || title=true
  plan="{\"actions\":{\"git\":\"$a_git\",\"summary\":\"$a_summary\",\"warning\":\"$a_warning\",\"grant\":\"$a_grant\",\"nudge\":\"$a_nudge\"},\"maxBytes\":$max,\"harness\":\"$harness\",\"title\":$title,\"absent\":[$absent]"
  [ "$sumfile" = /dev/null ] || plan="$plan,\"summaryBytes\":${DF_SUMMARY_BYTES:-0}"
  # Rider R1: the renderer hashes the response only when the bridge will write it (telemetry on, fd set).
  [ "${DOFLOW_TELEMETRY:-}" = off ] || [ -z "${DOFLOW_DECISION_FD:-}" ] || digest=true
  plan="$plan,\"digest\":$digest,\"mode\":\"hook\"}"
  # Hook mode: the first line is the dropped segment names, tab-joined (possibly empty); the second
  # is the response digest (empty unless plan.digest).
  out=$(jq -n -r -f "$renderer" --argjson plan "$plan" --rawfile git "$gitfile" \
    --rawfile summary "$sumfile" --rawfile grant "$grantfile" --arg warning "$warntext" \
    --arg nudge "$nudge" 2>/dev/null) || out=""
  [ "$sumfile" = /dev/null ] || rm -f "$sumfile" 2>/dev/null || true
  [ -z "$claimed_grant" ] || rm -f "$claimed_grant" 2>/dev/null || true
  [ -z "$warnclaimed" ] || rm -f "$warnclaimed" 2>/dev/null || true
  sumfile=/dev/null claimed_grant="" warnclaimed=""
  case "$out" in *$'\n'*$'\n'?*) ;; *) out="" ;; esac
  if [ -z "$out" ]; then
    _doflow_em_release
    _doflow_em_silent render
    return 0
  fi
  dropped=${out%%$'\n'*}
  out=${out#*$'\n'}
  digest=${out%%$'\n'*}
  out=${out#*$'\n'}

  # Step 8: the refusal ledger line (key: the grant's summary id), one optional-dropped line per
  # dropped segment, then the nudge record.
  DF_EMIT_REASON=emit
  if [ "$a_grant" = pointer ]; then
    DF_EMIT_REASON=$refusal
    _doflow_em_ledger_add "$dir" grant "$DF_GRANT_ID" "$refusal" hook || _doflow_em_capture ledger
  fi
  rest=$dropped
  while [ -n "$rest" ]; do
    seg=${rest%%$'\t'*}
    case "$rest" in *$'\t'*) rest=${rest#*$'\t'} ;; *) rest="" ;; esac
    [ -n "$seg" ] || continue
    key=$seg
    [ "$seg" != summary ] || [ -z "$sumid" ] || key=$sumid
    [ "$seg" != grant ] || [ -z "${DF_GRANT_ID:-}" ] || key=$DF_GRANT_ID
    _doflow_em_ledger_add "$dir" optional-dropped "$key" over-budget hook || _doflow_em_capture ledger
  done
  if [ "$a_nudge" = include ]; then
    case $'\t'"$dropped"$'\t' in
      *$'\t'nudge$'\t'*) ;;
      *)
        DF_EMIT_NUDGE=rendered
        if declare -F nudge_mark >/dev/null 2>&1; then nudge_mark "$session" nudged || true; fi
        if declare -F doflow_decide >/dev/null 2>&1; then doflow_decide advisory prompt-nudge || true; fi
        ;;
    esac
  fi
  _doflow_em_measure "$out" "$digest"
  printf '%s\n' "$out"
  return 0
}
