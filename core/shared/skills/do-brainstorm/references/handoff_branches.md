# Step 8: branching on the handoff

Steps named here are SKILL.md's.

Branch on the response's `disposition`, not the exit code:
- **`completed`** — this stage was recorded normally; check `awaitingGate` below.
- **`annotated`** — this stage was already recorded on an earlier run of this skill (a
  re-invocation to amend `requirement.md`, say); the rerun note was appended, no gate to recheck.
- **`deferred`** — a gate ahead of this stage, an unfinished mutating stage, or a rejected run
  prevented the handoff. Discovery is the chain's first stage, so nothing before it can open a
  gate; report `reason` plainly and stop rather than resolving something that is not this
  stage's.
- **`standalone`** — no workflow applies; there is nothing further to record here.

Then the gate anchored to this stage, read directly off the same response rather than re-derived
from `workflow.gates[]`. A non-null `awaitingGate` carries the `gateId`, `name` and `prompt`
(`gate-0`, "Unresolved clarifications", in the `feature` workflow); a null one means no gate
follows this stage in this workflow and there is nothing to decide. `gate-0` is
`clarification`-kind and its `unresolved-clarifications` trigger is exactly what step 9 already
checks — so this stage resolves it rather than leaving a mechanically-answerable gate for a
human. When §7 genuinely carries zero markers, approve it plainly — this is the routine path,
never a forced one:
```bash
"$DOFLOW" orchestrate --action decide-gate --task-id "<slug>" --gate "<awaitingGate.gateId>" --decision approve --note "requirement.md §7 carries zero markers" --json
```
In the rare aborted-session case where markers remain, do **not** decide the gate at all: leave
the run `AWAITING_GATE` and say so — resolving it is a human's call, and approving it anyway
would be a forced override this stage has no reason to make. Finish by rendering the trail. The
`--slug` value attaches with an `=`; a space-separated one is rejected with an error rather than
silently rendering the wrong feature's trail:
```bash
"$DOFLOW" render-audit --slug="<slug>" --json
```
Every call in this step is advisory to the trail. If one fails, report it plainly and continue;
trail logging issues do not invalidate `requirement.md` or block finishing this skill.
