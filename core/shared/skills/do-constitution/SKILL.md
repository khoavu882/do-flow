---
name: do-constitution
description: "Create or amend the per-repo constitution (tier-2), overlaying the base; bumps semver, writes a Sync Impact Report, and propagates a pointer into the agent context file. Use when the user wants to establish or change repo-specific governing principles that every later phase and agent must inherit, or says 'let's set some ground rules for this repo' or 'amend our constitution to require X' rather than asking for a feature."
argument-hint: "[principle inputs] [--amend]"
effort: high
---

# do-constitution

Phase 0 of the doflow chain — the persistent rules every later phase and agent inherits.
Maintains the **tier-2** per-repo constitution that overlays the tier-1 `CONSTITUTION_BASE.md`.

## Invocation
```text
/do-constitution [principle inputs] [--amend]
```

## Behavioral Flow
1. **Resolve** — resolve and run `do-paths.sh --json` from the installed DoFlow config, then note
   `constitution_base`, `constitution_local`, and `repo_root`:
   ```bash
   DOFLOW_CONFIG_DIR="${DOFLOW_CONFIG_DIR:-}"
   if [ -z "$DOFLOW_CONFIG_DIR" ] || [ ! -f "$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh" ]; then
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.doflow/scripts/doflow/bash/do-paths.sh" ] && DOFLOW_CONFIG_DIR="$d/.doflow" && break
       d="$(dirname "$d")"
     done
   fi
   bash "$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh" --json
   ```
2. **Read both tiers** — the base (read-only), and the local file when `has_constitution_local` is
   true. You reconcile them yourself, tier-2 taking precedence — nothing merges them for you — and
   tier-2 may not weaken base P1 (Safety), a rule stated here rather than validated by any check.
   See `references/DOFLOW_CHAIN.md` → "Two-tier constitution" for what is computed and what is
   convention.
3. **Create or amend** — branch on `has_constitution_local` from step 1, not a filesystem check of
   your own (path math belongs to the resolver; `constitution_local` is still emitted when the file
   is absent, which is exactly the create case):
   - `has_constitution_local` false: copy the installed
     `$DOFLOW_CONFIG_DIR/templates/doflow/constitution-template.md` to `constitution_local`
     and fill it from the user's principle inputs (repo-specific rules only;
     don't restate base principles).
   - true, and `--amend`: apply the requested change.
4. **Version + Sync Impact** — bump the semver version line and fill the `SYNC IMPACT REPORT` comment
   (old→new version, what changed, what it propagates to). If a change clarifies/renames a principle that
   templates reference, note it.
5. **Propagate (deterministic)** — pipe a short pointer block to the helper so it lands in the agent
   context file without rewriting it:
   ```bash
   SYNC="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/sync-context.sh}"
   if [ -z "$SYNC" ] || [ ! -f "$SYNC" ]; then
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.doflow/scripts/doflow/bash/sync-context.sh" ] && SYNC="$d/.doflow/scripts/doflow/bash/sync-context.sh" && break
       d="$(dirname "$d")"
     done
   fi
   printf 'doflow: active constitution = agent-docs/constitution.md (v<version>), overlaying CONSTITUTION_BASE.md.\n' \
     | bash "$SYNC" --file CLAUDE.md   # or AGENTS.md for Codex
   ```
6. **Stop** — report the version, the Sync Impact summary, and the propagated context file.

## Boundaries
**Will:** maintain the tier-2 constitution, version it, write the Sync Impact Report, and propagate a
marker-delimited pointer via `sync-context.sh`.
**Will Not:** weaken base P1 (Safety), rewrite the whole context file (only the DOFLOW block), or edit code.

## CRITICAL BOUNDARIES
Output: `agent-docs/constitution.md` (tier-2) + an updated `<!-- DOFLOW START/END -->` block in the
context file. **Next Step:** `/do-brainstorm` to start a feature under this constitution.
