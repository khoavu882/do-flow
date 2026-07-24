---
name: do-implement
description: "Feature and code implementation, standalone (outside the doflow chain)"
argument-hint: "[feature-description] [--type component|api|service|feature] [--framework react|vue|express] [--safe] [--with-tests]"
disable-model-invocation: true
effort: high
---

# do-implement

Standalone "just build this" entry point — for a feature small enough not to warrant the full
doflow chain. If `agent-docs/doflow/<slug>/plan.md` already exists for this work, use
`/do-execute-plan` instead — it consumes that plan's task checklist; this skill has no plan to
consume and would duplicate that work from scratch.

## Invocation
```text
/do-implement [feature-description] [--type component|api|service|feature] [--framework react|vue|express] [--safe] [--with-tests]
```

## Behavioral Flow
1. **Detect context**: existing framework/language conventions in the target area (not assumed —
   read a neighboring file first), `--framework` overrides detection when given. Check
   `CLAUDE.md`/`ARCHITECTURE.md` for stated conventions before introducing a new pattern.
2. **Confidence-check gate**: this is implementation-class work — the `confidence-check` skill's
   pre-implementation gate applies before any file is written, same as any other edit.
3. **Plan the change** at the size implied by `--type`: `component`/`api` — single-area change;
   `service`/`feature` — likely spans multiple files, decompose first (if it turns out to span
   more than a handful of files or multiple repos, that's a signal this should have gone through
   `/do-brainstorm` → `/do-plan` instead — say so rather than pushing through).
4. **Generate code** matching the detected/specified framework's actual conventions (real
   patterns from this codebase, not generic scaffolding) — no `TODO`/`throw new Error("not
   implemented")` stubs; a partial feature is not a deliverable (RULE_02_WORKFLOW).
5. **`--with-tests`**: write tests alongside the implementation, covering the new behavior's
   success path and at least one edge case — not deferred to a later step.
6. **`--safe`**: run existing tests/build before considering the change complete; without it,
   still report what validation was and wasn't run, rather than implying full verification.
7. **Report**: files changed, what was and wasn't tested, and any scope-size flag from step 3.

## Boundaries
**Will:** implement a standalone feature/component/API using this codebase's actual conventions;
pass through `confidence-check` before edits; write tests under `--with-tests`.
**Will Not:** make an architectural decision that contradicts `ARCHITECTURE.md`/`CLAUDE.md`
without flagging the conflict first; leave a stub/partial implementation as "done"; silently
absorb work that's really multi-repo or multi-phase enough to need `/do-brainstorm`/`/do-plan`
instead.

## Next Step
`/do-test` to run the test suite, then `/do-git` to commit — or `/do-code-review` first if the
change is large enough to warrant a review pass.
