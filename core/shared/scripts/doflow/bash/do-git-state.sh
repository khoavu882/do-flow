#!/usr/bin/env bash
# do-git-state.sh — deterministic lifecycle state helper for /do-git.
#
# Emits JSON describing the repository's position in the development cycle.
# This is a deterministic layer component: no prompts, no side effects, just
# reading git refs and producing structured data.

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  printf '{"error":"jq-not-found","branch_class":null}\n'
  exit 0
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
resolved="$(bash "$script_dir/do-paths.sh" --json 2>/dev/null)"
repo_root="$(printf '%s' "$resolved" | jq -r '.repo_root // empty')"

trunk_names="main develop"
feature_prefixes="feat feature"
fix_prefixes="fix bugfix"
integration_branch="develop"
production_branch="master"

mode=""
class_name=""
slug=""

for arg in "$@"; do
  case "$arg" in
    --state)                    mode="state" ;;
    --next-version)             mode="next-version" ;;
    --propagation-targets)      mode="propagation-targets" ;;
    --fingerprint)              mode="fingerprint" ;;
    --branch-name)              mode="branch-name" ;;
    --class=*)                  class_name="${arg#--class=}" ;;
    --slug=*)                   slug="${arg#--slug=}" ;;
    *) ;;
  esac
done

[ -z "$mode" ] && mode="state"

if [ -z "$repo_root" ]; then
  printf '{"error":"not-a-git-repo"}\n'
  exit 0
fi

cd "$repo_root"

current_branch=""
if git rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
else
  current_branch=""
fi

# ── Helper: classify a branch name ────────────────────────────────────────────
get_class() {
  local b="$1"
  case "$b" in
    "") echo "trunk" ;;
    master|main|develop|HEAD) echo "trunk" ;;
    release/*) echo "release" ;;
    hotfix/*) echo "hotfix" ;;
    feat/*|feature/*) echo "feature" ;;
    fix/*|bugfix/*) echo "fix" ;;
    */*) echo "other" ;;
    *) echo "other" ;;
  esac
}

get_slug() {
  local b="$1"
  case "$b" in
    "") echo "" ;;
    master|main|develop|HEAD) echo "" ;;
    release/*|hotfix/*) echo "" ;;
    */*) echo "${b#*/}" ;;
    *) echo "$b" ;;
  esac
}

commits_between() {
  local from="$1"
  local to="$2"
  if git rev-parse "$from" >/dev/null 2>&1 && git rev-parse "$to" >/dev/null 2>&1; then
    local ahead="$(git rev-list --count "${to}..${from}" 2>/dev/null || echo "0")"
    local behind="$(git rev-list --count "${from}..${to}" 2>/dev/null || echo "0")"
    echo "$ahead $behind"
  else
    echo "0 0"
  fi
}

is_dirty() {
  local status="$(git status --short 2>/dev/null | wc -l)"
  [ "$status" -gt 0 ]
}

join_array() {
  local IFS="$1"
  shift
  echo "$*"
}

do_state() {
  local class="$(get_class "$current_branch")"
  local slugs="$(get_slug "$current_branch")"
  local dirty="false"
  is_dirty && dirty="true"
  
  local ahead="0"
  local behind="0"
  if git rev-parse "refs/heads/${current_branch}" >/dev/null 2>&1 && \
     git rev-parse "refs/heads/${integration_branch}" >/dev/null 2>&1; then
    local counts="$(commits_between "$current_branch" "$integration_branch")"
    ahead="$(echo "$counts" | awk '{print $1}')"
    behind="$(echo "$counts" | awk '{print $2}')"
  fi
  
  local position="in-sync"
  [ "$ahead" -gt 0 ] && position="ahead-of-integration"
  [ "$behind" -gt 0 ] && position="behind-integration"
  [ "$dirty" = "true" ] && position="dirty-worktree"
  
  jq -n \
    --arg branch "${current_branch:-null}" \
    --arg class_name "$class" \
    --arg feature_slug "$slugs" \
    --argjson dirty "$dirty" \
    --arg ahead "$ahead" \
    --arg behind "$behind" \
    --arg position "$position" \
    '{
      branch:        (if $branch=="" then null else $branch end),
      class:         $class_name,
      feature_slug:  (if $feature_slug=="" then null else $feature_slug end),
      dirty:         $dirty,
      ahead_of_integration: ($ahead | tonumber),
      behind_integration: ($behind | tonumber),
      position:      $position
    }'
}

do_next_version() {
  local base_tag=""
  local current_version="0.0.0"
  
  base_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  
  if [ -n "$base_tag" ]; then
    current_version="${base_tag#v}"
  fi
  
  # Strip any semver pre-release/build-metadata suffix (e.g. "-beta.4", "+build.5") before
  # splitting into numeric fields — the arithmetic below requires plain integers, and a suffix
  # left in place (patch="0-beta.4") crashes $(( )) with "invalid arithmetic operator".
  local version_core="${current_version%%-*}"
  version_core="${version_core%%+*}"

  local major minor patch
  major="0"; minor="0"; patch="0"
  IFS='.' read -r major minor patch <<< "$version_core" 2>/dev/null || true
  major="${major:-0}"; minor="${minor:-0}"; patch="${patch:-0}"
  
  local next_major="$major"
  local next_minor="$minor"
  local next_patch="$((patch + 1))"
  
  if [ -n "$base_tag" ]; then
    local commits=""
    commits="$(git log --oneline "${base_tag}..HEAD" 2>/dev/null || true)"
    
    if printf '%s' "$commits" | grep -qE 'BREAKING CHANGE|\!:'; then
      next_major=$((major + 1))
      next_minor=0
      next_patch=0
    elif printf '%s' "$commits" | grep -qE '^feat|^feature'; then
      if [ "$major" -eq 0 ]; then
        next_minor=$((minor + 1))
        next_patch=0
      else
        next_minor=$((minor + 1))
        next_patch=0
      fi
    fi
  fi
  
  local next_version="${next_major}.${next_minor}.${next_patch}"
  
  local bump_kind="PATCH"
  if [ -n "$base_tag" ]; then
    local commits=""
    commits="$(git log --oneline "${base_tag}..HEAD" 2>/dev/null || true)"
    
    if printf '%s' "$commits" | grep -qE 'BREAKING CHANGE|\!:'; then
      bump_kind="MAJOR"
    elif printf '%s' "$commits" | grep -qE '^feat|^feature'; then
      bump_kind="MINOR"
    fi
  else
    bump_kind="INITIAL"
    next_version="1.0.0"
  fi
  
  local commit_count=0
  if [ -n "$base_tag" ]; then
    local commits=""
    commits="$(git log --oneline "${base_tag}..HEAD" 2>/dev/null || true)"
    if [ -n "$commits" ]; then
      commit_count=$(printf '%s' "$commits" | wc -l | tr -d ' ')
    fi
  fi
  
  jq -n \
    --arg base_tag "${base_tag:-null}" \
    --arg current_version "$current_version" \
    --arg next_version "$next_version" \
    --arg bump_kind "$bump_kind" \
    --argjson commit_count "$commit_count" \
    '{
      base_tag:       (if $base_tag=="" then null else $base_tag end),
      current_version:$current_version,
      next_version:   $next_version,
      bump_kind:      $bump_kind,
      commits_count:  ($commit_count | tonumber)
    }'
}

do_propagation_targets() {
  local targets_json="[]"
  
  # Integration branch is always a target
  targets_json="$(echo "$targets_json" | jq --arg k "integration" --arg n "$integration_branch" --argjson hf "true" \
    '. += [{kind: $k, name: $n, has_fix: $hf}]')"
  
  # Get all active release branches as targets
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    targets_json="$(echo "$targets_json" | jq --arg k "release" --arg n "$rel" --argjson hf "false" \
      '. += [{kind: $k, name: $n, has_fix: $hf}]')"
  done < <(git for-each-ref --format='%(refname:short)' refs/heads/release/* 2>/dev/null | sed 's|refs/heads/release/||')
  
  local current_class="$(get_class "$current_branch")"
  
  jq -n \
    --arg current "${current_branch:-null}" \
    --arg class "$current_class" \
    '{current: (if $current=="" then null else $current end), class: $class, targets: []}' \
    | jq --argjson t "$targets_json" '.targets = $t'
}

do_fingerprint() {
  local head_sha=""
  head_sha="$(git rev-parse HEAD 2>/dev/null | head -c 40)" || true
  
  [ -z "$head_sha" ] && { printf '{"error":"cannot-read-head-sha"}\n'; exit 1; }
  
  local ref_list=""
  while IFS= read -r r; do
    ref_list="${ref_list}${r}"$'\n'
  done < <(git for-each-ref --format='%(refname)' refs/heads refs/tags 2>/dev/null | sort)
  
  local fp=""
  fp="$(printf '%s\n%s' "$head_sha" "$ref_list" | shasum -a 256 | cut -d' ' -f1)" || true
  
  [ -z "$fp" ] && fp="fingerprint-unavailable"
  
  jq -n \
    --arg sha "$head_sha" \
    --arg branch "${current_branch:-null}" \
    --arg fingerprint "$fp" \
    '{
      sha:    $sha,
      branch: (if $branch=="" then null else $branch end),
      fingerprint: $fingerprint
    }'
}

do_branch_name() {
  local class="${class_name:-}"
  local slugs="${slug:-}"
  
  [ -z "$class" ] && { printf '{"error":"missing-class"}\n'; exit 2; }
  [ -z "$slugs" ] && { printf '{"error":"missing-slug"}\n'; exit 2; }
  
  local branch_name=""
  case "$class" in
    feature)   branch_name="feat/${slugs}" ;;
    fix)       branch_name="fix/${slugs}" ;;
    release)   branch_name="release/${slugs}" ;;
    hotfix)    branch_name="hotfix/${slugs}" ;;
    trunk|other)
      printf '{"error":"cannot-create-branch-for-trunk-or-other-class"}\n'
      exit 2
      ;;
    *)         branch_name="${class}/${slugs}" ;;
  esac
  
  jq -n --arg name "$branch_name" '{name: $name}'
}

case "$mode" in
  state)              do_state ;;
  next-version)       do_next_version ;;
  propagation-targets) do_propagation_targets ;;
  fingerprint)        do_fingerprint ;;
  branch-name)        do_branch_name ;;
  *)                  printf '{"error":"unknown-mode","mode":"%s"}\n' "$mode"; exit 2 ;;
esac

exit 0
