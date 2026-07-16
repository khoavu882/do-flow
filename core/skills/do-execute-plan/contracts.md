# `--contracts` — cross-service code frame generation

Read this file only when `/do-execute-plan --contracts` is the active invocation. It is step 4 of
`do-execute-plan`'s Behavioral Flow, factored out here per Anthropic's progressive-disclosure
guidance so the other five flag modes (`--next`/`--phase`/`--all`/`--resume`/`--dry-run`) don't pay
the token cost of this algorithm on every invocation.

`plan.md`'s task list is already loaded (step 3). This produces a distinct deliverable from the
task-execution loop in steps 5-9 — runs standalone (no task-selection mode required), to
completion, then stops. Idempotent — safe to re-run.

## Algorithm

1. **Derive service identity** — for each task, map its `files:` path to a service identity
   against known roots: `sources/<name>`, `sources-rf/<name>`, `clients/<name>` (first path segment
   after the root). Paths outside these roots are excluded, not misfired into a fake service.

2. **Partition touched services** into:
   - **dependency** — named in some task's `depends-on:`, owns no task of its own in this plan.
   - **in-scope** — owns a task (being built for real in this same plan) — no contract needed.

3. **Classify each dependency service's integration style**:
   - `network` — root is `sources/` or `sources-rf/` (microservice-style).
   - `in-process` — a known legacy monolith (e.g. `cops-backend`), or a module in the same repo as
     the consuming task.

4. **Infer each dependency service's language** — check, in order, for a known build/package
   manifest file in the service's repo root: `pom.xml` → Java, `build.gradle`/`.kts` → Java unless
   `.kt` source files are present (→ Kotlin), `package.json` → JavaScript unless `tsconfig.json` or
   `.ts`/`.tsx` files are present (→ TypeScript), `Package.swift` → Swift, `Podfile` → Swift unless
   `.m`/`.h` outnumber `.swift` files (→ Objective-C), `Cargo.toml` → Rust, `go.mod` → Go,
   `pyproject.toml`/`requirements.txt` → Python, `*.csproj` → C#. If none found, fall back to
   file-extension frequency among source files (excluding `node_modules/`, `.git/`, `build/`,
   `dist/`, `target/`). If still inconclusive, record `inferred_language: unresolved` — this step
   only determines the language, it does not write anything; the placeholder write (if needed)
   happens in step 5, gated by that step's idempotency check like every other write. Read-only —
   never write into the dependency service's own repo.

5. **Per dependency service, three outcomes** based on
   `agent-docs/doflow/<slug>/contracts/<service>/manifest.yaml` (always under the active feature's
   own dir — never elsewhere). `generation_hash` covers source task text *and* the inferred
   language *and* which signal produced it (manifest file vs. extension-frequency) — a change in
   any of the three counts as stale, not just a task-text change:
   - **Doesn't exist** → generate, in the inferred language:
     `code/` — an interface/client declaration with the method signature(s) implied by the
     consuming task's `depends-on:` relationship (a clearly-labeled placeholder signature if not
     enough information exists to infer one) — signatures only, zero implementation.
     `data/` — native-language type/DTO declarations for the referenced data shape(s) — fields
     only, no schema file.
     `mock/` — an unfilled skeleton mirroring `code/`'s interface shape — signature-only, same as
     `code/`, not a working fake with canned responses.
     A service whose language couldn't be inferred gets a generic, explicitly-commented
     placeholder in each folder instead. Also write `manifest.yaml`:
     ```yaml
     service: sources/otp-service          # derived service identity
     integration_style: network            # network | in-process
     inferred_language: java               # or "unresolved" if inference failed
     inference_signal: build.gradle        # which manifest file, "extension-frequency", or "none" if unresolved
     generated_from_plan: agent-docs/doflow/<slug>/plan.md
     source_task_ids: ["T-004", "T-007"]   # plan.md tasks whose depends-on: produced this entry
     generation_hash: <sha256 of source_task_ids' full task text + inferred_language + inference_signal>
     generated_at: <ISO-8601 timestamp>
     ```
   - **Exists, `generation_hash` matches** → skip (already current).
   - **Exists, `generation_hash` mismatches** (source tasks, inferred language, or inference signal
     changed since last generation) → do NOT auto-overwrite; surface a warning naming the service
     and stale manifest path so the user can reconcile manually — the existing `code`/`data`/`mock`
     content may hold manual edits (NFR-001 of
     `agent-docs/doflow/003-contracts-frame-generation/requirement.md`).

6. **Report** — N services generated, M skipped (already current), K flagged stale (mismatch, not
   overwritten), and the in-scope services with no contract generated (expected outcome, not an
   error — state this explicitly so it doesn't read as a bug).

## Constraints (carried from the design — do not relax these)
- Never write outside `agent-docs/doflow/<slug>/contracts/` — never into a target service's own
  repo (including the dependency service scanned for language inference — read-only, step 4).
- `code/`/`data/`/`mock/` content is pinned, not freeform: signatures and type/data shapes only,
  zero implementation logic — in the inferred language, or a generic placeholder when language
  inference fails. `mock/` mirrors `code/`'s interface shape; it is not a working fake.
- The one hard gate is step 2 (`do-prereqs.sh --require-plan`) — this algorithm does not add a new
  gate; the advisory notice in step 5 ("Select work") is non-blocking.
