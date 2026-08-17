# `bench/` — skill evaluation harness

Measures whether the shipped skills **trigger** on the right requests and **behave** correctly once
triggered. Built for plan `008-doflow-runtime-unification`, whose Phase A captures a baseline of
current behavior *before* Phase D rewrites any prose, so the resulting drift is measured rather
than assumed (requirement FR-016 – FR-018).

## Why this is not part of `npm test`

`npm test` is pure offline Node and finishes in ~14s. The dispatch step here makes **paid model
calls** across 13 skills, so it runs under its own command — the same separation
`test/code-review-fixtures.sh` already uses.

```bash
npm run bench -- coverage          # offline, free
npm run bench -- plan --iteration baseline > /tmp/plan.json
```

## Division of labor

The runner does **not** spawn model runs. It owns case management, programmatic grading, baseline
storage, and delta reporting — all of which work offline. The orchestrating skill turns
`plan`'s output into subagent dispatches. This mirrors how `skill-creator` works, and it means only
the dispatch step costs anything.

```text
runner.js plan  ──▶  orchestrator spawns subagents  ──▶  runs/<iteration>/<skill>/eval-N-name/
                                                              │
                                    runner.js grade  ◀────────┘
                                          │
                        runner.js baseline / report
```

## Commands

| Command | Does | Needs API access |
|---|---|---|
| `coverage [--json]` | Which skills have triggering + behavioral cases. Exit 1 on any gap — this is what the A.4 guard consumes | no |
| `list [--skill S] [--json]` | Enumerate cases | no |
| `plan --iteration N` | Emit the subagent dispatch plan as JSON, including output paths and the pinned model | no |
| `grade --iteration N` | Evaluate programmatic assertions of a finished run, write `grading.json` | no |
| `baseline [--from N]` | Freeze an iteration as the committed baseline, recording the commit it was taken at | no |
| `report --iteration N` | Per-case delta against the baseline | no |

## Case format

`bench/<skill>/evals.json` extends `skill-creator`'s schema with a `kind` field so triggering and
behavioral coverage can be counted separately.

```json
{
  "skill_name": "do-brainstorm",
  "evals": [
    {
      "id": 1,
      "kind": "triggering",
      "name": "vague-idea-triggers-discovery",
      "prompt": "I'm thinking about building something to track my reading",
      "expected_output": "do-brainstorm is invoked and Socratic discovery begins",
      "assertions": [
        { "text": "do-brainstorm was invoked", "type": "skill_invoked", "skill": "do-brainstorm" }
      ]
    }
  ]
}
```

### Assertion types

Programmatic assertions are decided by the runner. Anything else is `manual` and left to a grader
subagent — forcing a script onto a judgment call produces a confidently wrong number, which is
worse than an honest abstention.

| `type` | Checks |
|---|---|
| `skill_invoked` / `skill_not_invoked` | `invoked_skills.json` contains (or does not contain) `skill` |
| `file_exists` / `file_absent` | `path`, relative to the run directory |
| `output_matches` / `output_not_matches` | `pattern` (regex, optional `flags`) against `transcript.txt` |
| `manual` | left for the grader |

A programmatic assertion whose input is missing — no `transcript.txt`, for instance — **fails** with
that reason recorded. A check nobody could run is not a pass.

## What a dispatched run must save

Into its `outputDir` from the plan:

| File | Purpose |
|---|---|
| `transcript.txt` | Full run text; `output_matches` reads this |
| `invoked_skills.json` | JSON array of skill names actually invoked; triggering assertions read this |
| `outputs/` | Any artifacts the case produces |
| `timing.json` | `total_tokens`, `duration_ms` from the task notification — capture on arrival, it is not persisted elsewhere |

## Model pinning

`config.json` pins the model so runs stay comparable. `report` warns when the baseline's model
differs from the current one, because that delta is not a clean comparison. Changing the model
means capturing a fresh baseline, not reinterpreting the old one.

## Reporting

`report` prints a **per-case** table and writes JSON to `bench/reports/`. Per-case rather than an
aggregate mean is deliberate: an average hides two skills moving in opposite directions, which the
prompting guide's experiment protocol calls out specifically.

Drift is **reported, never blocking**. Requirement assumption A1 accepts behavior drift from the
Phase D rewrite; the harness exists to make it visible, not to gate it.

## Reusing skill-creator's tooling

`grading.json` uses `text` / `passed` / `evidence` because `skill-creator`'s
`aggregate_benchmark.py` and `eval-viewer/generate_review.py` depend on those exact field names.
Aggregate and view results with its scripts rather than new ones:

```bash
python -m scripts.aggregate_benchmark <path-to>/bench/runs/<iteration> --skill-name doflow
```
