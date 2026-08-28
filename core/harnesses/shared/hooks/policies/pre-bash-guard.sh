#!/usr/bin/env bash
# pre-bash-guard.sh — Canonical Policy Library: PreToolUse(shell-command) hook
#
# Intercepts every shell-command tool call and blocks dangerous commands by
# matching against POSIX ERE patterns in blocked-patterns.conf (grep -E).
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional; not required to
#          evaluate this policy)
#   stdin  a PreToolUse-shaped JSON payload; tool name is read from the union
#          of field names harnesses use, and matched against the union of
#          known shell-command tool names (Bash/bash — Claude/Codex;
#          run_shell_command — Gemini; run_command — the generic name
#          stream-hook-runner.js's own COMMAND_TOOL_PATTERN already
#          recognized), since a native front door (Claude/Codex/Kiro) execs
#          this script directly with no payload translation of its own.
#   exit   0 = allow, non-zero = deny with the reason on stderr.
#
# Reconciliation note (022-normalize-hooks, Phase A / D1): this also absorbs
# stream-hook-runner.js's inline DESTRUCTIVE_COMMAND_PATTERN
# (`\brm\s+-rf\s+[/~]`), which was the only pre-bash-guard protection Gemini
# and Antigravity sessions routed through that runner actually had — it
# duplicated, rather than delegated to, this policy's fuller
# blocked-patterns.conf coverage (git force-push, git reset --hard, git clean
# -fd, SQL DROP/DELETE/TRUNCATE, curl|wget-pipe-to-shell, chmod -R 777, dd
# from a block device). That pattern is kept here as a hardcoded floor for
# the case blocked-patterns.conf itself is missing, so a harness that had
# only the hardcoded regex before this change does not lose even that
# minimum floor of protection; once blocked-patterns.conf is present (the
# normal case), the full config-driven pattern list applies as it already
# does for claude/gemini/codex today, which is a real, intended widening of
# coverage for Gemini/Antigravity once B.5 wires this policy for them (see
# design.md R2/R3), not a silent side effect.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0          # no jq -> cannot evaluate -> allow

INPUT=$(cat)

TOOL_NAME=""
for field in '.tool_name' '.tool' '.toolName' '.name'; do
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
  [ -n "$TOOL_NAME" ] && break
done

# Fast exit for non-shell-command tool events (union of every known
# shell-command tool name across harnesses, case-insensitive).
case "$TOOL_NAME" in
  Bash|bash|run_shell_command|run_command) ;;
  *) exit 0 ;;
esac

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Nothing to check if command is empty
[ -z "$COMMAND" ] && exit 0

PATTERNS_FILE="$(dirname "$0")/blocked-patterns.conf"

# Hardcoded floor: stream-hook-runner.js's inline regex was always active
# regardless of a config file being present; preserve that minimum
# protection even when blocked-patterns.conf itself is missing.
DESTRUCTIVE_COMMAND_PATTERN='\brm[[:space:]]+-rf[[:space:]]+[/~]'

if [ ! -f "$PATTERNS_FILE" ]; then
  if (echo "$COMMAND" | grep -qiE -- "$DESTRUCTIVE_COMMAND_PATTERN" 2>/dev/null); then
    echo "[pre-bash-guard] Catastrophic delete blocked — path is too broad (affects root or home)." >&2
    exit 2
  fi
  # No patterns file beyond the hardcoded floor — allow everything else
  # (fail open — don't block the agent).
  exit 0
fi

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason exclude || [ -n "$pattern" ]; do
  # Skip comments and empty lines
  [ -z "$pattern" ] && continue
  case "$pattern" in \#*) continue ;; esac

  # Match pattern against command (case-insensitive, POSIX extended regex).
  # Wrap in subshell so a bad regex exits the subshell, not the script.
  # "--" stops grep from treating a pattern beginning with '-' (e.g. an
  # exclude pattern like "--force-with-lease") as an option flag.
  matched=false
  if (echo "$COMMAND" | grep -qiE -- "$pattern" 2>/dev/null); then
    matched=true
  fi

  # Optional third column: if the command also matches the exclude pattern,
  # this pattern line is skipped entirely (approximates negative lookahead,
  # which POSIX ERE cannot express — e.g. "--force-with-lease" excludes the
  # "git push --force" block).
  if [ "$matched" = "true" ] && [ -n "$exclude" ]; then
    if (echo "$COMMAND" | grep -qiE -- "$exclude" 2>/dev/null); then
      matched=false
    fi
  fi

  if [ "$matched" = "true" ]; then
    echo "[pre-bash-guard] ${reason:-Command blocked by pre-bash-guard}" >&2
    exit 2
  fi
done < "$PATTERNS_FILE"

# No match — allow
exit 0
