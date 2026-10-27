#!/usr/bin/env bash
# IC-005, E.1 (Claude Code 2.1.292): event gives status; duration_ms is numeric on both
# post events. Neither has a numeric exit code. Never inspect or record output/error text.
[ "${DOFLOW_TELEMETRY:-}" != off ] || exit 0
exec >/dev/null 2>&1
event=${1:-}
case "$event" in PostToolUse|PostToolUseFailure) ;; *) exit 0 ;; esac
IFS= read -r -d '' payload || true
case "$payload" in *test*|*jest*|*mocha*) ;; *) exit 0 ;; esac

# Source definitions only; no lifecycle policy, failure capture or native response runs here.
_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) hook_dir=${_DOFLOW_SRC%/*} ;; *) hook_dir=. ;; esac
. "$hook_dir/../../.doflow/shared/hooks/bridge/bridge.sh" || exit 0

# Same project-store resolution as bridge.sh, including nested dispatch delivery directories.
# The bridge currently has no separately exported doflow_telemetry_dir helper.
if [ -n "${DOFLOW_CONFIG_DIR:-}" ]; then
  d=$DOFLOW_CONFIG_DIR
else
  d=${PWD:-}
  case "$d" in /*) ;; *) exit 0 ;; esac
  while :; do
    if [ -d "$d/.doflow" ]; then
      case "$d/" in */.doflow/*) ;; *) d=${d%/}/.doflow; break ;; esac
    fi
    [ -n "$d" ] && [ "$d" != / ] || exit 0
    d=${d%/*}
  done
fi
[ -d "$d/state" ] || exit 0

tuple=$(printf '%s' "$payload" | jq -c --arg harness claude --arg event "$event" \
  --arg policy post-shell-observe --arg mode observe -f "$_DOFLOW_BRIDGE_DIR/envelope.jq") || exit 0
case "$tuple" in *$'\n'*|''|'{}'|'{"dft":1}') exit 0 ;; esac
class=${tuple##*\"test_class\":\"}; class=${class%%\"*}
case "$class" in test.full|test.scoped|test.other) ;; *) exit 0 ;; esac
day=${tuple:17:10}
case "$day" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) exit 0 ;; esac
rest=${tuple#\{\"dft\":1,\"date\":\"??????????\",}
case "$rest" in \"timestamp\":*\}) ;; *) exit 0 ;; esac
# test_class is last in the tuple; print it explicitly so the contract guard sees the key.
rest=${rest%,\"test_class\":*}\}
[ -d "$d/state/runs/telemetry" ] || mkdir "$d/state/runs/telemetry" || exit 0
f=$d/state/runs/telemetry/$day.jsonl
[ ! -e "$f" ] || [ -f "$f" ] || exit 0
printf '{"kind":"hook","harness":"claude","event":"%s","policy":"post-shell-observe","verdict":"observe","test_class":"%s",%s\n' "$event" "$class" "$rest" >>"$f" || true
exit 0
