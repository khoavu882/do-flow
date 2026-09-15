#!/usr/bin/env bash
# render-puml.sh — renders a feature's authored PlantUML sources and projects them into its artifact.
#
# ONE verb doing BOTH derived views, deliberately (035 design R6): reading the source once means the
# committed image and the generated inline block cannot come from different revisions of it. Two
# verbs could, and that drift is what this whole feature exists to remove.
#
# Fail-open, matching render-audit.sh and render-diagrams.sh: no active feature, no design/c4/
# directory, and no renderer are each reported via a note and exit 0. Authoring C4 in PlantUML is
# OPT-IN per feature, so a feature without design/c4/ is not a broken feature -- it is the ordinary
# case, and this verb must say so rather than fail.
#
# Writes ONLY into <feature dir>/design/c4/ and one delimited region of one artifact. It never
# touches design/diagrams/, which is feature 034's ignored render output (035 IC-005).
#
# Usage: render-puml.sh [--slug=<slug>] [--check] [--json]

set -uo pipefail

emit_json=false
check_only=false
slug_override=""
bad_args=()
for a in "$@"; do
  case "$a" in
    --json)   emit_json=true ;;
    --check)  check_only=true ;;
    --slug=*) slug_override="${a#--slug=}" ;;
    *) bad_args+=("$a") ;;
  esac
done

if [ "${#bad_args[@]}" -gt 0 ]; then
  printf 'render-puml: unrecognized argument(s): %s\n' "${bad_args[*]}" >&2
  printf 'usage: render-puml.sh [--slug=<slug>] [--check] [--json]\n' >&2
  exit 2
fi

note() {
  if [ "$emit_json" = true ]; then
    if command -v jq >/dev/null 2>&1; then jq -n --arg n "$1" '{ok:true, written:false, note:$n, rendered:[]}'
    else printf '{"ok":true,"written":false,"note":"%s","rendered":[]}\n' "$1"; fi
  else
    printf 'render-puml: %s (nothing rendered)\n' "$1"
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || note "jq-absent"

script_dir="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$script_dir/do-paths.sh"
[ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/scripts/doflow/bash/do-paths.sh"
[ -f "$RESOLVER" ] || note "resolver-absent"
# Resolved after repo_root below, since the runtime sits beside the repo root in a checkout and
# under <config>/runtime/ in an install -- the resolver is the only thing that knows which.

resolver_args=(--json)
[ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
resolved_json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || note "resolver-error"

repo_root=$(printf '%s' "$resolved_json" | jq -r '.repo_root // empty')
feature_slug=$(printf '%s' "$resolved_json" | jq -r '.feature_slug // empty')
feature_dir=$(printf '%s' "$resolved_json" | jq -r '.feature_dir // empty')

# The projector lives in the JS runtime, not beside the helpers: G12 keeps this repo to one runtime
# implementation, and Python in core/ is how a shadow tree grew the first time, one individually
# defensible module at a time. render-audit.sh already shells out to node for the same reason.
PROJECTOR="$repo_root/src/runtime/c4-project.js"
[ -f "$PROJECTOR" ] || PROJECTOR="${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/runtime/src/runtime/c4-project.js"
design_rel=$(printf '%s' "$resolved_json" | jq -r '.design // empty')
[ -n "$feature_slug" ] || note "no-active-feature"
[ -n "$feature_dir" ] || note "resolver-missing-feature-dir"

src_dir="$repo_root/$feature_dir/design/c4"
# Authoring C4 in PlantUML is opt-in. No directory is the ordinary case, not a failure.
[ -d "$src_dir" ] || note "no design/c4/ directory in $feature_dir — authoring C4 in PlantUML is opt-in, so there is nothing to render"

sources=()
while IFS= read -r f; do sources+=("$f"); done < <(find "$src_dir" -maxdepth 1 -type f -name '*.puml' | sort)
[ "${#sources[@]}" -gt 0 ] || note "no .puml source found in $feature_dir/design/c4"

# Which source feeds design.md's inline block: container when present, else context. Named once so
# --check and the render loop cannot disagree about which source the block is supposed to match.
block_source_for() {
  local pick="" stem
  for f in "$@"; do
    stem="$(basename "${f%.puml}")"
    if [ "$stem" = "container" ]; then pick="$f"; fi
    if [ -z "$pick" ] && [ "$stem" = "context" ]; then pick="$f"; fi
  done
  printf '%s' "$pick"
}

short_hash() { node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,12))' "$1"; }

# ── --check: re-hash and report, rendering and writing nothing (035 IC-004) ──────────────────────
if [ "$check_only" = true ]; then
  stale=()
  for src in "${sources[@]}"; do
    want="$(short_hash "$src")"
    have=""
    [ -f "${src%.puml}.sha" ] && have="$(cat "${src%.puml}.sha")"
    [ "$want" = "$have" ] || stale+=("$(basename "$src")")
  done
  # IC-004 records the revision in BOTH derived outputs, so checking only the .sha sibling checked
  # only the image. The sibling is written inside the renderer-success branch below; the inline
  # block is written by a separate branch that an absent marker pair can skip. They drift apart, and
  # a check that reads one of them reports the other as current without ever having looked at it.
  block_src="$(block_source_for "${sources[@]}")"
  if [ -n "$block_src" ] && [ -n "$design_rel" ] && [ -f "$repo_root/$design_rel" ]; then
    want="$(short_hash "$block_src")"
    have="$(sed -n 's/.*source-hash: \([0-9a-f]*\).*/\1/p' "$repo_root/$design_rel" | head -1)"
    [ "$want" = "$have" ] || stale+=("$(basename "$block_src") -> inline block in $design_rel")
  fi
  if [ "$emit_json" = true ]; then
    printf '%s\n' "${stale[@]:-}" | jq -R . | jq -s \
      --argjson ok "$([ "${#stale[@]}" -eq 0 ] && echo true || echo false)" \
      'map(select(length>0)) | {ok: $ok, checked:true, stale:.}'
  else
    if [ "${#stale[@]}" -eq 0 ]; then printf 'render-puml: every derived output matches its source\n'
    else printf 'render-puml: stale against their source: %s\n' "${stale[*]}"; fi
  fi
  [ "${#stale[@]}" -eq 0 ] || exit 1
  exit 0
fi

have_renderer=true
command -v plantuml >/dev/null 2>&1 || have_renderer=false

block_src="$(block_source_for "${sources[@]}")"
rendered=(); failures=0; projected=""
for src in "${sources[@]}"; do
  stem="$(basename "${src%.puml}")"
  digest="$(short_hash "$src")"

  if [ "$have_renderer" = true ]; then
    if plantuml -tpng -o "$src_dir" "$src" >/dev/null 2>&1; then
      printf '%s\n' "$digest" > "${src%.puml}.sha"
      rendered+=("$feature_dir/design/c4/$stem.png")
    else
      failures=$((failures + 1))
      printf 'render-puml: renderer failed on %s\n' "$stem.puml" >&2
    fi
  fi

  # One source feeds design.md §2's inline block; the others render only to images.
  if [ "$src" = "$block_src" ]; then
    if ! block="$(node "$PROJECTOR" "$src" 2>&1)"; then
      printf 'render-puml: %s\n' "$block" >&2
      exit 1
    fi
    projected="$block"
  fi
done

[ "$have_renderer" = true ] || note "PlantUML not found. Run 'doflow tools' for the install command registered for this machine (on Homebrew: brew install plantuml), or 'doflow doctor'. The sources were left unrendered."

# ── Replace the delimited region of the artifact (035 IC-004, RK3) ───────────────────────────────
# The one operation here that can destroy authored prose. Two guards: an artifact whose markers are
# absent is REPORTED and left untouched rather than repaired by guess, and the rewrite goes through
# a temp file moved into place -- the same pattern render-audit.sh uses, for the same reason.
block_written=false
if [ -n "$projected" ] && [ -n "$design_rel" ] && [ -f "$repo_root/$design_rel" ]; then
  target="$repo_root/$design_rel"
  if grep -q '<!-- generated from' "$target" && grep -q '<!-- end generated -->' "$target"; then
    tmp="$(mktemp "${target}.XXXXXX")" || note "mktemp-failed"
    trap 'rm -f "$tmp"' EXIT
    # Two corrections a review found here. The end offset added the CLOSE marker's length PLUS a
    # newline unconditionally, so whenever the marker was not followed by one it ate the next
    # character instead -- and because the character it ate first was the newline, every later run
    # ate another. It had already demoted this feature's own "### C4 Level 3" heading to "##" and
    # glued it to the marker. And CLOSE is now searched FROM start, so a close marker sitting before
    # the open one reads as absent rather than duplicating everything between them.
    if node -e '
      const fs = require("node:fs");
      const [target, tmp, block] = process.argv.slice(1);
      const OPEN = "<!-- generated from";
      const CLOSE = "<!-- end generated -->";
      const text = fs.readFileSync(target, "utf8");
      const start = text.indexOf(OPEN);
      const closeAt = start === -1 ? -1 : text.indexOf(CLOSE, start);
      if (closeAt === -1) {
        process.stderr.write("generated-block markers are absent or out of order\n");
        process.exit(1);
      }
      const afterClose = closeAt + CLOSE.length;
      const end = afterClose + (text[afterClose] === "\n" ? 1 : 0);
      fs.writeFileSync(tmp, text.slice(0, start) + block + text.slice(end));
    ' "$target" "$tmp" "$projected" && [ -s "$tmp" ]; then
      mv "$tmp" "$target"; block_written=true
    else
      rm -f "$tmp"
      failures=$((failures + 1))
      printf 'render-puml: rewriting %s failed; it was left untouched\n' "$design_rel" >&2
    fi
  else
    printf 'render-puml: %s carries no generated-block markers; it was left untouched\n' "$design_rel" >&2
  fi
fi

if [ "$emit_json" = true ]; then
  printf '%s\n' "${rendered[@]:-}" | jq -R . | jq -s \
    --argjson failures "$failures" --arg dir "$feature_dir/design/c4" --argjson block "$([ "$block_written" = true ] && echo true || echo false)" \
    'map(select(length>0)) | {ok: ($failures==0), written: (length>0), dir: $dir, blockWritten: $block, failures: $failures, rendered: .}'
else
  printf 'render-puml: %s source(s) rendered into %s; inline block %s\n' "${#rendered[@]}" "$feature_dir/design/c4" "$([ "$block_written" = true ] && echo written || echo 'not written')"
fi

[ "$failures" -eq 0 ] || exit 1
exit 0
