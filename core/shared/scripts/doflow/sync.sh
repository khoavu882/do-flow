#!/usr/bin/env bash
# doflow sync: Compiles canonical guidance into harness targets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"

python3 "$SCRIPT_DIR/compiler.py" --repo-root="$REPO_ROOT" "$@"
