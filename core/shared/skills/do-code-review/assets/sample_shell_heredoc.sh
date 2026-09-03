#!/usr/bin/env bash
# Fixture for _blank_heredocs. Guards three behaviours at once; see code_quality_checker.py.
set -euo pipefail

# 1. Heredoc body is prose only. Real complexity is 1; every keyword below is text.
usage() {
  cat <<'EOF'
Usage: tool [options]
  Pick one or the other and then decide if you want more.
  If the file exists and the flag is set or the mode is auto, it will run.
  Use for each item, while any remain, and case by case.
EOF
}

# 2. Real branches around a heredoc are still counted: if + while + case.
emit() {
  if [ -n "${1:-}" ]; then
    cat <<-INDENTED
	this or that and if for while case
	INDENTED
  fi
  while read -r line; do
    case "$line" in a) ;; *) ;; esac
  done
}

# 3. An opener whose terminator never appears is not a heredoc, so the branches
#    below it must stay visible rather than being blanked to end-of-file.
unterminated() {
  echo "<<NEVERCLOSED is only mentioned, never opened"
  if [ -f /tmp/x ] && [ -d /tmp ]; then
    for i in 1 2 3; do echo "$i"; done
  fi
}

usage
emit
unterminated
