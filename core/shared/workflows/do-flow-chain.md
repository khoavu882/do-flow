---
description: Run the DoFlow spec-driven delivery chain on an idea
---

When the user types `/do-flow-chain <idea>`, orchestrate DoFlow's installed skills as one
delivery sequence, pausing where human judgment matters:

1. Act as the discovery lead and run `/do-brainstorm` with `<idea>` to produce
   `requirement.md`. Wait for the user to confirm the requirement before continuing.
2. Run `/do-design` to turn the confirmed requirement into `design.md`.
3. Run `/do-plan` to decompose the design into a dependency-ordered `plan.md`.
4. Ask the user to review all three specifications. Only proceed on explicit approval.
5. Execute `/do-execute-plan --scope next` repeatedly until the plan's checklist is complete.
6. Run `/do-test`, then `/do-code-review`, and report both results before proposing any commit.

If the user comments directly inside any specification file, re-read it, apply the requested
changes, and ask for approval again before moving on.
