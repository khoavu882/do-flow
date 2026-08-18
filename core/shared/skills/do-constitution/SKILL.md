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
1. **Resolve** — run the resolver and note `constitution_base`, `constitution_local`, and
   `repo_root`. Every DoFlow runtime call in this skill goes through the runtime seam. Resolve it
   **once** here and reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```
Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

2. **Read both tiers** — the base (read-only), and the local file when `has_constitution_local` is
   true. You reconcile them yourself, tier-2 taking precedence — nothing merges them for you.
   See the guidance tree's `references/DOFLOW_CHAIN.md` → "Two-tier constitution" for what is
   computed and what is convention, and for the rule the two tiers are governed by.
3. **Create or amend** — branch on `has_constitution_local` from step 1, not a filesystem check of
   your own (path math belongs to the resolver; `constitution_local` is still emitted when the file
   is absent, which is exactly the create case):
   - `has_constitution_local` false: copy the installed constitution template to
     `constitution_local` and fill it from the user's principle inputs (repo-specific rules only;
     don't restate base principles).
   - true, and `--amend`: apply the requested change.

The template is `templates/doflow/constitution-template.md` in the install step 1 resolved: take `constitution_base` from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.

4. **Version + Sync Impact** — bump the semver version line and fill the `SYNC IMPACT REPORT` comment
   (old→new version, what changed, what it propagates to). If a change clarifies/renames a principle that
   templates reference, note it.
5. **Propagate (deterministic)** — pipe a short pointer block to the `sync-context` verb so it lands
   in the agent context file without rewriting it:
   ```bash
   printf 'doflow: active constitution = agent-docs/constitution.md (v<version>), overlaying CONSTITUTION_BASE.md.\n' \
     | "$DOFLOW" sync-context --file CLAUDE.md   # or AGENTS.md for Codex
   ```
   The verb acknowledges in plain text on success. **Any non-zero exit means the pointer did not
   land** — 1 the write failed, 2 the call was malformed. Report it in step 6 as a failed
   propagation; never claim the context file was updated on a non-zero exit.
6. **Stop** — report the version, the Sync Impact summary, and the propagated context file (or the
   propagation failure from step 5).

## Boundaries
**Will:** maintain the tier-2 constitution, version it, write the Sync Impact Report, and propagate a
marker-delimited pointer via the `sync-context` verb.
**Will Not:** weaken base P1 (Safety), rewrite the whole context file (only the DOFLOW block), or edit code.

## CRITICAL BOUNDARIES
Output: `agent-docs/constitution.md` (tier-2) + an updated `<!-- DOFLOW START/END -->` block in the
context file. **Next Step:** `/do-brainstorm` to start a feature under this constitution.
