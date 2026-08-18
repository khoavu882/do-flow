---
name: do-diagnose
description: "Unified diagnostic and code remediation engine — root cause analysis, performance profiling, security auditing, and targeted refactoring. Use when something is broken, slow, insecure, or needs cleanup and the user wants root-cause evidence before any fix, or says 'why is this crashing' / 'this endpoint feels slow' / 'audit this for security issues' rather than asking for a brand-new feature."
argument-hint: "[target|issue] [--focus quality|security|performance|architecture] [--fix]"
effort: medium
---

# do-diagnose

Unified diagnostic and code improvement engine. Replaces separate analyze/troubleshoot/reflect/improve tools with a single evidence-first diagnostic workflow.

## Invocation
```text
/do-diagnose [target|issue] [--focus quality|security|performance|architecture] [--fix]
```

## Behavioral Flow

1. **Resolve the Runtime Seam** — every DoFlow runtime call in this skill goes through the seam.
   Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```
Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

2. **Propose the Task Class; the Runtime Validates It** — the investigation mode is not a flag, it
   *is* the task class, so settle the class first. Propose exactly one id:

```bash
"$DOFLOW" classify --task-class "<proposed>" --json
```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
- **Exit 2** — surface the message verbatim and stop.

This skill is one of the accepted workflow's analysis stages — `root-cause` for `bug`,
`architecture-mapping` for `refactor`, `usage-impact` for `dependency-change`. A workflow that
declares no analysis stage is not a workflow to diagnose under: say so and re-propose the class.

   - A performance or security investigation is not its own class: it is classed by what the work
     is — `bug` when behavior is wrong now, `refactor` when structure changes with behavior held
     fixed, `research` when the deliverable is a written answer. `--focus` is what narrows such a
     run to one domain; it never changes the class.
   - While diagnosing, no stage this skill serves has a readiness template — do not call `readiness`
     and do not report one as skipped. Step 6's `--fix` path is different: it enters the validated
     class's implementation stage, which does.

3. **Derive Intent & Scope from the Accepted Class**:
   - `bug` → reproduce the issue, isolate the cause via stack traces/diffs, formulate a hypothesis.
     Consult this skill's own `references/root_cause.md`.
   - `refactor` → identify dead code, code smells, god functions, and structure cleanups. Consult
     `references/refactoring.md`.
   - `dependency-change` → map who uses the dependency and what the change reaches.
   - `--focus performance` → profile execution, detect hot paths, identify algorithmic complexity
     ($O(n^2)$) or N+1 queries, within whichever class was accepted.
   - `--focus security` → static scan for secrets, unsanitized inputs, auth gaps, or vulnerability
     signatures. Consult `references/code_audit.md`.
   - `--focus quality|architecture` → narrow to maintainability or to boundary/structure concerns.
   - With no `--focus`, investigate the whole reported symptom rather than picking a domain.

4. **Evidence-First Diagnosis**:
   - Confirm root cause with concrete evidence before proposing any changes.
   - Resolve each retrieval need through the router rather than reaching for a habitual tool:
     `"$DOFLOW" route --intent <locate-known-symbol|locate-concept|trace-dependency|estimate-blast-radius|inspect-history|verify-runtime-behavior> --json`.

**Discovery first.** One broad pass over the whole reported scope to find the terminology, the surfaces involved, and the competing readings — do not conclude here. Only then, one targeted pass per named sub-question.

Name the competing hypotheses the discovery pass turned up before you test any of them, and say
what observation would falsify each. A hypothesis that nothing could falsify is not one to spend a
retrieval on.

**Stop when** every hypothesis the contract names has an answer or a stated gap, **and** the last round produced no new hypothesis. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

   - Then propose ranked fix options with blast-radius ratings (Low / Medium / High). Those ranked
     options are the remediation plan step 6 asks the user to approve. Stops after producing them;
     never begins edits here.

5. **Batch This Stage's Evidence**:
   - One pass at the end of the diagnosis, never one call per finding. `<task id>` is the unit these
     stores key on: the plan task id when one exists, otherwise the feature slug or the issue id you
     are diagnosing. Use the same id for every `evidence`, `claim` and `readiness` call in the run.
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
     "$DOFLOW" claim --task-id "<task id>" --action add --statement "<the root cause, in one sentence>"
     ```
   - This stage's items are what the investigation observed: stack frames, log lines, test results
     and diff hunks are **extracted**; your reading of them is **inferred**. A diagnosis is where
     inference most easily passes for observation, so never merge the two into one reported line.

Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.

   - The root cause enters as a claim and is stored as a `hypothesis`. It becomes supported only
     through linked evidence, recorded after the batch lands:
     ```bash
     "$DOFLOW" claim --task-id "<task id>" --action link --claim-id "<claim id>" --evidence-id "<evidence id>" --relation supports
     ```
     An evidence id the ledger does not hold is refused (exit 2), not graded — so write the batch
     first, then link. A plausible story that explains the symptom is not support, and a symptom
     reproducing is evidence of the symptom, not of the cause.

6. **Remediation (`--fix`)**:
   - Only apply modifications when `--fix` is passed and after the user approves the remediation plan.
   - `--fix` performs the edit that the validated class's workflow places behind its implementation
     stage, so consult that same contract first — never a new one:
     `"$DOFLOW" readiness --task-class "<validated class>" --task-id "<task id>" --json`. Both flags
     are required; omitting either exits 2 and names the valid set. Branch on the `state` field
     (`READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED`) — the verb exits 0 for every
     state it computes, so a zero exit is not a green light, and none of the four is ever expressed
     as a number or a percentage. `BLOCKED` means stop.
   - All four states are reachable, so the verdict is about this task: `NEEDS_EVIDENCE` until step
     5's batch is recorded, `READY` once it covers the contract, `BLOCKED` on a claim whose evidence
     contradicts itself. **Run step 5's write before this call** — grading an empty ledger reports a
     missing diagnosis you have already done. `--verification-plan`, `--scope` and `--invariants`
     are inputs you *state*, not evidence the gate measured: the report echoes them back as
     `callerAsserted`, so pass them when true and say which requirements rest on a statement rather
     than on a record. Never write `READY` the gate did not give.
   - If the validated class has no readiness template — `review`, `research` and `operations` have
     none, and the verb exits 1 saying so — do not invent one and do not proceed anyway: the change
     is its own task under its own class. Say that and stop.
   - Verify fixes immediately by re-running tests.

7. **Iteration is Bounded by the Runtime, Not by You**:
   - After a remediation pass that does not hold, classify the failure and take the action it
     returns rather than choosing your own retry count:
     `"$DOFLOW" recover --error "<message>" --failed-check "<name>" --iteration <n> --json`.
     Exit 0 means a bounded retry is available — repeat steps 3–5 under it. Exit 1 means the loop
     must stop; report where it stopped instead of trying again.
   - Risk assessment before remediating production or shared infrastructure is step 6's readiness
     call, which always runs. There is no separate opt-in for it.
   - Every runtime call above is recorded in the run ledger as it happens; `"$DOFLOW" trace` reads it
     back. Nothing needs to be switched on for that.

## Boundaries
**Will:** Propose a task class and have the runtime validate it, reproduce active issues, perform
multi-domain static/runtime audits, batch the stage's evidence and claims, and rank remediation
strategies.
**Will Not:** Apply edits without `--fix` and explicit confirmation; bypass or disable tests to
force passing status; diagnose under a class the runtime rejected or replaced with `feature`;
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.
