#!/usr/bin/env bash
# sync-legacy.sh — AI Config Manager (original bash implementation)
#
# Preserved verbatim as the independent reference implementation `test/cli-parity.sh` diffs
# `doflow` against. `bin/sync.sh` is now a thin deprecation shim delegating to `bin/doflow.js` —
# this file is what it used to be, kept so the parity harness still has something independent to
# compare against (comparing doflow to a shim that just calls doflow would be a no-op check).
#
# Installs and manages configuration files for Claude, Codex, and Gemini AI tools.
#
# Requirements: bash 4.0+, jq
# Usage: ./sync-legacy.sh --help
#
# Version: 1.0.0

set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1 — CONSTANTS & GLOBALS
# ══════════════════════════════════════════════════════════════════════════════

readonly VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
readonly REPO_ROOT
readonly MAPPINGS_FILE="$SCRIPT_DIR/mappings.conf"
readonly DEFAULT_BACKUP_DIR="$HOME/.claude/backups"
readonly MANIFEST_FILE_NAME=".install-manifest.json"

declare -A TOOL_DIRS=(
  [claude]="$HOME/.claude"
  [codex]="$HOME/.codex"
  [gemini]="$HOME/.gemini"
)

# State — set by parse_args
OP=""
TARGETS=()
DRY_RUN=false
VERBOSE=false
FORCE=false
CHECKSUM=false
NO_BACKUP=false
PRUNE_N=0
BACKUP_DIR=""
ROLLBACK_ID=""

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2A — OUTPUT & SAFETY
# ══════════════════════════════════════════════════════════════════════════════

# Set up colors only when stdout is a terminal
if [[ -t 1 ]]; then
  RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
  GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; CYAN=''; GREEN=''; BLUE=''; BOLD=''; RESET=''
fi

log() {
  # All log output goes to stderr so stdout remains clean for function return values.
  local level="$1"; shift
  local msg="$*"
  case "$level" in
    INFO)    printf "${CYAN}[INFO]${RESET}  %s\n" "$msg" >&2 ;;
    WARN)    printf "${YELLOW}[WARN]${RESET}  %s\n" "$msg" >&2 ;;
    ERROR)   printf "${RED}[ERROR]${RESET} %s\n" "$msg" >&2 ;;
    SUCCESS) printf "${GREEN}[OK]${RESET}    %s\n" "$msg" >&2 ;;
    DRY)     printf "${BLUE}[DRY]${RESET}   %s\n" "$msg" >&2 ;;
    VERB)    if $VERBOSE; then printf "        %s\n" "$msg" >&2; fi ;;
  esac
}

confirm() {
  local msg="$1"
  if $FORCE; then
    log INFO "$msg [auto-confirmed via --force]"
    return 0
  fi
  printf "${BOLD}%s${RESET} [y/N] " "$msg"
  local reply
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

show_help() {
  cat <<EOF
${BOLD}sync.sh v${VERSION}${RESET} — AI Config Manager

${BOLD}USAGE${RESET}
  ./sync.sh [OPERATION] [OPTIONS]

${BOLD}OPERATIONS${RESET}
  -i, --install           Full install: sync all mapped files, backup first
  -u, --update            Incremental update: sync changed files only
  -r, --rollback [ID]     Restore a previous backup (interactive if no ID given)
  -s, --status            Show current installed state from manifest
      --list-backups      List all available backups with timestamps
      --self-update       git pull + reinstall (preserves user-owned files)
  -h, --help              Show this help
      --version           Print script version

${BOLD}OPTIONS${RESET}
  -t, --target <list>     Comma-separated tools: claude,codex,gemini (default: all)
  -n, --dry-run           Preview changes without writing anything
  -v, --verbose           Show per-file operations
  -f, --force             Skip confirmation prompts (CI/automation-safe)
  -b, --backup-dir <path> Override backup root (default: \$HOME/.claude/backups)
      --no-backup         Skip backup step — requires --force
      --prune <N>         Keep only N most recent backups after operation
      --checksum          Use SHA256 diff instead of mtime (more accurate)

${BOLD}EXAMPLES${RESET}
  ./sync.sh --install                         Install to all tools
  ./sync.sh --install --target claude         Install Claude config only
  ./sync.sh --install --dry-run               Preview what would be installed
  ./sync.sh --update --target claude,gemini   Update Claude and Gemini
  ./sync.sh --rollback                        Restore from backup (interactive)
  ./sync.sh --rollback install_2026-03-26_14-30-00  Restore specific backup
  ./sync.sh --status                          Show current install state
  ./sync.sh --self-update                     Pull latest and reinstall
  ./sync.sh --install --prune 5              Install and keep only 5 backups

${BOLD}NOTES${RESET}
  - Requires bash 4.0+, jq, and rsync
  - Backups stored in: \$HOME/.claude/backups/
  - Full backups use tar.gz; partial (update) backups use plain directories
  - User-owned files (not tracked by manifest) are preserved during --self-update
  - Use --force --no-backup to skip backup (dangerous)
EOF
}

show_version() {
  printf "sync.sh v%s\n" "$VERSION"
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2B — ARGUMENT PARSING & VALIDATION
# ══════════════════════════════════════════════════════════════════════════════

parse_args() {
  [[ $# -eq 0 ]] && { OP="help"; return 0; }

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -i|--install)
        OP="install"
        ;;
      -u|--update)
        OP="update"
        ;;
      -r|--rollback)
        OP="rollback"
        # Consume next arg as rollback ID if it doesn't start with -
        if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then
          ROLLBACK_ID="$2"
          shift
        fi
        ;;
      -s|--status)
        OP="status"
        ;;
      --list-backups)
        OP="list-backups"
        ;;
      --self-update)
        OP="self-update"
        ;;
      -h|--help)
        OP="help"
        ;;
      --version)
        OP="version"
        ;;
      -t|--target)
        [[ $# -lt 2 ]] && { log ERROR "--target requires a value"; exit 1; }
        IFS=',' read -ra TARGETS <<< "$2"
        shift
        ;;
      -n|--dry-run)
        DRY_RUN=true
        ;;
      -v|--verbose)
        VERBOSE=true
        ;;
      -f|--force)
        FORCE=true
        ;;
      -b|--backup-dir)
        [[ $# -lt 2 ]] && { log ERROR "--backup-dir requires a path"; exit 1; }
        BACKUP_DIR="$2"
        shift
        ;;
      --no-backup)
        NO_BACKUP=true
        ;;
      --prune)
        [[ $# -lt 2 ]] && { log ERROR "--prune requires a number"; exit 1; }
        PRUNE_N="$2"
        shift
        ;;
      --checksum)
        CHECKSUM=true
        ;;
      *)
        log ERROR "Unknown option: $1"
        printf "Run './sync.sh --help' for usage.\n"
        exit 1
        ;;
    esac
    shift
  done

  [[ -z "$OP" ]] && OP="help"
  BACKUP_DIR="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
}

validate_env() {
  # Bash 4.0+ required for associative arrays (declare -A) and namerefs (declare -n)
  if (( BASH_VERSINFO[0] < 4 )); then
    log ERROR "bash 4.0+ is required (current: $BASH_VERSION)"
    log ERROR "macOS users: brew install bash && use /usr/local/bin/bash"
    exit 1
  fi

  # jq required for all manifest I/O
  if ! command -v jq &>/dev/null; then
    log ERROR "jq is required but not installed"
    log ERROR "  Ubuntu/Debian: sudo apt-get install jq"
    log ERROR "  macOS:         brew install jq"
    log ERROR "  Fedora:        sudo dnf install jq"
    exit 1
  fi

  # rsync required for directory sync (file-only mappings fall back to cp)
  if ! command -v rsync &>/dev/null; then
    log ERROR "rsync is required but not installed"
    log ERROR "  Ubuntu/Debian: sudo apt-get install rsync"
    log ERROR "  macOS:         brew install rsync"
    exit 1
  fi

  # Script must be run from within the repo (mappings.conf must exist)
  if [[ ! -f "$MAPPINGS_FILE" ]]; then
    log ERROR "mappings.conf not found: $MAPPINGS_FILE"
    log ERROR "Run sync.sh from within the claude-code-agent-workflow directory"
    exit 1
  fi

  # Safety guard: --no-backup requires --force
  if $NO_BACKUP && ! $FORCE; then
    log ERROR "--no-backup skips all backup protection and requires --force"
    exit 1
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2D — PLATFORM HELPERS
# ══════════════════════════════════════════════════════════════════════════════

# Portable batch mtime retrieval (GNU vs BSD stat).
# Outputs lines of "epoch_seconds path" for each file argument.
_batch_mtime() {
  if stat --version &>/dev/null 2>&1; then
    # GNU coreutils (Linux)
    stat --format="%Y %n" "$@" 2>/dev/null
  else
    # BSD stat (macOS)
    stat -f "%m %N" "$@" 2>/dev/null
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3A — MAPPING ENGINE
# ══════════════════════════════════════════════════════════════════════════════

# Parse mappings.conf for a given tool section.
# Outputs lines of "src_rel:dst_rel" (paths relative to SCRIPT_DIR / tool dir).
read_mappings() {
  local tool="$1"
  local in_section=false

  while IFS= read -r line; do
    # Strip inline comments
    line="${line%%#*}"
    # Skip blank lines
    [[ -z "${line// }" ]] && continue

    # Section header: [toolname]
    if [[ "$line" =~ ^\[([a-zA-Z0-9_-]+)\] ]]; then
      [[ "${BASH_REMATCH[1]}" == "$tool" ]] && in_section=true || in_section=false
      continue
    fi

    # Mapping entry: "src : dst"
    if $in_section && [[ "$line" =~ ^([^:]+):([^:]+)$ ]]; then
      local src dst
      src="$(printf '%s' "${BASH_REMATCH[1]}" | xargs)"
      dst="$(printf '%s' "${BASH_REMATCH[2]}" | xargs)"
      [[ -n "$src" && -n "$dst" ]] && printf "%s:%s\n" "$src" "$dst"
    fi
  done < "$MAPPINGS_FILE"
}

resolve_targets() {
  if [[ ${#TARGETS[@]} -eq 0 ]]; then
    TARGETS=(claude codex gemini)
  fi

  local valid=(claude codex gemini)
  for t in "${TARGETS[@]}"; do
    local found=false
    for v in "${valid[@]}"; do [[ "$t" == "$v" ]] && found=true && break; done
    if ! $found; then
      log ERROR "Unknown target: '$t' (valid: claude, codex, gemini)"
      exit 1
    fi
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3B — BACKUP MODULE
# ══════════════════════════════════════════════════════════════════════════════

_backup_id() {
  local op="$1"
  printf "%s_%s" "$op" "$(date +%Y-%m-%d_%H-%M-%S)"
}

# create_backup <operation> <tools_array_nameref> [partial_src_files...]
# Returns the backup ID via stdout.
# Full backup (no partial files): uses tar.gz
# Partial backup (files listed): uses plain directory copy
create_backup() {
  local operation="$1"
  local -n _cb_tools=$2
  local partial_files=("${@:3}")

  local bid
  bid="$(_backup_id "$operation")"
  local bk_dir="$BACKUP_DIR/$bid"

  if $DRY_RUN; then
    log DRY "Would create backup: $bk_dir"
    printf "%s\n" "$bid"
    return 0
  fi

  mkdir -p "$bk_dir"

  local is_full=true
  [[ ${#partial_files[@]} -gt 0 ]] && is_full=false

  local src_commit
  src_commit="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

  for tool in "${_cb_tools[@]}"; do
    local src_dir="${TOOL_DIRS[$tool]}"
    if [[ ! -d "$src_dir" ]]; then
      log VERB "No existing $tool dir — nothing to back up"
      continue
    fi

    if $is_full; then
      # Full backup: compressed tar.gz (3.7x compression for text files)
      local tar_path="$bk_dir/${tool}.tar.gz"
      log VERB "Full backup: $src_dir -> $tar_path"
      # Exclude the backups dir when backing up .claude to avoid recursion
      if [[ "$tool" == "claude" ]]; then
        tar -czf "$tar_path" --exclude='./backups' -C "$src_dir" . 2>/dev/null || {
          log WARN "tar encountered errors backing up $tool (partial backup may exist)"
        }
      else
        tar -czf "$tar_path" -C "$src_dir" . 2>/dev/null || {
          log WARN "tar encountered errors backing up $tool"
        }
      fi
    else
      # Partial backup: plain directory — user-inspectable for update operations
      local partial_dir="$bk_dir/$tool"
      mkdir -p "$partial_dir"
      for f in "${partial_files[@]}"; do
        # Only include files that belong to this tool's target dir
        [[ "$f" == "$src_dir/"* ]] || continue
        local rel="${f#"$src_dir/"}"
        local dst_f="$partial_dir/$rel"
        mkdir -p "$(dirname "$dst_f")"
        cp -p "$f" "$dst_f"
        log VERB "  Backed up: $rel"
      done
    fi
  done

  # Write backup metadata manifest
  local tools_csv
  tools_csv="$(IFS=,; printf '%s' "${_cb_tools[*]}")"

  jq -n \
    --arg id    "$bid" \
    --arg op    "$operation" \
    --arg ts    "$(date -u +%FT%TZ)" \
    --arg src   "$SCRIPT_DIR" \
    --arg commit "$src_commit" \
    --argjson full "$is_full" \
    --arg tools "$tools_csv" \
    '{
      id:              $id,
      operation:       $op,
      timestamp:       $ts,
      source_path:     $src,
      source_commit:   $commit,
      type:            (if $full then "full" else "partial" end),
      tools_affected:  ($tools | split(","))
    }' > "$bk_dir/.manifest.json"

  log INFO "Backup created: $bid"
  printf "%s\n" "$bid"
}

restore_backup() {
  local bid="$1"
  local bk_dir="$BACKUP_DIR/$bid"

  if [[ ! -d "$bk_dir" ]]; then
    log ERROR "Backup not found: $bid"
    log ERROR "Use --list-backups to see available backups"
    exit 1
  fi

  local bk_type="full"
  [[ -f "$bk_dir/.manifest.json" ]] && \
    bk_type="$(jq -r '.type // "full"' "$bk_dir/.manifest.json" 2>/dev/null || printf 'full')"

  for tool in claude codex gemini; do
    local dst_dir="${TOOL_DIRS[$tool]}"

    if [[ "$bk_type" == "full" ]]; then
      local tar_path="$bk_dir/${tool}.tar.gz"
      [[ ! -f "$tar_path" ]] && continue
      if $DRY_RUN; then
        log DRY "Would restore $tool from $tar_path"
        continue
      fi
      mkdir -p "$dst_dir"
      log INFO "Restoring $tool..."
      tar -xzf "$tar_path" -C "$dst_dir"
    else
      local partial_dir="$bk_dir/$tool"
      [[ ! -d "$partial_dir" ]] && continue
      if $DRY_RUN; then
        log DRY "Would restore $tool (partial) from $partial_dir"
        continue
      fi
      cp -rp "$partial_dir/." "$dst_dir/"
      log INFO "Restored $tool (partial)"
    fi
  done
}

list_backups() {
  mkdir -p "$BACKUP_DIR"

  local entries=()
  for bk_dir in "$BACKUP_DIR"/*/; do
    [[ -d "$bk_dir" ]] && entries+=("$bk_dir")
  done

  if [[ ${#entries[@]} -eq 0 ]]; then
    log INFO "No backups found in $BACKUP_DIR"
    return 0
  fi

  printf "\n${BOLD}%-42s %-14s %-9s %s${RESET}\n" "BACKUP ID" "OPERATION" "TYPE" "TIMESTAMP"
  printf "%s\n" "$(printf '%.0s─' {1..85})"

  local count=0
  for bk_dir in "${entries[@]}"; do
    local manifest="$bk_dir/.manifest.json"
    if [[ -f "$manifest" ]]; then
      local id op ts bk_type
      read -r id op ts bk_type < <(
        jq -r '[.id, .operation, .timestamp, .type] | @tsv' "$manifest" 2>/dev/null \
          || printf "?\tunknown\t?\t?"
      )
      printf "%-42s %-14s %-9s %s\n" "$id" "$op" "$bk_type" "$ts"
    else
      local bid
      bid="$(basename "$bk_dir")"
      printf "%-42s %-14s %-9s %s\n" "$bid" "unknown" "?" "-"
    fi
    count=$(( count + 1 ))
  done

  printf "\n%d backup(s) in %s\n\n" "$count" "$BACKUP_DIR"
}

prune_backups() {
  local keep_n="$1"
  (( keep_n <= 0 )) && return 0

  # Collect backup dirs then sort by mtime (newest first).
  # Uses _batch_mtime (GNU/BSD-portable stat) — avoids find -printf which is GNU only.
  local -a dirs=()
  for d in "$BACKUP_DIR"/*/; do [[ -d "$d" ]] && dirs+=("${d%/}"); done

  mapfile -t all_backups < <(
    [[ ${#dirs[@]} -eq 0 ]] && exit 0
    _batch_mtime "${dirs[@]}" 2>/dev/null | sort -rn | awk '{print $2}'
  )

  local total=${#all_backups[@]}
  if (( total <= keep_n )); then
    log VERB "Prune: $total backup(s) present, keeping $keep_n — nothing to prune"
    return 0
  fi

  local to_delete=("${all_backups[@]:$keep_n}")
  for bk_dir in "${to_delete[@]}"; do
    local bid
    bid="$(basename "$bk_dir")"
    if $DRY_RUN; then
      log DRY "Would prune: $bid"
    else
      rm -rf "$bk_dir"
      log INFO "Pruned: $bid"
    fi
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3C — SYNC ENGINE
# ══════════════════════════════════════════════════════════════════════════════

# diff_files <tool> <output_array_nameref>
# Finds changed files between source and destination.
# PERFORMANCE CRITICAL: uses batch stat/sha256sum — no per-file subshell loops.
# Output array entries: "src_abs_path:dst_abs_path"
diff_files() {
  local tool="$1"
  local -n _df_changed=$2
  local dst_dir="${TOOL_DIRS[$tool]}"

  # Build src→dst path map and collect all source file paths
  local -a src_files=()
  local -A src_to_dst=()

  while IFS=: read -r src_rel dst_rel; do
    local src_path="$REPO_ROOT/$src_rel"

    local src_base="${src_path%/}"    # normalize: strip trailing slash
    local dst_base="${dst_rel%/}"     # normalize: strip trailing slash
    if [[ -d "$src_base" ]]; then
      while IFS= read -r -d '' f; do
        local rel="${f#"${src_base}/"}"
        local dst_f="$dst_dir/$dst_base/$rel"
        src_files+=("$f")
        src_to_dst["$f"]="$dst_f"
      done < <(find "$src_base" -type f -print0 | sort -z)
    elif [[ -f "$src_base" ]]; then
      local dst_f="$dst_dir/$dst_base"
      src_files+=("$src_base")
      src_to_dst["$src_base"]="$dst_f"
    fi
  done < <(read_mappings "$tool")

  [[ ${#src_files[@]} -eq 0 ]] && return 0

  if $CHECKSUM; then
    # ── SHA256 batch diff ──────────────────────────────────────────────────
    # Single sha256sum call on all source files
    declare -A src_hashes=()
    while IFS='  ' read -r hash path; do
      src_hashes["$path"]="$hash"
    done < <(sha256sum "${src_files[@]}" 2>/dev/null)

    # Collect existing destination files for batch hashing
    local -a existing_dst=()
    for f in "${src_files[@]}"; do
      local dst_f="${src_to_dst[$f]}"
      [[ -f "$dst_f" ]] && existing_dst+=("$dst_f")
    done

    declare -A dst_hashes=()
    if [[ ${#existing_dst[@]} -gt 0 ]]; then
      while IFS='  ' read -r hash path; do
        dst_hashes["$path"]="$hash"
      done < <(sha256sum "${existing_dst[@]}" 2>/dev/null)
    fi

    # Compare: changed = hash mismatch or dst missing
    for f in "${src_files[@]}"; do
      local dst_f="${src_to_dst[$f]}"
      local src_hash="${src_hashes[$f]:-}"
      local dst_hash="${dst_hashes[$dst_f]:-}"
      if [[ "$src_hash" != "$dst_hash" ]]; then _df_changed+=("$f:$dst_f"); fi
    done

  else
    # ── mtime batch diff ───────────────────────────────────────────────────
    # Single stat call on all source files (BATCH — not per-file)
    declare -A src_mtimes=()
    while IFS=' ' read -r mtime path; do
      src_mtimes["$path"]="$mtime"
    done < <(_batch_mtime "${src_files[@]}" 2>/dev/null)

    # Batch stat all destination files that exist
    local -a existing_dst=()
    for f in "${src_files[@]}"; do
      local dst_f="${src_to_dst[$f]}"
      [[ -f "$dst_f" ]] && existing_dst+=("$dst_f")
    done

    declare -A dst_mtimes=()
    if [[ ${#existing_dst[@]} -gt 0 ]]; then
      while IFS=' ' read -r mtime path; do
        dst_mtimes["$path"]="$mtime"
      done < <(_batch_mtime "${existing_dst[@]}" 2>/dev/null)
    fi

    # Compare: changed = mtime mismatch or dst missing
    for f in "${src_files[@]}"; do
      local dst_f="${src_to_dst[$f]}"
      local src_mtime="${src_mtimes[$f]:-0}"
      local dst_mtime="${dst_mtimes[$dst_f]:-0}"
      if [[ "$src_mtime" != "$dst_mtime" ]]; then _df_changed+=("$f:$dst_f"); fi
    done
  fi
}

# sync_files <tool> [changed_only=false] [src:dst entries...]
# Uses rsync for --dry-run preview; cp -p for actual writes.
sync_files() {
  local tool="$1"
  local changed_only="${2:-false}"
  local -a entries=("${@:3}")
  local dst_dir="${TOOL_DIRS[$tool]}"
  local synced=0

  if [[ "$changed_only" == "true" ]]; then
    # Update mode: sync only the pre-computed changed entries
    for entry in "${entries[@]}"; do
      local src_f="${entry%%:*}"
      local dst_f="${entry#*:}"
      if _sync_one "$src_f" "$dst_f"; then synced=$(( synced + 1 )); fi
    done
  else
    # Full install mode: walk all mappings
    while IFS=: read -r src_rel dst_rel; do
      local src_path="$REPO_ROOT/$src_rel"

      if [[ -d "$src_path" ]]; then
        local dst_path="$dst_dir/$dst_rel"
        if $DRY_RUN; then
          # rsync -av --dry-run gives per-file output; filter summary lines
          while IFS= read -r line; do
            [[ "$line" =~ ^(sending|sent|total\ size|receiving|^\.\/$|^$) ]] && continue
            [[ -z "$line" ]] && continue
            log DRY "  $tool/${dst_rel%/}/$line"
          done < <(rsync -av --dry-run "$src_path/" "$dst_path/" 2>/dev/null || true)
        else
          mkdir -p "$dst_path"
          rsync -a --quiet "$src_path/" "$dst_path/"
          log VERB "  Synced dir: $tool/${dst_rel%/}/"
          synced=$(( synced + 1 ))
        fi

      elif [[ -f "$src_path" ]]; then
        if _sync_one "$src_path" "$dst_dir/$dst_rel"; then synced=$(( synced + 1 )); fi
      fi
    done < <(read_mappings "$tool")
  fi

  log INFO "  $tool: synced $synced item(s)"
}

_sync_one() {
  local src="$1" dst="$2"
  if $DRY_RUN; then
    log DRY "  $src -> $dst"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  cp -p "$src" "$dst"
  log VERB "  $src -> $dst"
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3D — MANIFEST MODULE
# ══════════════════════════════════════════════════════════════════════════════

_manifest_path() {
  printf "%s/%s" "${TOOL_DIRS[claude]}" "$MANIFEST_FILE_NAME"
}

# write_manifest <operation> <backup_id> <tool...>
write_manifest() {
  local operation="$1"
  local bid="${2:-}"
  shift 2
  local tools=("$@")

  $DRY_RUN && { log DRY "Would write manifest: $(_manifest_path)"; return 0; }

  local src_commit
  src_commit="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

  # Build per-tool object
  local tools_json="{}"
  for tool in "${tools[@]}"; do
    tools_json="$(
      printf '%s' "$tools_json" | jq \
        --arg t  "$tool" \
        --arg ts "$(date -u +%FT%TZ)" \
        '.[$t] = {installed: true, last_updated: $ts}'
    )"
  done

  local manifest_content
  manifest_content="$(jq -n \
    --arg version "$VERSION" \
    --arg op      "$operation" \
    --arg ts      "$(date -u +%FT%TZ)" \
    --arg src     "$SCRIPT_DIR" \
    --arg commit  "$src_commit" \
    --arg bid     "$bid" \
    --argjson tools "$tools_json" \
    '{
      script_version:  $version,
      last_operation:  $op,
      last_run:        $ts,
      source_path:     $src,
      source_commit:   $commit,
      last_backup_id:  $bid,
      tools:           $tools
    }')"

  # Atomic write: temp file + mv prevents partial-write corruption
  local manifest_file
  manifest_file="$(_manifest_path)"
  mkdir -p "$(dirname "$manifest_file")"

  local tmp_file
  tmp_file="$(mktemp)"
  printf '%s\n' "$manifest_content" > "$tmp_file"
  mv "$tmp_file" "$manifest_file"

  log VERB "Manifest written: $manifest_file"
}

# read_manifest: prints all key fields via single jq call
# Output: "op<TAB>run<TAB>commit<TAB>bid"
read_manifest() {
  local manifest_file
  manifest_file="$(_manifest_path)"

  if [[ ! -f "$manifest_file" ]]; then
    printf "none\tnone\tnone\tnone\n"
    return 0
  fi

  # Single jq call reads all needed fields at once — no repeated jq spawns
  jq -r '[.last_operation, .last_run, .source_commit, .last_backup_id] | @tsv' \
    "$manifest_file" 2>/dev/null \
    || printf "error\terror\terror\terror\n"
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 4 — ENGINE LAYER
# ══════════════════════════════════════════════════════════════════════════════

cmd_install() {
  log INFO "Install targets: ${TARGETS[*]}"
  log INFO "Source: $REPO_ROOT/core"

  confirm "Install configs to: ${TARGETS[*]}?" || { log INFO "Aborted."; exit 0; }

  # Backup existing state (full tar.gz)
  local bid=""
  if ! $NO_BACKUP; then
    log INFO "Creating full backup..."
    bid="$(create_backup "install" TARGETS)"
  else
    log WARN "Skipping backup (--no-backup)"
  fi

  # Sync all mapped files for each target tool
  for tool in "${TARGETS[@]}"; do
    local dst_dir="${TOOL_DIRS[$tool]}"
    $DRY_RUN || mkdir -p "$dst_dir"
    log INFO "Syncing: $tool -> $dst_dir"
    sync_files "$tool"

    # Make hook scripts executable after deploying to claude
    if [[ "$tool" == "claude" ]] && ! $DRY_RUN; then
      local hooks_dir="${TOOL_DIRS[claude]}/hooks"
      if [[ -d "$hooks_dir" ]]; then
        chmod +x "$hooks_dir/"*.sh 2>/dev/null || true
        log VERB "  chmod +x applied to hooks/*.sh"
      fi
    fi
  done

  # Write manifest (atomic)
  write_manifest "install" "$bid" "${TARGETS[@]}"

  # Prune old backups if requested
  [[ "$PRUNE_N" -gt 0 ]] && prune_backups "$PRUNE_N"

  if $DRY_RUN; then
    log DRY "Dry run complete — no changes written"
  else
    log SUCCESS "Installation complete!"
  fi
}

cmd_update() {
  log INFO "Checking for changes in: ${TARGETS[*]}"

  # Per-tool changed file discovery
  local -A tool_changed=()
  local -a all_changed=()

  for tool in "${TARGETS[@]}"; do
    local changed=()
    diff_files "$tool" changed
    if [[ ${#changed[@]} -gt 0 ]]; then
      # Store as space-joined for later retrieval from assoc array
      tool_changed["$tool"]="${changed[*]}"
      all_changed+=("${changed[@]}")
    fi
  done

  if [[ ${#all_changed[@]} -eq 0 ]]; then
    log SUCCESS "Already up to date — no changes detected"
    exit 0
  fi

  log INFO "Found ${#all_changed[@]} changed file(s)"
  if $VERBOSE; then
    for entry in "${all_changed[@]}"; do
      log VERB "  Changed: ${entry%%:*}"
    done
  fi

  confirm "Update ${#all_changed[@]} changed file(s) in: ${TARGETS[*]}?" \
    || { log INFO "Aborted."; exit 0; }

  # Partial backup: plain dirs (inspectable) of changed destination files only
  local bid=""
  if ! $NO_BACKUP; then
    # Collect existing destination files for partial backup
    local -a dst_files_to_backup=()
    for entry in "${all_changed[@]}"; do
      local dst_f="${entry#*:}"
      [[ -f "$dst_f" ]] && dst_files_to_backup+=("$dst_f")
    done
    bid="$(create_backup "update" TARGETS "${dst_files_to_backup[@]}")"
  fi

  # Sync changed files only
  for tool in "${TARGETS[@]}"; do
    [[ -z "${tool_changed[$tool]:-}" ]] && continue
    local -a changed=()
    IFS=' ' read -ra changed <<< "${tool_changed[$tool]}"
    sync_files "$tool" "true" "${changed[@]}"
  done

  write_manifest "update" "$bid" "${TARGETS[@]}"

  [[ "$PRUNE_N" -gt 0 ]] && prune_backups "$PRUNE_N"

  if $DRY_RUN; then
    log DRY "Dry run complete"
  else
    log SUCCESS "Update complete!"
  fi
}

cmd_rollback() {
  local bid="$ROLLBACK_ID"

  # Interactive backup selection when no ID provided
  if [[ -z "$bid" ]]; then
    list_backups
    printf "Enter backup ID to restore (or press Enter to cancel): "
    read -r bid
    [[ -z "$bid" ]] && { log INFO "Aborted."; exit 0; }
  fi

  confirm "Restore from '$bid'? This overwrites your current config." \
    || { log INFO "Aborted."; exit 0; }

  # Safety: snapshot current state before restoring
  log INFO "Creating pre-rollback safety snapshot..."
  create_backup "pre-rollback" TARGETS > /dev/null

  restore_backup "$bid"

  write_manifest "rollback" "$bid" "${TARGETS[@]}"

  if $DRY_RUN; then
    log DRY "Dry run complete"
  else
    log SUCCESS "Rollback to '$bid' complete!"
  fi
}

cmd_status() {
  local manifest_file
  manifest_file="$(_manifest_path)"

  if [[ ! -f "$manifest_file" ]]; then
    log WARN "No install manifest found"
    log INFO "Run './sync.sh --install' to get started"
    return 0
  fi

  # Single jq call reads all top-level fields
  local op run commit bid
  read -r op run commit bid < <(read_manifest)

  printf "\n%sInstall Status%s\n" "$BOLD" "$RESET"
  printf "  %-22s %s\n" "Last operation:"   "$op"
  printf "  %-22s %s\n" "Last run:"          "$run"
  printf "  %-22s %s\n" "Source commit:"     "$commit"
  printf "  %-22s %s\n" "Last backup ID:"    "$bid"
  printf "  %-22s %s\n" "Script version:"    "$VERSION"
  printf "\n"

  printf "  %s%-12s %-14s %s%s\n" "$BOLD" "TOOL" "STATUS" "LAST UPDATED" "$RESET"
  printf "  %s\n" "$(printf '%.0s─' {1..50})"

  for tool in claude codex gemini; do
    local installed ts
    read -r installed ts < <(
      jq -r --arg t "$tool" \
        '[(.tools[$t].installed // false | tostring), (.tools[$t].last_updated // "never")] | @tsv' \
        "$manifest_file" 2>/dev/null || printf "false\tnever\n"
    )
    local status_str
    [[ "$installed" == "true" ]] \
      && status_str="${GREEN}installed${RESET}    " \
      || status_str="${YELLOW}not installed${RESET}"
    printf "  %-12s ${status_str} %s\n" "$tool" "$ts"
  done
  printf "\n"

  # Session lifecycle hooks require jq at runtime (separate from this script's own jq dep)
  if ! command -v jq &>/dev/null; then
    log WARN "jq not found — session lifecycle hooks require jq at runtime"
    log WARN "Install: sudo apt-get install jq  OR  brew install jq"
  fi
}

cmd_list_backups() {
  list_backups
}

cmd_self_update() {
  log INFO "Self-update: checking for upstream changes..."

  # Network-safe fetch: timeout prevents indefinite hang on offline systems
  if git -C "$SCRIPT_DIR" fetch --depth=1 origin --timeout=10 2>/dev/null; then
    if git -C "$SCRIPT_DIR" pull --ff-only 2>/dev/null; then
      local new_commit
      new_commit="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
      log INFO "Updated to commit: $new_commit"
    else
      log WARN "Fast-forward not possible — using current local state"
    fi
  else
    log WARN "git fetch failed (offline or no remote configured) — installing from current HEAD"
  fi

  # self-update ALWAYS uses --checksum:
  # git pull may refresh file mtimes even when content is identical,
  # which would cause mtime-based diff to report false positives.
  log INFO "Running install with --checksum (required after git operations)..."
  CHECKSUM=true
  cmd_install
}

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 5 — ERROR HANDLING & SAFETY
# ══════════════════════════════════════════════════════════════════════════════

_cleanup_on_error() {
  local exit_code=$?
  local line="${1:-}"
  log ERROR "Script failed at line $line (exit code: $exit_code)"
  log ERROR "Any partial changes may be incomplete — use --rollback if needed"
  exit "$exit_code"
}

trap '_cleanup_on_error $LINENO' ERR

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2C — MAIN ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

main() {
  parse_args "$@"

  # ── Fast-exit BEFORE validate_env ─────────────────────────────────────────
  # --help and --version must work even from read-only dirs or unsupported envs
  case "$OP" in
    help)    show_help;    exit 0 ;;
    version) show_version; exit 0 ;;
  esac

  validate_env
  resolve_targets

  # ── Dispatch ──────────────────────────────────────────────────────────────
  case "$OP" in
    install)       cmd_install ;;
    update)        cmd_update ;;
    rollback)      cmd_rollback ;;
    status)        cmd_status ;;
    list-backups)  cmd_list_backups ;;
    self-update)   cmd_self_update ;;
    *)
      log ERROR "Unknown operation: $OP"
      show_help
      exit 1
      ;;
  esac
}

main "$@"
