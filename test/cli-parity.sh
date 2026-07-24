#!/usr/bin/env bash
# cli-parity.sh — THE gate for porting a destructive installer. Installs BOTH sync-legacy.sh and
# doflow into scratch $HOMEs and diffs the resulting file trees. sync-legacy.sh uses $HOME/.<tool>,
# so overriding $HOME redirects both tools to the scratch dir.
#
# Phase E.3 note: bin/sync.sh is now a thin deprecation shim delegating to doflow.js — comparing
# doflow against a shim that just calls doflow would be a meaningless self-check. This harness
# targets bin/sync-legacy.sh, the preserved original bash implementation, which is the actual
# independent reference doflow was ported from and must keep matching.
#
# Phase A: compares the deployed file SET for `install` (excludes .install-manifest.json,
# which doflow writes in a later phase). Phase B extends this to backups, manifest, and perms.
#
# .claude.json is also excluded from the tree diff: doflow's selectable-MCP feature (src/mcp.js)
# merges MCP server config into $HOME/.claude.json (the location Claude Code actually reads MCP
# servers from), which sync-legacy.sh has no equivalent of and never writes. This is a deliberate
# improvement beyond parity, not a bug the tree diff should catch.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNC="$ROOT/bin/sync-legacy.sh"
DOFLOW="$ROOT/bin/doflow.js"
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }

tree() { ( cd "$1" 2>/dev/null && find . -type f ! -name '.install-manifest.json' ! -name '.claude.json' 2>/dev/null | sort ); }

# The neutral lifecycle ledger/recovery journal (src/state) has no sync-legacy.sh equivalent for
# ANY harness — Claude, Codex, and Gemini all now reconcile native resources through it. Strip it
# unconditionally before any tree diff, the same way core/CLAUDE.md's CLAUDE.md-only content diff
# is deliberately out of scope for this file-SET comparison.
tree_without_neutral_state() {
  tree "$1" | sed '/^\.\/\.doflow\/state\/ledger\.json$/d;/^\.\/\.doflow\/state\/recovery\/recovery_.*\.json$/d'
}

# Codex custom agents are a native lifecycle projection with no equivalent in sync-legacy.sh.
# They are deliberately excluded only after being verified against the source projection; every
# other installed path remains in the strict legacy-vs-CLI tree comparison below.
codex_native_projection_paths() {
  ( cd "$ROOT/core/harnesses/codex/agents" && find . -maxdepth 1 -type f -name '*.toml' -printf './.codex/agents/%f\n' )
  printf '%s\n' './.codex/config.toml' './.codex/hooks.json'
  printf '%s\n' pre-implement-gate.sh session-end.sh session-start.sh stop-check.sh subagent-audit.sh user-prompt-submit.sh mcp-tool-guard.sh pre-bash-guard.sh \
    session-end.impl.sh session-start.impl.sh stop-check.impl.sh subagent-audit.impl.sh user-prompt-submit.impl.sh \
    lib.sh blocked-patterns.conf mcp-policy.conf | sed 's#^#./.codex/hooks/#'
}

# GEMINI.md is a native lifecycle projection too (src/adapters/gemini) — sync-legacy.sh (and the
# now-trimmed mappings.conf [gemini] section) has no instructions-file mapping for Gemini at all.
gemini_native_projection_paths() { printf '%s\n' './.gemini/GEMINI.md'; }

# Build the combined set of native-projection paths expected only in doflow's tree, for whichever
# harnesses are actually in $TGT, then diff against sync-legacy's tree with the neutral state
# stripped from both sides of the comparison ($1) up front.
tree_without_native_projections() {
  local root="$1" tgt="$2" expected=""
  if [[ ",$tgt," == *,codex,* ]]; then expected="$expected
$(codex_native_projection_paths)"; fi
  if [[ ",$tgt," == *,gemini,* ]]; then expected="$expected
$(gemini_native_projection_paths)"; fi
  comm -23 <(tree_without_neutral_state "$root") <(printf '%s\n' "$expected" | sed '/^$/d' | sort)
}

verify_codex_native_projection() {
  local home="$1" source_file destination_file recovery
  while IFS= read -r source_file; do
    destination_file="$home/.codex/agents/$(basename "$source_file")"
    cmp -s "$source_file" "$destination_file" || return 1
  done < <(find "$ROOT/core/harnesses/codex/agents" -maxdepth 1 -type f -name '*.toml' | sort)
  grep -q '^hooks = true$' "$home/.codex/config.toml" || return 1
  for source_file in context7 sequential-thinking chrome-devtools playwright; do grep -q "^\[mcp_servers\.$source_file\]" "$home/.codex/config.toml" || return 1; done
  cmp -s "$ROOT/core/harnesses/codex/hooks/hooks.json" "$home/.codex/hooks.json" || return 1
  for source_file in pre-implement-gate.sh session-end.sh session-start.sh stop-check.sh subagent-audit.sh user-prompt-submit.sh mcp-tool-guard.sh pre-bash-guard.sh \
      session-end.impl.sh session-start.impl.sh stop-check.impl.sh subagent-audit.impl.sh user-prompt-submit.impl.sh \
      lib.sh blocked-patterns.conf mcp-policy.conf; do cmp -s "$ROOT/core/harnesses/codex/hooks/$source_file" "$home/.codex/hooks/$source_file" || return 1; done
  jq -e '.version == 1 and .targets.codex.installed == true and ([.resources[] | select(.harness == "codex")] | length > 0)' "$home/.doflow/state/ledger.json" >/dev/null || return 1
  recovery="$(find "$home/.doflow/state/recovery" -maxdepth 1 -type f -name 'recovery_*.json' | head -1)"
  [ -n "$recovery" ] && jq -e '.version == 1 and .status == "verified" and (.changes | length > 0)' "$recovery" >/dev/null
}

verify_gemini_native_projection() {
  local home="$1"
  grep -q '<!-- doflow:start -->' "$home/.gemini/GEMINI.md" 2>/dev/null || return 1
  grep -q '<!-- doflow:end -->' "$home/.gemini/GEMINI.md" 2>/dev/null || return 1
  jq -e '.version == 1 and .targets.gemini.installed == true and ([.resources[] | select(.harness == "gemini")] | length > 0)' "$home/.doflow/state/ledger.json" >/dev/null
}

for TGT in claude codex gemini "claude,codex,gemini"; do
  H1="$(mktemp -d)"; H2="$(mktemp -d)"
  # sync.sh is global-only; doflow defaults to project-scoped, so -g/--global is required here
  # to compare the same thing (see agent-docs/design_doflow-cli.md §11).
  HOME="$H1" bash "$SYNC"   --install --force --no-backup --target "$TGT" >/dev/null 2>&1
  HOME="$H2" node "$DOFLOW" install -g --force --no-backup --target "$TGT" >/dev/null 2>&1
  ok=1
  if [[ ",$TGT," == *,codex,* ]]; then verify_codex_native_projection "$H2" || ok=0; fi
  if [[ ",$TGT," == *,gemini,* ]]; then verify_gemini_native_projection "$H2" || ok=0; fi
  if [ "$ok" -eq 1 ]; then
    d="$(diff <(tree_without_neutral_state "$H1") <(tree_without_native_projections "$H2" "$TGT") 2>&1)"
  else
    d='Native lifecycle projection is missing or differs from its registry source'
  fi
  if [ -z "$d" ]; then
    n="$(tree "$H1" | wc -l | tr -d ' ')"
    pass "install --target $TGT : file-set parity ($n files)"
  else
    fail "install --target $TGT : trees differ"
    printf '%s\n' "$d" | head -25 | sed 's/^/      /'
  fi
  rm -rf "$H1" "$H2"
done

echo ""
echo "[Phase B] backup + manifest + perms parity (--target claude, real backup on)"

# Backup dir names are timestamp-based (<op>_YYYY-MM-DD_HH-MM-SS) so they legitimately differ
# between the two runs — tree()-style exact-path diffing doesn't apply here. Compare structure
# and content instead, ignoring known-volatile fields (timestamps, backup ids).
H3="$(mktemp -d)"; H4="$(mktemp -d)"
HOME="$H3" bash "$SYNC"   --install --force --target claude >/dev/null 2>&1
HOME="$H4" node "$DOFLOW" install -g --force --target claude >/dev/null 2>&1

# 1. manifest content parity, ignoring fields that are legitimately different between the two
# tools: last_run/source_commit/last_backup_id/last_updated (timestamps/ids), and script_version
# (sync.sh v1.0.0 and doflow's package.json v0.1.0 are independently-versioned by design, not a
# shared field — forcing them equal would mean faking one tool's version to match the other's).
strip_manifest() { jq -S 'del(.last_run, .source_commit, .last_backup_id, .script_version, .mcp_servers) | .tools |= map_values(del(.last_updated))' "$1" 2>/dev/null; }
M1="$(strip_manifest "$H3/.claude/.install-manifest.json")"
M2="$(strip_manifest "$H4/.claude/.install-manifest.json")"
if [ -n "$M1" ] && [ "$M1" = "$M2" ]; then
  pass "manifest content parity (last_operation/source_path/tools keys; script_version+timestamps ignored by design)"
else
  fail "manifest content differs"
  diff <(printf '%s' "$M1") <(printf '%s' "$M2") | head -20 | sed 's/^/      /'
fi

# 2. backup structure parity: exactly one install_* backup dir, each containing claude.tar.gz,
#    and the tarball contents match when extracted (ignoring the backup id in the dir name itself).
B1="$(find "$H3/.claude/backups" -maxdepth 1 -type d -name 'install_*' 2>/dev/null)"
B2="$(find "$H4/.claude/backups" -maxdepth 1 -type d -name 'install_*' 2>/dev/null)"
if [ -n "$B1" ] && [ -n "$B2" ] && [ -f "$B1/claude.tar.gz" ] && [ -f "$B2/claude.tar.gz" ]; then
  E1="$(mktemp -d)"; E2="$(mktemp -d)"
  tar -xzf "$B1/claude.tar.gz" -C "$E1"; tar -xzf "$B2/claude.tar.gz" -C "$E2"
  bd="$(diff <(cd "$E1" && find . -type f | sort) <(cd "$E2" && find . -type f | sort) 2>&1)"
  if [ -z "$bd" ]; then pass "backup tarball content parity (claude.tar.gz)"; else fail "backup tarball contents differ"; printf '%s\n' "$bd" | head -15 | sed 's/^/      /'; fi
  rm -rf "$E1" "$E2"
else
  fail "backup dir/tarball missing on one side (sync=$B1 doflow=$B2)"
fi

# 3. hooks executable-bit parity — chmod +x is relative (preserves existing bits, only adds ugo+x),
# so the expected mode depends on the source files' own permissions, not a fixed constant.
P1="$(stat --format='%a' "$H3/.claude/hooks/"*.sh 2>/dev/null | sort -u)"
P2="$(stat --format='%a' "$H4/.claude/hooks/"*.sh 2>/dev/null | sort -u)"
if [ -n "$P1" ] && [ "$P1" = "$P2" ]; then
  pass "hooks/*.sh chmod +x parity (mode $P1)"
else
  fail "hooks perms differ (sync=$P1 doflow=$P2)"
fi

rm -rf "$H3" "$H4"

echo ""
echo "[Phase C] update parity (--target claude)"

# Simulate drift by touching one already-installed dst file's mtime (avoids mutating this repo's
# actual source files, which both tools would otherwise read identically anyway).
#
# Deliberately NOT CLAUDE.md: as of the CLAUDE.md-preservation feature, doflow.js detects a
# pending CLAUDE.md change by content (via its marker-merge peek), not mtime — sync-legacy.sh has
# no such concept and still diffs it by mtime like every other file. Back-dating CLAUDE.md's mtime
# with nothing else changed would make sync-legacy.sh resync it (mtime looks stale) while doflow.js
# correctly no-ops it (content is already up to date), a deliberate improvement beyond parity, not
# a bug this script should catch — same category already carved out above for .claude.json/MCP.
# settings.json stays plain-mirrored in both tools, so it's still a valid mtime-drift target.
H5="$(mktemp -d)"; H6="$(mktemp -d)"
HOME="$H5" bash "$SYNC"   --install --force --no-backup --target claude >/dev/null 2>&1
HOME="$H6" node "$DOFLOW" install -g --force --no-backup --target claude >/dev/null 2>&1
touch -d '2000-01-01' "$H5/.claude/settings.json" "$H6/.claude/settings.json"

HOME="$H5" bash "$SYNC"   --update --force --no-backup --target claude >/dev/null 2>&1
HOME="$H6" node "$DOFLOW" update -g --force --no-backup --target claude >/dev/null 2>&1

# 1. both should re-sync exactly the one drifted file — verified indirectly: after update, a
# second update run on each must report "already up to date" (nothing left dangling).
S1="$(HOME="$H5" bash "$SYNC" --update --force --no-backup --target claude 2>&1)"
S2="$(HOME="$H6" node "$DOFLOW" update -g --force --no-backup --target claude 2>&1)"
if printf '%s' "$S1" | grep -qi 'up to date' && printf '%s' "$S2" | grep -qi 'up to date'; then
  pass "update converges: second run reports up-to-date on both sides"
else
  fail "update did not converge (sync or doflow still reports changes on the 2nd run)"
  printf 'sync:\n%s\ndoflow:\n%s\n' "$S1" "$S2" | head -20 | sed 's/^/      /'
fi

# 2. both manifests now report last_operation=update
O1="$(jq -r '.last_operation' "$H5/.claude/.install-manifest.json" 2>/dev/null)"
O2="$(jq -r '.last_operation' "$H6/.claude/.install-manifest.json" 2>/dev/null)"
if [ "$O1" = "update" ] && [ "$O2" = "update" ]; then
  pass "manifest last_operation=update on both sides"
else
  fail "manifest last_operation mismatch (sync=$O1 doflow=$O2)"
fi

rm -rf "$H5" "$H6"

echo ""
echo "[Parity] $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && { echo "PARITY OK ✓"; exit 0; } || exit 1
