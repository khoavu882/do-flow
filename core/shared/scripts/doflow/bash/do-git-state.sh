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

  # The pre-release suffix is *detected*, not merely discarded. Stripping it was originally added
  # so the arithmetic below would not crash on "0-beta.4", and that fix left the suffix's meaning
  # out of the answer: a base of 1.0.0-beta.7 was bumped as though it were the released 1.0.0, so
  # the verb proposed 1.0.1 and the 1.0.0 the beta line was building toward would never exist.
  #
  # Semver orders 1.0.0-beta.7 < 1.0.0 < 1.0.1, so a pre-release is already *before* its own
  # version number. Promoting it is therefore the bump, not an increment on top of it. These are
  # node-semver's documented rules for inc() from a pre-release, reproduced rather than invented.
  local version_core="${current_version%%-*}"
  version_core="${version_core%%+*}"
  local prerelease=""
  case "$current_version" in
    *-*) prerelease="${current_version#*-}"; prerelease="${prerelease%%+*}" ;;
  esac

  local major minor patch
  major="0"; minor="0"; patch="0"
  IFS='.' read -r major minor patch <<< "$version_core" 2>/dev/null || true
  major="${major:-0}"; minor="${minor:-0}"; patch="${patch:-0}"

  # One read of the commit range, reused. It was previously computed three times.
  local commits="" commit_count=0
  if [ -n "$base_tag" ]; then
    commits="$(git log --format=%s "${base_tag}..HEAD" 2>/dev/null || true)"
    # `git rev-list --count`, not `printf | wc -l`: the latter sees no trailing newline and so
    # undercounts every range by one.
    commit_count="$(git rev-list --count "${base_tag}..HEAD" 2>/dev/null || echo 0)"
  fi

  local bump_kind="PATCH"
  if [ -n "$base_tag" ]; then
    if printf '%s' "$commits" | grep -qE 'BREAKING CHANGE|\!:'; then
      bump_kind="MAJOR"
    elif printf '%s' "$commits" | grep -qE '^feat|^feature'; then
      bump_kind="MINOR"
    fi
  else
    bump_kind="INITIAL"
  fi

  local next_major="$major" next_minor="$minor" next_patch="$patch"
  if [ -z "$base_tag" ]; then
    next_major=1; next_minor=0; next_patch=0
  elif [ -n "$prerelease" ]; then
    # Promotion: a pre-release is released by dropping the suffix, provided the fields the bump
    # would raise are already zero. Otherwise the bump applies and the suffix falls away with it.
    case "$bump_kind" in
      MAJOR) if [ "$minor" -eq 0 ] && [ "$patch" -eq 0 ]; then :; else next_major=$((major + 1)); next_minor=0; next_patch=0; fi ;;
      MINOR) if [ "$patch" -eq 0 ]; then :; else next_minor=$((minor + 1)); next_patch=0; fi ;;
      *)     : ;;
    esac
  else
    case "$bump_kind" in
      MAJOR) next_major=$((major + 1)); next_minor=0; next_patch=0 ;;
      MINOR) next_minor=$((minor + 1)); next_patch=0 ;;
      *)     next_patch=$((patch + 1)) ;;
    esac
  fi

  local next_version="${next_major}.${next_minor}.${next_patch}"

  # The other honest option for a pre-release base: continue the line rather than promote it.
  # Reported alongside so the release ritual can offer the choice instead of assuming one.
  local next_prerelease=""
  if [ -n "$prerelease" ]; then
    local pre_label="${prerelease%.*}" pre_num="${prerelease##*.}"
    if printf '%s' "$pre_num" | grep -qE '^[0-9]+$'; then
      next_prerelease="${version_core}-${pre_label}.$((pre_num + 1))"
    else
      next_prerelease="${version_core}-${prerelease}.1"
    fi
  fi

  jq -n \
    --arg base_tag "${base_tag:-null}" \
    --arg current_version "$current_version" \
    --arg next_version "$next_version" \
    --arg next_prerelease "$next_prerelease" \
    --arg prerelease "$prerelease" \
    --arg bump_kind "$bump_kind" \
    --argjson commit_count "$commit_count" \
    '{
      base_tag:         (if $base_tag=="" then null else $base_tag end),
      current_version:  $current_version,
      is_prerelease:    ($prerelease != ""),
      next_version:     $next_version,
      next_prerelease:  (if $next_prerelease=="" then null else $next_prerelease end),
      bump_kind:        $bump_kind,
      commits_count:    ($commit_count | tonumber)
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
