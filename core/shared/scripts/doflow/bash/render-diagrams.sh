#!/usr/bin/env bash
# render-diagrams.sh — renders a chain artifact's fenced mermaid blocks to image files.
#
# A FAITHFUL render: the same nodes, the same edges, the same labels. The committed markdown is the
# only source of truth and is never modified, and no fenced block anywhere carries a theme
# directive — styling is supplied at render time from assets/mermaid-theme.json, so the source an
# author wrote is the source a reviewer diffs.
#
# Fail-open, matching render-audit.sh's own convention: a missing renderer, no active feature, and
# an artifact carrying no diagram are each reported via a note and exit 0 — never a hard error. This
# verb sits OUTSIDE the chain (034 FR-011: user-invoked only, never a stage), so an absent optional
# capability must never read as a broken run. Exit 1 is reserved for a renderer that ran and failed.
#
# Usage: render-diagrams.sh [--slug=<slug>] [--artifact=<path>] [--format=png|svg] [--json]
#   No --slug     → resolve the active feature via do-paths.sh, exactly like render-audit.sh.
#   No --artifact → every chain artifact in the feature dir that contains a fenced mermaid block.

set -uo pipefail

emit_json=false
slug_override=""
artifact_override=""
format="png"
bad_args=()
for a in "$@"; do
  case "$a" in
    --json)       emit_json=true ;;
    --slug=*)     slug_override="${a#--slug=}" ;;
    --artifact=*) artifact_override="${a#--artifact=}" ;;
    --format=*)   format="${a#--format=}" ;;
    *) bad_args+=("$a") ;;
  esac
done

# An unrecognized argument is a hard failure naming it, never a silent fall-through: the
# space-separated `--slug value` form would otherwise render the ACTIVE feature instead of the one
# the caller named, with no signal. Same reasoning, same handling, as render-audit.sh.
if [ "${#bad_args[@]}" -gt 0 ]; then
  printf 'render-diagrams: unrecognized argument(s): %s\n' "${bad_args[*]}" >&2
  printf 'usage: render-diagrams.sh [--slug=<slug>] [--artifact=<path>] [--format=png|svg] [--json]\n' >&2
  exit 2
fi
case "$format" in
  png|svg) ;;
  *) printf 'render-diagrams: --format must be png or svg, got: %s\n' "$format" >&2; exit 2 ;;
esac

# Fail-open note: report and exit 0. Nothing downstream may treat an absent capability as failure.
note() {
  if [ "$emit_json" = true ]; then
    if command -v jq >/dev/null 2>&1; then
      jq -n --arg n "$1" '{ok:true, written:false, note:$n, rendered:[]}'
    else
      printf '{"ok":true,"written":false,"note":"%s","rendered":[]}\n' "$1"
    fi
  else
    printf 'render-diagrams: %s (nothing rendered)\n' "$1"
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || note "jq-absent"

script_dir="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$script_dir/do-paths.sh"
[ -f "$RESOLVER" ] || RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
[ -f "$RESOLVER" ] || note "resolver-absent"

# The theme sits beside this script's own tree, not in the repo being rendered.
THEME="$script_dir/../assets/mermaid-theme.json"

resolver_args=(--json)
[ -n "$slug_override" ] && resolver_args+=("--slug=$slug_override")
resolved_json=$(bash "$RESOLVER" "${resolver_args[@]}" 2>/dev/null) || note "resolver-error"

repo_root=$(printf '%s' "$resolved_json" | jq -r '.repo_root // empty')
feature_slug=$(printf '%s' "$resolved_json" | jq -r '.feature_slug // empty')
feature_dir=$(printf '%s' "$resolved_json" | jq -r '.feature_dir // empty')
[ -n "$feature_slug" ] || note "no-active-feature"
[ -n "$feature_dir" ] || note "resolver-missing-feature-dir"

# The renderer is an OPTIONAL dependency, deliberately absent from package.json (034 FR-012): a
# user who never renders a diagram never pays for a headless browser download. Its absence is
# reported with the way to get it, and is not a failure.
command -v mmdc >/dev/null 2>&1 || note "mermaid renderer not found. Install with: npm install -g @mermaid-js/mermaid-cli (or run: doflow doctor)"

# The theme is REQUIRED, not best-effort (034 FR-014): the render must apply the diagram-design
# roles, so an absent asset is reported rather than silently producing default-styled output. It
# fails open exactly as the absent renderer above does -- a note and exit 0 -- because this verb
# sits outside the chain and a missing shipped asset is a broken install, not a broken run. The
# earlier form appended `-c` only when the file happened to exist, which meant a reinstall gone
# wrong rendered unthemed images and reported ok:true with failures:0 and nothing on stderr.
[ -f "$THEME" ] || note "theme asset missing at $THEME. The render would not apply the DoFlow diagram theme, so it was not attempted. Reinstall the scripts tree: npx @khoavu882/doflow install"

out_dir="$repo_root/$feature_dir/design/diagrams"

# Collect the artifacts to scan. A named --artifact wins; otherwise every markdown file in the
# feature dir, in a stable order so block indices are reproducible across runs.
artifacts=()
if [ -n "$artifact_override" ]; then
  candidate="$artifact_override"
  [ -f "$candidate" ] || candidate="$repo_root/$artifact_override"
  [ -f "$candidate" ] || { printf 'render-diagrams: no such artifact: %s\n' "$artifact_override" >&2; exit 2; }
  artifacts+=("$candidate")
else
  while IFS= read -r f; do artifacts+=("$f"); done < <(find "$repo_root/$feature_dir" -type f -name '*.md' -not -path '*/diagrams/*' | sort)
fi
[ "${#artifacts[@]}" -gt 0 ] || note "no markdown artifacts found under $feature_dir"

tmpdir="$(mktemp -d 2>/dev/null)" || note "mktemp-failed"
trap 'rm -rf "$tmpdir"' EXIT

rendered=()
failures=0
total_blocks=0

for artifact in "${artifacts[@]}"; do
  stem="$(basename "$artifact")"; stem="${stem%.md}"

  # Extract each fenced mermaid block to its own file, numbered from 01 in DOCUMENT ORDER. Index,
  # not heading text, is the identity: a heading is free prose that can change without the diagram
  # changing, which would silently rename an output file.
  count=$(awk -v outdir="$tmpdir" -v stem="$stem" '
    /^[[:space:]]*```mermaid[[:space:]]*$/ && !inblock { inblock=1; n++; f=sprintf("%s/%s-%02d.mmd", outdir, stem, n); next }
    inblock && /^[[:space:]]*```[[:space:]]*$/ { inblock=0; close(f); next }
    inblock { print >> f }
    END { print n+0 }
  ' "$artifact")

  [ "$count" -gt 0 ] 2>/dev/null || continue
  total_blocks=$((total_blocks + count))
  mkdir -p "$out_dir" || note "cannot create $out_dir"

  i=1
  while [ "$i" -le "$count" ]; do
    nn=$(printf '%02d' "$i")
    src="$tmpdir/$stem-$nn.mmd"
    dest="$out_dir/$stem-$nn.$format"
    # -s 2 renders PNG at twice device scale so it stays sharp projected; ignored for svg.
    mmdc_args=(-i "$src" -o "$dest" -b "#f5f5f5" -c "$THEME")
    [ "$format" = "png" ] && mmdc_args+=(-s 2)
    if mmdc "${mmdc_args[@]}" >/dev/null 2>&1; then
      rendered+=("$feature_dir/design/diagrams/$stem-$nn.$format")
    else
      failures=$((failures + 1))
      printf 'render-diagrams: renderer failed on %s block %s\n' "$(basename "$artifact")" "$nn" >&2
    fi
    i=$((i + 1))
  done
done

[ "$total_blocks" -gt 0 ] || note "no fenced mermaid block found in the artifacts scanned"

# The output directory excludes its own contents, in any host project, whether or not that project
# ignores agent-docs/. `!.gitignore` keeps the rule itself trackable so it becomes durable once
# committed. The installer manages no ignore rules, so the verb owns this.
if [ -d "$out_dir" ] && [ ! -f "$out_dir/.gitignore" ]; then
  printf '*\n!.gitignore\n' > "$out_dir/.gitignore"
fi

if [ "$emit_json" = true ]; then
  printf '%s\n' "${rendered[@]:-}" | jq -R . | jq -s \
    --argjson failures "$failures" --argjson blocks "$total_blocks" --arg dir "$feature_dir/design/diagrams" \
    'map(select(length > 0)) | {ok: ($failures == 0), written: (length > 0), dir: $dir, blocks: $blocks, failures: $failures, rendered: .}'
else
  printf 'render-diagrams: %s of %s block(s) rendered into %s\n' "${#rendered[@]}" "$total_blocks" "$feature_dir/design/diagrams"
  for r in "${rendered[@]:-}"; do [ -n "$r" ] && printf '  %s\n' "$r"; done
fi

[ "$failures" -eq 0 ] || exit 1
exit 0
