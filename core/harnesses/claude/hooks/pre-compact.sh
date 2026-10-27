#!/usr/bin/env bash
# pre-compact.sh — PreCompact hook
#
# Outputs plain stdout, not JSON. In Claude Code 2.1.304 and 2.1.308, this reached the
# compaction summary model as custom instructions; vendor docs are silent on
# PreCompact stdout (FU-w563w2).
# Text comes from the shared compact-text.sh (IC-001/IC-002), capped at 490 bytes.
# Must never exit non-zero or block.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
CWD=$(json_field "$INPUT" ".cwd")

# Rule compact-instructions.instructions (DEC-023) decides whether this hook emits; it is
# `include` for both roles, so the output below is unchanged. The role comes from the shared
# identity.sh, read silently: this hook never wrote the role diagnostic and does not start now.
POLICIES="$(dirname "$0")/../../.doflow/shared/hooks/policies"
[[ -f "$POLICIES/emission-rules.sh" ]] || POLICIES="$(dirname "$0")/../../shared/hooks/policies"
_DF_ROLE=worker
if declare -F _doflow_role_resolve >/dev/null 2>&1; then _doflow_role_resolve 2>/dev/null; fi
DF_ACTION=skip
if [[ -f "$POLICIES/emission-rules.sh" ]]; then
  # shellcheck source=/dev/null
  . "$POLICIES/emission-rules.sh"
  doflow_emission_rule compact-instructions.instructions "$_DF_ROLE"
fi
[[ "$DF_ACTION" == include ]] || exit 0

[[ -f "$POLICIES/compact-text.sh" ]] || exit 0
# shellcheck source=/dev/null
source "$POLICIES/compact-text.sh"
doflow_compact_text "$CWD"
printf '%s' "$DF_COMPACT_TEXT"

exit 0
