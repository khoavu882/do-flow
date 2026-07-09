#!/usr/bin/env bash
# do-prereqs.sh — doflow implement-phase prerequisite gate (prompt-level PRIMARY).
#
# Called as step 1 of /do-execute-plan. With --require-tasks it exits 2 (and prints an
# error JSON) when the active feature lacks plan.md or tasks.md — the "no implementing
# before you've planned" rule. Self-contained; fail-open for everything EXCEPT the
# explicit gate failure (the one intentional non-zero exit).
#
# Usage: do-prereqs.sh --require-tasks   # exit 0 = ok, exit 2 = missing plan/tasks

set -uo pipefail

require_tasks=false
for a in "$@"; do [ "$a" = "--require-tasks" ] && require_tasks=true; done

command -v jq >/dev/null 2>&1 || { echo '{"ok":true,"note":"jq-absent-skip-gate"}'; exit 0; }

RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || RESOLVER="$(cd "$(dirname "$0")" && pwd)/do-paths.sh"   # co-located fallback
[ -x "$RESOLVER" ] || { echo '{"ok":true,"note":"resolver-absent-skip-gate"}'; exit 0; }

json=$("$RESOLVER" --json 2>/dev/null) || { echo '{"ok":true,"note":"resolver-error-skip-gate"}'; exit 0; }
slug=$(echo "$json" | jq -r '.feature_slug // empty')
has_plan=$(echo "$json" | jq -r '.has_plan')
has_tasks=$(echo "$json" | jq -r '.has_tasks')

if [ "$require_tasks" = true ]; then
  if [ -z "$slug" ]; then
    echo "$json" | jq '{ok:false, error:"no-active-feature", hint:"run /do-spec to start a feature"}'
    exit 2
  fi
  if [ "$has_plan" != "true" ] || [ "$has_tasks" != "true" ]; then
    echo "$json" | jq '{ok:false, error:"missing-prereqs", has_plan:.has_plan, has_tasks:.has_tasks,
                        hint:"run /do-plan and /do-tasks before /do-execute-plan"}'
    exit 2
  fi
fi

echo "$json" | jq '{ok:true, feature_slug:.feature_slug, has_plan:.has_plan, has_tasks:.has_tasks}'
exit 0
