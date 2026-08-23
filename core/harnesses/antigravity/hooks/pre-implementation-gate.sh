#!/usr/bin/env bash
# doflow-pre-implementation-gate.sh — Antigravity PreToolUse hook (native payload contract).
#
# Denies Antigravity file-mutation tools (write_to_file, replace_file_content,
# multi_replace_file_content) when a branch-coupled DoFlow feature has been started but its three
# specifications do not exist yet — the same contract the Claude Code gate enforces, expressed in
# Antigravity's documented hook schema:
#
#   stdin  : { toolCall: { name, args }, ... }          (docs/hooks, Input/Output Contract)
#   stdout : { decision: "deny"|"allow", reason }
#
# Everything here fails open except the one case the gate exists for. Requires: bash, jq, git.

set -euo pipefail

json=$(cat)

tool_name=$(printf '%s' "$json" | jq -r '.toolCall.name // empty' 2>/dev/null || true)
case "$tool_name" in
  write_to_file|replace_file_content|multi_replace_file_content) ;;
  *) exit 0 ;;
esac

# Workspace root: the deepest of the documented workspacePaths that is a git repo.
repo_root=""
for dir in $(printf '%s' "$json" | jq -r '.workspacePaths[]? // empty' 2>/dev/null); do
  if git -C "$dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    repo_root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
    break
  fi
done
[ -n "$repo_root" ] || exit 0

# Branch-coupled feature slug (do-paths convention): feat/<NNN-slug> -> agent-docs/doflow/<NNN-slug>/
branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
[ -n "$branch" ] || exit 0
case "$branch" in
  master|main|develop|trunk) exit 0 ;;                       # trunk: no flow to gate
esac
slug=${branch#*/}
feature_dir="$repo_root/agent-docs/doflow/$slug"
[ -d "$feature_dir" ] || exit 0                              # flow not started -> allow

if [ -f "$feature_dir/requirement.md" ] && [ -f "$feature_dir/design.md" ] && [ -f "$feature_dir/plan.md" ]; then
  exit 0                                                     # specifications complete -> allow
fi

jq -n --arg fd "agent-docs/doflow/$slug" '{
  decision: "deny",
  reason: ("doflow gate: feature \($fd) is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Skip the flow by removing the feature directory.)")
}'
exit 0
