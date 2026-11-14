#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# render-page.sh — writes one self-contained HTML page from a feature's chain documents.
#
# The page carries the requirement, design, interface contracts, data model, plan, decisions, state
# and audit that exist for the feature, in that order, with a contents list and its diagrams. The
# markdown stays the only source of truth and is never modified; the page is a projection for a
# reader who wants the feature in a browser, with no server and no harness running.
#
# Diagrams (--diagrams):
#   auto    inline when the mermaid renderer (mmdc) is on PATH, source otherwise. The default.
#   inline  each mermaid block rendered with assets/mermaid-theme.json and embedded in the page.
#           Without the renderer this is source, with a note, as for auto.
#   cdn     the page loads Mermaid from jsDelivr when it is opened, one file checked against a pinned
#           hash. It needs the network then and runs Mermaid over document text, so it is only ever
#           chosen by the caller.
#   source  each block shown as text.
#
# Fail-open, matching render-diagrams.sh: no active feature, no resolver, no document and no renderer
# are each reported via a note and exit 0. This verb sits outside the chain (user-invoked only, never a
# stage). Exit 1 is a renderer that ran and failed on a block (the page is still written, with that
# block as source), or the projector itself failing (nothing written; under --json an error object).
#
# Usage: render-page.sh [--slug=<slug>] [--out=<file>] [--diagrams=auto|inline|cdn|source] [--json]
#   No --slug → resolve the active feature via do-paths.sh, exactly like render-audit.sh.
#   No --out  → <feature dir>/page.html

set -uo pipefail

emit_json=false
slug_override=""
out_override=""
diagrams="auto"
bad_args=()
for a in "$@"; do
  case "$a" in
    --json)       emit_json=true ;;
    --slug=*)     slug_override="${a#--slug=}" ;;
    --out=*)      out_override="${a#--out=}" ;;
    --diagrams=*) diagrams="${a#--diagrams=}" ;;
    *) bad_args+=("$a") ;;
  esac
done

# An unrecognized argument is a hard failure naming it: the space-separated `--slug value` form would
# otherwise render the ACTIVE feature instead of the one the caller named. Same as render-diagrams.sh.
if [ "${#bad_args[@]}" -gt 0 ]; then
  printf 'render-page: unrecognized argument(s): %s\n' "${bad_args[*]}" >&2
  printf 'usage: render-page.sh [--slug=<slug>] [--out=<file>] [--diagrams=auto|inline|cdn|source] [--json]\n' >&2
  exit 2
fi
case "$diagrams" in
  auto|inline|cdn|source) ;;
  *) printf 'render-page: --diagrams must be auto, inline, cdn or source, got: %s\n' "$diagrams" >&2; exit 2 ;;
esac

# Fail-open note: report and exit 0. Nothing downstream may treat an absent capability as failure.
note() {
  if [ "$emit_json" = true ]; then
    if command -v jq >/dev/null 2>&1; then
      jq -n --arg n "$1" '{ok:true, written:false, note:$n, documents:[]}'
    else
      printf '{"ok":true,"written":false,"note":"%s","documents":[]}\n' "$1"
    fi
  else
    printf 'render-page: %s (nothing written)\n' "$1"
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || note "jq-absent"
command -v node >/dev/null 2>&1 || note "node-absent"

script_dir="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$script_dir/do-paths.sh"
[ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
[ -f "$RESOLVER" ] || note "resolver-absent"

# The theme sits beside this script's own tree, not in the repo being rendered.
THEME="$script_dir/../assets/mermaid-theme.json"

resolver_args=(--json)
[ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
rc=0; resolved_json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || rc=$?
# An unsafe slug is refused, not noted: exit 2 with the resolver's error object (IC-009).
if [ "$rc" -eq 2 ] && [ "$(printf '%s' "$resolved_json" | jq -r '.error // empty' 2>/dev/null)" = "invalid-slug" ]; then
  if [ "$emit_json" = true ]; then printf '%s\n' "$resolved_json"; else printf 'render-page: %s\n' "$(printf '%s' "$resolved_json" | jq -r '.message')" >&2; fi
  exit 2
fi
[ "$rc" -eq 0 ] || note "resolver-error"

repo_root=$(printf '%s' "$resolved_json" | jq -r '.repo_root // empty')
feature_root=$(printf '%s' "$resolved_json" | jq -r '.feature_root // empty')
[ -n "$feature_root" ] || feature_root="$repo_root"
feature_slug=$(printf '%s' "$resolved_json" | jq -r '.feature_slug // empty')
feature_dir=$(printf '%s' "$resolved_json" | jq -r '.feature_dir // empty')
[ -n "$feature_slug" ] || note "no-active-feature"
[ -n "$feature_dir" ] || note "resolver-missing-feature-dir"

# The projector lives in the JS runtime, not beside the helpers (G12: one runtime implementation);
# render-puml.sh reaches c4-project.ts the same way.
PROJECTOR="$repo_root/src/runtime/page-project.ts"
[ -f "$PROJECTOR" ] || PROJECTOR="${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/runtime/src/runtime/page-project.ts"
[ -f "$PROJECTOR" ] || note "page projector not found at $PROJECTOR. Reinstall the runtime: npx @khoavu882/doflow install"

node_args=("$PROJECTOR" --paths "$resolved_json" --root "$feature_root" --diagrams "$diagrams" --theme "$THEME")
[ -n "$out_override" ] && node_args+=(--out "$out_override")

proj_err="$(mktemp 2>/dev/null)" || note "mktemp-failed"
trap 'rm -f "$proj_err"' EXIT
rc=0; result=$(node "${node_args[@]}" 2>"$proj_err") || rc=$?
# Exit 1 with a result is a page written with a block the renderer failed on; anything else without
# a result is the projector itself failing, which is reported as it is.
if [ -z "$result" ] || ! printf '%s' "$result" | jq -e . >/dev/null 2>&1; then
  message="the page projector failed: $(tr '\n' ' ' < "$proj_err")"
  if [ "$emit_json" = true ]; then jq -n --arg m "$message" '{ok:false, written:false, error:"projector-failed", message:$m, documents:[]}'
  else printf 'render-page: %s\n' "$message" >&2; fi
  exit 1
fi

if [ "$emit_json" = true ]; then
  printf '%s\n' "$result"
else
  if [ "$(printf '%s' "$result" | jq -r '.written')" = "true" ]; then
    printf '%s' "$result" | jq -r '"render-page: \(.documents | length) document(s), \(.diagrams.blocks) diagram(s) (\(.diagrams.mode)\(if .diagrams.failures > 0 then ", \(.diagrams.failures) failed" else "" end)) written to \(.file)"'
  else
    printf 'render-page: %s (nothing written)\n' "$(printf '%s' "$result" | jq -r '.note // "nothing to render"')"
  fi
  printf '%s' "$result" | jq -r 'select(.written and .note) | "render-page: \(.note)"'
fi
exit "$rc"
