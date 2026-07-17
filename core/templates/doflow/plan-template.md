# Implementation Plan: [FEATURE NAME]

**Feature:** [NNN-slug] · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** [DATE]

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.

## 1. Approach
[Chosen approach in 2–4 sentences; the key technical decisions.]

## 2. Constitution Check (GATE)
> Verify against the resolved constitution (base + local). Any violation = STOP and revise
> the approach before continuing. (Advisory by default; not the hard hook gate.)
- [ ] Complies with [PRINCIPLE]: [how]
- [ ] No violation of [PRINCIPLE]: [how]

**Result:** PASS / FAIL — [note]

## 3. Research & Decisions
- **D1:** [decision] — resolves [NEEDS CLARIFICATION: …]; rationale: [evidence].

## 4. Components & Changes
- [component] → [change]; files: [paths]

## 5. Data / Contracts
[schema, API, or interface pointers — or "N/A".]

## 6. Risks & Mitigations
- [risk] → [mitigation]

## 7. Validation Strategy
[how each FR/NFR is verified — tests, manual checks, gates.]

## 8. Tasks
> Dependency-ordered. `[P]` = parallel-safe with its phase siblings. `[US#]` = traces to a
> user story in requirement.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact. `depends-on:` is optional — set it when a task
> depends on an external service that has no owning task in this same plan (not a service also
> touched by another task here); `/do-execute-plan --contracts` reads it to know which services
> need a code frame generated. `contract-doc:` is also optional — set it alongside `depends-on:`
> only when that dependency has no local repo (a vendor API, a SaaS integration) but *does* have a
> documented contract; points to a doc built from `templates/doflow/contract-doc-template.md`, and
> tells `--contracts` to generate a real frame from it instead of silently skipping a non-local
> dependency (the default when no `contract-doc:` is set — not every dependency needs one).

### Repo Branch Plan
> Populate when this plan spans 2+ repos (a container workspace, not a monorepo) — derive `Repo`
> from each task's `files:` path *and* each task's `depends-on:` value the same way, by walking up
> to the nearest enclosing `.git` (a `depends-on:` value that resolves to no `.git` is skipped, not
> guessed); derive `Planned Branch` from `requirement.md`'s `**Ticket:**`
> field + this feature's slug (`feat/<TICKET>-<slug-description>`, or `feat/<slug>` if no ticket is
> recorded); `Role` is `primary` (owns a task here) or `dependency-only` (referenced only via
> `depends-on:`). For a single-repo plan, write "N/A: single-repo feature" instead of the table.

| Repo | Planned Branch | Role |
|---|---|---|
| [repo path] | `feat/[branch]` | primary |

### Phase A — [name]
- [ ] A.1 [P] [US1] [task] — owner: [agent]; files: [paths]; depends-on: [service, optional]; contract-doc: [doc path, optional]
- [ ] A.2 [US1] [task, depends A.1] — owner: [agent]; files: [paths]; depends-on: [service, optional]; contract-doc: [doc path, optional]

### Phase B — [name]
- [ ] B.1 [P] [US2] [task] — owner: [agent]; files: [paths]; depends-on: [service, optional]; contract-doc: [doc path, optional]

### Checkpoints
- After Phase A: [validation step]; commit `[message]`

### Completion criteria
- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
