#!/usr/bin/env bash
# do-args.sh — the one argument rule the do-*.sh helpers share. Sourced, never run.
#
# Their argument loops read `--flag=value`. A caller that writes `--flag value` used to fall through
# the loops' `*) ;;` arm with the flag dropped and the value ignored, so `do-paths.sh --slug x`
# silently resolved the ACTIVE feature instead of x. doflow_normalize_args folds the space form into
# the `=` form for the flags a script declares, so the loop itself stays as it was.
#
#   doflow_normalize_args "<flag> <flag> ..." "$@"
#   set -- ${DOFLOW_ARGS[@]+"${DOFLOW_ARGS[@]}"}
#
# The next word is a flag's value unless it starts with a dash: a value-less `--slug` (last, or
# followed by another flag) stays bare and is dropped by the loop exactly as before, and a word that
# starts with a dash is never swallowed. An empty word is a value. Flags a script did not declare,
# `--flag=value` words and positional words pass through untouched. bash 3.2 compatible: the array
# is filled by index and expanded with the `${a[@]+...}` guard, which `set -u` needs for an empty one.

doflow_normalize_args() {
  local _flags=" $1 " _word _pending=""
  shift
  DOFLOW_ARGS=()
  for _word in "$@"; do
    if [ -n "$_pending" ]; then
      case "$_word" in
        -*) DOFLOW_ARGS[${#DOFLOW_ARGS[@]}]="$_pending" ;;
        *)  DOFLOW_ARGS[${#DOFLOW_ARGS[@]}]="$_pending=$_word"; _pending=""; continue ;;
      esac
      _pending=""
    fi
    case "$_word" in
      --*=*) ;;
      --*)   case "$_flags" in *" $_word "*) _pending="$_word"; continue ;; esac ;;
    esac
    DOFLOW_ARGS[${#DOFLOW_ARGS[@]}]="$_word"
  done
  if [ -n "$_pending" ]; then DOFLOW_ARGS[${#DOFLOW_ARGS[@]}]="$_pending"; fi
}
