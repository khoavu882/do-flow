#!/usr/bin/env bash
# do-prereqs.sh — doflow implement-phase prerequisite gate (prompt-level PRIMARY).
#
# Called as step 1 of /do-execute-plan. With --require-plan it exits 2 (and prints an
# error JSON) when the active feature lacks requirement.md, design.md, or plan.md — the
# "no implementing before you've planned" rule. Self-contained; fail-open for everything
# EXCEPT the explicit gate failure (the one intentional non-zero exit).
#
# Usage: do-prereqs.sh --require-plan [--slug=<slug>]
#   exit 0 = ok, exit 2 = missing requirement/design/plan (or ambiguous/no active feature)
#   --slug=<slug> forwards to do-paths.sh — pass this after a caller has already disambiguated
#   an "ambiguous-feature" result (non-git root, 2+ candidates) via AskUserQuestion.

set -uo pipefail

require_plan=false
slug_override=""
for a in "$@"; do
  case "$a" in
    --require-plan) require_plan=true ;;
    --slug=*)       slug_override="${a#--slug=}" ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo '{"ok":true,"note":"jq-absent-skip-gate"}'; exit 0; }

RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || RESOLVER="$(cd "$(dirname "$0")" && pwd)/do-paths.sh"   # co-located fallback
[ -x "$RESOLVER" ] || { echo '{"ok":true,"note":"resolver-absent-skip-gate"}'; exit 0; }

RESOLVER_ARGS=(--json)
[ -n "$slug_override" ] && RESOLVER_ARGS+=("--slug=$slug_override")
json=$("$RESOLVER" "${RESOLVER_ARGS[@]}" 2>/dev/null) || { echo '{"ok":true,"note":"resolver-error-skip-gate"}'; exit 0; }
slug=$(echo "$json" | jq -r '.feature_slug // empty')
candidate_slugs=$(echo "$json" | jq -c '.candidate_slugs // []')
has_requirement=$(echo "$json" | jq -r '.has_requirement')
has_design=$(echo "$json" | jq -r '.has_design')
has_plan=$(echo "$json" | jq -r '.has_plan')

if [ "$require_plan" = true ]; then
  if [ -z "$slug" ]; then
    if [ "$candidate_slugs" != "[]" ]; then
      echo "$json" | jq '{ok:false, error:"ambiguous-feature", candidate_slugs:.candidate_slugs,
                          hint:"multiple agent-docs/doflow/ feature dirs exist and no git branch disambiguates them — ask which one via AskUserQuestion, then re-run do-prereqs.sh --require-plan --slug=<chosen>"}'
    else
      echo "$json" | jq '{ok:false, error:"no-active-feature", hint:"run /do-brainstorm to start a feature"}'
    fi
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
