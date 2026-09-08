#!/usr/bin/env bash
# pre-implementation-gate.sh — Canonical Policy Library: PreToolUse(Edit|Write|...)
# backstop for the doflow implement gate. The HARD half of the one enforced
# gate (the other half is the prompt-level do-prereqs.sh inside
# /do-execute-plan — defense in depth).
#
# Denies a SOURCE-file edit when a feature has been STARTED (its feature_dir
# exists) but requirement.md, design.md, or plan.md is still missing: "don't
# write code before you've planned." It is deliberately SCOPED so it never
# fires outside the doflow chain:
#   - no active feature dir            -> allow
#   - edit target is under agent-docs/ -> allow (editing the artifacts themselves)
#   - edit target outside the repo     -> allow
# Self-contained + fail-open (<50ms budget): any uncertainty -> allow (exit 0).
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR (repo root, if the front door sets it),
#          DOFLOW_AGENT (harness id, informational only here),
#          CLAUDE_CONFIG_DIR / CLAUDE_PROJECT_DIR / GEMINI_CONFIG_DIR / CODEX_HOME
#          (each already read by the harness-specific dispatcher this policy
#          replaces — kept so an unmodified front door still resolves its own
#          harness's do-paths.sh resolver)
#   stdin  a PreToolUse-shaped JSON payload for an edit tool. Every harness's
#          own field names differ (Claude/Gemini: tool_name/tool_input.file_path;
#          Codex: tool_name=apply_patch with a unified diff in
#          tool_input.command; Kiro: field names undocumented) — this script
#          reads the union of known shapes rather than assuming one, since a
#          native front door (Claude/Codex/Kiro) execs this script directly
#          with no payload translation of its own.
#   exit   0 = allow, non-zero = deny with the reason on stderr. A front door
#          translates this into whatever JSON/exit-code shape its harness
#          natively expects — this script never speaks a harness-specific
#          decision shape.
#
# Reconciliation note (022-normalize-hooks, Phase A): claude/gemini/codex/kiro
# each shipped a separately-adapted copy of this gate; antigravity's copy
# additionally never depended on a do-paths.sh resolver at all — it computed
# feature_dir itself from the current branch name and checked the three
# artifact files directly on disk. That fallback path is folded in here as a
# resilience net for every harness (not only antigravity): if no do-paths.sh
# resolver is found, this script now computes feature_dir from the branch
# instead of silently allowing everything, which is a real behavior
# improvement for Kiro in particular — its own script's header already noted
# that its resolver is never installed on a real Kiro install today, so the
# gate has been a permanent no-op there until this fallback.
#
# Depends on nothing beyond bash, jq, and git being on PATH.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0          # no jq -> cannot evaluate -> allow

INPUT=$(cat)

# ── Normalized envelope (preferred; review R7) ────────────────────────────────
# A host adapter that has already decoded its native event sends
#   {"doflow_event": {"operation": "edit", "paths": [..], "projectRoot": "..", "taskId": ".."}}
# and this policy consumes it verbatim. The union decoder below remains the
# fallback for front doors that still forward raw native payloads; per-harness
# knowledge belongs in those adapters, and each one that starts sending the
# envelope retires its share of the union.
ENVELOPE_ROOT=""
ENVELOPE_OP=$(printf '%s' "$INPUT" | jq -r '.doflow_event.operation // empty' 2>/dev/null)
if [ -n "$ENVELOPE_OP" ]; then
  [ "$ENVELOPE_OP" = "edit" ] || exit 0          # only edits are gated
  FILES=$(printf '%s' "$INPUT" | jq -r '.doflow_event.paths[]? // empty' 2>/dev/null | sed '/^$/d' | sort -u)
  [ -n "$FILES" ] || exit 0
  ENVELOPE_ROOT=$(printf '%s' "$INPUT" | jq -r '.doflow_event.projectRoot // empty' 2>/dev/null)
else

# ── Tool name (union of every known field name across harnesses; LEGACY decoder) ──
tool=""
for field in '.tool_name' '.tool' '.toolName' '.name'; do
  tool=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
  [ -n "$tool" ] && break
done

is_patch_tool=false
case "$tool" in
  Edit|Write|MultiEdit|edit_file|write_file|create_file|replace_file|replace) ;;
  write_to_file|replace_file_content|multi_replace_file_content) ;;
  apply_patch) is_patch_tool=true ;;
  *) exit 0 ;;
esac

# ── Candidate files to gate ────────────────────────────────────────────────────
# Normal edit tools: one file, from the union of field names harnesses use.
# apply_patch (Codex): the tool has no file_path field at all — the paths are
# embedded in a unified diff under tool_input.command.
FILES=""
if [ "$is_patch_tool" = true ]; then
  PATCH=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
  [ -n "$PATCH" ] || exit 0
  # "#" (not the original codex script's "|") is the sed delimiter here: BSD
  # sed (macOS, no GNU coreutils) misparses "s|...(Add|Update|Delete)...|...|"
  # because it splits on every unescaped "|", including the ones meant as ERE
  # alternation inside the pattern — a portability bug in the source script
  # this reconciliation fixes rather than ports, since it silently broke
  # apply_patch parsing under this exact invocation on any non-GNU-sed host.
  FILES=$(printf '%s\n' "$PATCH" | sed -nE \
    -e 's#^\*\*\* (Add|Update|Delete) File: (.+)$#\2#p' \
    -e 's#^\+\+\+ (a/|b/)?(.+)$#\2#p' \
    | sed '/^\/dev\/null$/d' | sort -u)
  [ -n "$FILES" ] || exit 0
else
  file=""
  for field in '.tool_input.file_path' '.tool_input.path' '.tool_input.target' '.file_path' '.path'; do
    file=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
    [ -n "$file" ] && break
  done
  [ -n "$file" ] || exit 0
  FILES="$file"
fi

fi  # end legacy union decoder

# ── Resolve repo root ───────────────────────────────────────────────────────
# DOFLOW_PROJECT_DIR (explicit) beats the envelope's projectRoot beats git discovery.
ROOT="${DOFLOW_PROJECT_DIR:-$ENVELOPE_ROOT}"
if [ -z "$ROOT" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

# ── Resolve doflow state (feature_dir, repo_root, has_requirement/design/plan) ─
# Preferred path: exec whichever do-paths.sh resolver this install actually
# shipped, trying every known per-harness location (a front door invoking
# this script directly gives us no signal about which one, so this tries all
# of them rather than assuming DOFLOW_AGENT names the right one).
# Project-scoped candidates come before global ones; within each group the
# canonical, install-agnostic `.doflow/` location comes first — that is the
# two-step walk-up (project `.doflow`, then `$HOME/.doflow`) every SKILL.md
# and `doflow-run`'s own resolve_config_dir already uses. Without those two
# entries this list only ever found the per-harness MIRRORED copies, which a
# real install need never have projected — leaving the resolver unfound and
# the branch fallback below (flat paths only) as the whole gate.
RESOLVER_CANDIDATES=(
  "$ROOT/.doflow/scripts/doflow/bash/do-paths.sh"
  "$ROOT/.claude/scripts/doflow/bash/do-paths.sh"
  "$ROOT/.codex/scripts/doflow/bash/do-paths.sh"
  "$ROOT/.gemini/scripts/doflow/bash/do-paths.sh"
  "$ROOT/.kiro/scripts/doflow/bash/do-paths.sh"
  "$HOME/.doflow/scripts/doflow/bash/do-paths.sh"
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
  "${CLAUDE_PROJECT_DIR:-}/.claude/scripts/doflow/bash/do-paths.sh"
  "${CODEX_HOME:-$HOME/.codex}/scripts/doflow/bash/do-paths.sh"
  "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/scripts/doflow/bash/do-paths.sh"
  "$HOME/.kiro/scripts/doflow/bash/do-paths.sh"
)

RESOLVER=""
for candidate in "${RESOLVER_CANDIDATES[@]}"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { RESOLVER="$candidate"; break; }
done

feature_dir=""
repo_root=""
has_requirement=""
has_design=""
has_plan=""

if [ -n "$RESOLVER" ]; then
  json=$("$RESOLVER" --json 2>/dev/null) || json=""
  if [ -n "$json" ]; then
    feature_dir=$(printf '%s' "$json"     | jq -r '.feature_dir // empty' 2>/dev/null)
    repo_root=$(printf '%s' "$json"       | jq -r '.repo_root // empty' 2>/dev/null)
    has_requirement=$(printf '%s' "$json" | jq -r '.has_requirement // false' 2>/dev/null)
    has_design=$(printf '%s' "$json"      | jq -r '.has_design // false' 2>/dev/null)
    has_plan=$(printf '%s' "$json"        | jq -r '.has_plan // false' 2>/dev/null)
  fi
fi

# Fallback: no resolver installed for this harness (or it produced nothing
# usable) -> compute state directly from the branch-coupled feature
# convention (feat/<slug> -> agent-docs/doflow/<slug>/), the same self
# contained approach antigravity's own copy of this gate already used.
if [ -z "$feature_dir" ]; then
  repo_root="$ROOT"
  branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
  case "$branch" in
    ""|master|main|develop|trunk) exit 0 ;;   # no branch, or trunk -> no flow to gate
  esac
  slug=${branch#*/}
  feature_dir="agent-docs/doflow/$slug"
  if [ -d "$repo_root/$feature_dir" ]; then
    # Layout is decided ONCE from intention/requirement.md's presence, then every
    # path below follows from it — the same single-probe rule do-paths.sh applies,
    # so this fallback can never report a self-contradictory mix of layouts. Without
    # the structured arm a fully-planned feature (artifacts under intention/, design/,
    # plan/) read as unplanned here and blocked every source edit.
    if [ -f "$repo_root/$feature_dir/intention/requirement.md" ]; then
      has_requirement=true
      if [ -f "$repo_root/$feature_dir/design/design.md" ]; then has_design=true; else has_design=false; fi
      if [ -f "$repo_root/$feature_dir/plan.md" ]; then has_plan=true; else has_plan=false; fi
    elif [ -f "$repo_root/$feature_dir/requirement.md" ]; then
      has_requirement=true
      if [ -f "$repo_root/$feature_dir/design.md" ]; then has_design=true; else has_design=false; fi
      if [ -f "$repo_root/$feature_dir/plan.md" ]; then has_plan=true; else has_plan=false; fi
    else
      has_requirement=false; has_design=false; has_plan=false
    fi
  fi
fi

# Not in the flow (no started feature) -> allow.
[ -n "$feature_dir" ] || exit 0
[ -n "$repo_root" ] && [ -d "$repo_root/$feature_dir" ] || exit 0

# In the flow: block a source edit until requirement.md, design.md, AND
# plan.md all exist. Iterate every candidate file (apply_patch may name
# several); the first non-doflow, in-repo file triggers the deny, matching
# Codex's own original "first offending path wins" behavior.
if [ "$has_requirement" = "true" ] && [ "$has_design" = "true" ] && [ "$has_plan" = "true" ]; then
  exit 0
fi

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Edits to doflow artifacts are always allowed.
  case "$file" in *"/agent-docs/"*|agent-docs/*) continue ;; esac

  # Only gate files inside this repo; an absolute path elsewhere -> allow (skip).
  case "$file" in
    /*) case "$file" in "$repo_root"/*) ;; *) continue ;; esac ;;
  esac

  echo "[pre-implementation-gate] doflow gate: feature $feature_dir is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Edits under agent-docs/ are always allowed; skip the flow by removing the feature dir.)" >&2
  exit 2
done <<< "$FILES"

exit 0
