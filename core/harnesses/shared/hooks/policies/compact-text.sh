#!/usr/bin/env bash
# IC-001 (feature 116): shared PreCompact text builder; sourced, not executed.

doflow_compact_text() {
  local CWD="${1:-}"
  local preserve branch sha uncommitted recent text

  preserve='Preserve: decisions made, files modified, open questions, planned next steps, acceptance criteria and pending verification of the active task.'

  if [[ -n "$CWD" ]] && is_git_worktree "$CWD"; then
    branch=$(git_branch_of "$CWD" || echo "")
    sha=$(git_short_sha_of "$CWD" || echo "")
    uncommitted=$(git_uncommitted_count_of "$CWD" || echo "0")
    recent=$(run_with_timeout 1 -- git -C "$CWD" log --format="%h %s" -2 2>/dev/null \
      | awk 'NR>1{printf " | "}{printf "%s",$0}' || echo "")

    text=$(printf '%s\nInclude in compact summary:\n- git branch: %s sha: %s\n- uncommitted files: %s\n- cwd: %s\n- recent commits: %s' \
      "$preserve" "${branch:-unknown}" "${sha:-unknown}" "$uncommitted" "${CWD:-unknown}" "${recent:-none}")
  else
    text=$(printf '%s\nInclude in compact summary:\n- cwd: %s (not a git repository)' \
      "$preserve" "${CWD:-unknown}")
  fi

  # Malformed UTF-8 (a commit subject or path can carry any byte) becomes U+FFFD here, before the cap, so the
  # Claude (raw stdout) and Codex (jq --arg) outputs decode to the same text and the cap counts the bytes sent.
  # jq is a hard requirement of both hooks; without it the text is left as it was (FU-535bfv).
  if command -v jq >/dev/null 2>&1; then
    local clean
    if clean=$(printf '%s' "$text" | jq -Rsj '.' 2>/dev/null); then text="$clean"; fi
  fi

  # The cap is 490 BYTES in every locale: LC_ALL=C makes the substring and length below count bytes,
  # where a UTF-8 locale would count characters. A cut can then end inside a multi-byte character, so
  # a trailing partial UTF-8 sequence is dropped (FU-tsq77m).
  local LC_ALL=C cut i b need
  cut="${text:0:490}"
  i=$(( ${#cut} - 1 ))
  # Walk back over at most three continuation bytes (0x80-0xBF) to the byte that starts the last character.
  while [[ $i -ge 1 && $(( ${#cut} - i )) -le 3 ]]; do
    printf -v b '%d' "'${cut:i:1}"
    b=$(( b & 255 )) # the shell may print a byte above 127 as a negative number (bash 3.2) or a code unit
    [[ $b -ge 128 && $b -lt 192 ]] || break
    i=$(( i - 1 ))
  done
  printf -v b '%d' "'${cut:i:1}"
  b=$(( b & 255 ))
  need=1
  [[ $b -ge 192 ]] && need=2
  [[ $b -ge 224 ]] && need=3
  [[ $b -ge 240 ]] && need=4
  [[ $(( ${#cut} - i )) -lt $need ]] && cut="${cut:0:i}"
  DF_COMPACT_TEXT="$cut"
  return 0
}
