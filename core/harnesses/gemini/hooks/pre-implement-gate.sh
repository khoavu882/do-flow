#!/usr/bin/env bash
# Gemini BeforeTool(write_file|replace) adapter for the DoFlow implementation gate.
#
# Gemini's edit tools use a "file_path" tool_input key (docs/reference/tools.md) —
# same field path as Claude's, unlike Codex's apply_patch
# (which needed a separate patch-parsing adaptation). Deny output uses Gemini's
# top-level {"decision":"deny","reason":...} shape, not Claude's/Codex's
# hookSpecificOutput.permissionDecision nesting.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)
tool=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool" in write_file|replace) ;; *) exit 0 ;; esac

file=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

# Edits to doflow artifacts are always allowed.
case "$file" in *"/agent-docs/"*|agent-docs/*) exit 0 ;; esac

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
RESOLVER="$ROOT/.gemini/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || RESOLVER="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || exit 0
STATE=$("$RESOLVER" --json 2>/dev/null) || exit 0

FEATURE_DIR=$(printf '%s' "$STATE" | jq -r '.feature_dir // empty' 2>/dev/null)
REPO_ROOT=$(printf '%s' "$STATE" | jq -r '.repo_root // empty' 2>/dev/null)
HAS_REQUIREMENT=$(printf '%s' "$STATE" | jq -r '.has_requirement // false' 2>/dev/null)
HAS_DESIGN=$(printf '%s' "$STATE" | jq -r '.has_design // false' 2>/dev/null)
HAS_PLAN=$(printf '%s' "$STATE" | jq -r '.has_plan // false' 2>/dev/null)

# Not in the flow (no started feature) -> allow.
[ -n "$FEATURE_DIR" ] || exit 0
[ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/$FEATURE_DIR" ] || exit 0

# Only gate files inside this repo; an absolute path elsewhere -> allow.
case "$file" in
  /*) case "$file" in "$REPO_ROOT"/*) ;; *) exit 0 ;; esac ;;
esac

if [ "$HAS_REQUIREMENT" != "true" ] || [ "$HAS_DESIGN" != "true" ] || [ "$HAS_PLAN" != "true" ]; then
  jq -n --arg fd "$FEATURE_DIR" '{
    decision: "deny",
    reason: ("doflow gate: feature \($fd) is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Edits under agent-docs/ are always allowed; skip the flow by removing the feature dir.)")
  }'
  exit 0
fi
exit 0
