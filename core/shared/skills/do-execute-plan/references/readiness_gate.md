# Task Readiness Gate

Pre-implementation contract gate. **The contract is defined by
`core/registry/readiness-templates.yaml` and evaluated by the readiness engine — query it, don't
recall it.** Requirement ids and class names below are reproduced for orientation only; when this
page and the command disagree, the command is right.

```bash
doflow readiness --task-class <class> --task-id <id>     # human-readable report
doflow readiness --task-class <class> --task-id <id> --json
doflow evidence  --task-id <id>                          # what has been recorded so far
```

Run it from the project the task belongs to: evidence is per-project state under that repo's
`.doflow/state/`, not global.

## Task classes

Pass the **key**, not the display name — `--task-class feature`, not `"New Feature"`.

| Key | Contract | Requirements |
| :--- | :--- | :--- |
| `bug` | Bug Fix Readiness | `reproduction`, `affected_code`, `root_cause`, `blast_radius`, `regression_verification` |
| `feature` | Feature Implementation Readiness | `scope_clear`, `affected_components`, `verification_plan` |
| `refactor` | Refactoring Readiness | `architecture_mapped`, `invariants_captured`, `baseline_tests`, `blast_radius` |
| `trivial-edit` | Trivial Edit Readiness | `target_identified`, `scope_verified` |
| `dependency-change` | Dependency Change Readiness | `compatibility_checked`, `usage_impact`, `verification_command` |

An unknown class exits 1 and lists the valid keys, so a typo fails loudly rather than silently
evaluating the wrong contract.

## Reading the report

Each unmet requirement carries a `recommendedAction` naming the **capability** that would satisfy
it — for example `blast_radius` recommends `code.impact-analysis`. Resolve that capability through
the router (`doflow capabilities`) to find the tool actually available here, then gather that
evidence. The gate tells you what is missing *and* how to go get it.

| State | Meaning | What to do |
| :--- | :--- | :--- |
| `READY` | Every mandatory prerequisite is verified by fresh evidence | Proceed. |
| `NEEDS_EVIDENCE` | Contract understood, prerequisites not yet established | Gather the named evidence first. Do not start editing on the assumption it will work out. |
| `BLOCKED` | A prerequisite cannot be satisfied | Stop. Never modify source while blocked; surface why. |

The engine fails closed: a requirement it cannot evaluate reads as unmet, not satisfied. A gate that
guesses in its own favour is worse than no gate, because it reports confidence it never earned.

## Current limitation — read before relying on `READY`

Nothing writes to the evidence ledger yet. `EvidenceLedger.addEvidence()` and `.save()` exist and
are tested, but no command, hook, or script calls them, so `doflow readiness` will report
`NEEDS_EVIDENCE` for evidence-backed requirements no matter how much work has actually been done.

Treat the command as the authoritative statement of *what the contract requires* — that part is
real and worth running — and satisfy those requirements through your own investigation, recording
findings in the task's report. Do not interpret a persistent `NEEDS_EVIDENCE` as a reason to halt
indefinitely; interpret it as the checklist it is.
