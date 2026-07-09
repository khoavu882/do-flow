# Tasks: [FEATURE NAME]

**Feature:** [NNN-slug] · **Plan:** ./plan.md · **Created:** [DATE]

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings. `[US#]` = traces to a
> user story in spec.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact.

## Phase A — [name]
- [ ] A.1 [P] [US1] [task] — owner: [agent]; files: [paths]
- [ ] A.2 [US1] [task, depends A.1] — owner: [agent]; files: [paths]

## Phase B — [name]
- [ ] B.1 [P] [US2] [task] — owner: [agent]; files: [paths]

## Checkpoints
- After Phase A: [validation step]; commit `[message]`

## Completion criteria
- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
