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
> `/do-execute-plan` — keep the markers intact.

### Phase A — [name]
- [ ] A.1 [P] [US1] [task] — owner: [agent]; files: [paths]
- [ ] A.2 [US1] [task, depends A.1] — owner: [agent]; files: [paths]

### Phase B — [name]
- [ ] B.1 [P] [US2] [task] — owner: [agent]; files: [paths]

### Checkpoints
- After Phase A: [validation step]; commit `[message]`

### Completion criteria
- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
