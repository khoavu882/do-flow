#!/usr/bin/env bash
# do-prereqs.sh — doflow implement-phase prerequisite gate (prompt-level PRIMARY).
#
# Called as step 1 of /do-execute-plan. With --require-plan it exits 2 (and prints an
# error JSON) when the active feature lacks requirement.md, design.md, or plan.md — the
# "no implementing before you've planned" rule. Self-contained; fail-open for everything
# EXCEPT the explicit gate failure (the one intentional non-zero exit).
#
# Usage: do-prereqs.sh --require-plan   # exit 0 = ok, exit 2 = missing requirement/design/plan

set -uo pipefail

require_plan=false
for a in "$@"; do [ "$a" = "--require-plan" ] && require_plan=true; done

command -v jq >/dev/null 2>&1 || { echo '{"ok":true,"note":"jq-absent-skip-gate"}'; exit 0; }

RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || RESOLVER="$(cd "$(dirname "$0")" && pwd)/do-paths.sh"   # co-located fallback
[ -x "$RESOLVER" ] || { echo '{"ok":true,"note":"resolver-absent-skip-gate"}'; exit 0; }

json=$("$RESOLVER" --json 2>/dev/null) || { echo '{"ok":true,"note":"resolver-error-skip-gate"}'; exit 0; }
slug=$(echo "$json" | jq -r '.feature_slug // empty')
has_requirement=$(echo "$json" | jq -r '.has_requirement')
has_design=$(echo "$json" | jq -r '.has_design')
has_plan=$(echo "$json" | jq -r '.has_plan')

if [ "$require_plan" = true ]; then
  if [ -z "$slug" ]; then
    echo "$json" | jq '{ok:false, error:"no-active-feature", hint:"run /do-brainstorm to start a feature"}'
    exit 2
  fi
  if [ "$has_requirement" != "true" ] || [ "$has_design" != "true" ] || [ "$has_plan" != "true" ]; then
    echo "$json" | jq '{ok:false, error:"missing-prereqs", has_requirement:.has_requirement,
                        has_design:.has_design, has_plan:.has_plan,
                        hint:"run /do-design and /do-plan before /do-execute-plan"}'
    exit 2
  fi
fi

echo "$json" | jq '{ok:true, feature_slug:.feature_slug, has_requirement:.has_requirement, has_design:.has_design, has_plan:.has_plan}'
exit 0
