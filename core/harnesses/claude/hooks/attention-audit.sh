#!/usr/bin/env bash
# Claude front door: an ask that waits on the person (PermissionRequest, Notification) through the shared bridge step
# observe-attention (row 180 IC-180-D1). Front door only: which events are asks and which payload fields are read is
# Claude's `attention` entry in core/registry/harnesses.json. Pure observability: it prints nothing, returns no
# decision and always exits 0, so the permission flow is unchanged.
exec >/dev/null 2>&1
step="$(dirname "$0")/../../.doflow/shared/hooks/bridge/observe-attention.sh"
[ -f "$step" ] || exit 0
( . "$step" && doflow_observe_attention claude "${1:-}" ) || true
exit 0
