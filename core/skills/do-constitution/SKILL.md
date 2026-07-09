---
name: do-constitution
description: "Create or amend the per-repo constitution (tier-2), overlaying the base; bumps semver, writes a Sync Impact Report, and propagates a pointer into the agent context file."
argument-hint: "[principle inputs] [--amend]"
disable-model-invocation: true
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
1. **Resolve** — `do-paths.sh --json`; note `constitution_base`, `constitution_local`, `repo_root`.
2. **Read both tiers** — the base (read-only) and the local file if it exists. The effective set is
   `base ⊕ local` with **local winning on conflict** — except it may not weaken base P1 (Safety).
3. **Create or amend** —
   - if `constitution_local` is absent: copy `templates/doflow/constitution-template.md` to
     `agent-docs/constitution.md` and fill it from the user's principle inputs (repo-specific rules only;
     don't restate base principles).
   - if present and `--amend`: apply the requested change.
4. **Version + Sync Impact** — bump the semver version line and fill the `SYNC IMPACT REPORT` comment
   (old→new version, what changed, what it propagates to). If a change clarifies/renames a principle that
   templates reference, note it.
5. **Propagate (deterministic)** — pipe a short pointer block to the helper so it lands in the agent
   context file without rewriting it:
   ```bash
   SYNC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/sync-context.sh"
   [ -f "$SYNC" ] || SYNC="core/scripts/doflow/bash/sync-context.sh"
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
context file. **Next Step:** `/do-spec` to start a feature under this constitution.
