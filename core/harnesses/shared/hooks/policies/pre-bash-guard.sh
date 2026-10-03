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
# (`\brm\s+-rf\s+[/~]`, since narrowed to the recursive-rm-of-catastrophic-target
# rule below), which was the only pre-bash-guard protection Gemini
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

# ── Quoted text is not a command ──────────────────────────────────────────────
# scrub_quotes <text> -> sets SCRUBBED. Anchored shell-command patterns must
# not fire on text that is merely an argument (a commit message, an echo).
#   - quoted text containing whitespace or ; & | is blanked to "" (it could
#     otherwise fake a command position, e.g.  echo "done && rm -rf /x")
#   - a quoted word with none of those (e.g. "/" or "$HOME") is kept, unquoted,
#     so  rm -rf "/"  is still seen as a target
#   - the argument of sh|bash|zsh -c and eval IS executed, so it is kept and
#     placed in command position (wrapped in ";"), and scrubbed again inside.
# An unterminated quote leaves the rest of the text as is. Pure bash, no forks.
_EXEC_CTX='(^|[[:space:];&|(])([^[:space:]]*/)?(ba|z|da|k)?sh[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-[[:alnum:]]*c[[:space:]]+$|(^|[[:space:];&|(])eval[[:space:]]+$'
scrub_quotes() {
  local rest=$1 out="" pre c body inner closed
  while :; do
    pre=${rest%%[\'\"\\]*}
    if [ "$pre" = "$rest" ]; then out+=$rest; break; fi
    out+=$pre; rest=${rest#"$pre"}
    c=${rest:0:1}
    if [ "$c" = '\' ]; then out+=${rest:0:2}; rest=${rest:2}; continue; fi
    body=${rest:1}; inner=""; closed=0
    if [ "$c" = "'" ]; then
      case $body in *\'*) inner=${body%%\'*}; rest=${body#*\'}; closed=1 ;; esac
    else
      while :; do
        pre=${body%%[\"\\]*}
        [ "$pre" = "$body" ] && break
        inner+=$pre; body=${body#"$pre"}
        if [ "${body:0:1}" = '\' ]; then inner+=${body:0:2}; body=${body:2}; continue; fi
        rest=${body:1}; closed=1; break
      done
    fi
    if [ "$closed" = 0 ]; then out+=$c$body; break; fi   # unterminated: keep as is
    if [[ $out =~ $_EXEC_CTX ]]; then
      scrub_quotes "$inner"; out+="; $SCRUBBED ; "
    elif [[ $inner == *[[:space:]\;\&\|]* ]]; then
      out+=$c$c
    else
      out+=$inner
    fi
  done
  SCRUBBED=$out
}
scrub_quotes "$COMMAND"
SHELL_TEXT=$SCRUBBED

# Hardcoded floor, used only when blocked-patterns.conf is missing: recursive
# rm (any flag spelling, flag before or after the target) of a catastrophic
# target — the same rule as the rm lines in blocked-patterns.conf. Subpaths
# such as /tmp/x are not blocked.
_RM_FLAG='(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)'
_RM_ARGS='([[:space:]]+[^[:space:];&|]+)*'
_RM_TARGET='(/+\*?|~(/\*?)?|\$HOME(/\*?)?|\$\{HOME\}(/\*?)?|/(Users|home|etc|usr|bin|sbin|var|opt|System|Library|Applications|private|root|boot|lib|dev|proc)(/\*?)?)'
_END='([[:space:];&|]|$)'
DESTRUCTIVE_COMMAND_PATTERN="(^|[[:space:];&|(\`])rm${_RM_ARGS}[[:space:]]+(${_RM_FLAG}${_RM_ARGS}[[:space:]]+${_RM_TARGET}${_END}|${_RM_TARGET}${_RM_ARGS}[[:space:]]+${_RM_FLAG}${_END})"

if [ ! -f "$PATTERNS_FILE" ]; then
  if (printf '%s\n' "$SHELL_TEXT" | grep -qiE -- "$DESTRUCTIVE_COMMAND_PATTERN" 2>/dev/null); then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of root, home or a system directory." >&2
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
  # Anchored shell-command patterns (they begin with the "(^|" command-position
  # anchor) match the quote-scrubbed text; every other pattern (the SQL ones)
  # matches the full text, so statements inside quoted psql -c / heredocs are
  # still caught.
  case "$pattern" in '(^|'*) target=$SHELL_TEXT ;; *) target=$COMMAND ;; esac
  matched=false
  if (printf '%s\n' "$target" | grep -qiE -- "$pattern" 2>/dev/null); then
    matched=true
  fi

  # Optional third column: if the command also matches the exclude pattern,
  # this pattern line is skipped entirely (approximates negative lookahead,
  # which POSIX ERE cannot express — e.g. "--force-with-lease" excludes the
  # "git push --force" block).
  if [ "$matched" = "true" ] && [ -n "$exclude" ]; then
    if (printf '%s\n' "$target" | grep -qiE -- "$exclude" 2>/dev/null); then
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
