#!/usr/bin/env bash
# sync.sh — entry-point wrapper
# Delegates to bin/sync.sh so users can run ./sync.sh from the repo root.
exec "$(dirname "$0")/bin/sync.sh" "$@"
