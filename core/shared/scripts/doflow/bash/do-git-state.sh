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
# The resolver refuses a branch whose derived slug is unsafe and then prints no repo_root. This
# helper does not need a feature, only the repository, so it asks git rather than reporting a
# repository that exists as "not-a-git-repo".
[ -z "$repo_root" ] && repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

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

# Which ref the integration branch resolves to decides whether a distance measured against it
# means anything. The local branch was used unconditionally, so a develop that had not been pulled
# made every distance wrong by however stale it was — observed live at 22 reported against 32.
#
# The remote-tracking ref is preferred where it exists; the local branch is the fallback for a
# repository with no remote or one never fetched. Preferring it does not make the answer *fresh* —
# origin/develop is only as current as the last fetch — so the third field reports how far the
# local branch trails, which is non-zero exactly when a `git fetch` would change the answer.
#
# Echoes: "<ref> <kind> <local-behind-remote>"
resolve_integration_ref() {
  local branch="$1"
  local ref="$branch" kind="local" behind=0
  if git rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null 2>&1; then
    ref="origin/${branch}"
    kind="remote-tracking"
    if git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null 2>&1; then
      behind="$(git rev-list --count "${branch}..origin/${branch}" 2>/dev/null || echo 0)"
    fi
  fi
  printf '%s %s %s\n' "$ref" "$kind" "$behind"
}

# Commits either side of a comparison, or "0 0" when either ref is missing.
# Echoes: "<ahead> <behind>"
distance_from() {
  local branch="$1" against="$2"
  if git rev-parse "refs/heads/${branch}" >/dev/null 2>&1 && \
     git rev-parse --verify --quiet "$against" >/dev/null 2>&1; then
    local counts; counts="$(commits_between "$branch" "$against")"
    printf '%s %s\n' "$(echo "$counts" | awk '{print $1}')" "$(echo "$counts" | awk '{print $2}')"
  else
    printf '0 0\n'
  fi
}

# The single lifecycle word for a branch's position. Ordered so the most actionable state wins:
# an uncommitted change matters more than any distance, and being behind matters more than ahead.
lifecycle_position() {
  local ahead="$1" behind="$2" dirty="$3"
  if [ "$dirty" = "true" ]; then printf 'dirty-worktree\n'
  elif [ "$behind" -gt 0 ]; then printf 'behind-integration\n'
  elif [ "$ahead" -gt 0 ]; then printf 'ahead-of-integration\n'
  else printf 'in-sync\n'
  fi
}

do_state() {
  local class="$(get_class "$current_branch")"
  local slugs="$(get_slug "$current_branch")"
  local dirty="false"
  is_dirty && dirty="true"
  
  local integration_ref integration_ref_kind integration_local_behind
  read -r integration_ref integration_ref_kind integration_local_behind \
    <<< "$(resolve_integration_ref "$integration_branch")"

  local ahead behind position
  read -r ahead behind <<< "$(distance_from "$current_branch" "$integration_ref")"
  position="$(lifecycle_position "$ahead" "$behind" "$dirty")"
  
  jq -n \
    --arg branch "${current_branch:-null}" \
    --arg class_name "$class" \
    --arg feature_slug "$slugs" \
    --argjson dirty "$dirty" \
    --arg ahead "$ahead" \
    --arg behind "$behind" \
    --arg position "$position" \
    --arg integration_ref "$integration_ref" \
    --arg integration_ref_kind "$integration_ref_kind" \
    --arg integration_local_behind "$integration_local_behind" \
    '{
      branch:        (if $branch=="" then null else $branch end),
      class:         $class_name,
      feature_slug:  (if $feature_slug=="" then null else $feature_slug end),
      dirty:         $dirty,
      ahead_of_integration: ($ahead | tonumber),
      behind_integration: ($behind | tonumber),
      integration_ref: $integration_ref,
      integration_ref_kind: $integration_ref_kind,
      integration_local_behind_remote: ($integration_local_behind | tonumber),
      position:      $position
    }'
}

# The production branch's ref, for finding release tags that were never merged back: the local
# branch where it exists, else its remote-tracking ref. `main` is the default; `master` is the
# older default the lifecycle policy still names. Echoes nothing when neither exists.
production_ref() {
  local b
  for b in main master; do
    if git rev-parse --verify --quiet "refs/heads/${b}" >/dev/null 2>&1; then printf '%s\n' "$b"; return; fi
    if git rev-parse --verify --quiet "refs/remotes/origin/${b}" >/dev/null 2>&1; then printf 'origin/%s\n' "$b"; return; fi
  done
}

# Splits a semver string into its numeric core and its pre-release label.
# Echoes: "<major> <minor> <patch> <prerelease-or-empty>"
parse_semver() {
  local version="$1"
  local core="${version%%-*}"; core="${core%%+*}"
  local pre=""
  case "$version" in
    *-*) pre="${version#*-}"; pre="${pre%%+*}" ;;
  esac
  local major minor patch
  IFS='.' read -r major minor patch <<< "$core" 2>/dev/null || true
  printf '%s %s %s %s\n' "${major:-0}" "${minor:-0}" "${patch:-0}" "$pre"
}

# Reads the commit subjects since a base tag and names the bump they imply.
# Echoes: "<MAJOR|MINOR|PATCH|INITIAL> <commit-count>"
classify_bump() {
  local base_tag="$1"
  if [ -z "$base_tag" ]; then
    printf 'INITIAL 0\n'
    return
  fi
  local subjects count kind="PATCH"
  subjects="$(git log --format=%s "${base_tag}..HEAD" 2>/dev/null || true)"
  # `git rev-list --count`, not `printf | wc -l`: the latter sees no trailing newline and so
  # undercounts every range by one.
  count="$(git rev-list --count "${base_tag}..HEAD" 2>/dev/null || echo 0)"
  if printf '%s' "$subjects" | grep -qE 'BREAKING CHANGE|\!:'; then
    kind="MAJOR"
  elif printf '%s' "$subjects" | grep -qE '^feat|^feature'; then
    kind="MINOR"
  fi
  printf '%s %s\n' "$kind" "$count"
}

# The next free number on a pre-release line. Computing label.N+1 arithmetically once proposed a
# tag that already existed — a well-formed value derived without consulting the thing it describes.
# `git describe` finds the nearest *reachable* tag, so a pre-release cut on an unmerged branch is
# invisible to the base-tag lookup and collides here instead. Taken numbers are stepped over rather
# than stopped on, because the caller wants a usable candidate, and the count of them is reported
# because the gap is a fact about the tag history. Bounded so a pathological tag set cannot spin.
# Echoes: "<candidate> <skipped-count>"
next_free_prerelease() {
  local core="$1" pre="$2"
  local label="${pre%.*}" num="${pre##*.}"
  if ! printf '%s' "$num" | grep -qE '^[0-9]+$'; then
    printf '%s-%s.1 0\n' "$core" "$pre"
    return
  fi
  local candidate=$((num + 1)) skipped=0 guard=0
  while [ "$guard" -lt 100 ]; do
    if ! git rev-parse --verify --quiet "refs/tags/v${core}-${label}.${candidate}" >/dev/null 2>&1; then
      break
    fi
    candidate=$((candidate + 1)); skipped=$((skipped + 1)); guard=$((guard + 1))
  done
  printf '%s-%s.%s %s\n' "$core" "$label" "$candidate" "$skipped"
}

do_next_version() {
  local base_tag current_version="0.0.0"
  # `git describe --tags --abbrev=0` answers "nearest reachable tag by commit distance", and every
  # version decision below needs "newest reachable tag by version". Those coincide only while
  # history is linear — and a release ritual merges twice, so the newest tag routinely sits further
  # from HEAD than an older one. On this repository after v1.0.0 shipped, beta.8 was reachable at 33
  # commits and beta.7 at 31, so describe returned beta.7 and every later computation was based on a
  # superseded release.
  #
  # Sorting by version instead. The `v*` filter keeps a non-version tag from winning the sort, and
  # --merged keeps the answer to tags that are actually released work.
  #
  # "Merged" means into HEAD *or into the production branch*. A release ritual tags the merge commit
  # on production, and the integration branch only gets that commit back through a second merge
  # that may not have happened yet, so from the integration branch the newest release tag is
  # unreachable and the proposal was based on an older one (v1.8.3 proposed while v1.12.0 was out).
  # The tags are sorted by git as before; the union only decides which of them are eligible.
  local production eligible
  production="$(production_ref)"
  eligible="$({ git tag --merged HEAD --list 'v*' 2>/dev/null; [ -n "$production" ] && git tag --merged "$production" --list 'v*' 2>/dev/null; } | sort -u)"
  if [ -n "$eligible" ]; then
    base_tag="$(git tag --list 'v*' --sort=-v:refname 2>/dev/null | grep -Fx -f <(printf '%s\n' "$eligible") | head -1 || true)"
  fi
  [ -n "$base_tag" ] && current_version="${base_tag#v}"

  # The manifest is what a release publishes. A base tag that disagrees with it means the tag or
  # the manifest is behind, which the caller should see before proposing a version from either.
  local manifest_version="" warning=""
  if [ -n "$base_tag" ] && [ -f package.json ]; then
    manifest_version="$(jq -r '.version // empty' package.json 2>/dev/null || true)"
    if [ -n "$manifest_version" ] && [ "$manifest_version" != "$current_version" ]; then
      warning="manifest version ${manifest_version} differs from base tag ${base_tag}"
    fi
  fi

  local major minor patch prerelease
  read -r major minor patch prerelease <<< "$(parse_semver "$current_version")"
  local version_core="${major}.${minor}.${patch}"

  local bump_kind commit_count
  read -r bump_kind commit_count <<< "$(classify_bump "$base_tag")"

  # Semver orders 1.0.0-beta.7 < 1.0.0 < 1.0.1, so a pre-release already sits *before* its own
  # version number: promoting it IS the bump, not an increment on top of it. A bump promotes when
  # the field it would raise is already zero, and otherwise increments with the suffix falling
  # away. These are node-semver's inc() rules reproduced rather than invented.
  local next_major="$major" next_minor="$minor" next_patch="$patch"
  if [ "$bump_kind" = "INITIAL" ]; then
    next_major=1; next_minor=0; next_patch=0
  elif [ -n "$prerelease" ]; then
    case "$bump_kind" in
      MAJOR) [ "$minor" -eq 0 ] && [ "$patch" -eq 0 ] || { next_major=$((major + 1)); next_minor=0; next_patch=0; } ;;
      MINOR) [ "$patch" -eq 0 ] || { next_minor=$((minor + 1)); next_patch=0; } ;;
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
  local next_prerelease="" next_prerelease_skipped=0
  if [ -n "$prerelease" ]; then
    read -r next_prerelease next_prerelease_skipped <<< "$(next_free_prerelease "$version_core" "$prerelease")"
  fi

  jq -n \
    --arg base_tag "${base_tag:-null}" \
    --arg current_version "$current_version" \
    --arg next_version "$next_version" \
    --arg next_prerelease "$next_prerelease" \
    --arg next_prerelease_skipped "$next_prerelease_skipped" \
    --arg prerelease "$prerelease" \
    --arg bump_kind "$bump_kind" \
    --argjson commit_count "$commit_count" \
    --arg warning "$warning" \
    '{
      base_tag:         (if $base_tag=="" then null else $base_tag end),
      current_version:  $current_version,
      is_prerelease:    ($prerelease != ""),
      next_version:     $next_version,
      next_prerelease:  (if $next_prerelease=="" then null else $next_prerelease end),
      next_prerelease_skipped: ($next_prerelease_skipped | tonumber),
      bump_kind:        $bump_kind,
      commits_count:    ($commit_count | tonumber)
    } + (if $warning != "" then {warning: $warning} else {} end)'
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

  # A slug becomes a branch name and then a directory under agent-docs/doflow/, so it must not be
  # able to name a path or a flag (IC-009). Same shape do-paths.sh enforces for its own slugs.
  if ! [[ "$slugs" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [[ "$slugs" == *..* ]]; then
    jq -n --arg slug "$slugs" '{error: "invalid-slug", message: ("slug \"" + $slug + "\" is not a valid feature slug: use letters, digits, dot, underscore or dash, start with a letter or digit, and no \"..\""), hint: "use letters, digits, dot, underscore or dash, start with a letter or digit, and no \"..\""}'
    exit 2
  fi
  
  # Two vocabularies meet here and only one of them is a branch prefix.
  #
  # The arms below are *branch* classes — the same set get_class emits — so --class=fix round-trips
  # and --class=bug did not: it fell through to a catch-all that prepended whatever it was handed,
  # producing bug/<slug>, which get_class then classified as "other". Every DoFlow skill holds a
  # *task* class (bug, refactor, dependency-change, trivial-edit, feature), so the caller most
  # likely to use this verb was the one guaranteed to get an unusable name.
  #
  # Task classes are mapped rather than passed through. In branch terms everything that is not a
  # feature is a fix: the lifecycle policy declares exactly two working prefixes, feat and fix, and
  # inventing refactor/ or trivial-edit/ would widen a vocabulary get_class does not recognise —
  # trading one unclassifiable name for four.
  local branch_class="$class"
  case "$class" in
    bug|refactor|dependency-change|trivial-edit) branch_class="fix" ;;
  esac

  local branch_name=""
  case "$branch_class" in
    feature)   branch_name="feat/${slugs}" ;;
    fix)       branch_name="fix/${slugs}" ;;
    release)   branch_name="release/${slugs}" ;;
    hotfix)    branch_name="hotfix/${slugs}" ;;
    trunk|other)
      printf '{"error":"cannot-create-branch-for-trunk-or-other-class"}\n'
      exit 2
      ;;
    # An unrecognised class is refused rather than prepended. The catch-all that used to sit here
    # is what let a task class through and produced a name no verb could classify.
    *)
      printf '{"error":"unknown-class","class":"%s","valid":"feature, fix, release, hotfix, bug, refactor, dependency-change, trivial-edit"}\n' "$class"
      exit 2
      ;;
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
