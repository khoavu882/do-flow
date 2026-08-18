---
name: do-diagnose
description: "Unified diagnostic and code remediation engine — root cause analysis, performance profiling, security auditing, and targeted refactoring. Use when something is broken, slow, insecure, or needs cleanup and the user wants root-cause evidence before any fix, or says 'why is this crashing' / 'this endpoint feels slow' / 'audit this for security issues' rather than asking for a brand-new feature."
argument-hint: "[target|issue] [--type bug|perf|security|refactor] [--focus quality|security|performance|architecture] [--iterations n] [--validate] [--trace] [--fix]"
effort: medium
---

# do-diagnose

Unified diagnostic and code improvement engine. Replaces separate analyze/troubleshoot/reflect/improve tools with a single evidence-first diagnostic workflow.

## Invocation
```text
/do-diagnose [target|issue] [--type bug|perf|security|refactor] [--focus quality|security|performance|architecture] [--iterations n] [--validate] [--trace] [--fix]
```

## Behavioral Flow

1. **Resolve the Runtime Seam**:
   - Every DoFlow runtime call in this skill goes through the seam. Resolve it **once** here and
     reuse `$DOFLOW` for every later call in this skill:
     ```bash
     # Resolve the DoFlow runtime: nearest project install wins, then the global one.
     D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
     DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
     "$DOFLOW" paths --json
     ```
     The walk-up starts at the working directory, so run every command in this skill from the
     project root. Exit 2 means no runtime was found; the message names every place searched —
     surface it verbatim and stop, do not go looking yourself.

2. **Propose the Task Class; the Runtime Validates It**:
   - `--type` names the *investigation mode* below, not the task class. Propose the class
     separately, as exactly one id:
     ```bash
     "$DOFLOW" classify --task-class "<proposed>" --json
     ```
   - Branch on the returned `outcome` field, not on the exit code. **`ACCEPTED`** → the returned
     `workflow` is this run's plan of record, and this skill is one of its analysis stages
     (`root-cause` for `bug`, `architecture-mapping` for `refactor`, `usage-impact` for
     `dependency-change`). **`REJECTED`** → **stop**, print `message` verbatim, ask the user to
     choose from `validClasses`, and re-validate. Never substitute `feature`, never retry with a
     guess. **Exit 2** → surface the message verbatim and stop.
   - `perf` and `security` are `--type` values, **not** declared classes: proposing either gets a
     `REJECTED` outcome, correctly. A performance or security investigation is classed by what the
     work is — `bug` when behavior is wrong now, `refactor` when structure changes with behavior
     held fixed, `research` when the deliverable is a written answer.
   - Every stage this skill serves declares `readinessTemplate: null`. Do **not** call `readiness`
     while diagnosing, and do not report one as skipped.

3. **Classify Intent & Scope (`--type`)**:
   - `bug` (default if reproducing error): Reproduce issue, isolate cause via stack traces/diffs, formulate hypothesis. Consult `references/root_cause.md`.
   - `perf`: Profile execution, detect hot paths, identify algorithmic complexity ($O(n^2)$) or N+1 queries.
   - `security`: Static scan for secrets, unsanitized inputs, auth gaps, or vulnerability signatures. Consult `references/code_audit.md`.
   - `refactor`: Identify dead code, code smells, god functions, and structure cleanups. Consult `references/refactoring.md`.

4. **Evidence-First Diagnosis**:
   - Confirm root cause with concrete evidence before proposing any changes.
   - Propose ranked fix options with blast-radius ratings (Low / Medium / High).
   - Resolve each retrieval need through the router rather than reaching for a habitual tool:
     `"$DOFLOW" route --intent <locate-known-symbol|locate-concept|trace-dependency|estimate-blast-radius|inspect-history|verify-runtime-behavior> --json`.

5. **Batch This Stage's Evidence**:
   - One pass at the end of the diagnosis, never one call per finding. `<task id>` is the unit these
     stores key on: the plan task id when one exists, otherwise the feature slug or the issue id you
     are diagnosing. Use the same id for every `evidence`, `claim` and `readiness` call in the run.
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
     "$DOFLOW" claim --task-id "<task id>" --action add --statement "<the root cause, in one sentence>"
     ```
   - The batch file is a JSON array, one object per item (scratch input — delete it after the
     write), validated whole: one rejected item writes nothing, so a half-written diagnosis never
     reads as complete. Per item: `kind` (`exact-search`, `semantic-retrieval`, `structural`,
     `historical`, `documentation`, `test-result`, `runtime-observation`, `user-statement`, `diff`,
     `generated-analysis`), `provenance` (`extracted` | `inferred` | `asserted`, with **no
     default** — an unstated one is refused rather than filed as repository fact), and `source`
     (`provider` + `capability`, no `unknown` stand-in). `extracted` needs a `locator`; `inferred`
     and `asserted` need `content`; `generated-analysis` and `user-statement` can never be
     `extracted`. `id`, `freshness`, `supports`/`contradicts`, `stage` and any score field are
     refused by name.
   - The same items are the diagnosis you report: what was observed, its source (the provider +
     capability the router selected, or the exact command run), its locator, and whether it is
     **extracted** (a stack frame, a log line, a test result, a diff hunk) or **inferred** (your
     reading of them). Never merge those two provenances into one line — a diagnosis is where
     inference most easily passes for observation.
   - The root cause enters as a claim and is stored as a `hypothesis`. It becomes supported only
     through linked evidence, recorded after the batch lands:
     ```bash
     "$DOFLOW" claim --task-id "<task id>" --action link --claim-id "<claim id>" --evidence-id "<evidence id>" --relation supports
     ```
     An evidence id the ledger does not hold is refused (exit 2), not graded — so write the batch
     first, then link. A plausible story that explains the symptom is not support, and a symptom
     reproducing is evidence of the symptom, not of the cause.
   - Relevance is not confidence. A match count, a profiler's ranking, a "top hot path" is a
     property of the query, not of the fact — record the locator and the measurement, never a score,
     a percentage, or a confidence.

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

7. **Iteration & Validation (`--iterations`, `--validate`)**:
   - `--iterations [n]`: repeat steps 3–5 for the given cycle count, re-diagnosing after each remediation pass.
   - `--validate`: run a pre-execution risk assessment and require explicit confirmation before remediating production or shared infrastructure.

## Boundaries
**Will:** Propose a task class and have the runtime validate it, reproduce active issues, perform
multi-domain static/runtime audits, batch the stage's evidence and claims, and rank remediation
strategies.
**Will Not:** Apply edits without `--fix` and explicit confirmation; bypass or disable tests to
force passing status; diagnose under a class the runtime rejected or replaced with `feature`; call
`readiness` for an analysis stage that declares no template, or for a class that has none; report a
root cause, evidence or readiness as a number, a percentage or a confidence.
