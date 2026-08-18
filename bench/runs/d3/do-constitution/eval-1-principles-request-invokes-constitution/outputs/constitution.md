# DoFlow Constitution

**Version:** 0.1.0 · **Ratified:** 2026-08-18 · **Last amended:** 2026-08-18

<!-- SYNC IMPACT REPORT (filled by /do-constitution on each change):
     version: (none) → 0.1.0 · changed: initial ratification — five repo-specific principles
     (P-R1 single source, P-R2 registry-declared capability, P-R3 guards are the contract,
     P-R4 one runtime seam, P-R5 no build step) and four constraints, none of which weaken or
     restate base P1–P6 · propagated to: CLAUDE.md (DOFLOW pointer block), and advisory at
     /do-plan's Constitution Check for every later feature. -->

> Persistent, cross-feature rules every phase and agent inherits. This is the **tier-2**
> per-repo overlay on top of `CONSTITUTION_BASE.md`; these rules take precedence on conflict.
> The overlay is performed by the chain skill reading both files — see `DOFLOW_CHAIN.md` →
> "Two-tier constitution" for what is computed and what is convention. Bump the version (semver)
> on any change and fill the Sync Impact Report above.

## Principles

### P-R1 — One source, many projections
Every cross-harness asset — guidance, skills, agent specs, scripts, templates — has exactly one
physical home under `core/shared/`. Two harnesses placing the same asset differently is resolved
in `src/adapters/<harness>/`, never by a second copy of the content. Testable: a file whose bytes
appear under two harness trees is a violation regardless of how convenient the duplication is.

### P-R2 — A capability is declared before it is implemented
What a harness can do, where an asset projects, which verb routes where, and what the runtime may
decide are stated in `core/registry/*.yaml` first; `src/` implements the declaration. Adding a
harness means a registry entry plus an adapter implementing the same six-function contract
(`discover, render, plan, apply, remove, verify`) — not an adapter that quietly does more than the
registry admits. Testable: `test/guards/registry.test.js` compares the claim against the code.

### P-R3 — Guards state the contract; staleness is the defect
A failing `test/guards/*.test.js` means a doc, registry entry, or skill went stale relative to
another — the fix is the stale side. Weakening, narrowing, or skipping a guard to make a change
land is prohibited, and this holds even when the guard's finding looks cosmetic. Testable: no
diff may reduce a guard's assertion surface without an explicit, separately argued reason recorded
in the change.

### P-R4 — Skills reach the runtime through exactly one seam
A skill never names a helper script, never names a verb's implementation, and never uses a
repo-relative or skill-relative path to reach the runtime. It walks up from `$PWD` to
`.doflow/scripts/doflow/bin/doflow-run`, falls back to `$HOME/.doflow`, and exits 2 otherwise.
One dispatcher, one locator, one spelling of the resolver across the whole skill tree. Testable:
`test/guards/skill-seam.test.js` and `test/guards/runtime-unification.test.js`.

### P-R5 — Plain Node, no build step, scoped tests
The shipped artifact is source: Node `>=18`, no bundler, no TypeScript, no lint stage. `npm test`
stays literally `node --test "test/**/*.test.js"` — scoped to `test/`, so an unscoped run cannot
pick up a `*.test.js` a bench case wrote under `bench/runs/`. Anything outside `test/`
(`bash test/code-review-fixtures.sh`, `npm run bench`) is run deliberately and separately, never
folded into the default command.

## Constraints
- Runtime floor is Node `>=18`; no dependency may raise it without a version bump here.
- One runtime only. Python is permitted in this repo solely for `do-code-review`'s own analyzers
  under `core/shared/skills/do-code-review/scripts/`; it may not reappear elsewhere in `core/`.
- Installation and lifecycle state live in the neutral ledger at `.doflow/state/`, never in a
  harness's own config format.
- `npm run bench` makes paid model calls; it is never wired into a default or CI test command.

## Governance
- Amendments: bump semver, fill the Sync Impact Report, re-run dependent gates.
- `/do-plan`'s Constitution Check MUST evaluate against both tiers together (these rules taking
  precedence). Its verdict is advisory — recorded, not blocking.
