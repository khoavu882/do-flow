#!/usr/bin/env bash
# Codex PreToolUse(apply_patch) adapter for the DoFlow implementation gate.
#
# Codex exposes an apply_patch payload as a patch command rather than Claude's
# file_path field. If the patch paths cannot be identified, this guard fails open
# to avoid blocking an otherwise valid edit based on an ambiguous payload.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[[ "$TOOL_NAME" == "apply_patch" ]] || exit 0
PATCH=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -n "$PATCH" ]] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
RESOLVER="$ROOT/.codex/scripts/doflow/bash/do-paths.sh"
[[ -x "$RESOLVER" ]] || RESOLVER="${CODEX_HOME:-$HOME/.codex}/scripts/doflow/bash/do-paths.sh"
[[ -x "$RESOLVER" ]] || exit 0
STATE=$("$RESOLVER" --json 2>/dev/null) || exit 0

FEATURE_DIR=$(printf '%s' "$STATE" | jq -r '.feature_dir // empty' 2>/dev/null)
REPO_ROOT=$(printf '%s' "$STATE" | jq -r '.repo_root // empty' 2>/dev/null)
HAS_REQUIREMENT=$(printf '%s' "$STATE" | jq -r '.has_requirement // false' 2>/dev/null)
HAS_DESIGN=$(printf '%s' "$STATE" | jq -r '.has_design // false' 2>/dev/null)
HAS_PLAN=$(printf '%s' "$STATE" | jq -r '.has_plan // false' 2>/dev/null)
[[ -n "$FEATURE_DIR" && -n "$REPO_ROOT" && -d "$REPO_ROOT/$FEATURE_DIR" ]] || exit 0
[[ "$HAS_REQUIREMENT" == true && "$HAS_DESIGN" == true && "$HAS_PLAN" == true ]] && exit 0

PATHS=$(printf '%s\n' "$PATCH" | sed -nE \
  -e 's|^\*\*\* (Add|Update|Delete) File: (.+)$|\2|p' \
  -e 's|^\+\+\+ (a/|b/)?(.+)$|\2|p' \
  | sed '/^\/dev\/null$/d' | sort -u)
[[ -n "$PATHS" ]] || exit 0

while IFS= read -r FILE; do
  [[ -z "$FILE" || "$FILE" == agent-docs/* ]] && continue
  jq -n --arg fd "$FEATURE_DIR" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("doflow gate: feature \($fd) is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. Edits under agent-docs/ are allowed.")
    }
  }'
  exit 0
done <<< "$PATHS"
