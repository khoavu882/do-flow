#!/usr/bin/env bash
case $0 in */*) _DOFLOW_POLDIR=${0%/*} ;; *) _DOFLOW_POLDIR=. ;; esac
# pre-implementation-gate.sh — Canonical Policy Library: PreToolUse(Edit|Write|...)
# backstop for the doflow implement gate. The HARD half of the one enforced
# gate (the other half is the prompt-level do-prereqs.sh inside
# /do-execute-plan — defense in depth).
#
# Denies a SOURCE-file edit in two cases:
#   1. a feature has been STARTED (its feature_dir exists, in this checkout or,
#      from a linked worktree, in the main checkout) but requirement.md,
#      design.md, or plan.md is still missing: "don't write code before you've
#      planned";
#   2. the task is held to a readiness record and has no READY one for the
#      template of its workflow's first source-mutating stage. The task is held
#      when its run (in this checkout or exactly one other) is open with that
#      stage pending, or, with no run, on a feature branch whose folder has a
#      decision register and all three artifacts.
# It is deliberately SCOPED so it never fires outside the doflow chain:
#   - trunk                            -> allow
#   - branch is a fix, bugfix, refactor, chore, release or hotfix branch
#     (classes that cannot be a feature) -> no artifact check, run check only
#   - edit target is under agent-docs/ -> allow (editing the artifacts themselves)
#   - edit target outside the repo     -> allow
# It reads files with jq and lists checkouts with one git call; it never runs
# the DoFlow runtime. Missing or malformed v1 input is denied as out of step; other faults follow IC-011.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR (repo root, if the front door sets it),
#          DOFLOW_AGENT (harness id, informational only here),
#          CLAUDE_CONFIG_DIR / CLAUDE_PROJECT_DIR / CODEX_HOME
#          (each already read by the harness-specific dispatcher this policy
#          replaces — kept so an unmodified front door still resolves its own
#          harness's do-paths.sh resolver)
#   stdin  a native payload encoded as envelope v1 by the lifecycle bridge.
#   exit   exit 2 + doflow_decide deny = deny; other faults per IC-011. A front
#          door translates this into its native response shape.
#
# Reconciliation note (022-normalize-hooks, Phase A): claude/codex/kiro
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

INPUT=$(cat)
if [ -f "$_DOFLOW_POLDIR/contract.sh" ]; then
  . "$_DOFLOW_POLDIR/contract.sh"
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  doflow_read_envelope() { DF_ENV_CLASS=missing; DF_ENV_CODE=contract-missing; }
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-implementation-gate contract-missing ) >/dev/null 2>&1 || true
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then
    printf '[pre-implementation-gate] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2
  else
    printf '[pre-implementation-gate] DoFlow hooks out of step; run: doflow update\n' >&2
  fi
  doflow_decide deny contract-missing
  exit 2
fi
doflow_decision_init pre-implementation-gate 1
command -v jq >/dev/null 2>&1 || {
  doflow_decide error dependency-missing:jq
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-implementation-gate dependency-missing:jq ) >/dev/null 2>&1 || true
  exit 0
}

# Parse v1 apply_patch paths using the shared parser.
parse_patch_paths() {
  printf '%s\n' "$1" | sed -nE \
    -e 's#^\*\*\* (Add|Update|Delete) File: (.+)$#\2#p' \
    -e 's#^\+\+\+ (a/|b/)?(.+)$#\2#p' \
    | sed '/^\/dev\/null$/d' | sort -u
}

DF_ENV_CLASS=missing DF_ENV_CODE=envelope-missing
doflow_read_envelope || true

# ── Envelope v1 ───────────────────────────────────────────────────────────────
ENVELOPE_ROOT=""
ENVELOPE_TASK=""
if [ "$DF_ENV_CLASS" = v1 ]; then
  ENVELOPE_OP=$DF_ENV_OP
  [ "$ENVELOPE_OP" = "edit" ] || exit 0          # only edits are gated
  FILES=$DF_ENV_PATHS
  ENVELOPE_ROOT=$DF_ENV_ROOT
  ENVELOPE_TASK=$DF_ENV_TASK
  if [ -z "$FILES" ] && [ -z "$DF_ENV_PATCH" ]; then
    doflow_decide unsupported edit-without-target
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-implementation-gate edit-without-target ) >/dev/null 2>&1 || true
    exit 0
  fi
  if [ -z "$FILES" ] && [ -n "$DF_ENV_PATCH" ]; then
    FILES=$(parse_patch_paths "$DF_ENV_PATCH")
    [ -n "$FILES" ] || exit 0
  fi
elif [ "$DF_ENV_CLASS" = unsupported ]; then
  doflow_decide unsupported envelope-version
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-implementation-gate unsupported:envelope-version ) >/dev/null 2>&1 || true
  exit 0
else
  if [ "${DF_ENV_CODE:-envelope-missing}" != contract-missing ]; then
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-implementation-gate envelope-missing ) >/dev/null 2>&1 || true
  fi
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then printf '[pre-implementation-gate] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2; else printf '[pre-implementation-gate] DoFlow hooks out of step; run: doflow update\n' >&2; fi
  doflow_decide deny "${DF_ENV_CODE:-envelope-missing}"
  exit 2
fi

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
  "$ROOT/.kiro/scripts/doflow/bash/do-paths.sh"
  "$HOME/.doflow/scripts/doflow/bash/do-paths.sh"
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
  "${CLAUDE_PROJECT_DIR:-}/.claude/scripts/doflow/bash/do-paths.sh"
  "${CODEX_HOME:-$HOME/.codex}/scripts/doflow/bash/do-paths.sh"
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
    # One jq run for all five fields, one per line (none of them can hold a newline).
    {
      IFS= read -r feature_dir
      IFS= read -r repo_root
      IFS= read -r has_requirement
      IFS= read -r has_design
      IFS= read -r has_plan
    } < <(printf '%s' "$json" | jq -r '(.feature_dir // ""), (.repo_root // ""), (.has_requirement // false), (.has_design // false), (.has_plan // false)' 2>/dev/null) || true
  fi
fi

# Classes that cannot be a feature are not held to requirement/design/plan, even when they share a
# slug with a started feature folder: fix, bugfix, refactor, chore, release, hotfix and trunk. Any
# other branch (feat/, feature/, 043-auth, kai/043-auth) runs the feature class and is gated. do-paths.sh
# classifies fix/bugfix/release/hotfix/trunk the same way (refactor/ and chore/ are its `other`); the
# chain test fails if the two disagree.
branch=$(git -C "${repo_root:-$ROOT}" branch --show-current 2>/dev/null || true)
exempt=false
case "$branch" in
  ""|master|main|develop|trunk|HEAD) exit 0 ;;
  fix/*|bugfix/*|refactor/*|chore/*|release/*|hotfix/*) exempt=true ;;
esac

# Layout is decided ONCE from intention/requirement.md's presence, then every
# path below follows from it — the same single-probe rule do-paths.sh applies,
# so this probe can never report a self-contradictory mix of layouts. Without
# the structured arm a fully-planned feature (artifacts under intention/, design/,
# plan/) read as unplanned here and blocked every source edit.
probe_artifacts() {
  local dir="$1/$feature_dir"
  if [ -f "$dir/intention/requirement.md" ]; then
    has_requirement=true
    if [ -f "$dir/design/design.md" ]; then has_design=true; else has_design=false; fi
    if [ -f "$dir/plan.md" ]; then has_plan=true; else has_plan=false; fi
  elif [ -f "$dir/requirement.md" ]; then
    has_requirement=true
    if [ -f "$dir/design.md" ]; then has_design=true; else has_design=false; fi
    if [ -f "$dir/plan.md" ]; then has_plan=true; else has_plan=false; fi
  else
    has_requirement=false; has_design=false; has_plan=false
  fi
}

# Fallback: no resolver installed for this harness (or it produced nothing
# usable) -> compute state directly from the branch-coupled feature
# convention (feat/<slug> -> agent-docs/doflow/<slug>/), the same self
# contained approach antigravity's own copy of this gate already used.
# The task's slug is the resolver's, else the branch without its first
# prefix with any further / flattened to -, as the resolver derives it.
if [ -z "$feature_dir" ]; then
  repo_root="$ROOT"
  slug=${branch#*/}
  feature_dir="agent-docs/doflow/$slug"
  slug=${slug//\//-}
  [ -d "$repo_root/$feature_dir" ] && probe_artifacts "$repo_root"
else
  slug=${feature_dir##*/}
fi
[ -n "$feature_dir" ] && [ -n "$repo_root" ] || exit 0

# A task id stated by the envelope names the run and the record; one that is
# not a plain name cannot name either, so the slug stands in for it.
task_id="$ENVELOPE_TASK"
case "$task_id" in ""|.*|*..*|*[!A-Za-z0-9._-]*) task_id="$slug" ;; esac
[ -n "$task_id" ] || exit 0

# The real path of $1: its longest existing ancestor resolved with cd -P, the
# rest appended, so a path reached through a symlink (macOS /tmp and /var, a
# linked project folder) compares equal to the real repository root.
real_path() {
  local p="$1" rest="" dir
  while [ ! -e "$p" ] && [ "$p" != "/" ] && [ -n "$p" ]; do
    rest="/${p##*/}$rest"
    p=$(dirname "$p")
  done
  if [ -d "$p" ]; then
    dir=$(cd -P "$p" 2>/dev/null && pwd) || return 1
    p="$dir"
  else
    dir=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd) || return 1
    p="$dir/${p##*/}"
  fi
  printf '%s%s' "${p%/}" "$rest"
}
repo_real=$(cd -P "$repo_root" 2>/dev/null && pwd) || repo_real="$repo_root"

# Only source files inside this repo are gated: edits to doflow artifacts are
# always allowed, an absolute path elsewhere is not this repo's, and neither is a
# path git ignores.
GATED=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  # A ".." segment can lead out of agent-docs (agent-docs/../src/x), so such a path is judged by
  # its real path below, never by the text before the "..".
  case "/$file/" in
    */../*) ;;
    *) case "$file" in *"/agent-docs/"*|agent-docs/*) continue ;; esac ;;
  esac
  check="$file"
  case "$file" in
    /*)
      real=$(real_path "$file") || real="$file"
      case "/$real/" in */../*) ;; *) case "$real" in *"/agent-docs/"*) continue ;; esac ;; esac
      case "$real" in "$repo_real"/*) ;; *) continue ;; esac
      check="$real"
      ;;
    *)
      real=$(real_path "$repo_root/$file") || real="$repo_root/$file"
      # real_path folds a ".." only through directories that exist, so one left in it is not folded.
      case "/$file/" in */../*) case "/$real/" in */../*) ;; *) case "${real#"$repo_real"}/" in */agent-docs/*) continue ;; esac ;; esac ;; esac
      ;;
  esac
  # A path git ignores (a local config file such as .mcp.json) is not source. check-ignore
  # without --no-index answers "not ignored" for a tracked file, so tracked source stays gated.
  # The skip never applies to DoFlow's own state or gate artifacts: .doflow/ is gitignored, and
  # skipping it would let an edit forge a readiness record. Any `.doflow` or `agent-docs/doflow`
  # segment of the real path, or of the path as written (a `..` the resolver could not fold), keeps it gated.
  # The same holds for the do-paths.sh resolver the gate runs (any RESOLVER_CANDIDATES path, whichever
  # harness directory holds it, ignored or not): rewriting it can make the gate find no feature.
  case "/$file/" in */.doflow/*|*/agent-docs/doflow/*|*/../*|*/scripts/doflow/bash/do-paths.sh/) GATED=true; break ;; esac
  case "${real#"$repo_real"}/" in */.doflow/*|*/agent-docs/doflow/*|*/scripts/doflow/bash/do-paths.sh/) GATED=true; break ;; esac
  git -C "$repo_root" check-ignore -q -- "$check" 2>/dev/null && continue
  GATED=true
  break
done <<< "$FILES"
[ "$GATED" = true ] || exit 0

# ── Checkouts (one `git worktree list`, read at most once) ───────────────────
# MAIN is the main working tree when this checkout is a linked worktree of it;
# OTHERS are the repository's other checkouts. A bare main entry, a checkout
# whose directory is gone, and a DoFlow sandbox (.doflow-worktree-base at its
# root) are never read from; a sandbox sees no other checkout at all.
CHECKOUTS_READ=false
MAIN=""
OTHERS=()
checkouts() {
  [ "$CHECKOUTS_READ" = true ] && return 0
  CHECKOUTS_READ=true
  local list here line real current="" main="" paths=() bare=() i
  list=$(git -C "$repo_root" worktree list --porcelain 2>/dev/null) || return 0
  here=$(cd -P "$repo_root" 2>/dev/null && pwd) || return 0
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) paths+=("${line#worktree }"); bare+=(false) ;;
      bare) [ "${#paths[@]}" -gt 0 ] && bare[${#paths[@]}-1]=true ;;
    esac
  done <<< "$list"
  [ "${#paths[@]}" -gt 0 ] || return 0
  local reals=()
  for i in "${!paths[@]}"; do
    real=""
    [ "${bare[$i]}" = false ] && real=$(cd -P "${paths[$i]}" 2>/dev/null && pwd)
    reals+=("$real")
    [ "$i" -eq 0 ] && main="$real"
    if [ -n "$real" ] && { [ "$here" = "$real" ] || [ "${here#"$real"/}" != "$here" ]; }; then
      [ "${#real}" -gt "${#current}" ] && current="$real"
    fi
  done
  [ -n "$current" ] || return 0
  [ -e "$current/.doflow-worktree-base" ] && return 0
  [ "$main" != "$current" ] && MAIN="$main"
  for real in "${reals[@]}"; do
    [ -n "$real" ] && [ "$real" != "$current" ] && [ ! -e "$real/.doflow-worktree-base" ] && OTHERS+=("$real")
  done
  return 0
}

# Whether two files hold the same bytes.
same_bytes() {
  if command -v cmp >/dev/null 2>&1; then cmp -s "$1" "$2"; else [ "$(cat "$1")" = "$(cat "$2")" ]; fi
}

# Whether the flat record $1 of a namespaced task may be read as feature $2's
# (115 D-3): it names that feature (featureSlug on a run, slug on a readiness
# record) or none. A file that does not parse names nobody.
flat_is_ours() {
  local named
  named=$(jq -r '[.featureSlug, .slug] | map(select(type == "string" and . != "")) | first // empty' "$1" 2>/dev/null) || return 1
  [ -z "$named" ] || [ "$named" = "$2" ]
}

# The task's record of store $2 (readiness | orchestration) under checkout $1,
# keyed by feature $3 as the runtime keys it (115 C-1): <store>/<feature>/<id>.json
# for a task id other than the feature's slug, else the flat file; the flat file
# of a namespaced task only when it is this feature's or names none. Sets HIT.
HIT=""
record_in() {
  local store="$1/.doflow/state/$2"
  HIT=""
  if [ -n "$3" ] && [ "$3" != "$task_id" ]; then
    if [ -f "$store/$3/$task_id.json" ]; then HIT="$store/$3/$task_id.json"; return 0; fi
    [ -f "$store/$task_id.json" ] && flat_is_ours "$store/$task_id.json" "$3" && HIT="$store/$task_id.json"
    return 0
  fi
  [ -f "$store/$task_id.json" ] && HIT="$store/$task_id.json"
  return 0
}

# The task's readiness record, keyed by feature $1. From a linked worktree the
# main checkout's comes first, since every record lives there (115 IC-004), and
# a copy at the same path here with other bytes refuses (C-3). Else this
# checkout's, else exactly one other checkout's; held in two or more others it
# cannot be told which is meant -> allow.
FOUND=""
find_state() {
  local root count=0 copy
  FOUND=""
  if [ -f "$repo_root/.git" ]; then
    checkouts
    if [ -n "$MAIN" ]; then
      record_in "$MAIN" readiness "$1"
      if [ -n "$HIT" ]; then
        copy="$repo_root${HIT#"$MAIN"}"
        if [ -f "$copy" ] && ! same_bytes "$copy" "$HIT"; then
          printf "doflow gate readiness-before-implementation: task '%s' has a readiness record in this worktree (%s) that differs from the main checkout's (%s). Next: keep one of the two and remove the other, then re-run. Nothing was changed.\n" "$task_id" "$copy" "$HIT" >&2
          doflow_decide deny readiness-store-conflict
          exit 2
        fi
        FOUND="$HIT"
        return 0
      fi
    fi
  fi
  record_in "$repo_root" readiness "$1"
  if [ -n "$HIT" ]; then FOUND="$HIT"; return 0; fi
  checkouts
  for root in ${OTHERS[@]+"${OTHERS[@]}"}; do
    [ "$root" = "$MAIN" ] && continue
    record_in "$root" readiness "$1"
    [ -n "$HIT" ] || continue
    count=$((count + 1))
    FOUND="$HIT"
  done
  [ "$count" -le 1 ] || exit 0
}

# The feature a run file belongs to: the slug it recorded when it started, else
# its task id when that names a feature folder in the checkout holding it.
run_feature() {
  local recorded owner
  recorded=$(jq -r '.featureSlug // empty' "$1" 2>/dev/null) || recorded=""
  if [ -n "$recorded" ]; then printf '%s' "$recorded"; return 0; fi
  owner=${1%/.doflow/state/orchestration/*}
  [ -d "$owner/agent-docs/doflow/$task_id" ] && printf '%s' "$task_id"
  return 0
}

# The feature the task's records are keyed by, as the runtime keys them
# (featureSlugFor): a task id that names a feature folder in this checkout is
# its own feature, else the branch's.
run_key="$slug"
[ -d "$repo_root/agent-docs/doflow/$task_id" ] && run_key="$task_id"

# The task's run: this checkout's, else the one other checkout's run of the same
# feature. A run with the same id for another feature is a different task.
find_run() {
  local root count=0
  FOUND=""
  record_in "$repo_root" orchestration "$run_key"
  if [ -n "$HIT" ]; then FOUND="$HIT"; return 0; fi
  checkouts
  for root in ${OTHERS[@]+"${OTHERS[@]}"}; do
    record_in "$root" orchestration "$run_key"
    [ -n "$HIT" ] || continue
    [ "$(run_feature "$HIT")" = "$run_key" ] || continue
    count=$((count + 1))
    FOUND="$HIT"
  done
  [ "$count" -le 1 ] || exit 0
}

# ── Feature folder: this checkout's, else the main checkout's ────────────────
FEATURE_ROOT=""
if [ -d "$repo_root/$feature_dir" ]; then
  FEATURE_ROOT="$repo_root"
else
  checkouts
  if [ -n "$MAIN" ] && [ -d "$MAIN/$feature_dir" ]; then
    FEATURE_ROOT="$MAIN"
    probe_artifacts "$MAIN"
  fi
fi
HAS_REGISTER=false
[ -n "$FEATURE_ROOT" ] && [ -f "$FEATURE_ROOT/$feature_dir/decisions/register.json" ] && HAS_REGISTER=true
PLANNED=false
[ "$has_requirement" = "true" ] && [ "$has_design" = "true" ] && [ "$has_plan" = "true" ] && PLANNED=true

# In the flow: block a source edit until requirement.md, design.md, AND
# plan.md all exist. Classes that cannot be a feature skip this check.
if [ "$exempt" = false ] && [ -n "$FEATURE_ROOT" ] && [ "$PLANNED" = false ]; then
  echo "[pre-implementation-gate] doflow gate: feature $feature_dir is missing requirement.md, design.md, or plan.md — run /do-brainstorm, /do-design, then /do-plan before editing source. (Edits under agent-docs/ are always allowed; skip the flow by removing the feature dir.)" >&2
  doflow_decide deny missing-artifacts
  exit 2
fi

# ── Readiness ────────────────────────────────────────────────────────────────
# The workflow registry the installed runtime reads: beside this policy in an
# install, the source tree's own, the project's install, the global install.
POLICY_DIR=$_DOFLOW_POLDIR
REGISTRY=""
for candidate in \
  "${POLICY_DIR:+$POLICY_DIR/../../../runtime/core/registry/workflows.json}" \
  "${POLICY_DIR:+$POLICY_DIR/../../../../registry/workflows.json}" \
  "$repo_root/.doflow/runtime/core/registry/workflows.json" \
  "$HOME/.doflow/runtime/core/registry/workflows.json"; do
  [ -n "$candidate" ] && [ -f "$candidate" ] && { REGISTRY="$candidate"; break; }
done

# The class's gated stage: its first stage whose kind mutates source and that
# names a readiness template. Sets STAGE_ID, STAGE_TEMPLATE and STAGE_EDIT
# (false when the stage opts out of this edit-time check); all empty for none.
gated_stage() {
  local out
  STAGE_ID=""; STAGE_TEMPLATE=""; STAGE_EDIT=""
  [ -n "$REGISTRY" ] || return 0
  out=$(jq -r --arg c "$1" '. as $r
    | [($r.classes[$c].stages // [])[]
       | select(($r.stageKinds[.kind].mutatesSource // false) == true and (.readinessTemplate // "") != "")]
    | first // empty
    | .id, .readinessTemplate, (.editTimeGate != false)' "$REGISTRY" 2>/dev/null) || return 0
  { IFS= read -r STAGE_ID; IFS= read -r STAGE_TEMPLATE; IFS= read -r STAGE_EDIT; } <<< "$out"
  return 0
}

# Whether the run file's program shows that stage completed or skipped.
stage_done() {
  jq -e --arg id "$1" 'any(.program[]?; .type == "stage" and .id == $id
    and (.status == "completed" or .status == "skipped"))' "$RUN" >/dev/null 2>&1
}

RUN=""
find_run
RUN="$FOUND"
run_slug=""
if [ -n "$RUN" ]; then
  run_slug=$(run_feature "$RUN")
  run_info=$(jq -r '(.state // ""), (.taskClass // "")' "$RUN" 2>/dev/null) || exit 0
  { IFS= read -r run_state; IFS= read -r run_class; } <<< "$run_info"
  case "$run_state" in COMPLETED|REJECTED) exit 0 ;; esac
fi

if [ -n "$RUN" ]; then
  class="$run_class"
elif [ "$exempt" = false ] && [ -n "$FEATURE_ROOT" ] && [ "$PLANNED" = true ] && [ "$HAS_REGISTER" = true ]; then
  class=feature
else
  exit 0
fi

gated_stage "$class"
[ -n "$STAGE_ID" ] && [ "$STAGE_EDIT" = true ] || exit 0
if [ -n "$RUN" ]; then
  # A run whose program does not name that stage (missing, malformed, or compiled
  # from a registry that named it differently) cannot be judged here -> allow, as
  # the runtime reads such a run as having no gated stage.
  jq -e --arg id "$STAGE_ID" 'any(.program[]?; .type == "stage" and .id == $id)' "$RUN" >/dev/null 2>&1 || exit 0
  stage_done "$STAGE_ID" && exit 0
fi

# The record, where the runtime looks: under the feature's namespace (the run's
# own feature when it recorded one), then flat; the main checkout first from a
# linked worktree, else this checkout first.
record_slug="${run_slug:-$run_key}"
find_state "$record_slug"
record_state=""; record_class=""; record_at=""
if [ -n "$FOUND" ]; then
  record_info=$(jq -r '(.state // ""), (.taskClass // ""), (.evaluatedAt // "")' "$FOUND" 2>/dev/null) || exit 0
  { IFS= read -r record_state; IFS= read -r record_class; IFS= read -r record_at; } <<< "$record_info"
  [ -n "$record_state" ] || exit 0
fi

# The runtime's refusal texts, byte for byte. The next command names the slug
# only when its feature folder exists here or in the main checkout, which is
# when the runtime names it too (and when `readiness --slug` resolves it).
next="doflow-run readiness --task-class $STAGE_TEMPLATE --task-id $task_id"
if [ -n "$record_slug" ] && [ "$record_slug" != "$task_id" ]; then
  checkouts
  if [ -d "$repo_root/agent-docs/doflow/$record_slug" ] || { [ -n "$MAIN" ] && [ -d "$MAIN/agent-docs/doflow/$record_slug" ]; }; then
    next="$next --slug=$record_slug"
  fi
fi
gate="doflow gate readiness-before-implementation: task '$task_id'"
rest="Next: $next, then gather what it lists until it reports READY. Nothing was changed."
if [ -z "$FOUND" ]; then
  printf "%s has no readiness record for the '%s' template. %s\n" "$gate" "$STAGE_TEMPLATE" "$rest" >&2
  doflow_decide deny readiness-missing
  exit 2
fi
if [ "$record_state" != READY ]; then
  printf "%s was last evaluated %s at %s against the '%s' template, not READY. %s\n" \
    "$gate" "$record_state" "$record_at" "$STAGE_TEMPLATE" "$rest" >&2
  doflow_decide deny readiness-not-ready
  exit 2
fi
if [ "$record_class" != "$STAGE_TEMPLATE" ]; then
  printf "%s has a READY record for the '%s' template, and this stage needs '%s'. %s\n" \
    "$gate" "$record_class" "$STAGE_TEMPLATE" "$rest" >&2
  doflow_decide deny readiness-wrong-template
  exit 2
fi

exit 0
