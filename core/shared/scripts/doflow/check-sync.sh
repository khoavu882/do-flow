#!/usr/bin/env bash
# doflow check-sync: Verifies zero-drift projection status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"

python3 "$SCRIPT_DIR/compiler.py" --repo-root="$REPO_ROOT" --check "$@"
