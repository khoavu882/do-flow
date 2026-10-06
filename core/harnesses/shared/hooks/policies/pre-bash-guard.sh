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

# ASCII-only patterns: the C locale keeps bash's substring/pattern operations
# byte-wise (much faster than multibyte-aware in a UTF-8 locale).
export LC_ALL=C

# ── Quoted text, comments and heredoc bodies are not commands ────────────────
# scrub_quotes <text> -> sets SCRUBBED. Anchored shell-command patterns must
# not fire on text that is merely data (a commit message, an echo, a comment,
# a heredoc body). One linear pass, line by line, pure bash, no forks:
#   - quoted text containing whitespace or ; & | is blanked to "" (it could
#     otherwise fake a command position, e.g.  echo "done && rm -rf /x");
#     a quoted word with none of those ("/", "$HOME", $'/') is kept, unquoted,
#     so  rm -rf "/"  is still seen as a target
#   - the argument of sh|bash|zsh -c, eval and a here-string fed to a shell IS executed: it is kept and put
#     in command position (wrapped in ";"), scrubbed again inside
#   - inside double quotes, $( ... ) and `...` bodies also run: kept the same way
#   - a # that starts a word comments out the rest of the line
#   - a heredoc body (<<WORD, <<-WORD, quoted or not) is data and is dropped,
#     except when the heredoc feeds a shell (bash <<EOF), whose body runs
#   - a backslash-newline joins the two lines (outside a heredoc body)
#   - a backslash-escaped character is literal; an unterminated quote keeps the
#     rest of the text as is (errs toward blocking)
# Nesting depth is capped; beyond the cap the raw text is used (errs toward
# blocking). Text with no quote, # or << (or no command word at all) is
# returned unchanged without scanning.
_EXEC_CTX='(^|[[:space:];&|(])((([^[:space:]]*/)?(ba|z|da|k)?sh[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-[[:alnum:]]*c|eval)[[:space:]]+|([^[:space:]]*/)?(ba|z|da|k)?sh([[:space:]]+-[-[:alnum:]]*)*[[:space:]]*[0-9]*<<<[[:space:]]*)$'
_SH_HERE='(^|[[:space:];&|(])([^[:space:]]*/)?(ba|z|da|k)?sh([[:space:]]+-[[:alnum:]]+)*[[:space:]]*$'
_HD_WORD="^(-?)[[:space:]]*[\"']?\\\\?([A-Za-z_][A-Za-z0-9_.-]*)"
SCRUB_DEPTH=0

# Closes the quote scrub_quotes just read (uses its locals: out qc qin qexec).
_scrub_close_quote() {
  local rest pre body acc depth ch
  if [ "$qexec" = 1 ]; then
    [ "$qc" = '"' ] && qin=${qin//\\\"/\"}      # \" inside "..." is a quote of the inner command
    scrub_quotes "$qin"; cur+="; $SCRUBBED ; "
    return
  fi
  case $qin in
    *[[:space:]\;\&\|]*) ;;
    *) cur+=$qin; return ;;
  esac
  cur+=$qc$qc
  [ "$qc" = '"' ] || return
  case $qin in *'$('*|*\`*) ;; *) return ;; esac
  rest=$qin
  while :; do
    pre=${rest%%[\`\$\\]*}
    [ "$pre" = "$rest" ] && break
    rest=${rest#"$pre"}
    case ${rest:0:1} in
      '\') rest=${rest:2} ;;
      '`')
        body=${rest:1}
        case $body in *\`*) acc=${body%%\`*}; rest=${body#*\`} ;; *) acc=$body; rest="" ;; esac
        scrub_quotes "$acc"; cur+="; $SCRUBBED ; " ;;
      *)
        if [ "${rest:1:1}" = "(" ]; then
          body=${rest:2}; acc=""; depth=1
          while [ -n "$body" ]; do
            pre=${body%%[()]*}
            if [ "$pre" = "$body" ]; then acc+=$body; body=""; break; fi
            acc+=$pre; ch=${body:${#pre}:1}; body=${body:$((${#pre} + 1))}
            if [ "$ch" = "(" ]; then depth=$((depth + 1)); acc+=$ch
            else depth=$((depth - 1)); [ "$depth" -eq 0 ] && break; acc+=$ch; fi
          done
          rest=$body
          scrub_quotes "$acc"; cur+="; $SCRUBBED ; "
        else
          rest=${rest:1}
        fi ;;
    esac
  done
}

scrub_quotes() {
  local text=$1
  case $text in
    *[\'\"#]*|*'<<'*|*'\'$'\n'*) ;;
    *) SCRUBBED=$text; return ;;
  esac
  case $text in
    *rm[[:space:]]*|*git[[:space:]]*|*curl[[:space:]]*|*wget[[:space:]]*|*chmod[[:space:]]*|*dd[[:space:]]*|*find[[:space:]]*|*eval*|*sh[[:space:]]*) ;;
    *) SCRUBBED=$text; return ;;
  esac
  if [ "$SCRUB_DEPTH" -ge 8 ]; then SCRUBBED=$text; return; fi
  SCRUB_DEPTH=$((SCRUB_DEPTH + 1))

  local out="" cur="" line L first=1 qc="" qin="" qexec=0 qansi=0 hd_word="" hd_dash=0
  local pre c tail w d
  while IFS= read -r line; do
    if [ -z "$hd_word" ]; then                # backslash-newline joins lines
      while [[ $line == *[!\\]'\' || $line == '\' ]] && IFS= read -r w; do line="${line%?} $w"; done
    fi
    L=$line
    if [ -n "$qc" ]; then
      qin+=$'\n'
    else
      [ "$first" = 1 ] || cur+=$'\n'
      if [ -n "$hd_word" ]; then              # inside a heredoc body: skip the line
        if [ "$hd_dash" = 1 ]; then while [ "${L:0:1}" = $'\t' ]; do L=${L:1}; done; fi
        [ "$L" = "$hd_word" ] && hd_word=""
        first=0; continue
      fi
    fi
    first=0
    # A very long line is scanned in ~1 KB segments (quote state carries over),
    # so the per-token slicing below never copies a huge remainder: stays linear.
    while [ -n "$line" ]; do
    if [ ${#line} -gt 2048 ]; then
      L=${line:0:1024}; line=${line:1024}
      while [[ $L == *'\' || $L == *'<' ]] && [ -n "$line" ]; do L+=${line:0:1}; line=${line:1}; done
    else
      L=$line; line=""
    fi
    while [ -n "$L" ]; do
      if [ ${#cur} -gt 512 ]; then             # keep the tail buffer small
        out+=${cur:0:$((${#cur} - 128))}; cur=${cur: -128}
      fi
      if [ -n "$qc" ]; then                    # inside a quote: look for the close
        if [ "$qc" = "'" ] && [ "$qansi" = 0 ]; then
          case $L in
            *\'*) qin+=${L%%\'*}; L=${L#*\'}; _scrub_close_quote; qc="" ;;
            *) qin+=$L; L="" ;;
          esac
        else
          if [ "$qc" = '"' ]; then pre=${L%%[\"\\]*}; else pre=${L%%[\'\\]*}; fi
          if [ "$pre" = "$L" ]; then
            qin+=$L; L=""
          else
            qin+=$pre; L=${L#"$pre"}
            if [ "${L:0:1}" = '\' ]; then
              qin+=${L:0:2}; L=${L:2}
            else
              L=${L:1}; _scrub_close_quote; qc=""
            fi
          fi
        fi
        continue
      fi
      pre=${L%%[\'\"\\#<]*}
      if [ "$pre" = "$L" ]; then cur+=$L; L=""; break; fi
      cur+=$pre; L=${L#"$pre"}
      c=${L:0:1}
      case $c in
        '\') cur+=${L:0:2}; L=${L:2} ;;
        '#')
          case ${cur: -1} in
            ""|[[:space:]\;\&\|\(]) L="" ;;
            *) cur+=$c; L=${L:1} ;;
          esac ;;
        '<')
          if [ "${L:0:3}" = '<<<' ]; then
            cur+='<<<'; L=${L:3}
          elif [ "${L:0:2}" = '<<' ]; then
            cur+='<<'; L=${L:2}
            case $out$cur in
              *'(('*) ;;
              *)
                if [[ $L =~ $_HD_WORD ]]; then
                  d=${BASH_REMATCH[1]}; w=${BASH_REMATCH[2]}
                  if [ ${#cur} -gt 122 ]; then tail=${cur: -122}; else tail=$cur; fi
                  tail=${tail%??}
                  [[ $tail =~ $_SH_HERE ]] || { hd_word=$w; [ -n "$d" ] && hd_dash=1 || hd_dash=0; }
                fi ;;
            esac
          else
            cur+='<'; L=${L:1}
          fi ;;
        *)                                     # opening quote
          qc=$c; qin=""; qexec=0; qansi=0; L=${L:1}
          if [ "$c" = "'" ] && [ "${cur: -1}" = '$' ]; then
            cur=${cur%?}; qansi=1
          fi
          if [ ${#cur} -gt 100 ]; then tail=${cur: -100}; else tail=$cur; fi
          [[ $tail =~ $_EXEC_CTX ]] && qexec=1 ;;
      esac
    done
    done
  done <<< "$text"
  [ -n "$qc" ] && cur+=$qc$qin                  # unterminated quote: keep as is
  SCRUB_DEPTH=$((SCRUB_DEPTH - 1))
  SCRUBBED=$out$cur
}
scrub_quotes "$COMMAND"
SHELL_TEXT=$SCRUBBED

# Hardcoded floor, used only when blocked-patterns.conf is missing: recursive
# rm (any flag spelling, flag before or after the target) of a catastrophic
# target — the same rule as the rm lines in blocked-patterns.conf. Subpaths
# such as /tmp/x are not blocked.
_CMDPOS='(^|[;&|(`])[[:space:]]*'
_WRAP='((sudo([[:space:]]+(-[ugChprtUDR][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|--(user|group|host|prompt|role|type|chdir)[[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|xargs([[:space:]]+(-[nILPsdEa][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|env([[:space:]]+(-[uCS][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|(command|time|nohup|exec|eval|then|do|else)([[:space:]]+(-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*)[[:space:]]+)*'
_PATHRM='(\\|/(usr/)?bin/)?rm'
_RM_FLAG='(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)'
_RM_ARGS='([[:space:]]+[^[:space:];&|]+)*'
_END='([[:space:];&|)`]|$)'
_RM_PREFIX="${_CMDPOS}${_WRAP}${_PATHRM}${_RM_ARGS}[[:space:]]+"
# _floor_rm_hits <target-regex> : does the scrubbed command recursively rm it?
_floor_rm_hits() {
  grep -qE -- "${_RM_PREFIX}(${_RM_FLAG}${_RM_ARGS}[[:space:]]+($1)${_END}|($1)${_RM_ARGS}[[:space:]]+${_RM_FLAG}${_END})" <<<"$SHELL_TEXT" 2>/dev/null
}

if [ ! -f "$PATTERNS_FILE" ]; then
  # The pattern file ships with DoFlow, so a missing one means a broken install: record it on this
  # machine (feature 046, IC-018) and go on exactly as before. Subshell, output discarded: nothing
  # the helper does can reach this policy's options, variables, output or exit status.
  ( . "$(dirname "$0")/capture-failure.sh"; doflow_capture_failure pre-bash-guard patterns-missing ) >/dev/null 2>&1 || true
  if _floor_rm_hits '/+\*{0,2}'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of the root directory (/)" >&2
    exit 2
  fi
  if _floor_rm_hits '(~[A-Za-z_][A-Za-z0-9_.-]*|~|\$HOME|\$\{HOME\})(/\*{0,2})?'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of the home directory" >&2
    exit 2
  fi
  if _floor_rm_hits '/(Users|home|etc|usr|bin|sbin|var|opt|System|Library|Applications|Volumes|private|root|boot|lib|dev|proc)(/\*{0,2})?'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of a system directory" >&2
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

  # Match pattern against command (POSIX extended regex; case-insensitive for the SQL patterns,
  # case-sensitive for the anchored shell-command ones, as a shell is).
  # A bad regex makes grep exit 2, which "if" reads as no match (fail open).
  # "--" stops grep from treating a pattern beginning with '-' (e.g. an
  # exclude pattern like "--force-with-lease") as an option flag.
  # Anchored shell-command patterns (they begin with the "(^|" command-position
  # anchor) match the scrubbed text; every other pattern (the SQL ones)
  # matches the full text, so statements inside quoted psql -c / heredocs are
  # still caught.
  case "$pattern" in '(^|'*) target=$SHELL_TEXT; gflags=-qE ;; *) target=$COMMAND; gflags=-qiE ;; esac
  matched=false
  if grep $gflags -- "$pattern" <<<"$target" 2>/dev/null; then
    matched=true
  fi

  # Optional third column: if the command also matches the exclude pattern,
  # this pattern line is skipped entirely (approximates negative lookahead,
  # which POSIX ERE cannot express — e.g. "--force-with-lease" excludes the
  # "git push --force" block).
  if [ "$matched" = "true" ] && [ -n "$exclude" ]; then
    if grep $gflags -- "$exclude" <<<"$target" 2>/dev/null; then
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
