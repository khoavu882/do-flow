#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# render-drawio.sh — writes an editable draw.io draft of a feature's C4 sources, for a presentation.
#
# Each design/c4/<level>.puml becomes design/presentation/<level>.drawio: a first draft a person then
# arranges by hand in draw.io, with their own product icons on the elements. It is a presentation
# copy, never the source of truth; Mermaid and PlantUML stay the working diagrams.
#
# Icons: DoFlow ships none (logos are trademarks with mixed licences). They are read from
# <feature dir>/design/presentation/icons/ unless --icons names another folder inside the checkout,
# by file name: <sprite>.svg|png, else <technology>.svg|png (docs/reference.md has the rule). The verb
# prints the file names it looked for on each element that found none.
#
# A .drawio that was edited after it was generated is never overwritten without --force.
# When a draw.io binary is on PATH (or DOFLOW_DRAWIO names one) a <level>.drawio.svg is exported beside
# it, under a timeout (--timeout, default 60 s); without one the .drawio is still written and the
# export is reported as skipped, with the command to run.
#
# Fail-open like render-puml.sh: no active feature, no design/c4/ and no source are each reported via
# a note and exit 0. Exit 1 is a source the projector refused or a .drawio it would not overwrite.
#
# Usage: render-drawio.sh [--slug=<slug>] [--level=<name>] [--icons=<dir>] [--force] [--timeout=<seconds>] [--json]

set -uo pipefail

emit_json=false
force=false
slug_override=""
level=""
icons_override=""
timeout_sec="60"
bad_args=()
for a in "$@"; do
  case "$a" in
    --json)      emit_json=true ;;
    --force)     force=true ;;
    --slug=*)    slug_override="${a#--slug=}" ;;
    --level=*)   level="${a#--level=}" ;;
    --icons=*)   icons_override="${a#--icons=}" ;;
    --timeout=*) timeout_sec="${a#--timeout=}" ;;
    *) bad_args+=("$a") ;;
  esac
done

usage='usage: render-drawio.sh [--slug=<slug>] [--level=<name>] [--icons=<dir>] [--force] [--timeout=<seconds>] [--json]'
if [ "${#bad_args[@]}" -gt 0 ]; then
  printf 'render-drawio: unrecognized argument(s): %s\n%s\n' "${bad_args[*]}" "$usage" >&2
  exit 2
fi
case "$level" in
  *[!A-Za-z0-9._-]*) printf 'render-drawio: --level takes a file name such as container, got: %s\n' "$level" >&2; exit 2 ;;
esac

note() {
  if [ "$emit_json" = true ]; then
    if command -v jq >/dev/null 2>&1; then jq -n --arg n "$1" '{ok:true, written:false, note:$n, levels:[]}'
    else printf '{"ok":true,"written":false,"note":"%s","levels":[]}\n' "$1"; fi
  else
    printf 'render-drawio: %s (nothing written)\n' "$1"
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || note "jq-absent"
command -v node >/dev/null 2>&1 || note "node-absent"

script_dir="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$script_dir/do-paths.sh"
[ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/scripts/doflow/bash/do-paths.sh"
[ -f "$RESOLVER" ] || note "resolver-absent"

resolver_args=(--json)
[ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
rc=0; resolved_json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || rc=$?
# An unsafe slug is refused, not noted: exit 2 with the resolver's error object (IC-009).
if [ "$rc" -eq 2 ] && [ "$(printf '%s' "$resolved_json" | jq -r '.error // empty' 2>/dev/null)" = "invalid-slug" ]; then
  if [ "$emit_json" = true ]; then printf '%s\n' "$resolved_json"; else printf 'render-drawio: %s\n' "$(printf '%s' "$resolved_json" | jq -r '.message')" >&2; fi
  exit 2
fi
[ "$rc" -eq 0 ] || note "resolver-error"

repo_root=$(printf '%s' "$resolved_json" | jq -r '.repo_root // empty')
feature_slug=$(printf '%s' "$resolved_json" | jq -r '.feature_slug // empty')
feature_dir=$(printf '%s' "$resolved_json" | jq -r '.feature_dir // empty')
# The feature folder sits in the checkout that holds agent-docs: in a linked worktree that is the
# main checkout, not repo_root. Same reading as render-puml.sh and render-page.sh.
feature_root=$(printf '%s' "$resolved_json" | jq -r '.feature_root // empty')
[ -n "$feature_root" ] || feature_root="$repo_root"
[ -n "$feature_slug" ] || note "no-active-feature"
[ -n "$feature_dir" ] || note "resolver-missing-feature-dir"

# The projector lives in the JS runtime (G12: one runtime implementation), reached the way
# render-puml.sh reaches c4-project.ts.
PROJECTOR="$repo_root/src/runtime/drawio-project.ts"
[ -f "$PROJECTOR" ] || PROJECTOR="${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/runtime/src/runtime/drawio-project.ts"
[ -f "$PROJECTOR" ] || note "draw.io projector not found at $PROJECTOR. Reinstall the runtime: npx @khoavu882/doflow install"

src_dir="$feature_root/$feature_dir/design/c4"
[ -d "$src_dir" ] || note "no design/c4/ directory in $feature_dir — authoring C4 in PlantUML is opt-in, so there is nothing to render"
[ -n "$(find "$src_dir" -maxdepth 1 -type f -name '*.puml' | head -1)" ] || note "no .puml source found in $feature_dir/design/c4"

out_dir="$feature_root/$feature_dir/design/presentation"
icons_dir="$out_dir/icons"
[ -n "$icons_override" ] && icons_dir="$icons_override"

node_args=("$PROJECTOR" --src-dir "$src_dir" --out-dir "$out_dir" --icons "$icons_dir" --base "$feature_root" --root "$feature_root" --timeout "$timeout_sec")
[ "$repo_root" != "$feature_root" ] && [ -n "$repo_root" ] && node_args+=(--root "$repo_root")
[ -n "$level" ] && node_args+=(--level "$level")
[ "$force" = true ] && node_args+=(--force)

proj_err="$(mktemp 2>/dev/null)" || note "mktemp-failed"
trap 'rm -f "$proj_err"' EXIT
rc=0; result=$(node "${node_args[@]}" 2>"$proj_err") || rc=$?
if [ -z "$result" ] || ! printf '%s' "$result" | jq -e . >/dev/null 2>&1; then
  message="the draw.io projector failed: $(tr '\n' ' ' < "$proj_err")"
  if [ "$emit_json" = true ]; then jq -n --arg m "$message" '{ok:false, written:false, error:"projector-failed", message:$m, levels:[]}'
  else printf 'render-drawio: %s\n' "$message" >&2; fi
  exit "$([ "$rc" -eq 2 ] && echo 2 || echo 1)"
fi

if [ "$emit_json" = true ]; then
  printf '%s\n' "$result"
else
  printf '%s' "$result" | jq -r '
    .levels[] |
    if .status == "written" or .status == "unchanged" then
      "render-drawio: \(.status) \(.file) (\(.counts.elements) element(s), \(.counts.edges) relation(s); icons: \(.icons.used | length) used, \(.icons.missing | length) missing)"
    else
      "render-drawio: \(.level): \(.status): \(.message)"
    end,
    (.icons.skipped[]? | "render-drawio:   icon \(.file) for \(.element) not used: \(.why)"),
    (.icons.missing[]? | "render-drawio:   no icon for \(.element); looked for " + ([.keys[] | "\(.).svg, \(.).png"] | join(", "))),
    (.export // empty | if .status == "exported" then "render-drawio:   exported \(.file)"
      else "render-drawio:   export \(.status): \(.reason). To export by hand: \(.command)" end)'
  printf '%s' "$result" | jq -r '"render-drawio: icons are read from \(.iconsDir)/ (DoFlow ships none; see docs/reference.md)"'
fi
exit "$rc"
