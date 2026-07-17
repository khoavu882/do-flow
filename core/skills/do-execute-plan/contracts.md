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

   This entire derivation — walk-up *and* the no-signal fallback — only ever applies to a
   `depends-on:` value whose starting directory actually exists on disk (a `files:` value always
   qualifies; it names a path the plan legitimately intends to touch). A `depends-on:` value that
   names no real directory at all — an external vendor, SaaS, or organization label with nothing
   to walk up from, e.g. a partner's name rather than a path — never reaches a service identity
   through this step. Step 2 routes that case to a different outcome, not this one; don't apply the
   no-signal fallback to it (that fallback is for a real, existing, merely manifest-less
   directory — a fundamentally different situation from a value that isn't a path at all).

2. **Partition touched services** into:
   - **in-scope** — owns a task (being built for real in this same plan) — no contract needed.
   - **dependency (local)** — named in some task's `depends-on:`, owns no task, and step 1 derived
     a real service identity for it.
   - **dependency (non-local)** — named in some task's `depends-on:`, owns no task, and step 1
     derived *no* service identity for it — either because its starting directory doesn't exist on
     disk at all, or because it degenerated to the consuming repo's own root (step 1's exclusion
     case). Both sub-cases collapse into the same outcome here, since either way there is no local
     boundary to generate from:
     - has a `contract-doc:` field on the same task → **documented dependency**, routed to step
       5's contract-doc generation path (below) instead of local language inference, which has
       nothing to scan.
     - no `contract-doc:` → excluded entirely, same as today — no contract generated, surfaced via
       the existing advisory notice, not an error.

   A non-local dependency name can be referenced by more than one task, same as a local one
   (`manifest.yaml`'s `source_task_ids` already supports multiple contributing tasks) — treat every
   task naming the same non-local value as one entity, not one per task. Their `contract-doc:`
   fields MUST agree: either all of them set to the same target, or none of them set at all. If
   they disagree (some set, some not; or set to different targets), surface an explicit warning
   naming the conflicting tasks and their differing `contract-doc:` values — never silently pick
   one, same "don't guess" posture as everywhere else in this algorithm.

   A `contract-doc:` field set on a task whose `depends-on:` value *does* resolve to a local
   identity (a "dependency (local)" case, not non-local) is simply unused — local dependencies are
   generated from the local repo, never from a doc, regardless of whether `contract-doc:` is
   present. Not an error and not warned about; the field only has an effect in the non-local case.

3. **Classify each local dependency's integration style**, derived from *how* step 1 found its
   boundary, not from a named-root or known-monolith list:
   - `network` — the boundary is a distinct git repo (its own `.git`) — an independently
     deployable unit.
   - `in-process` — the boundary was matched via a manifest file only, within the same repo as the
     consuming task.
   - `network` (default) — when step 1's no-signal fallback applies: `in-process` requires
     positive evidence (a same-repo manifest match); its absence defaults to treating the
     dependency as separate rather than silently downgrading it.

   A **documented (non-local) dependency** never went through step 1 at all, so none of the above
   applies — it's always `network`, unconditionally: it has no local repo by definition (that's
   what made it non-local in the first place), so it can never be `in-process`.

4. **Infer each local dependency's language** (a documented dependency has no repo to infer from
   here — step 5's "Documented dependencies" case infers a *rendering* language from the consumer
   instead, reusing this same manifest-detection logic on a different starting point) — check, in
   order, for a known build/package manifest file in the service's repo root: `pom.xml` → Java,
   `build.gradle`/`.kts` → Java unless
   `.kt` source files are present (→ Kotlin), `package.json` → JavaScript unless `tsconfig.json` or
   `.ts`/`.tsx` files are present (→ TypeScript), `Package.swift` → Swift, `Podfile` → Swift unless
   `.m`/`.h` outnumber `.swift` files (→ Objective-C), `Cargo.toml` → Rust, `go.mod` → Go,
   `pyproject.toml`/`requirements.txt` → Python, `*.csproj` → C#. If none found, fall back to
   file-extension frequency among source files (excluding `node_modules/`, `.git/`, `build/`,
   `dist/`, `target/`). If still inconclusive, record `inferred_language: unresolved` — this step
   only determines the language, it does not write anything; the placeholder write (if needed)
   happens in step 5, gated by that step's idempotency check like every other write. Read-only —
   never write into the dependency service's own repo.

5. **Per local dependency, three outcomes** based on
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
     source: local-inference               # local-inference | contract-doc (documented dependencies, below)
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

   **Documented dependencies** (a `contract-doc:` field is present — step 2's non-local case) are
   generated the same way, in the same `manifest.yaml`-driven three-outcome shape, but from a
   different source — the `contract-doc:` target, not local repo scanning (there is none to scan):
   - **Doesn't exist** → first validate the `contract-doc:` target: does it contain a `## Methods`
     section with at least one grammar-conformant `interface` block (the same grammar as the
     pseudocode example above)? `## Types` must also be present.
     - **Not compliant** (missing `## Methods`, missing `## Types`, or `## Methods` has no valid
       `interface` block) → surface an explicit warning naming the dependency, the `contract-doc:`
       path, and what's missing — no frame generated. Never silently skip without saying why, and
       never generate a frame from a doc that doesn't meet the bar.
     - **Compliant** → parse `## Methods` (→ `code/`) and `## Types` (→ `data/`); if `## Webhook`
       is present, its type block is also written into `data/`, alongside (not merged with) the
       `## Types` blocks — a webhook payload is still just a data shape, not a new artifact
       category, but its declaration stays textually separate from `## Types`' own blocks. A
       `## Webhook` type sharing a name with a `## Types` block is a `contract-doc:` authoring
       error (a naming collision the doc author must avoid); this algorithm does not attempt to
       detect or rename it. Infer the *rendering* language from the **consuming task's own repo**
       — reuse step 4's manifest-detection logic starting from the consumer's `files:` path,
       walking up *all the way to and including* the consuming repo's own root this time (unlike
       step 1's identity derivation, which stops short of it — that exclusion exists to prevent
       multiple *service identities* from colliding on the repo root, a concern that doesn't apply
       to language detection at all: many root-level tasks correctly sharing "this repo's own
       language" is the right outcome, not a collision). Render `code/`, `data/`, `mock/` in that
       language — or in this step's pseudocode grammar if even the consuming repo's own root has
       no recognizable manifest — same zero-implementation, signature/shape-only rule as every
       other frame this algorithm generates; `mock/` mirrors `code/`, unfilled, same rule as
       always. Also write `manifest.yaml`:
       ```yaml
       service: notification-vendor              # the literal depends-on: value; no local path to derive from
       source: contract-doc
       contract_doc_path: agent-docs/doflow/<slug>/notification-vendor-api.md
       integration_style: network                 # always, per step 3 — no local repo, never in-process
       inferred_language: java                     # the CONSUMING task's inferred language, not the dependency's
       inference_signal: build.gradle              # same step-4 signal, applied to the consumer's repo
       generated_from_plan: agent-docs/doflow/<slug>/plan.md
       source_task_ids: ["T-004"]
       generation_hash: <sha256 of source_task_ids full task text plus the contract-doc target's full file content plus inferred_language>
       generated_at: <ISO-8601 timestamp>
       ```
   - **Exists, `generation_hash` matches** → skip (already current) — same rule as above.
   - **Exists, `generation_hash` mismatches** (source tasks, the `contract-doc:` target's content,
     or the consumer's inferred language changed since last generation) → do NOT auto-overwrite;
     same warn-don't-clobber rule as above — a doc edit is real drift and must be caught, not
     silently missed.

6. **Report** — N services generated, M skipped (already current), K flagged stale (mismatch, not
   overwritten), the in-scope services with no contract generated (expected outcome, not an error),
   and, separately, J documented-dependency frames generated from `contract-doc:` (step 5's
   "Documented dependencies" case) — state this breakdown explicitly so a documented-dependency
   frame doesn't read as an ordinary local-inference one, or vice versa.

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
- A `depends-on:` value whose starting directory does not exist on disk at all is excluded from
  service-identity derivation *entirely* (step 1) — it never reaches step 5's local generation
  path. It gets a frame only if the same task also carries a `contract-doc:` field (step 2's
  "documented dependency" case); with neither, it stays silently skipped, same as today's default.
- `contract-doc:` targets MUST follow the pinned structure in
  `templates/doflow/contract-doc-template.md` — a `## Methods` section with at least one
  grammar-conformant `interface` block, plus a `## Types` section (`## Webhook` is optional). A
  non-compliant target gets an explicit warning, never a silently-empty or guessed frame — this
  algorithm does not attempt free-form prose extraction anywhere.
- A documented dependency's frame renders in the *consuming* task's own inferred language (step 4,
  reused unchanged, applied to the consumer's repo) — never a language inferred from the
  dependency itself, which has no local repo to infer one from.
