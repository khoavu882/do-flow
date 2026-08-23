#!/usr/bin/env bash
# doflow-stop-check.sh — Antigravity Stop hook (native payload contract).
#
# Blocks Antigravity from stopping while the active task's completion check has not passed: the
# last assistant response in the conversation transcript still carries unfinished-work markers
# (TODO/FIXME/stub/NotImplementedError). The same gate Claude Code's stop-check enforces,
# expressed in Antigravity's documented hook schema (docs/hooks, Input/Output Contract):
#
#   stdin  : { executionNum, terminationReason, fullyIdle, transcriptPath?, ... }
#   stdout : { decision: "continue", reason }   — the documented answer that prevents the stop;
#            silence (exit 0, no stdout) lets the session end.
#
# FAIL-OPEN DOCTRINE: this hook runs at session end, where breaking the stop would trap the user
# inside a loop — worse than under-gating. It therefore exits 0 silently on EVERY ambiguity:
# empty or unparseable stdin, a missing transcriptPath, an unreadable or unrecognized transcript,
# jq absent. It speaks only when it positively recognizes unfinished work.
#
# transcriptPath is treated as OPTIONAL and UNVERIFIED: used when present and parseable, never
# required. Its documented value points at <app_data_dir>/brain/<conversationId>/.system_generated/
# logs/transcript.jsonl; the entry schema inside is not part of the published contract, so any
# foreign shape extracts to nothing and fails open.
#
# Unlike Claude's stop-check there is no lint-dispatch half: Antigravity wires no PostToolUse
# editor hook yet, so no neutral edited-files queue exists to drain. Requires: bash, jq.

set -eu

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)
[ -n "$input" ] || exit 0

transcript=$(printf '%s' "$input" | jq -r '.transcriptPath // empty' 2>/dev/null || true)
[ -n "$transcript" ] || exit 0
[ -f "$transcript" ] || exit 0

# Extract the last assistant message from JSONL. tail-scan is O(constant) regardless of
# transcript size; 200 lines covers any realistic single response. A foreign schema (entries
# without .role/.content) yields "" here and the gate fails open below.
last_assistant_content=$(
  tail -n 200 "$transcript" 2>/dev/null \
    | jq -rs '[.[] | select(.role == "assistant")] | last | .content // ""' 2>/dev/null || true
)
[ -n "$last_assistant_content" ] || exit 0

# Same marker pattern as Claude/Codex/Kiro's shared stop-check: match stubs only inside code
# comment context so explanatory prose ("I removed the TODO comment") does not trigger.
STUB_PATTERN='(#|//)[[:space:]]*(TODO|FIXME)([^[:alnum:]_]|$)|raise NotImplementedError|throw new Error\(.*[Nn]ot [Ii]mplemented|(#|//)[[:space:]]*stub([^[:alnum:]_]|$)'

if printf '%s\n' "$last_assistant_content" | grep -qiE -- "$STUB_PATTERN" 2>/dev/null; then
  jq -n --arg reason "doflow stop-check: unfinished stub or TODO detected in the last response — please complete the implementation before stopping." \
    '{ decision: "continue", reason: $reason }'
fi
exit 0
