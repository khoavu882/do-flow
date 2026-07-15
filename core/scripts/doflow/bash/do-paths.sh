#!/usr/bin/env bash
# do-paths.sh — deterministic path/feature resolver for the doflow chain.
#
# Emits a single JSON object describing the ACTIVE feature so doflow skills
# never compute paths, feature numbers, or existence themselves (the
# deterministic/generative split — design §4). The active feature is derived
# from the git branch (branch-coupled, FR-6): `feat/<NNN-slug>` → feature dir
# `agent-docs/doflow/<NNN-slug>/`. On a trunk branch (master/main/develop) the
# slug is null and the caller must prompt for one.
#
# Self-contained by design: it does NOT source core/hooks/lib.sh, because this
# script and lib.sh sit at different relative depths in the dev tree vs after
# sync.sh install. It needs only `git` + `jq`.
#
# Fail-open: on any error it still emits best-effort JSON and exits 0, so a
# skill is never hard-blocked by path resolution. The one non-zero exit is the
# explicit `--require feature` gate (exit 2 when no active feature).
#
# Usage:
#   do-paths.sh [--json]            # default — full resolver JSON
#   do-paths.sh --paths-only        # skip the next_number scan (cheap)
#   do-paths.sh --require feature   # exit 2 + error JSON if no active feature

set -uo pipefail   # deliberately NOT -e: we handle errors and still emit JSON

mode="json"
require=""
prev=""
for arg in "$@"; do
  case "$arg" in
    --json)         mode="json" ;;
    --paths-only)   mode="paths-only" ;;
    --require)      require="pending" ;;          # value follows in next arg
    --require=*)    require="${arg#--require=}" ;;
    feature)        [ "$prev" = "--require" ] && require="feature" ;;
    *) ;;
  esac
  prev="$arg"
done
[ "$require" = "pending" ] && require="feature"

# jq is mandatory to emit JSON; fail-open with a diagnostic object if absent.
if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","feature_slug":null}\n'
  exit 0
fi

# ── repo root & branch (degrade gracefully outside a git repo) ────────────────
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

# ── feature slug from branch (null on trunk branches) ─────────────────────────
feature_slug=""
case "$branch" in
  ""|master|main|develop|HEAD) feature_slug="" ;;
  */*)                         feature_slug="${branch#*/}" ;;  # strip feat/, fix/, …
  *)                           feature_slug="$branch" ;;
esac

specs_rel="agent-docs/doflow"
specs_dir="$repo_root/$specs_rel"

feature_dir=""; requirement=""; design=""; plan=""; state=""
has_requirement=false; has_design=false; has_plan=false
if [ -n "$feature_slug" ]; then
  feature_dir="$specs_rel/$feature_slug"
  abs="$repo_root/$feature_dir"
  requirement="$feature_dir/requirement.md"; design="$feature_dir/design.md"
  plan="$feature_dir/plan.md"; state="$feature_dir/state.md"
  [ -f "$abs/requirement.md" ] && has_requirement=true
  [ -f "$abs/design.md" ]      && has_design=true
  [ -f "$abs/plan.md" ]        && has_plan=true
fi

# ── next number: max(existing spec dirs, numbered branches) + 1 ───────────────
# Base-10 forced (10#) so leading zeros never trigger octal parsing.
next_number="001"
if [ "$mode" != "paths-only" ]; then
  max=0
  if [ -d "$specs_dir" ]; then
    for d in "$specs_dir"/*/; do
      [ -d "$d" ] || continue
      n="$(basename "$d")"; n="${n%%-*}"
      case "$n" in ''|*[!0-9]*) continue ;; esac
      n=$((10#$n)); [ "$n" -gt "$max" ] && max="$n"
    done
  fi
  while IFS= read -r b; do
    seg="${b##*/}"; num="${seg%%-*}"
    case "$num" in ''|*[!0-9]*) continue ;; esac
    num=$((10#$num)); [ "$num" -gt "$max" ] && max="$num"
  done < <(git -C "$repo_root" branch --format='%(refname:short)' 2>/dev/null || true)
  next_number="$(printf '%03d' "$((max + 1))")"
fi

# ── constitution paths (two-tier — design §6) ─────────────────────────────────
constitution_local="agent-docs/constitution.md"   # tier-2, per-repo (may not exist)
script_dir="$(cd "$(dirname "$0")" && pwd)"
constitution_base=""
for c in \
  "$script_dir/../../references/CONSTITUTION_BASE.md" \
  "$script_dir/../../../references/CONSTITUTION_BASE.md" \
  "$HOME/.claude/references/CONSTITUTION_BASE.md"; do
  if [ -f "$c" ]; then
    constitution_base="$(cd "$(dirname "$c")" && pwd)/CONSTITUTION_BASE.md"
    break
  fi
done

# ── --require feature gate (the one non-zero exit) ────────────────────────────
if [ "$require" = "feature" ] && [ -z "$feature_slug" ]; then
  jq -n --arg branch "$branch" \
    '{error:"no-active-feature",
      branch:(if $branch=="" then null else $branch end),
      hint:"checkout a feat/<NNN-slug> branch or run /do-brainstorm to start one"}'
  exit 2
fi

# ── emit resolver JSON ────────────────────────────────────────────────────────
jq -n \
  --arg repo_root "$repo_root" \
  --arg branch "$branch" \
  --arg feature_slug "$feature_slug" \
  --arg feature_dir "$feature_dir" \
  --arg requirement "$requirement" --arg design "$design" --arg plan "$plan" --arg state "$state" \
  --argjson has_requirement "$has_requirement" --argjson has_design "$has_design" --argjson has_plan "$has_plan" \
  --arg next_number "$next_number" \
  --arg constitution_base "$constitution_base" \
  --arg constitution_local "$constitution_local" \
  '{
    repo_root:          $repo_root,
    branch:             (if $branch=="" then null else $branch end),
    feature_slug:       (if $feature_slug=="" then null else $feature_slug end),
    feature_dir:        (if $feature_dir=="" then null else $feature_dir end),
    requirement:        (if $requirement=="" then null else $requirement end),
    design:             (if $design=="" then null else $design end),
    plan:               (if $plan=="" then null else $plan end),
    state:              (if $state=="" then null else $state end),
    has_requirement:    $has_requirement,
    has_design:         $has_design,
    has_plan:           $has_plan,
    next_number:        $next_number,
    constitution_base:  (if $constitution_base=="" then null else $constitution_base end),
    constitution_local: $constitution_local
  }'
exit 0
