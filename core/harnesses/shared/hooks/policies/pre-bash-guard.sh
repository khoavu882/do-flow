#!/usr/bin/env bash
_DOFLOW_SRC=${0//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_POLDIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_POLDIR=. ;; esac
# pre-bash-guard.sh — Canonical Policy Library: PreToolUse(shell-command) hook
#
# Intercepts every shell-command tool call and blocks dangerous commands by
# matching against POSIX ERE patterns in blocked-patterns.conf (grep -E).
#
# Multi-session safe: reads the conf and canonical worker/cwd directories only.
# Marked reset/clean rules and an exact DROP DATABASE launch snapshot may exempt a dispatch worker;
# every failed scope/command check retains the ordinary pattern verdict.
# Must complete in <50ms.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional; not required to
#          evaluate this policy)
#   stdin  a native payload with envelope v1 under doflow_event; only the
#          envelope's operation, tool and command and native root cwd are used.
#   exit   exit 2 + doflow_decide deny = deny; other faults per IC-011.
#
# Reconciliation note (022-normalize-hooks, Phase A / D1): this also absorbs
# stream-hook-runner.js's inline DESTRUCTIVE_COMMAND_PATTERN
# (`\brm\s+-rf\s+[/~]`, since narrowed to the recursive-rm-of-catastrophic-target
# rule below), which was the only pre-bash-guard protection
# Antigravity sessions routed through that runner actually had — it
# duplicated, rather than delegated to, this policy's fuller
# blocked-patterns.conf coverage (git force-push, git reset --hard, git clean
# -fd, SQL DROP/DELETE/TRUNCATE, curl|wget-pipe-to-shell, chmod -R 777, dd
# from a block device). That pattern is kept here as a hardcoded floor for
# the case blocked-patterns.conf itself is missing, so a harness that had
# only the hardcoded regex before this change does not lose even that
# minimum floor of protection; once blocked-patterns.conf is present (the
# normal case), the full config-driven pattern list applies as it already
# does for claude/codex today, which is a real, intended widening of
# coverage for Antigravity once B.5 wires this policy for them (see
# design.md R2/R3), not a silent side effect.

set -uo pipefail

INPUT=$(cat)
if [ -f "$_DOFLOW_POLDIR/contract.sh" ]; then
  . "$_DOFLOW_POLDIR/contract.sh"
else
  doflow_decision_init() { :; }
  doflow_decide() { :; }
  doflow_read_envelope() { DF_ENV_CLASS=missing; DF_ENV_CODE=contract-missing; }
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-bash-guard contract-missing ) >/dev/null 2>&1 || true
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then
    printf '[pre-bash-guard] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2
  else
    printf '[pre-bash-guard] DoFlow hooks out of step; run: doflow update\n' >&2
  fi
  doflow_decide deny contract-missing
  exit 2
fi
doflow_decision_init pre-bash-guard 1
command -v jq >/dev/null 2>&1 || {
  doflow_decide error dependency-missing:jq
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-bash-guard dependency-missing:jq ) >/dev/null 2>&1 || true
  exit 0
}
DF_ENV_CLASS=missing DF_ENV_CODE=envelope-missing
doflow_read_envelope || true

TOOL_NAME=""
COMMAND=""
if [ "$DF_ENV_CLASS" = v1 ]; then
  [ "$DF_ENV_OP" = command ] || exit 0
  TOOL_NAME=$DF_ENV_TOOL
  COMMAND=$DF_ENV_COMMAND
elif [ "$DF_ENV_CLASS" = unsupported ]; then
  doflow_decide unsupported envelope-version
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-bash-guard unsupported:envelope-version ) >/dev/null 2>&1 || true
  exit 0
else
  if [ "${DF_ENV_CODE:-envelope-missing}" != contract-missing ]; then
    ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-bash-guard envelope-missing ) >/dev/null 2>&1 || true
  fi
  if [[ "${DOFLOW_AGENT:-}" =~ ^[a-z]+$ ]]; then printf '[pre-bash-guard] DoFlow hooks out of step; run: doflow update -t %s\n' "$DOFLOW_AGENT" >&2; else printf '[pre-bash-guard] DoFlow hooks out of step; run: doflow update\n' >&2; fi
  doflow_decide deny "${DF_ENV_CODE:-envelope-missing}"
  exit 2
fi

# Nothing to check if command is empty
[ -z "$COMMAND" ] && exit 0

PATTERNS_FILE="$_DOFLOW_POLDIR/blocked-patterns.conf"

# ASCII-only patterns: the C locale keeps bash's substring/pattern operations
# byte-wise (much faster than multibyte-aware in a UTF-8 locale).
export LC_ALL=C

# Shape checks accept one terminal line ending, never an additional command.
# Keep COMMAND raw for all ordinary pattern verdicts.
SHAPE_COMMAND=$COMMAND
case $SHAPE_COMMAND in
  *$'\r\n') SHAPE_COMMAND=${SHAPE_COMMAND%$'\r\n'} ;;
  *$'\n') SHAPE_COMMAND=${SHAPE_COMMAND%$'\n'} ;;
esac

# Lazy and cached: shape checks precede the shared scope's only two subshells
# (cd/pwd builtins), then one git probe for reset/clean only.
# Never infer worker identity from command text.
_WORKER_EXEMPT=
_worker_exempt() {
  case $_WORKER_EXEMPT in allow) return 0 ;; deny) return 1 ;; esac
  _WORKER_EXEMPT=deny
  local reset_re='^[[:blank:]]*git[[:blank:]]+reset([[:blank:]]+(--hard|-q|--quiet))+([[:blank:]]+[A-Za-z0-9_@][A-Za-z0-9_./^~@{}-]*)?[[:blank:]]*$'
  local clean_re='^[[:blank:]]*git[[:blank:]]+clean([[:blank:]]+(-[dfqxX]+|--force|--quiet))+[[:blank:]]*$'
  local forces command=$SHAPE_COMMAND
  if [[ $command =~ $reset_re ]]; then
    case " $command " in *[[:blank:]]--hard[[:blank:]]*) ;; *) return 1 ;; esac
  elif [[ $command =~ $clean_re ]]; then
    forces=${command//[!f]/}
    [ "${#forces}" -eq 1 ] || return 1
  else
    return 1
  fi
  _worker_scope || return 1
  local project=${_WORKER_DIR%/.doflow/state/dispatch-worktrees/*}
  local name=${_WORKER_DIR##*/} info git_dir top suffix
  [ -d "$project/.git" ] || return 1
  # No inherited GIT_* / config environment can redirect this read-only probe.
  info=$(env -i PATH="$PATH" HOME="${HOME:-}" git -C "$_WORKER_CWD" rev-parse --path-format=absolute --git-dir --show-toplevel 2>/dev/null) || return 1
  git_dir=${info%%$'\n'*}; top=${info#*$'\n'}
  [ "$top" = "$_WORKER_DIR" ] || return 1
  case $git_dir in "$project/.git/worktrees/$name"*) ;; *) return 1 ;; esac
  suffix=${git_dir#"$project/.git/worktrees/$name"}
  case $suffix in *[!0-9]*) return 1 ;; esac
  _WORKER_EXEMPT=allow
  return 0
}

# Both exemptions use exactly the same worker, dispatch-path, cwd and GIT_* checks.
_WORKER_SCOPE=
_worker_scope() {
  case $_WORKER_SCOPE in allow) return 0 ;; deny) return 1 ;; esac
  _WORKER_SCOPE=deny
  local worktree cwd config_key
  [ "${DOFLOW_SESSION_ROLE:-}" = worker ] || return 1
  [ -z "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_INDEX_FILE+x}${GIT_COMMON_DIR+x}${GIT_CONFIG_PARAMETERS+x}${GIT_CONFIG_COUNT+x}" ] || return 1
  for config_key in ${!GIT_CONFIG_KEY_@}; do return 1; done
  case ${DOFLOW_WORKTREE:-} in /*) ;; *) return 1 ;; esac
  [ -d "$DOFLOW_WORKTREE" ] || return 1
  # A sentinel preserves path-ending newlines across command substitution.
  worktree=$(CDPATH= cd -P -- "$DOFLOW_WORKTREE" 2>/dev/null && pwd -P && printf '.') || return 1
  worktree=${worktree%.}; worktree=${worktree%$'\n'}
  local dispatch_re='/\.doflow/state/dispatch-worktrees/d-[0-9a-f]{12}$'
  [[ $worktree =~ $dispatch_re ]] || return 1
  [ -n "${DF_ENV_CWD:-}" ] || return 1
  cwd=$(CDPATH= cd -P -- "$DF_ENV_CWD" 2>/dev/null && pwd -P && printf '.') || return 1
  cwd=${cwd%.}; cwd=${cwd%$'\n'}
  case $cwd in "$worktree"|"$worktree"/*) ;; *) return 1 ;; esac
  _WORKER_DIR=$worktree _WORKER_CWD=$cwd
  _WORKER_SCOPE=allow
  return 0
}

# 112: no settings reads here. Re-validate only the launcher's snapshot, then
# recognise one full bare client invocation and one statement. No shell eval,
# substitutions, variables, wrappers, redirects, additional args or statements.
_worker_dropdb_exempt() {
  local list=${DOFLOW_GUARD_DROP_DATABASES:-} list_re='^[a-z][a-z0-9_]{0,62}( [a-z][a-z0-9_]{0,62})*$'
  [ "${#list}" -le 1024 ] && [[ $list =~ $list_re ]] || return 1
  local names=() name rest client quote statement id_re sql_re command=$SHAPE_COMMAND
  IFS=' ' read -r -a names <<< "$list"
  [ "${#names[@]}" -le 32 ] || return 1
  local psql_re='^[[:blank:]]*psql([[:blank:]]+(-[hpUd][[:blank:]]+[A-Za-z0-9_.:-]+|--(host|port|username|dbname)=[A-Za-z0-9_.:-]+|-w))*[[:blank:]]+-c[[:blank:]]+'
  local mysql_re='^[[:blank:]]*mysql([[:blank:]]+(-[hPu][[:blank:]]+[A-Za-z0-9_.:-]+|--(host|port|user)=[A-Za-z0-9_.:-]+))*[[:blank:]]+-e[[:blank:]]+'
  if [[ $command =~ $psql_re ]]; then client=psql
  elif [[ $command =~ $mysql_re ]]; then client=mysql
  else return 1
  fi
  rest=${command:${#BASH_REMATCH[0]}}
  local single_re="^'([^']*)'[[:blank:]]*$" double_re='^"([^"]*)"[[:blank:]]*$'
  if [[ $rest =~ $single_re ]]; then quote=single
  elif [[ $rest =~ $double_re ]]; then quote=double
  else return 1
  fi
  statement=${BASH_REMATCH[1]}
  id_re='[a-z][a-z0-9_]*'
  if [ "$quote" = single ]; then
    if [ "$client" = psql ]; then id_re='([a-z][a-z0-9_]*|"[a-z][a-z0-9_]*")'
    else id_re='([a-z][a-z0-9_]*|`[a-z][a-z0-9_]*`)'
    fi
  fi
  sql_re="^[[:blank:]]*[Dd][Rr][Oo][Pp][[:blank:]]+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee][[:blank:]]+([Ii][Ff][[:blank:]]+[Ee][Xx][Ii][Ss][Tt][Ss][[:blank:]]+)?($id_re)[[:blank:]]*;?[[:blank:]]*$"
  [[ $statement =~ $sql_re ]] || return 1
  name=${BASH_REMATCH[2]}
  case $name in \"*\"|\`*\`) name=${name#?}; name=${name%?} ;; esac
  local listed found=false
  for listed in "${names[@]}"; do
    if [ "$name" = "$listed" ]; then found=true; break; fi
  done
  [ "$found" = true ] || return 1
  _worker_scope
}

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
    *rm[[:space:]]*|*git[[:space:]]*|*curl[[:space:]]*|*wget[[:space:]]*|*chmod[[:space:]]*|*dd[[:space:]]*|*find[[:space:]]*|*eval*|*sh[[:space:]]*|*echo[[:space:]]*|*printf[[:space:]]*|*cat[[:space:]]*|*tee[[:space:]]*|*mkdir[[:space:]]*|*cd[[:space:]]*|*true[[:space:]]*|*:[[:space:]]*|*gh[[:space:]]*) ;;
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

# Positive SQL text-only allow-list, ALWAYS on raw COMMAND, never SHELL_TEXT.
# Whole-command matches permit only commit messages, echo/printf literals,
# cat with a single-quoted heredoc, and gh pr/issue create/comment/edit bodies.
# Double quotes forbid $, backticks and backslashes; file paths have no dot-led
# segment. Heredoc delimiters are single-quoted identifiers, close exactly once
# on the final line, and allow one trailing newline. The sole substitution is
# the exact Claude commit $(cat <<'WORD' ... WORD) idiom. No eval or shell parser:
# every non-match keeps the original raw SQL verdict, including malformed input.
_text_only_command() {
  local text=${COMMAND%$'\n'} b='[[:blank:]]' single="'[^']*'" literal path git gh args re header body word line closed=false
  literal="($single|\"[^\"\$\`\\\\]*\")"
  path='/?[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*'
  git="git${b}+commit(${b}+(-a|-q|--no-verify))*"
  args="(${b}+([A-Za-z0-9_./:=,@%+-]+|$literal))*"
  gh="gh${b}+(pr|issue)${b}+(create|comment|edit)$args"
  re="^${b}*$git(${b}+-m${b}+$literal(${b}+(-a|-q|--no-verify))*)+${b}*$"
  [[ $text =~ $re ]] && return 0
  re="^${b}*(echo|printf)${b}+$literal(${b}*>>?${b}*$path)?${b}*$"
  [[ $text =~ $re ]] && return 0
  re="^${b}*$gh${b}+--body${b}+$single$args${b}*$"
  [[ $text =~ $re ]] && return 0

  # Split only the first line. The body is inert only if its first delimiter
  # occurrence is also its last line; otherwise a hidden second command runs.
  case $text in *$'\n'*) ;; *) return 1 ;; esac
  header=${text%%$'\n'*}; body=${text#*$'\n'}
  local hd="<<'([A-Za-z_][A-Za-z0-9_]*)'" cat_start='"\$\(cat' cat_end=$'\n)"'
  local redir=">>?${b}*$path" tee_flag="(-a|--append)"
  local re_git="^${b}*($git${b}+-F${b}+-${b}+|$gh${b}+--body-file${b}+-${b}+)${hd}${b}*$"
  local re_cat_before="^${b}*cat(${b}+${redir})?${b}+${hd}${b}*$"
  local re_cat_after="^${b}*cat${b}+${hd}(${b}*${redir})?${b}*$"
  local re_tee_before="^${b}*tee(${b}+${tee_flag})?${b}+${path}${b}+${hd}${b}*$"
  local re_tee_after="^${b}*tee(${b}+${tee_flag})?${b}+${hd}${b}+(${tee_flag}${b}+)?${path}${b}*$"
  if [[ $header =~ $re_git ]] || [[ $header =~ $re_cat_before ]] || [[ $header =~ $re_cat_after ]] || [[ $header =~ $re_tee_before ]] || [[ $header =~ $re_tee_after ]]; then
    # Match the delimiter separately so prefix capture groups cannot change its index.
    [[ $header =~ $hd ]] || return 1
    word=${BASH_REMATCH[1]}
  else
    re="^${b}*$git${b}+-m${b}+$cat_start${b}+${hd}${b}*$"
    [[ $header =~ $re ]] || return 1
    [[ $header =~ $hd ]] || return 1
    word=${BASH_REMATCH[1]}
    [[ $body == *"$cat_end" ]] || return 1
    body=${body%"$cat_end"}
  fi
  while IFS= read -r line; do
    [ "$closed" = false ] || return 1
    [ "$line" != "$word" ] || closed=true
  done <<< "$body"
  [ "$closed" = true ]
}
DATA_ONLY=false
_text_only_command && DATA_ONLY=true

# Project-specific unanchored patterns keep their verdicts too: only these
# three shipped SQL families participate in the text-only exception.
_sql_pattern() {
  case $1 in
    'DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)[[:space:]]'|\
    'DELETE[[:space:]]+FROM[[:space:]]+[[:alnum:]_]+[[:space:]]*;'|\
    'TRUNCATE[[:space:]]+TABLE') return 0 ;;
  esac
  return 1
}

# Hardcoded floor, used only when blocked-patterns.conf is missing: recursive
# rm (any flag spelling, flag before or after the target) of a catastrophic
# target — the same rule as the rm lines in blocked-patterns.conf. Subpaths
# such as /tmp/x are not blocked.
_CMDPOS='(^|[;&|(`])[[:space:]]*'
_WRAP='((sudo([[:space:]]+(-[ugChprtUDR][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|--(user|group|host|prompt|role|type|chdir)[[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|xargs([[:space:]]+(-[nILPsdEa][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|env([[:space:]]+(-[uCS][[:space:]]+[^-[:space:];&|][^[:space:];&|]*|-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*|(command|time|nohup|exec|eval|then|do|else)([[:space:]]+(-[^[:space:];&|]*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*))*)[[:space:]]+)*'
_PATHRM='(\\|/(usr/)?bin/)?rm'
_RM_FLAG='(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)'
_RM_ARGS='([[:space:]]+[^[:space:];&|]+)*'
_END='([[:space:];&|)`]|$)'
_RM_PREFIX="${_CMDPOS}${_WRAP}${_PATHRM}${_RM_ARGS}[[:space:]]+"
# _floor_rm_hits <target-regex> : does the scrubbed command recursively rm it?
_floor_rm_hits() {
  grep -qiE -- "${_RM_PREFIX}(${_RM_FLAG}${_RM_ARGS}[[:space:]]+($1)${_END}|($1)${_RM_ARGS}[[:space:]]+${_RM_FLAG}${_END})" <<<"$SHELL_TEXT" 2>/dev/null
}

if [ ! -f "$PATTERNS_FILE" ]; then
  # The pattern file ships with DoFlow, so a missing one means a broken install: record it on this
  # machine (feature 046, IC-018) and go on exactly as before. Subshell, output discarded: nothing
  # the helper does can reach this policy's options, variables, output or exit status.
  ( . "$_DOFLOW_POLDIR/capture-failure.sh"; doflow_capture_failure pre-bash-guard patterns-missing ) >/dev/null 2>&1 || true
  doflow_decide error patterns-missing
  if _floor_rm_hits '/+\*{0,2}'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of the root directory (/)" >&2
    doflow_decide deny catastrophic-rm-root
    exit 2
  fi
  if _floor_rm_hits '(~[A-Za-z_][A-Za-z0-9_.-]*|~|\$HOME|\$\{HOME\})(/\*{0,2})?'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of the home directory" >&2
    doflow_decide deny catastrophic-rm-home
    exit 2
  fi
  if _floor_rm_hits '/(Users|home|etc|usr|bin|sbin|var|opt|System|Library|Applications|Volumes|private|root|boot|lib|dev|proc)(/\*{0,2})?'; then
    echo "[pre-bash-guard] Catastrophic delete blocked — recursive rm of a system directory" >&2
    doflow_decide deny catastrophic-rm-system
    exit 2
  fi
  # No patterns file beyond the hardcoded floor — allow everything else
  # (fail open — don't block the agent).
  exit 0
fi

# One combined ERE cheaply rules out commands that match no live pattern. A
# grep match or regex error falls through to the original per-line loop, which
# still owns the reason and optional exclude semantics.
_anchored_patterns="" _full_patterns="" _has_backreference=false
_has_worker_marker=false
while IFS=$'\t' read -r pattern _reason _exclude || [ -n "$pattern" ]; do
  [ -z "$pattern" ] && continue
  case "$pattern" in
    '#@exempt-next worker-worktree') _has_worker_marker=true; continue ;;
    \#*) continue ;;
  esac
  if [ "$DATA_ONLY" = true ] && _sql_pattern "$pattern"; then continue; fi
  if [[ "$pattern" =~ \\[1-9] ]]; then _has_backreference=true; fi
  case "$pattern" in
    '(^|'*) _anchored_patterns="${_anchored_patterns:+$_anchored_patterns|}($pattern)" ;;
    *) _full_patterns="${_full_patterns:+$_full_patterns|}($pattern)" ;;
  esac
done < "$PATTERNS_FILE"
_anchored_status=1 _full_status=1
if [ -n "$_anchored_patterns" ]; then
  grep -qiE -- "$_anchored_patterns" <<<"$SHELL_TEXT" 2>/dev/null
  _anchored_status=$?
fi
if [ -n "$_full_patterns" ]; then
  grep -qiE -- "$_full_patterns" <<<"$COMMAND" 2>/dev/null
  _full_status=$?
fi
if [ "$_anchored_status" -eq 1 ] && [ "$_full_status" -eq 1 ] && [ "$_has_backreference" != true ]; then
  # Some accepted worker shapes (reset -q --hard, clean -f) already match no
  # deny rule. Give those allows the same scope code without widening a rule.
  if [ "$_has_worker_marker" = true ] && _worker_exempt; then doflow_decide allow worker-worktree; fi
  exit 0
fi

# ── Pattern matching ──────────────────────────────────────────────────────────

_exempt_next= _worker_skipped=false
while IFS=$'\t' read -r pattern reason exclude || [ -n "$pattern" ]; do
  # Skip comments and empty lines
  [ -z "$pattern" ] && continue
  case "$pattern" in
    '#@exempt-next worker-worktree') _exempt_next=worker-worktree; continue ;;
    '#@exempt-next worker-dropdb') _exempt_next=worker-dropdb; continue ;;
    \#*) continue ;;
  esac
  exemption=$_exempt_next
  _exempt_next=
  if [ "$DATA_ONLY" = true ] && _sql_pattern "$pattern"; then continue; fi

  # Match pattern against command (case-insensitive, POSIX extended regex: the default macOS
  # filesystem is case-insensitive, so RM and GIT run there).
  # A bad regex makes grep exit 2, which "if" reads as no match (fail open).
  # "--" stops grep from treating a pattern beginning with '-' (e.g. an
  # exclude pattern like "--force-with-lease") as an option flag.
  # Anchored shell-command patterns (they begin with the "(^|" command-position
  # anchor) match the scrubbed text; every other pattern (the SQL ones)
  # matches the full text, so statements inside quoted psql -c / heredocs are
  # still caught.
  case "$pattern" in '(^|'*) target=$SHELL_TEXT ;; *) target=$COMMAND ;; esac
  matched=false
  if grep -qiE -- "$pattern" <<<"$target" 2>/dev/null; then
    matched=true
  fi

  # Optional third column: if the command also matches the exclude pattern,
  # this pattern line is skipped entirely (approximates negative lookahead,
  # which POSIX ERE cannot express — e.g. "--force-with-lease" excludes the
  # "git push --force" block).
  if [ "$matched" = "true" ] && [ -n "$exclude" ]; then
    if grep -qiE -- "$exclude" <<<"$target" 2>/dev/null; then
      matched=false
    fi
  fi

  if [ "$matched" = "true" ]; then
    if [ "$exemption" = worker-worktree ] && _worker_exempt; then
      _worker_skipped=worker-worktree
      continue
    fi
    if [ "$exemption" = worker-dropdb ] && _worker_dropdb_exempt; then
      _worker_skipped=worker-dropdb
      continue
    fi
    echo "[pre-bash-guard] ${reason:-Command blocked by pre-bash-guard}" >&2
    doflow_decide deny blocked-pattern
    exit 2
  fi
done < "$PATTERNS_FILE"

# No match — allow
[ "$_worker_skipped" != false ] && doflow_decide allow "$_worker_skipped"
exit 0
