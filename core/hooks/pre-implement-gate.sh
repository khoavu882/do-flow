#!/usr/bin/env bash
# pre-implement-gate.sh — PreToolUse(Edit|Write|MultiEdit) backstop for the doflow
# implement gate. The HARD half of the one enforced gate (the other half is the
# prompt-level do-prereqs.sh inside /do-execute-plan — defense in depth).
#
# Denies a SOURCE-file edit when a feature has been STARTED (its feature_dir exists) but
# plan.md or tasks.md is still missing: "don't write code before you've planned." It is
# deliberately SCOPED so it never fires outside the doflow chain:
#   - no active feature dir            -> allow
#   - edit target is under agent-docs/ -> allow (editing the artifacts themselves)
#   - edit target outside the repo     -> allow
# Self-contained + fail-open (<50ms budget): any uncertainty -> allow (exit 0). The one
# deny path emits the pre-bash-guard deny contract (permissionDecision: "deny").

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0          # no jq -> cannot evaluate -> allow

INPUT=$(cat)
tool=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool" in Edit|Write|MultiEdit) ;; *) exit 0 ;; esac

file=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

# Edits to doflow artifacts are always allowed.
case "$file" in *"/agent-docs/"*|agent-docs/*) exit 0 ;; esac

RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || exit 0                      # resolver absent -> allow
json=$("$RESOLVER" --json 2>/dev/null) || exit 0

feature_dir=$(echo "$json" | jq -r '.feature_dir // empty' 2>/dev/null)
repo_root=$(echo "$json"   | jq -r '.repo_root // empty' 2>/dev/null)
has_plan=$(echo "$json"    | jq -r '.has_plan' 2>/dev/null)
has_tasks=$(echo "$json"   | jq -r '.has_tasks' 2>/dev/null)

# Not in the flow (no started feature) -> allow.
[ -n "$feature_dir" ] || exit 0
[ -n "$repo_root" ] && [ -d "$repo_root/$feature_dir" ] || exit 0

# Only gate files inside this repo; an absolute path elsewhere -> allow.
case "$file" in
  /*) case "$file" in "$repo_root"/*) ;; *) exit 0 ;; esac ;;
esac

# In the flow: block source edits until BOTH plan.md and tasks.md exist.
if [ "$has_plan" != "true" ] || [ "$has_tasks" != "true" ]; then
  jq -n --arg fd "$feature_dir" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("doflow gate: feature \($fd) has no plan.md/tasks.md yet — run /do-plan then /do-tasks before editing source. (Edits under agent-docs/ are always allowed; skip the flow by removing the feature dir.)")
    }
  }'
  exit 0
fi
exit 0
