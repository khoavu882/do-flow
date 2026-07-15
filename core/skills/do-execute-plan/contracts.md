# `--contracts` — cross-service contract scaffolding

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

4. **Per dependency service, three outcomes** based on
   `agent-docs/doflow/<slug>/contracts/<service>/manifest.yaml` (always under the active feature's
   own dir — never elsewhere):
   - **Doesn't exist** → write `agent-docs/doflow/<slug>/contracts/<service>/{code,data,mock}/`
     (empty scaffold — content
     freeform, loosely guided by `integration_style`, not generated here) plus `manifest.yaml`:
     ```yaml
     service: sources/otp-service          # derived service identity
     integration_style: network            # network | in-process
     generated_from_plan: agent-docs/doflow/<slug>/plan.md
     source_task_ids: ["T-004", "T-007"]   # plan.md tasks whose depends-on: produced this entry
     generation_hash: <sha256 of source_task_ids' full task text>
     generated_at: <ISO-8601 timestamp>
     ```
   - **Exists, `generation_hash` matches** the current source tasks' full text → skip (already
     current).
   - **Exists, `generation_hash` mismatches** (source tasks changed since last scaffold) → do NOT
     auto-overwrite; surface a warning naming the service and stale manifest path so the user can
     reconcile manually — the existing `code`/`data`/`mock` content may hold manual edits (NFR-002
     of `agent-docs/doflow/001-execute-plan-contracts-scaffold/requirement.md`).

5. **Report** — N services scaffolded, M skipped (already current), K flagged stale (mismatch, not
   overwritten), and the in-scope services with no contract generated (expected outcome, not an
   error — state this explicitly so it doesn't read as a bug).

## Constraints (carried from the design — do not relax these)
- Never write outside `agent-docs/doflow/<slug>/contracts/` — never into a target service's own
  repo.
- Never prescribe exact file contents inside `code/`/`data/`/`mock/` — only the scaffold (folders +
  manifest) is this algorithm's job.
- The one hard gate is step 2 (`do-prereqs.sh --require-plan`) — this algorithm does not add a new
  gate; the advisory notice in step 5 ("Select work") is non-blocking.
