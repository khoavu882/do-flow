#!/usr/bin/env bash
# doflow unified CLI dispatcher
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"

CMD="${1:-help}"
shift || true

case "$CMD" in
  sync)
    bash "$SCRIPT_DIR/sync.sh" "$@"
    ;;
  check-sync)
    bash "$SCRIPT_DIR/check-sync.sh" "$@"
    ;;
  doctor)
    python3 "$SCRIPT_DIR/doctor.py" "$@"
    ;;
  route)
    python3 "$SCRIPT_DIR/tools/retrieval_bridge.py" "$@"
    ;;
  validate)
    bash "$SCRIPT_DIR/bash/validate-artifacts.sh" "$@"
    ;;
  *)
    node "$REPO_ROOT/bin/doflow.js" "$CMD" "$@"
    ;;
esac
