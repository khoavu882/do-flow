#!/usr/bin/env bash
# verify-paths-refactor.sh — Stage 3 acceptance gate.
#
# For EACH of the 8 harness ids x BOTH scopes (project / user), installs once from the baseline
# checkout (default /tmp/b1-base, a worktree of origin/develop) and once from THIS checkout into
# two fresh sandboxes under /tmp/b1-*/, then compares:
#   1. the NATIVE installed trees recursively (everything except .doflow/) — must be identical;
#      where an installed file legitimately embeds its own absolute install path (a known,
#      pre-existing nondeterminism — e.g. Antigravity's hooks.json command), a second pass
#      compares bytes with the sandbox roots normalized away, reported separately;
#   2. the .doflow/state ledger resource fingerprints — sorted (kind, ownershipIdentity,
#      fingerprint) tuples must match, with sandbox-root prefixes normalized (fingerprints cover
#      file CONTENT; see above). Manifest-level fields that embed source commit SHAs are not part
#      of the compared tuples and so cannot false-fail across different HEADs.
#
# Usage: bash scripts/verify-paths-refactor.sh [baseline-checkout]
# Exit 0 iff every cell passes. All sandboxes live under /tmp/b1-*; never touches $HOME.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
BASE="${1:-${DOFLOW_BASE_CHECKOUT:-/tmp/b1-base}}"
WORK="${DOFLOW_VERIFY_WORK:-/tmp/b1-verify}"
HARNESSES=(claude codex gemini opencode pi copilot kiro antigravity)
SCOPES=(project user)

if [ ! -x "$BASE/bin/doflow.js" ]; then
  echo "FAIL: baseline checkout not usable at '$BASE' (git worktree add /tmp/b1-base origin/develop)" >&2
  exit 2
fi

rm -rf "$WORK"
mkdir -p "$WORK"

pass=0; fail=0; normalized_cells=""

# Relative file list of everything EXCEPT neutral state and installer bookkeeping, sorted.
# Excluded: .doflow/ (compared separately as ledger tuples below) and .claude/.install-manifest.json
# — the legacy install manifest records source_path (checkout location), source_commit (HEAD SHA)
# and wall-clock timestamps, i.e. exactly the manifest fields this gate is told to exclude.
list_tree() {
  (cd "$1" && find . -path ./.doflow -prune -o -path './.claude/.install-manifest.json' -prune -o -type f -print | sort)
}

# Compare every listed file's bytes; returns 0 when all equal after substituting $2/$3 -> @ROOT@.
diff_normalized() { # <list-file> <rootA> <rootB>
  local list="$1" rootA="$2" rootB="$3" file
  while IFS= read -r file; do
    if ! cmp -s <(sed "s|$rootA|@ROOT@|g" "$rootA/$file") <(sed "s|$rootB|@ROOT@|g" "$rootB/$file"); then
      echo "    first differing file: $file"
      return 1
    fi
  done < "$list"
  return 0
}

# Compare two ledgers' owned-resource tuples: (kind, ownershipIdentity, fingerprint), sorted.
# Two escape hatches, both pre-existing nondeterminism rather than refactor drift:
#   - runtime.* asset rows are excluded: they project DoFlow's OWN sources into .doflow/runtime/,
#     so their fingerprints differ iff the implementation differs — the change under test itself
#     (the same class as source-commit SHAs).
#   - a differing fingerprint passes when the row's TARGET file bytes are identical after
#     substituting each sandbox root (content may embed its own absolute install path — e.g.
#     Antigravity's hooks.json command — so the CONTENT hashes differ while being equivalent).
ledger_compare() { # <ledgerA> <rootA> <ledgerB> <rootB>
  node -e '
    const fs = require("fs");
    const [fileA, rootA, fileB, rootB] = process.argv.slice(1);
    const load = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")).resources || [];
      } catch { return null; }
    };
    const ra = load(fileA); const rb = load(fileB);
    if (!ra || !rb) { console.log("MISMATCH unreadable ledger"); process.exit(0); }
    const keep = (r) => !String(r.assetId ?? "").startsWith("runtime.");
    const norm = (s, root) => String(s).split(root).join("@ROOT@");
    const index = (rows, root) => {
      const map = new Map();
      for (const r of rows.filter(keep)) {
        map.set(`${r.kind ?? ""}\u0000${r.ownershipIdentity ?? ""}`,
          { fingerprint: String(r.fingerprint ?? ""), target: r.target ?? null });
      }
      return map;
    };
    const ma = index(ra, rootA); const mb = index(rb, rootB);
    const problems = [];
    for (const [key] of ma) if (!mb.has(key)) problems.push(`only in baseline: ${JSON.stringify(key)}`);
    for (const [key] of mb) if (!ma.has(key)) problems.push(`only in branch: ${JSON.stringify(key)}`);
    for (const [key, va] of ma) {
      const vb = mb.get(key);
      if (!vb) continue;
      if (va.fingerprint === vb.fingerprint) continue;
      let equivalent = false;
      if (va.target && vb.target) {
        try {
          const ba = fs.readFileSync(va.target).toString().split(rootA).join("@ROOT@");
          const bb = fs.readFileSync(vb.target).toString().split(rootB).join("@ROOT@");
          equivalent = ba === bb;
        } catch { equivalent = false; }
      }
      if (!equivalent) problems.push(`fingerprint differs for ${JSON.stringify(key)}: ${va.fingerprint} vs ${vb.fingerprint}`);
    }
    if (problems.length === 0) console.log("MATCH");
    else console.log("MISMATCH\n  " + problems.slice(0, 8).join("\n  "));
  ' "$1" "$2" "$3" "$4"
}

run_install() { # <cli> <scope> <harness> <projdir> <home>
  local cli="$1" scope="$2" id="$3" proj="$4" home="$5"
  if [ "$scope" = project ]; then
    (cd "$REPO_ROOT" && HOME="$home" DOFLOW_CLI="$cli" node "$cli" install "$proj" -f --no-backup -t "$id" >/dev/null 2>"$home.err")
  else
    (cd "$REPO_ROOT" && HOME="$home" DOFLOW_CLI="$cli" node "$cli" install -g -f --no-backup -t "$id" >/dev/null 2>"$home.err")
  fi
}

printf '%-12s %-8s %-8s %-8s\n' HARNESS SCOPE TREE LEDGER
for id in "${HARNESSES[@]}"; do
  for scope in "${SCOPES[@]}"; do
    cell="${id}-${scope}"
    A="$WORK/a-$cell"; B="$WORK/b-$cell"
    rm -rf "$A" "$B"
    mkdir -p "$A/proj" "$A/home" "$B/proj" "$B/home"

    run_install "$BASE/bin/doflow.js" "$scope" "$id" "$A/proj" "$A/home" || true
    run_install "$REPO_ROOT/bin/doflow.js" "$scope" "$id" "$B/proj" "$B/home" || true

    if [ "$scope" = project ]; then rootA="$A/proj"; rootB="$B/proj"; else rootA="$A/home"; rootB="$B/home"; fi

    tree_status="FAIL"; ledger_status="FAIL"; note=""
    list_tree "$rootA" > "$A.list"; list_tree "$rootB" > "$B.list"

    # Same set of native files?
    if cmp -s "$A.list" "$B.list"; then
      # Raw byte identity first; fall back to root-normalized bytes.
      raw_ok=1
      while IFS= read -r f; do
        if ! cmp -s "$rootA/$f" "$rootB/$f"; then raw_ok=0; break; fi
      done < "$A.list"
      if [ "$raw_ok" = 1 ]; then
        tree_status="PASS"
      elif diff_normalized "$A.list" "$rootA" "$rootB"; then
        tree_status="PASS*"; note="abs-path-normalized"
      fi
    else
      echo "    $cell: differing native file sets:"
      diff "$A.list" "$B.list" | head -10 | sed 's/^/      /'
    fi

    if [ "$(ledger_compare "$rootA/.doflow/state/ledger.json" "$rootA" "$rootB/.doflow/state/ledger.json" "$rootB")" = MATCH ]; then
      ledger_status="PASS"
    fi

    if [ "$tree_status" != FAIL ] && [ "$ledger_status" = PASS ]; then
      pass=$((pass+1))
      printf '%-12s %-8s %-8s %-8s%s\n' "$id" "$scope" "$tree_status" "$ledger_status" "${note:+ ($note)}"
      [ -n "$note" ] && normalized_cells="$normalized_cells $cell"
    else
      fail=$((fail+1))
      printf '%-12s %-8s %-8s %-8s\n' "$id" "$scope" "$tree_status" "$ledger_status"
    fi
    rm -f "$A.list" "$B.list" "$A/home.err" "$B/home.err"
  done
done

echo
echo "cells: $pass passed, $fail failed (of $(( ${#HARNESSES[@]} * ${#SCOPES[@]} )))"
if [ -n "$normalized_cells" ]; then
  echo "cells passing only with sandbox-root normalization (installed bytes embed their own absolute"
  echo "install path — pre-existing behavior, identical modulo the root):$normalized_cells"
fi
[ "$fail" = 0 ]
