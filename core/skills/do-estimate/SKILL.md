---
name: do-estimate
description: "Provide development estimates for tasks, features, or projects with intelligent analysis"
when_to_use: Trigger automatically for read-only time, effort, complexity, scope, risk, or resource estimates. Stop after the estimate; do not start planning or implementation.
argument-hint: "[target] [--type time|effort|complexity] [--unit hours|days|weeks] [--breakdown]"
disable-model-invocation: false
user-invocable: true
effort: low
---

# do-estimate

Read-only estimate — stops after producing the number(s), never continues into planning or
implementation.

## Invocation
```text
/do-estimate [target] [--type time|effort|complexity] [--unit hours|days|weeks] [--breakdown]
```

## Behavioral Flow
1. **Scope `[target]`**: if it's an existing `requirement.md`/`plan.md` (a doflow feature), estimate
   against its actual user stories/tasks, not a re-description. If it's a freeform description,
   decompose it into the same shape first (rough FR list) so the estimate has something concrete
   to size.
2. **Size each piece** by `--type`:
   - `time`/`effort`: compare each piece against similar work already in this repo (git log for
     comparable past changes gives a real anchor, not a guess) plus known unknowns (new
     dependency, unfamiliar area of the codebase, external approval needed).
   - `complexity`: rate each piece low/medium/high based on concrete factors — number of files
     touched, cross-repo/cross-service span, whether it's additive or requires understanding
     existing behavior first.
3. **State the confidence band**, not a single number: a range plus what would narrow it (e.g.
   "3-5 days; narrows to 3 once the API contract is confirmed with the external-bank-service
   owner"). A point estimate without a stated confidence level is not acceptable output here.
4. **`--breakdown`**: show the per-piece estimates that sum to the total, not just the total.
5. **Report and stop** — do not proceed into `/do-plan` or `/do-implement` even if the estimate
   suggests the work is small; that decision belongs to the user.

## Boundaries
**Will:** produce a scoped, confidence-banded estimate anchored to comparable past work in this
repo where available; break down by piece under `--breakdown`.
**Will Not:** start planning, implementation, or any file edit; present a single point number
without a stated confidence range; commit the user to a timeline.

## Next Step
User decides whether to proceed — `/do-plan` for a doflow feature's implementation plan, or
`/do-implement` for a standalone build.
