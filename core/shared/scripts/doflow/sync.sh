#!/usr/bin/env bash
# doflow sync: Compiles canonical guidance into harness targets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUR="$PWD"
REPO_ROOT="$CUR"
while [[ "$CUR" != "/" ]]; do
  if [[ -f "$CUR/package.json" || -d "$CUR/.git" || -d "$CUR/.doflow" ]]; then
    REPO_ROOT="$CUR"
    break
  fi
  CUR="$(dirname "$CUR")"
done

python3 "$SCRIPT_DIR/compiler.py" --repo-root="$REPO_ROOT" "$@"
