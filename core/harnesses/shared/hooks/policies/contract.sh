#!/usr/bin/env bash
# contract.sh — shared decision and envelope contract for canonical policies.
#
# This file is sourced by policy scripts. It sets no shell options, installs no traps, reads no
# stdin, and keeps decision recording independent of jq.

doflow_decision_init() {
  DF_POLICY="${1:-}"
  DF_POLICY_VERSION="${2:-0}"
  doflow_decide allow allow
}

doflow_decide() {
  local LC_ALL=C
  local outcome="${1:-allow}" code="${2:-invalid-code}" fd="${DOFLOW_DECISION_FD:-}"
  case "$code" in
    [a-z]*)
      case "$code" in
        *[!a-z0-9:._-]*) code=invalid-code ;;
        *) [ "${#code}" -le 40 ] || code=invalid-code ;;
      esac
      ;;
    *) code=invalid-code ;;
  esac
  case "$fd" in
    3|4|5|6|7|8|9)
      # A caller may set the descriptor name without passing an open fd. Keep
      # that broken handoff silent and harmless, including under `set -e`.
      { printf '\036{"v":1,"policy":"%s","policyVersion":%s,"outcome":"%s","code":"%s"}\n' \
        "${DF_POLICY:-}" "${DF_POLICY_VERSION:-0}" "$outcome" "$code" >&"$fd"; } 2>/dev/null || :
      ;;
  esac
}

doflow_read_envelope() {
  local assignments
  if [ -z "${INPUT:-}" ]; then
    DF_ENV_CLASS=missing
    DF_ENV_CODE=envelope-missing
    DF_ENV_HARNESS=
    DF_ENV_EVENT=
    DF_ENV_OP=
    DF_ENV_TOOL=
    DF_ENV_PATHS=
    DF_ENV_COMMAND=
    DF_ENV_CWD=
    DF_ENV_PATCH=
    DF_ENV_ROOT=
    DF_ENV_TASK=
    return 0
  fi
  assignments=$(printf '%s' "${INPUT:-}" | jq -sr '
    (.[0]) as $root |
    ($root | if type == "object" then . else {} end) as $object |
    ($object.doflow_event // {}) as $event |
    ($event | if type == "object" then . else {} end) as $fields |
    def field($key): ($fields[$key] // "") | if type == "string" then . else "" end;
    def shellvar($name; $value): ($name + "=" + ($value | @sh));
    (if ($root | type) != "object" or (($event | type) != "object") then "missing"
     elif ($event | has("version") | not) then "missing"
     elif ($event.version | type) == "number" and $event.version == 1 then "v1"
     else "unsupported" end) as $class |
    [shellvar("DF_ENV_CLASS"; $class),
     shellvar("DF_ENV_CODE"; (if $class == "missing" then "envelope-missing" else "" end)),
     shellvar("DF_ENV_HARNESS"; field("harness")),
     shellvar("DF_ENV_EVENT"; field("event")),
     shellvar("DF_ENV_OP"; field("operation")),
     shellvar("DF_ENV_TOOL"; field("tool")),
     shellvar("DF_ENV_PATHS"; ([$fields.paths[]? | select(type == "string")] | join("\n"))),
     shellvar("DF_ENV_COMMAND"; field("command")),
     shellvar("DF_ENV_CWD"; ($object.cwd // "") | if type=="string" then . else "" end),
     shellvar("DF_ENV_PATCH"; field("patch")),
     shellvar("DF_ENV_ROOT"; field("projectRoot")),
     shellvar("DF_ENV_TASK"; field("taskId"))][]
  ' 2>/dev/null) || return 1
  eval "$assignments"
}
