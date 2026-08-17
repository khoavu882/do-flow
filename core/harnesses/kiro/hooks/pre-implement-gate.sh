#!/usr/bin/env bash
# Kiro PreToolUse adapter for the DoFlow implementation gate.
#
# Denies a SOURCE-file edit when a feature has been STARTED (its feature_dir exists) but
# requirement.md, design.md, or plan.md is still missing — the same "don't write code before
# you've planned" contract Claude's and Codex's own pre-implement-gate.sh enforce. Kiro's own
# PreToolUse stdin JSON field names are NOT documented beyond "session/event context on stdin"
# (kiro.dev/docs/hooks/actions/ does not enumerate them), so this script is defensive rather than
# assuming Claude's exact shape (tool_name/tool_input.file_path): it tries several plausible field
# names in order and fails open (exit 0 — allow) the moment any of them is missing or ambiguous,
# exactly like the Claude/Codex versions fail open on their own uncertain paths.
#
# Residual uncertainty: until core/registry/assets.yaml's scripts.doflow asset is extended to
# apply to 'kiro' (out of scope for this change — see agent-docs/doflow/006-multi-harness-parity/
# plan.md D.1), the do-paths.sh resolver this script looks for is never installed under
# .kiro/scripts/doflow/bash/, so this gate currently always allows (resolver absent -> allow) on
# a real Kiro install. The hook wiring is real and ready; the resolver dependency is a follow-up.
#
# Self-contained + fail-open (<50ms budget): any uncertainty -> allow (exit 0). The one deny path
# emits nothing but a non-zero exit — Kiro confirms PreToolUse blocks on a non-zero exit code
# (kiro.dev/docs/hooks/), unlike Claude/Codex's JSON permissionDecision payload, so no JSON body
# is required (or assumed to be read) here.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0          # no jq -> cannot evaluate -> allow

INPUT=$(cat)

# Tool name: try the field names DoFlow has seen across harnesses so far, in order of how likely
# each is to appear; stop at the first non-empty match.
tool=""
for field in '.tool_name' '.tool' '.toolName' '.name'; do
  tool=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
  [ -n "$tool" ] && break
done
case "$tool" in Edit|Write|MultiEdit|edit_file|write_file|create_file|replace_file) ;; *) exit 0 ;; esac

# File path: same defensive fallback chain for the edited file's path field.
file=""
for field in '.tool_input.file_path' '.tool_input.path' '.tool_input.target' '.file_path' '.path'; do
  file=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
  [ -n "$file" ] && break
done
[ -n "$file" ] || exit 0

# Edits to doflow artifacts are always allowed.
case "$file" in *"/agent-docs/"*|agent-docs/*) exit 0 ;; esac

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
RESOLVER="$ROOT/.kiro/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || RESOLVER="$HOME/.kiro/scripts/doflow/bash/do-paths.sh"
[ -x "$RESOLVER" ] || exit 0                      # resolver absent -> allow (see header note)
json=$("$RESOLVER" --json 2>/dev/null) || exit 0

feature_dir=$(printf '%s' "$json"     | jq -r '.feature_dir // empty' 2>/dev/null)
repo_root=$(printf '%s' "$json"       | jq -r '.repo_root // empty' 2>/dev/null)
has_requirement=$(printf '%s' "$json" | jq -r '.has_requirement // false' 2>/dev/null)
has_design=$(printf '%s' "$json"      | jq -r '.has_design // false' 2>/dev/null)
has_plan=$(printf '%s' "$json"        | jq -r '.has_plan // false' 2>/dev/null)

# Not in the flow (no started feature) -> allow.
[ -n "$feature_dir" ] || exit 0
[ -n "$repo_root" ] && [ -d "$repo_root/$feature_dir" ] || exit 0

# Only gate files inside this repo; an absolute path elsewhere -> allow.
case "$file" in
  /*) case "$file" in "$repo_root"/*) ;; *) exit 0 ;; esac ;;
esac

if [ "$has_requirement" != "true" ] || [ "$has_design" != "true" ] || [ "$has_plan" != "true" ]; then
  echo "[pre-implement-gate] doflow gate: feature $feature_dir is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Edits under agent-docs/ are always allowed.)" >&2
  exit 2
fi
exit 0
