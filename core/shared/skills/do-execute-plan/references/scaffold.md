# `--scaffold` — turning the plan into a reviewable code scaffold

Read this file only when `/do-execute-plan --scaffold` is the active invocation. It is step 3 of
`do-execute-plan`'s Behavioral Flow, factored out here per Anthropic's progressive-disclosure
guidance so the other invocation modes (`--scope next|phase:N|all|resume`, and the `--review`
modifier) don't pay the token cost of this algorithm on every invocation.

It answers one question: *what shape does my plan imply, before any of it reaches my code?* The
cross-service frames in Part 2 are one case of that, not the headline.

`plan.md`'s task list is already resolved by the time this runs. This produces a distinct deliverable
from the task-execution loop in step 4 — it runs standalone (no task-selection mode required), to
completion, then stops. Idempotent: safe to re-run, and re-running an unchanged plan produces no
diff at all.

## What it produces

```text
agent-docs/doflow/<slug>/scaffold/
├── MANIFEST.md                       # what was generated, from which artifact, and what was SKIPPED
├── src/<path>.<ext>.stub             # mirrors the intended source layout — signatures only
├── test/<FR-id>.test.<ext>.stub      # test stubs derived from acceptance criteria
└── contracts/<service>/…             # external-dependency frames (Part 2)
```

Part 1's files all carry a `.stub` suffix, and that is load-bearing rather than decorative:
`node --test` collects *any* `.js` under a directory named `test`, and pytest and `go test ./...`
sweep just as broadly, so a stub emitted as plain `FR-001.test.js` under that directory would
silently join the host project's own test run and fail it. One suffix on everything is a stronger
guarantee than a per-toolchain exclusion list — nothing in Part 1's output is loadable by anything
until someone deliberately drops the suffix. Part 2's `contracts/` frames do not carry it: `default/` exists to be compiled against,
and its tree holds no directory a runner sweeps.

| Property | Rule |
|---|---|
| Source tree | Never written to. `git status` outside the feature directory is unchanged by a run, and the host project's test run is unaffected |
| Content | Signatures, types, stubs. **No implementation logic** |
| Traceability | Every file header names its originating FR / component / task |
| Idempotency | Re-running produces no diff |
| Human edits | Detected by fingerprint and reported, never overwritten |
| Invocation | Explicit only — never inferred from plan contents |

Two rules deserve their reasoning, because both are easy to "improve" into a defect:

- **No implementation logic, ever.** The artifact exists so an engineer can judge the shape a plan
  implies. Generated logic nobody has verified is exactly the false confidence this scaffold is
  supposed to remove — a body that looks finished stops being reviewed. Every emitted body is one
  fixed "not implemented" signal from the Default-Implementation Grammar in Part 2, and nothing else.
- **What was skipped matters as much as what was produced.** A reader who cannot see the gaps reads
  the tree as the whole shape of the plan. So a scaffold built from an artifact the generator could
  not read or parse says so in `MANIFEST.md` and exits non-zero — it never degrades into a thin tree
  that reads as complete.

## Two cases, one output tree

| | Part 1 — in-scope | Part 2 — external dependency |
|---|---|---|
| Input | `requirement.md`, `design.md`, `plan.md` | a `depends-on:` value with no owning task |
| Produced by | `src/runtime/scaffold/generate.js`, deterministically | this file's algorithm, executed by you |
| Lands in | `scaffold/src/`, `scaffold/test/`, `scaffold/MANIFEST.md` | `scaffold/contracts/<service>/` |
| Answers | what shape does my own plan imply | what shape must I code against at the boundary |

They meet in one place: the generator partitions every `depends-on:` value and reports the result in
`MANIFEST.md`'s **External dependencies** table. It deliberately does *not* derive service
boundaries itself — the walk-up rules in Part 2 handle nested `.git` boundaries, non-local vendors
and `external-contract:` targets, and a second implementation of that walk would be one more thing to
keep in sync. Read the table, then run Part 2 for every row whose disposition is `external`.

## Part 1 — in-scope scaffold from the three artifacts

Deterministic, so it is executed rather than reasoned through. Run it, then report what it returns —
do not restate its counts from memory or re-derive them by reading the tree.

```bash
# `$DOFLOW` is already resolved by step 1. One verb, like every other runtime call — the seam
# resolves the active feature itself, so nothing here interpolates a path or a slug.
"$DOFLOW" scaffold --json
```

Run it from the project root: the verb resolves which feature is active exactly the way `paths`
does, from the working directory. The one case worth knowing about is a non-git root holding more
than one feature directory — there the resolver cannot choose, and exits 2 naming every candidate.
Ask the user which one via `AskUserQuestion` and re-run as `"$DOFLOW" scaffold --slug=<chosen>
--json`; do not pick for them.

Exit codes follow the runtime's uniform contract: `0` complete, `1` a finding you must report to the
user, `2` a usage or resolution error. **Branch on `status`, not on the presence of output** — a
`BLOCKED` run still writes `MANIFEST.md`, because a report naming what it could not read is more
useful than no report at all.

What the generator does, so you can read its output rather than guess at it:

1. **Reads all three artifacts** and records each one's SHA-256 in `MANIFEST.md`. A missing one, or
   a `plan.md` with no parseable task list, is `BLOCKED`: no source files are written.
2. **Builds the traceability chain** — a task's `[US#]` resolves through `requirement.md`'s FR index
   to its requirements, and through `design.md` §3 to the components serving them. That chain is
   what puts a real FR / component / task in every file header instead of a generic banner.
3. **Mirrors the intended source layout** from every task's `files:` value into `scaffold/src/`,
   keeping each path exactly as the plan wrote it and appending `.stub`. In a repository whose code
   already lives in `src/`, that reads as `scaffold/src/src/runtime/thing.js.stub`; the doubling is
   deliberate, so a path can never collide with `MANIFEST.md` or `contracts/`.
4. **Emits per-file frames** in the language of the file's own extension — the plan already stated
   it, so nothing is inferred. Where `design.md` §4 declares an interface for the file's component,
   that block is carried through verbatim as a quoted comment; where it does not, the file gets one
   clearly labelled placeholder signature and is listed under **Emitted without a declared shape**.
   No API nobody wrote down is ever invented.
5. **Emits test stubs** from `requirement.md`'s acceptance criteria, one file per requirement. Each
   stub fails until implemented, deliberately: a stub that passes asserts nothing and reads as
   coverage. The stub language comes from the repository's own manifest, detected by
   `command-detect.js` — the same detector the verification engine uses, not a second one.
6. **Protects hand edits.** Every generated file carries a fingerprint of its own body. A body that
   no longer matches, or a file with no fingerprint at all, is treated as hand-authored: reported
   under **Preserved**, never rewritten. This includes `MANIFEST.md` — delete it to refresh it.
   Files from an earlier run that the plan no longer implies are reported as **Orphaned** and left
   in place; deleting work someone may have started is the worse failure.

### What Part 1 does not cover

Named here rather than discovered later, because each one appears in `MANIFEST.md` as a skip and a
reader is entitled to know whether it is a gap or a decision:

- **Content files.** Markdown, YAML, JSON and the rest have no signature to emit. Skipped benignly;
  they do not affect the exit code.
- **Directories.** A `files:` value naming a directory has no single signature behind it.
- **Languages with no emitter.** The generator emits JavaScript, TypeScript, Python, Go and Rust.
  Java, Kotlin, C#, Swift and Objective-C are covered by Part 2's Default-Implementation Grammar,
  which you execute, but not by the generator; shell and everything else are covered by neither.
  Each case is skipped with its own wording and pushes the run to a non-zero exit, because a plan
  whose main language the generator cannot emit has not been scaffolded in any useful sense.
- **Applying the scaffold.** Moving anything into the source tree stays a deliberate human act, or
  `/do-execute-plan`'s ordinary job. Nothing here promotes itself.

## Part 2 — external dependencies (cross-service contract frames)

For every `depends-on:` value `MANIFEST.md` dispositions as `external`. Steps are numbered within
this Part; `scaffold/contracts/<service>/` is the only place any of it may write.

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
   produces no contract for that dependency — reported to the user as an advisory notice naming
   the skipped dependency, not an error. This works in any consuming repo's directory
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
     - has an `external-contract:` field on the same task → **documented dependency**, routed to
       step 5's external-contract generation path (below) instead of local language inference,
       which has nothing to scan. That is what the field name states: no local repo exists, so the
       document is the only contract there is.
     - no `external-contract:` → excluded entirely, same as today — no contract generated, surfaced
       via the existing advisory notice, not an error.

   A non-local dependency name can be referenced by more than one task, same as a local one
   (`manifest.yaml`'s `source_task_ids` already supports multiple contributing tasks) — treat every
   task naming the same non-local value as one entity, not one per task. Their `external-contract:`
   fields MUST agree: either all of them set to the same target, or none of them set at all. If
   they disagree (some set, some not; or set to different targets), surface an explicit warning
   naming the conflicting tasks and their differing `external-contract:` values — never silently
   pick one, same "don't guess" posture as everywhere else in this algorithm.

   An `external-contract:` field set on a task whose `depends-on:` value *does* resolve to a local
   identity (a "dependency (local)" case, not non-local) is simply unused — local dependencies are
   generated from the local repo, never from a doc, regardless of whether `external-contract:` is
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
   `agent-docs/doflow/<slug>/scaffold/contracts/<service>/manifest.yaml` (always under the active feature's
   own dir — never elsewhere). `generation_hash` covers source task text *and* the inferred
   language *and* which signal produced it (manifest file vs. extension-frequency) *and*
   `default/`'s generated content — a change in any of the four counts as stale, not just a
   task-text change:
   - **Doesn't exist** → generate, in the inferred language:
     `code/` — an interface/client declaration with the method signature(s) implied by the
     consuming task's `depends-on:` relationship (a clearly-labeled placeholder signature if not
     enough information exists to infer one) — signatures only, zero implementation.
     `data/` — native-language type/DTO declarations for the referenced data shape(s) — fields
     only, no schema file.
     `mock/` — an unfilled skeleton mirroring `code/`'s interface shape — signature-only, same as
     `code/`, not a working fake with canned responses.
     `default/` — a compilable **default implementation** of `code/`'s interface, so a reviewer (or
     the consuming task's own code) has something to read/compile against immediately, not just a
     shape to hand-implement first: one file per `code/` interface file, same naming convention,
     every method resolving to a single pinned, language-family-specific "not implemented" signal
     (see the Default-Implementation Grammar table below) — never real business logic, never a
     guessed behavior. Generated only when `inferred_language` resolves to a real language; the
     pseudocode fallback immediately below covers `code/`/`data/`/`mock/` but never `default/` —
     pseudocode has no execution semantics to carry a "not implemented" signal, so an
     `inferred_language: unresolved` service gets no `default/` artifact at all, not a pseudocode
     stand-in.

     **Default-Implementation Grammar** — one pinned rule per language family (never invented per
     service), each producing an explicit, idiomatic "not implemented" signal and nothing else. The
     message text is a fixed template (`"<Service> default implementation — not implemented"`,
     substituted only with the service name) so two generations of the same interface produce
     byte-identical output:

     | Language family | Mechanism | Example shape |
     |---|---|---|
     | Java / Kotlin | throw an unchecked "unsupported operation" exception | `throw new UnsupportedOperationException("<Service> default implementation — not implemented")` |
     | JavaScript / TypeScript | throw an `Error` | `throw new Error("<Service> default implementation — not implemented")` |
     | Python | raise `NotImplementedError` | `raise NotImplementedError("<Service> default implementation — not implemented")` |
     | C# | throw `NotImplementedException` | `throw new NotImplementedException("<Service> default implementation — not implemented")` |
     | Swift | trap via the language's fatal-error function | `fatalError("<Service> default implementation — not implemented")` |
     | Objective-C | trap via an always-failing assertion | `NSAssert(NO, @"<Service> default implementation — not implemented")` |
     | Rust | the language's own "unimplemented" macro | `unimplemented!("<Service> default implementation — not implemented")` |
     | Go (no exceptions — idiomatic error return, not a trap) | zero value + non-nil error | `return <zero-value>, errors.New("<Service> default implementation — not implemented")` |

     This table's language-family set is exactly step 4's existing manifest-detection set
     (`pom.xml`/`build.gradle`→Java/Kotlin, `package.json`→JS/TS, `Package.swift`/`Podfile`→
     Swift/Objective-C, `Cargo.toml`→Rust, `go.mod`→Go, `pyproject.toml`/`requirements.txt`→Python,
     `*.csproj`→C#) — no language reaches `default/` generation that step 4 doesn't already resolve
     to, so this table never needs a language step 4 itself doesn't cover.

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
     source: local-inference               # local-inference | external-contract (documented dependencies, below)
     integration_style: network            # network | in-process
     inferred_language: java               # or "unresolved" if inference failed
     inference_signal: build.gradle        # which manifest file, "extension-frequency", or "none" if unresolved
     generated_from_plan: agent-docs/doflow/<slug>/plan.md
     source_task_ids: ["T-004", "T-007"]   # plan.md tasks whose depends-on: produced this entry
     generation_hash: <sha256 of source_task_ids' full task text + inferred_language + inference_signal + default/'s generated content>
     generated_at: <ISO-8601 timestamp>
     ```
   - **Exists, `generation_hash` matches** → skip (already current).
   - **Exists, `generation_hash` mismatches** (source tasks, inferred language, inference signal, or
     `default/`'s generated content changed since last generation — including a manifest generated
     before `default/` existed at all) → do NOT auto-overwrite; surface a warning naming the service
     and stale manifest path so the user can reconcile manually — the existing
     `code`/`data`/`mock`/`default` content may hold manual edits that a silent regeneration would
     destroy.

   **Documented dependencies** (an `external-contract:` field is present — step 2's non-local case)
   are
   generated the same way, in the same `manifest.yaml`-driven three-outcome shape, but from a
   different source — the `external-contract:` target, not local repo scanning (there is none to scan):
   - **Doesn't exist** → first validate the `external-contract:` target: does it contain a `## Methods`
     section with at least one grammar-conformant `interface` block (the same grammar as the
     pseudocode example above)? `## Types` must also be present.
     - **Not compliant** (missing `## Methods`, missing `## Types`, or `## Methods` has no valid
       `interface` block) → surface an explicit warning naming the dependency, the `external-contract:`
       path, and what's missing — no frame generated. Never silently skip without saying why, and
       never generate a frame from a doc that doesn't meet the bar.
     - **Compliant** → parse `## Methods` (→ `code/`) and `## Types` (→ `data/`); if `## Webhook`
       is present, its type block is also written into `data/`, alongside (not merged with) the
       `## Types` blocks — a webhook payload is still just a data shape, not a new artifact
       category, but its declaration stays textually separate from `## Types`' own blocks. A
       `## Webhook` type sharing a name with a `## Types` block is an `external-contract:` authoring
       error (a naming collision the doc author must avoid); this algorithm does not attempt to
       detect or rename it. Infer the *rendering* language from the **consuming task's own repo**
       — reuse step 4's manifest-detection logic starting from the consumer's `files:` path,
       walking up *all the way to and including* the consuming repo's own root this time (unlike
       step 1's identity derivation, which stops short of it — that exclusion exists to prevent
       multiple *service identities* from colliding on the repo root, a concern that doesn't apply
       to language detection at all: many root-level tasks correctly sharing "this repo's own
       language" is the right outcome, not a collision). Render `code/`, `data/`, `mock/` in that
       language — or in this step's pseudocode grammar if even the consuming repo's own root has
       no recognizable manifest — same zero-implementation, signature/shape-only rule `code/`,
       `data/`, and `mock/` share everywhere else in this algorithm (`default/`, next, follows a
       different rule); `mock/` mirrors `code/`, unfilled, same rule as always. Also render
       `default/` in that same resolved language, using the
       Default-Implementation Grammar table above, applying the same exclusion it already states:
       skip `default/` entirely (not a pseudocode stand-in) when even the consuming repo's own root
       has no recognizable manifest. Also write `manifest.yaml`:
       ```yaml
       service: notification-vendor              # the literal depends-on: value; no local path to derive from
       source: external-contract
       external_contract_path: agent-docs/doflow/<slug>/notification-vendor-api.md
       integration_style: network                 # always, per step 3 — no local repo, never in-process
       inferred_language: java                     # the CONSUMING task's inferred language, not the dependency's
       inference_signal: build.gradle              # same step-4 signal, applied to the consumer's repo
       generated_from_plan: agent-docs/doflow/<slug>/plan.md
       source_task_ids: ["T-004"]
       generation_hash: <sha256 of source_task_ids full task text plus the external-contract target's full file content plus inferred_language plus default/'s generated content>
       generated_at: <ISO-8601 timestamp>
       ```
   - **Exists, `generation_hash` matches** → skip (already current) — same rule as above.
   - **Exists, `generation_hash` mismatches** (source tasks, the `external-contract:` target's content,
     the consumer's inferred language, or `default/`'s generated content changed since last
     generation — including a manifest generated before `default/` existed at all) → do NOT
     auto-overwrite; same warn-don't-clobber rule as above — a doc edit is real drift and must be
     caught, not silently missed.

6. **Report** — N services generated, M skipped (already current), K flagged stale (mismatch, not
   overwritten), the in-scope services with no contract generated (expected outcome, not an error),
   and, separately, J documented-dependency frames generated from `external-contract:` (step 5's
   "Documented dependencies" case) — state this breakdown explicitly so a documented-dependency
   frame doesn't read as an ordinary local-inference one, or vice versa. Also state, separately
   again, how many of the generated/current services got a `default/` artifact vs. how many were
   skipped because `inferred_language` is `unresolved` (step 5's pseudocode-fallback case never
   producing `default/`) — a `default/`-skip is an expected outcome of that case, not an error,
   but must be named so it doesn't read as an omission.

## Constraints (carried from the design — do not relax these)

The first applies to both Parts. Every other constraint here is Part 2's, and its bare step numbers
are Part 2's steps — Part 1's equivalents are enforced by `src/runtime/scaffold/generate.js` and its guard
rather than restated as prose.

- Never write outside `agent-docs/doflow/<slug>/scaffold/` — not into the source tree, and not
  into a target service's own repo (including the dependency service scanned for language
  inference in Part 2 step 4 — read-only). This is the one property the whole artifact rests on, and
  `test/guards/scaffold.test.js` enforces it by running the generator against a filesystem that can
  only reach the feature directory.
- `code/`/`data/`/`mock/` content is pinned, not freeform: signatures and type/data shapes only,
  zero implementation logic — in the inferred language, or the pinned generic-pseudocode grammar
  (`.pseudo` files, step 5) when language inference fails. `mock/` mirrors `code/`'s interface
  shape; it is not a working fake, in either case.
- `default/` content is pinned too, but under a different rule than `code/`/`data/`/`mock/`: zero
  *real* implementation, not zero implementation, period — every method body is one fixed,
  language-family-specific "not implemented" signal (the Default-Implementation Grammar table,
  step 5), never freeform, never a guessed behavior, and never generated at all for the
  pseudocode-fallback case (no `.pseudo` equivalent — step 5 states this explicitly).
- Service-boundary detection (Part 2 step 1) is walk-up-based (nearest `.git` or manifest ancestor, or
  the starting directory itself — from a `files:` path or a `depends-on:` value alike — as a
  last-resort fallback) — never a fixed list of named root directories, so Part 2 works in any
  consuming repo's layout. Known accepted
  limitation: two dependencies that both lack any `.git`/manifest signal can fall back to distinct
  but nested directories (e.g. `legacy/mod` and `legacy/mod/util`), generating two separate
  `contracts/` entries for what may be one logical service — no automatic consolidation; this is
  the same class of ambiguity NFR-002 already accepts elsewhere in Part 2 rather than
  guessing. Sharper case of the same limitation: if a nested fallback identity's final path
  segment is literally `code`, `data`, `mock`, or `default` (e.g. `legacy/mod` and
  `legacy/mod/code`), the inner service's `manifest.yaml` lands inside the outer service's own
  generated `code/`/`data/`/`mock/`/`default/` output directory — still not a write outside
  `agent-docs/doflow/<slug>/scaffold/` (the first Constraint above still holds), but visually
  confusing; not auto-detected or renamed.
- The one hard gate is `do-execute-plan` step 1 (`"$DOFLOW" prereqs --require-plan`) — neither Part
  of this file adds a gate of its own. The advisory notice Part 2 raises for a dependency it cannot
  resolve is non-blocking, and Part 1's non-zero exit is a finding to report, not a stop.
- A `depends-on:` value whose starting directory does not exist on disk at all is excluded from
  service-identity derivation *entirely* (Part 2 step 1) — it never reaches Part 2 step 5's local
  generation path. It gets a frame only if the same task also carries an `external-contract:` field
  (step 2's
  "documented dependency" case); with neither, it stays silently skipped, same as today's default.
- `external-contract:` targets MUST follow the pinned structure in
  `templates/doflow/external-contract-template.md` — a `## Methods` section with at least one
  grammar-conformant `interface` block, plus a `## Types` section (`## Webhook` is optional). A
  non-compliant target gets an explicit warning, never a silently-empty or guessed frame — Part 2
  does not attempt free-form prose extraction anywhere.
- A documented dependency's frame renders in the *consuming* task's own inferred language (Part 2
  step 4,
  reused unchanged, applied to the consumer's repo) — never a language inferred from the
  dependency itself, which has no local repo to infer one from.