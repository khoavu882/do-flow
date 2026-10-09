#!/usr/bin/env bash
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
# the DoFlow runtime. Self-contained + fail-open: any uncertainty -> allow (exit 0).
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
ENVELOPE_TASK=""
ENVELOPE_OP=$(printf '%s' "$INPUT" | jq -r '.doflow_event.operation // empty' 2>/dev/null)
if [ -n "$ENVELOPE_OP" ]; then
  [ "$ENVELOPE_OP" = "edit" ] || exit 0          # only edits are gated
  FILES=$(printf '%s' "$INPUT" | jq -r '.doflow_event.paths[]? // empty' 2>/dev/null | sed '/^$/d' | sort -u)
  [ -n "$FILES" ] || exit 0
  ENVELOPE_ROOT=$(printf '%s' "$INPUT" | jq -r '.doflow_event.projectRoot // empty' 2>/dev/null)
  ENVELOPE_TASK=$(printf '%s' "$INPUT" | jq -r '.doflow_event.taskId // empty' 2>/dev/null)
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
# always allowed, and an absolute path elsewhere is not this repo's.
GATED=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in *"/agent-docs/"*|agent-docs/*) continue ;; esac
  case "$file" in
    /*)
      real=$(real_path "$file") || real="$file"
      case "$real" in *"/agent-docs/"*) continue ;; esac
      case "$real" in "$repo_real"/*) ;; *) continue ;; esac
      ;;
  esac
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

# A state file under this checkout, else under exactly one other checkout, at
# the first of the given paths that exists in each; held in two or more others,
# it cannot be told which is meant -> allow.
FOUND=""
find_state() {
  local rel root count=0 hit
  FOUND=""
  for rel in "$@"; do
    if [ -f "$repo_root/$rel" ]; then FOUND="$repo_root/$rel"; return 0; fi
  done
  checkouts
  for root in ${OTHERS[@]+"${OTHERS[@]}"}; do
    hit=""
    for rel in "$@"; do
      [ -f "$root/$rel" ] && { hit="$root/$rel"; break; }
    done
    [ -n "$hit" ] || continue
    count=$((count + 1))
    FOUND="$hit"
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

# The task's run: this checkout's, else the one other checkout's run of the same
# feature. A run with the same id for another feature is a different task.
find_run() {
  local rel=".doflow/state/orchestration/$task_id.json" root count=0
  FOUND=""
  if [ -f "$repo_root/$rel" ]; then FOUND="$repo_root/$rel"; return 0; fi
  checkouts
  for root in ${OTHERS[@]+"${OTHERS[@]}"}; do
    [ -f "$root/$rel" ] || continue
    [ "$(run_feature "$root/$rel")" = "$slug" ] || continue
    count=$((count + 1))
    FOUND="$root/$rel"
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
  exit 2
fi

# ── Readiness ────────────────────────────────────────────────────────────────
# The workflow registry the installed runtime reads: beside this policy in an
# install, the source tree's own, the project's install, the global install.
POLICY_DIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || POLICY_DIR=""
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
# own feature when it recorded one), then flat; this checkout first.
record_slug="${run_slug:-$slug}"
if [ -n "$record_slug" ] && [ "$record_slug" != "$task_id" ]; then
  find_state ".doflow/state/readiness/$record_slug/$task_id.json" ".doflow/state/readiness/$task_id.json"
else
  find_state ".doflow/state/readiness/$task_id.json"
fi
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
  exit 2
fi
if [ "$record_state" != READY ]; then
  printf "%s was last evaluated %s at %s against the '%s' template, not READY. %s\n" \
    "$gate" "$record_state" "$record_at" "$STAGE_TEMPLATE" "$rest" >&2
  exit 2
fi
if [ "$record_class" != "$STAGE_TEMPLATE" ]; then
  printf "%s has a READY record for the '%s' template, and this stage needs '%s'. %s\n" \
    "$gate" "$record_class" "$STAGE_TEMPLATE" "$rest" >&2
  exit 2
fi

exit 0
