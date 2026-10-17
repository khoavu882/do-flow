#!/usr/bin/env bash
# capture-failure.sh — Canonical Policy Library: failure capture helper (feature 046, IC-018, DEC-032)
#
# Defines doflow_capture_failure <policy> <point>, which appends one IC-011 line to the machine-wide
# DoFlow failure list when a guard policy fails open because DoFlow's own install is broken (for
# example its pattern file is missing). It exists only to be sourced, in a subshell with all output
# discarded, from inside a branch where the policy already fails open:
#
#   ( . "<policy-dir>/capture-failure.sh"; doflow_capture_failure pre-bash-guard patterns-missing ) >/dev/null 2>&1 || true
#
# The subshell keeps anything this file does away from the policy, which runs with `set -uo pipefail`,
# does not source lib.sh and would change exit codes under `set -e`. So this file:
#   - sets no shell option and installs no trap (DEC-018), and is written to be safe under the
#     caller's `set -u` and `pipefail`;
#   - reads no stdin and writes nothing to stdout or stderr;
#   - never rotates the file (rotation is done by the Node writers only, DEC-019);
#   - never blocks, never changes the policy's decision, and swallows every error.

case ${BASH_SOURCE[0]} in */*) _DOFLOW_CAPTURE_FAILURE_DIR=${BASH_SOURCE[0]%/*} ;; *) _DOFLOW_CAPTURE_FAILURE_DIR=. ;; esac
# The line holds only the policy name and the point name from DoFlow's own code, the working
# directory, the harness name and the install version: never the tool call, its arguments or stdin.
# It is a no-op when there is no config home (neither XDG_CONFIG_HOME nor HOME is set to an absolute
# path; doflow_config_home below) and while capture is off (DOFLOW_FAILURE_CAPTURE=off|0|false|no,
# the `off` sentinel file, or a `failure.capture` value other than "on" in <config home>/settings.json,
# read by doflow_lex_capture below), the same rules the Node writer follows (IC-011, IC-014, IC-005).
# The two marked blocks are byte-identical to the ones in bin/doflow-run.

# BEGIN doflow-config-home v1 (rule: src/runtime/config-home.ts; checked by test/guards/settings.test.js)
doflow_config_home() {
  DOFLOW_HOME=""
  case "${XDG_CONFIG_HOME:-}" in
    /*) DOFLOW_HOME="${XDG_CONFIG_HOME}/doflow"; return 0 ;;
  esac
  case "${HOME:-}" in
    /*) DOFLOW_HOME="${HOME}/.config/doflow" ;;
  esac
  return 0
}
# END doflow-config-home v1

# BEGIN doflow-settings-lexical v1 (rule: src/runtime/settings/lexical.ts; checked by test/guards/settings.test.js)
doflow_lex_capture() {
  local f="${1:-}" text="" rest="" d=""
  local re='"failure\.capture"[[:space:]]*:[[:space:]]*("[^"]*"|[^,}"[:space:]]*)'
  DOFLOW_LEX_CAPTURE=""
  if [ ! -e "$f" ]; then
    # Missing is no setting, unless the folder holding it cannot be searched (Node: EACCES is off).
    d="${f%/*}"
    if [ -n "$d" ] && [ "$d" != "$f" ] && [ -d "$d" ] && [ ! -x "$d" ]; then DOFLOW_LEX_CAPTURE="off"; fi
    return 0
  fi
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then DOFLOW_LEX_CAPTURE="off"; return 0; fi
  IFS= read -r -d '' text < "$f" || true
  rest="$text"
  while [[ $rest =~ $re ]]; do
    if [ "${BASH_REMATCH[1]}" = '"on"' ]; then DOFLOW_LEX_CAPTURE="${DOFLOW_LEX_CAPTURE:-on}"; else DOFLOW_LEX_CAPTURE="off"; fi
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
  return 0
}
# END doflow-settings-lexical v1

doflow_capture_failure() {
  local policy="${1:-}" point="${2:-}"
  local LC_ALL=C   # byte-wise lengths and cuts; scoped to this function
  local home="" setting="" version="" harness="" project="" cwd="" hp="" at="" line="" here="" dir=""

  doflow_config_home
  [ -n "$DOFLOW_HOME" ] || return 0
  home="$DOFLOW_HOME/failures"

  # Case-insensitive, whitespace trimmed at the ends only: the same reading the Node writer has.
  setting="$(printf '%s' "${DOFLOW_FAILURE_CAPTURE:-}" | tr '[:upper:]' '[:lower:]')" || return 0
  setting="${setting#"${setting%%[![:space:]]*}"}"
  setting="${setting%"${setting##*[![:space:]]}"}"
  case "$setting" in
    off|0|false|no) return 0 ;;
  esac
  [ -f "$home/off" ] && return 0
  doflow_lex_capture "$DOFLOW_HOME/settings.json"
  [ "$DOFLOW_LEX_CAPTURE" = off ] && return 0

  [[ "$policy" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || policy="unknown"
  [[ "$point" =~ ^[A-Za-z][A-Za-z0-9._:-]{0,39}$ ]] || return 0

  harness="${DOFLOW_AGENT:-}"
  [[ "$harness" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || harness="none"

  # script_version of the nearest install manifest: walking up from this file, then the global one.
  here="$(CDPATH= cd -P -- "$_DOFLOW_CAPTURE_FAILURE_DIR" 2>/dev/null && pwd -P)" || here=""
  dir="$here"
  while [ -n "$dir" ] && [ -z "$version" ]; do
    if [ -f "$dir/.doflow/.install-manifest.json" ]; then
      version="$(sed -n 's/^[[:space:]]*"script_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/.doflow/.install-manifest.json" | head -n 1)" || version=""
    fi
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done
  if [ -z "$version" ] && [ -f "${HOME:-}/.doflow/.install-manifest.json" ]; then
    version="$(sed -n 's/^[[:space:]]*"script_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.doflow/.install-manifest.json" | head -n 1)" || version=""
  fi
  [[ "$version" =~ ^[A-Za-z0-9._+-]{1,40}$ ]] || version="unknown"

  # The working directory with the home prefix as `~`, cut to 200 bytes, control characters turned
  # into spaces and every quote and backslash escaped, so the line stays one valid JSON string.
  cwd="$(pwd 2>/dev/null)" || cwd=""
  hp="${HOME:-}"
  hp="${hp%/}"
  if [ -n "$hp" ]; then
    case "$cwd" in
      "$hp") cwd="~" ;;
      "$hp"/*) cwd="~${cwd#"$hp"}" ;;
    esac
  fi
  project="$(printf '%s' "${cwd:0:200}" | tr '\001-\037\177' ' ')" || project=""
  project="${project//\\/\\\\}"
  project="${project//\"/\\\"}"

  at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" || return 0
  line="{\"v\":1,\"at\":\"$at\",\"source\":\"hook\",\"command\":\"$policy\",\"harness\":\"$harness\",\"version\":\"$version\",\"project\":\"$project\",\"kind\":\"$point\",\"message\":\"\",\"frame\":null,\"exit\":null}"
  if [ "${#line}" -gt 999 ]; then
    line="{\"v\":1,\"at\":\"$at\",\"source\":\"hook\",\"command\":\"$policy\",\"harness\":\"$harness\",\"version\":\"$version\",\"project\":\"\",\"kind\":\"$point\",\"message\":\"\",\"frame\":null,\"exit\":null}"
  fi

  (umask 077; mkdir -p "$home") || return 0
  # Only ever append to a regular file: opening a FIFO for append would block forever.
  [ ! -e "$home/events.jsonl" ] || [ -f "$home/events.jsonl" ] || return 0
  ( umask 077; printf '%s\n' "$line" >>"$home/events.jsonl" ) || return 0
  return 0
}
