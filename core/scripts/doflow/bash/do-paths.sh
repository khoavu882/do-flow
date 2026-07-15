#!/usr/bin/env bash
# do-paths.sh — deterministic path/feature resolver for the doflow chain.
#
# Emits a single JSON object describing the ACTIVE feature so doflow skills
# never compute paths, feature numbers, or existence themselves (the
# deterministic/generative split — design §4). In a git repo, the active
# feature is derived from the branch (branch-coupled, FR-6): `feat/<NNN-slug>`
# → feature dir `agent-docs/doflow/<NNN-slug>/`. On a trunk branch
# (master/main/develop) the slug is null and the caller must prompt for one.
# Outside a git repo (e.g. doflow installed at a multi-service container root,
# above the actual git sub-repos) there is no branch to key off at all, so
# resolution falls back to scanning `agent-docs/doflow/` directly — see the
# "feature slug" section below and `candidate_slugs` in the emitted JSON.
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
#   do-paths.sh --slug=<slug>       # force resolution to this slug, skipping branch/dir detection
#                                    # (used by a skill after it has already disambiguated via
#                                    # AskUserQuestion — see "non-git root" note below)

set -uo pipefail   # deliberately NOT -e: we handle errors and still emit JSON

mode="json"
require=""
slug_override=""
prev=""
for arg in "$@"; do
  case "$arg" in
    --json)         mode="json" ;;
    --paths-only)   mode="paths-only" ;;
    --require)      require="pending" ;;          # value follows in next arg
    --require=*)    require="${arg#--require=}" ;;
    --slug=*)       slug_override="${arg#--slug=}" ;;
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
is_git_repo=false
repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$repo_root" ]; then
  is_git_repo=true
else
  repo_root="$(pwd)"
fi
branch=""
[ "$is_git_repo" = true ] && branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

specs_rel="agent-docs/doflow"
specs_dir="$repo_root/$specs_rel"

# ── feature slug: branch-derived in a git repo; directory-scan otherwise ──────
# A non-git root (doflow installed above the actual git repos — e.g. a multi-service
# container workspace) has no branch to key off at all, so branch parsing doesn't apply here —
# fall back to scanning agent-docs/doflow/ directly. Exactly one candidate dir is unambiguous
# and gets auto-selected (no prompt needed — nothing to decide). Zero candidates is genuinely
# "no active feature." Two or more is a real decision this deterministic script cannot make on
# its own; it surfaces every candidate via `candidate_slugs` instead of guessing, so the calling
# skill (do-execute-plan / do-flow, which has AskUserQuestion access) can ask the user, then
# re-invoke with `--slug=<chosen>` to force resolution.
feature_slug=""
candidate_slugs_json="[]"
if [ "$is_git_repo" = true ]; then
  case "$branch" in
    ""|master|main|develop|HEAD) feature_slug="" ;;
    */*)                         feature_slug="${branch#*/}" ;;  # strip feat/, fix/, …
    *)                           feature_slug="$branch" ;;
  esac
elif [ -d "$specs_dir" ]; then
  dirs=()
  for d in "$specs_dir"/*/; do
    [ -d "$d" ] || continue
    dirs+=("$(basename "$d")")
  done
  case "${#dirs[@]}" in
    0) : ;;
    1) feature_slug="${dirs[0]}" ;;
    *) candidate_slugs_json="$(printf '%s\n' "${dirs[@]}" | jq -R . | jq -s .)" ;;
  esac
fi

# An explicit --slug always wins (post-disambiguation re-resolution, or a deliberate override).
if [ -n "$slug_override" ]; then
  feature_slug="$slug_override"
  candidate_slugs_json="[]"
fi

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
  if [ "$candidate_slugs_json" != "[]" ]; then
    jq -n --arg branch "$branch" --argjson candidate_slugs "$candidate_slugs_json" \
      '{error:"ambiguous-feature",
        branch:(if $branch=="" then null else $branch end),
        candidate_slugs:$candidate_slugs,
        hint:"multiple agent-docs/doflow/ feature dirs exist and no git branch disambiguates them — ask which one via AskUserQuestion, then re-run with --slug=<chosen>"}'
  else
    jq -n --arg branch "$branch" \
      '{error:"no-active-feature",
        branch:(if $branch=="" then null else $branch end),
        hint:"checkout a feat/<NNN-slug> branch or run /do-brainstorm to start one"}'
  fi
  exit 2
fi

# ── emit resolver JSON ────────────────────────────────────────────────────────
jq -n \
  --arg repo_root "$repo_root" \
  --argjson is_git_repo "$is_git_repo" \
  --arg branch "$branch" \
  --arg feature_slug "$feature_slug" \
  --arg feature_dir "$feature_dir" \
  --argjson candidate_slugs "$candidate_slugs_json" \
  --arg requirement "$requirement" --arg design "$design" --arg plan "$plan" --arg state "$state" \
  --argjson has_requirement "$has_requirement" --argjson has_design "$has_design" --argjson has_plan "$has_plan" \
  --arg next_number "$next_number" \
  --arg constitution_base "$constitution_base" \
  --arg constitution_local "$constitution_local" \
  '{
    repo_root:          $repo_root,
    is_git_repo:        $is_git_repo,
    branch:             (if $branch=="" then null else $branch end),
    feature_slug:       (if $feature_slug=="" then null else $feature_slug end),
    feature_dir:        (if $feature_dir=="" then null else $feature_dir end),
    candidate_slugs:    $candidate_slugs,
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
