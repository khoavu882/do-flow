# Structure refactor plan

Contributor-facing execution map for the structure refactor approved after the 2026-08
ecosystem study (anthropics/skills, opencode v2, gemini-cli, vercel-labs/skills, gh skill
install, the config-sync family). Each stage is one independently revertible PR through the
normal develop→main chain. This document is the reviewable "map" in the demonolith sense:
every structural move is written down here before it happens, and this file changes in the
same commit as the move.

## Invariants (hold at every merge)

- Test suite green; never below the count recorded in the latest merged stage's report.
- No flag day: expand/migrate/contract, every intermediate state shippable.
- Doctrine untouched: single-source content, six-function adapter contract, one verb table,
  marker-merge for user files.
- Direction rule (G-B1): `core/` never requires from `src/`, `bin/`, or `test/`.
- Inventory ratchets (G-B2) change only in the commit that deliberately moves the thing.

## Stages

### Stage 1 — registry `.yaml` → `.json` hard cutover

Status: **landed** (#33).

The `.yaml` extension on JSON files is a historical quirk guarded into permanence. Kill it.

- Rename all 12 `core/registry/*.yaml` to `.json` (contents already JSON; zero semantic change).
- Update the FILENAMES map in `src/registry/index.js` and delete its subset-comment rationale.
- Sweep all references across `src/`, `bin/`, `test/`, `docs/` (~20 JS files + doc prose).
- Guards that enforced the quirk flip to enforce `.json`; G-B2 list shape updates same commit.
- No dual-read shim: `core/` ships inside the package, there are no external readers of these
  files, and a compatibility mode would be permanent complexity for zero benefit.

Done when: zero remaining `.yaml` references to core/registry paths; suite green; e2e install
sandbox round-trip green.

### Stage 2 — CLI extraction from bin monolith

Status: **landed** (#34).

`bin/doflow.js` is 1215 lines holding parseArgs plus nine `cmd*` handlers. Apply our own
verb-table doctrine to installer commands.

- New src/cli/index.js: argument parsing + one command→handler table.
- Move `cmdInstall/cmdUpdate/cmdReconcile/cmdRemove/cmdStatus/cmdTools/cmdListBackups/
  cmdRollback/cmdSelfUpdate` to src/cli/commands/*.js.
- Collapse the three duplicate inline `createAdapterRegistry({...})` instantiations
  (bin lines ~588/~703/~803) into one shared factory.
- `bin/doflow.js` shrinks to shebang + require + dispatch (~15 lines).
- New guard: command names are written down only in the src/cli table; bin/ defines no
  handlers.

Done when: suite green; temp-home smoke of install/status/remove/--dry-run.

### Stage 3 — harness paths become data

Status: **landed** (#37).

Adapters currently hardcode native path facts in code. vercel-labs/skills holds 75+ agents as
one declarative table; DoFlow moves its per-harness path facts the same way.

- Inventory first: catalog every path fact in the eight adapters' `nativePaths()`/plan
  functions; classify *declarable* (dir joins, scope switches) vs *logic* (env overrides,
  conditional user dirs). Logic residue stays in adapters with an inline justification comment.
- Minimal schema extension in harnesses.json: `{ base: project|home|xdg|custom,
  segments[], scope }` per surface. No template engine, no expression language.
- Adapters consume resolved paths from the registry; G-checks extend to probe sandbox installs
  against declared paths.

Done when: **byte-identical installed trees** for all 8 harnesses × project+user scope
pre/post refactor, ledger fingerprints equal. Rollback = revert restores hardcoded paths.

### Stage 4 — generate capability-map.md from the registry

Status: **landed** (#35).

G8 exists because the capability map drifted from the registry by hand. Generation removes the
class of error instead of detecting it.

- scripts/generate-capability-map.js renders tables/matrices between managed markers;
  prose outside markers is preserved untouched.
- G8 flips from "cells match registry" to "run generator → git diff must be empty".
- Adds npm script `gen:capability-map`.
- Landed: `scripts/generate-capability-map.js` (npm run `gen:capability-map`) renders the
  `capability-matrix` and `hook-event-matrix` regions between `<!-- BEGIN GENERATED:<region> -->`
  / `<!-- END GENERATED:<region> -->` markers; prose outside markers is never machine-edited.

Done when: regenerate produces zero diff; docs build strict-clean.

### Stage 5 — upstream format-drift watcher

Status: **landed** (#36). Baseline lives at scripts/drift/baseline.json (CI state, deliberately outside the 12-file registry ratchet), not core/registry/.

Registry evidence URLs record where facts came from but nothing watches them; two drifts were
caught manually this cycle (antigravity hooks, copilot payloads).

- scripts/drift/baseline.json: normalized fingerprint of the doc page backing each capability
  claim (CI state, deliberately outside the ratcheted 12-file core/registry family).
- scripts/check-format-drift.js: fetch evidence URL → normalize (strip dates/nav/whitespace)
  → fingerprint → diff baseline; non-zero exit naming changed rows. Read-only locally via
  `npm run drift`.
- Scheduled CI workflow (weekly): on drift, opens an issue listing changed claims.
- Auth-walled claims (Copilot payload schemas) stay issue-tracked, not watched.

Done when: read-only check passes locally; workflow validates; first scheduled run green or
issue-opening verified.

### Stage 7 — workspace split (blocked, unscheduled)

npm-workspaces `packages/doflow` + `packages/doflow-content`. Only after G-B1 has held and a
real second consumer of `core/` as content exists. Deliberately not started: the barrel-split
lesson is that packages split on divergent dependency/release surfaces, not tidiness.

## Method notes

- Parallel implementation waves with serial merges; collision points known per wave
  (CHANGELOG.md, docs/architecture.md, package.json scripts).
- Any red suite fixes forward on the feature branch; nothing merges red.
- Windows CI leg stays informational.
