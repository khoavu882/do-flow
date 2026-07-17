# `--contracts` — cross-service code frame generation

Read this file only when `/do-execute-plan --contracts` is the active invocation. It is step 4 of
`do-execute-plan`'s Behavioral Flow, factored out here per Anthropic's progressive-disclosure
guidance so the other five flag modes (`--next`/`--phase`/`--all`/`--resume`/`--dry-run`) don't pay
the token cost of this algorithm on every invocation.

`plan.md`'s task list is already loaded (step 3). This produces a distinct deliverable from the
task-execution loop in steps 5-9 — runs standalone (no task-selection mode required), to
completion, then stops. Idempotent — safe to re-run.

## Algorithm

1. **Derive service identity** — applies identically to two kinds of input: a task's `files:`
   value (finds what it *owns* — step 2's in-scope side) and a `depends-on:` value that has no
   owning task in this plan (finds what it *references* — step 2's dependency side; this is the
   algorithm's primary use case, not an afterthought — a genuine dependency owns no task, so it
   only ever reaches a service identity through this path, never through the `files:` path above).
   A `files:` value is a file — start from its containing directory. A `depends-on:` value is
   already a directory reference — start from that directory itself.

   From the starting directory, walk up, stopping *strictly before* the consuming repo's own root
   — that root's own `.git`/manifest is not a valid signal here, it only confirms we're inside
   this repo, not where an internal service boundary starts. The nearest ancestor strictly between
   the starting directory and the consuming repo's root that is either a distinct git repo (a
   *nested* `.git` — either a `.git` directory or a `.git` *file*, so a submodule/worktree gitlink
   still counts — never the consuming repo's own) or contains one of the known build/package
   manifest files listed in step 4 below (the same signal, not a separate list — reused, not
   duplicated) becomes the service boundary; its path *relative to the consuming repo's root* is
   the service identity, always — no special case for a nested `.git`, which would otherwise
   degenerate to a meaningless self-relative `.`.

   If no such ancestor exists anywhere in that range, the service identity falls back to the
   starting directory itself, exactly as given — trusting the plan author's own already-specific
   path as the evidence, not guessing a workspace-convention depth — **unless the starting
   directory is the consuming repo's own root itself** (a `files:` value that's a root-level file,
   e.g. `package.json`, or a `depends-on:` value naming the repo root directly), in which case the
   path is excluded from service-identity derivation entirely: the same treatment the original
   fixed-root-list version gave paths outside its known roots. Not every path needs to resolve to
   a service, and silently naming the whole consuming repo "the service" would collapse every such
   path into one colliding identity. A `depends-on:` value that degenerates this way simply
   produces no contract for that dependency — surfaced through the existing advisory notice
   (`do-execute-plan/SKILL.md` step 5), not an error. This works in any consuming repo's directory
   layout, not only one shaped like a specific multi-service container workspace.

2. **Partition touched services** into:
   - **dependency** — named in some task's `depends-on:`, owns no task of its own in this plan.
   - **in-scope** — owns a task (being built for real in this same plan) — no contract needed.

3. **Classify each dependency service's integration style**, derived from *how* step 1 found its
   boundary, not from a named-root or known-monolith list:
   - `network` — the boundary is a distinct git repo (its own `.git`) — an independently
     deployable unit.
   - `in-process` — the boundary was matched via a manifest file only, within the same repo as the
     consuming task.
   - `network` (default) — when step 1's no-signal fallback applies: `in-process` requires
     positive evidence (a same-repo manifest match); its absence defaults to treating the
     dependency as separate rather than silently downgrading it.

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
     A service whose language couldn't be inferred (`inferred_language: unresolved`) gets a
     structurally-valid **generic pseudocode** frame instead — never a real-language extension, so
     no editor mistakes it for compilable code, and never freeform prose. Every file opens with the
     same banner comment; the grammar is fixed, not improvised per service:
     ```text
     // GENERIC PSEUDOCODE — fallback notation, not a real target language.
     // <service>'s implementation language could not be inferred; do not attempt to compile this.
     interface <Service>Client {
       <method1>(<param1>: <Param1Type>, <param2>: <Param2Type>): <Return1Type>
       <method2>(<param1>: <Param1Type>): <Return2Type>
     }
     ```
     one line per method, comma-separated params on the same line, no line between methods —
     `code/interface.pseudo` is this interface with one line per method signature implied by the
     consuming task's `depends-on:` relationship (a clearly-labeled placeholder signature if not
     enough information exists to infer one).
     `data/types.pseudo` — the same banner, then one `type <Name> = { <field1>: <type1>,
     <field2>: <type2> }` block per referenced data shape (comma-separated fields, same style as
     the interface's params), and one `enum <Name> { <VALUE_A>, <VALUE_B> }` block per referenced
     enum-shaped supporting type (comma-separated variants — same delimiter style as `type`, no
     format switch between the two) — fields/variants only, no schema file.
     `mock/interface.pseudo` — byte-identical to `code/interface.pseudo`'s interface block (same
     banner, same `interface <Service>Client { ... }` signature, no method bodies — a pseudocode
     `interface` cannot carry one) — same "signature-only, same as `code/`, not a working fake"
     rule the resolved-language case already uses for `mock/`, just in pseudocode instead of the
     inferred language. Also write `manifest.yaml`:
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
     content may hold manual edits that a silent regeneration would destroy.

6. **Report** — N services generated, M skipped (already current), K flagged stale (mismatch, not
   overwritten), and the in-scope services with no contract generated (expected outcome, not an
   error — state this explicitly so it doesn't read as a bug).

## Constraints (carried from the design — do not relax these)
- Never write outside `agent-docs/doflow/<slug>/contracts/` — never into a target service's own
  repo (including the dependency service scanned for language inference — read-only, step 4).
- `code/`/`data/`/`mock/` content is pinned, not freeform: signatures and type/data shapes only,
  zero implementation logic — in the inferred language, or the pinned generic-pseudocode grammar
  (`.pseudo` files, step 5) when language inference fails. `mock/` mirrors `code/`'s interface
  shape; it is not a working fake, in either case.
- Service-boundary detection (step 1) is walk-up-based (nearest `.git` or manifest ancestor, or
  the starting directory itself — from a `files:` path or a `depends-on:` value alike — as a
  last-resort fallback) — never a fixed list of named root directories, so this algorithm works
  in any consuming repo's layout. Known accepted
  limitation: two dependencies that both lack any `.git`/manifest signal can fall back to distinct
  but nested directories (e.g. `legacy/mod` and `legacy/mod/util`), generating two separate
  `contracts/` entries for what may be one logical service — no automatic consolidation; this is
  the same class of ambiguity NFR-002 already accepts elsewhere in this algorithm rather than
  guessing. Sharper case of the same limitation: if a nested fallback identity's final path
  segment is literally `code`, `data`, or `mock` (e.g. `legacy/mod` and `legacy/mod/code`), the
  inner service's `manifest.yaml` lands inside the outer service's own generated `code/`/`data/`/
  `mock/` output directory — still not a write outside `agent-docs/doflow/<slug>/contracts/`
  (the first Constraint above still holds), but visually confusing; not auto-detected or renamed.
- The one hard gate is step 2 (`do-prereqs.sh --require-plan`) — this algorithm does not add a new
  gate; the advisory notice in step 5 ("Select work") is non-blocking.
