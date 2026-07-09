#!/usr/bin/env bash
# sync.sh — deprecation shim over `doflow` (bin/doflow.js), which has reached parity with this
# script's install/update/status/rollback/list-backups/self-update and is now the maintained
# installer.
#
# sync.sh's grammar is flag-based operations (--install/--update/--rollback [ID]/--status/
# --list-backups/--self-update/--help/--version); doflow's is subcommand-based (install/update/
# rollback [id]/...). This shim translates one to the other rather than blindly forwarding argv —
# `exec node doflow.js "$@"` would fail immediately, since `--install` isn't a doflow flag.
#
# sync.sh had no project-scope concept (every invocation meant $HOME) — this shim always adds
# -g/--global, preserving that historical behavior. -v/--verbose and -b/--backup-dir have no doflow
# equivalent (no verbose mode; backup dir is always <tool-dir>/backups) and are dropped with a
# warning rather than silently ignored.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOFLOW="$SCRIPT_DIR/doflow.js"

command -v node >/dev/null 2>&1 || {
  echo "[ERROR] node is required to run doflow (sync.sh is now a shim over bin/doflow.js)." >&2
  echo "        Install Node >= 18, or use bin/sync-legacy.sh directly (no Node dependency)." >&2
  exit 1
}

CMD=""
ROLLBACK_ID=""
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--install) CMD="install" ;;
    -u|--update) CMD="update" ;;
    -s|--status) CMD="status" ;;
    --list-backups) CMD="list-backups" ;;
    --self-update) CMD="self-update" ;;
    -h|--help) CMD="help" ;;
    --version) CMD="version" ;;
    -r|--rollback)
      CMD="rollback"
      if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then ROLLBACK_ID="$2"; shift; fi
      ;;
    -t|--target|-n|--dry-run|-f|--force|--no-backup|--prune|--checksum)
      PASSTHROUGH+=("$1")
      # -t/--target and --prune take a value argument; carry it along untranslated.
      if [[ "$1" == "-t" || "$1" == "--target" || "$1" == "--prune" ]]; then
        [[ $# -gt 1 ]] && { PASSTHROUGH+=("$2"); shift; }
      fi
      ;;
    -v|--verbose)
      echo "[WARN]  --verbose has no doflow equivalent — dropped." >&2
      ;;
    -b|--backup-dir)
      echo "[WARN]  --backup-dir has no doflow equivalent (backups always live under <tool-dir>/backups) — dropped." >&2
      [[ $# -gt 1 ]] && shift
      ;;
    *)
      echo "[ERROR] Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

[[ -z "$CMD" ]] && CMD="help"

case "$CMD" in
  help) exec node "$DOFLOW" --help ;;
  version) exec node "$DOFLOW" --version ;;
esac

echo "[INFO] sync.sh is deprecated — delegating to 'doflow $CMD'. Use doflow directly going forward." >&2

args=("$CMD")
[[ "$CMD" == "rollback" && -n "$ROLLBACK_ID" ]] && args+=("$ROLLBACK_ID")
args+=(-g "${PASSTHROUGH[@]}")

exec node "$DOFLOW" "${args[@]}"
