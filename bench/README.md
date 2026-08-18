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

## Which skills a run measures

**A run must read its skill from its own sandbox, by path. Invoking `/<skill>` by name measures the
wrong tree.**

Claude Code merges skills in the order policy → user → project and its name lookup takes the *first*
match, so `~/.claude/skills/<name>/SKILL.md` shadows any project-scope copy. This is not a
theoretical risk: 12 of the 13 globally installed DoFlow skills currently differ from
`core/shared/skills/`, and the installed `do-code-review` is missing the markdown content-type
dispatch entirely. A Phase D re-run that resolved installed copies would compare old against old and
print a null delta reading as "no regression" — the worst failure available to a drift detector.

Two tempting fixes do **not** work, and were checked rather than assumed:

| Attempt | Result |
|---|---|
| Project into the sandbox's `.claude/skills/` so project scope wins | No. Project scope loses the name lookup to user scope. Verified live: a project-scope `do-git` shadow was ignored in favour of the installed copy |
| Let nested-directory skill discovery pick the sandbox up | No. Discovery skips gitignored directories and `.doflow/` is gitignored, so the sandbox is never scanned. Even when it is, a colliding name is renamed to a directory-scoped variant rather than promoted |

So the harness does not fight name resolution — it bypasses it:

1. **Sandbox creation projects this repo's skills** into `<sandbox>/.claude/skills/`, via the real
   `bin/doflow.js install <sandbox> --force -t claude` (~0.15s). The installer rather than a
   hand-copy, so the sandbox exercises the actual projection and the guidance, scripts and templates
   the skills reference come with it — a lone `SKILL.md` would leave every `references/` path
   dangling and change the behaviour being measured.
2. **The plan tells the dispatched agent** to read `<sandbox>/.claude/skills/<skill>/SKILL.md` and
   follow it, and carries that file's expected `sha256`.
3. **The run records what it actually read** in `skill_source.json`.
4. **`grade` classifies every run** as `verified` · `global-fallback` · `mismatch` · `unrecorded`.
   Anything but `verified` is flagged in `grading.json`, on stderr, and in the report's `source`
   column. A missing record is never treated as a pass — silence is exactly what the defect looked
   like.

A run's `.doflow-skill-source.json` inside the sandbox records the per-skill hashes the projection
laid down, so the sandbox side of the claim is checkable too.

**What this costs, stated plainly.** A `triggering` case asks "does this request route here?", which
is normally answered *by* the name/description lookup we are bypassing. Those cases are therefore
measured one step removed: the run reads the sandbox copy's frontmatter and judges routing from that
description. That measures this repo's wording — the thing Phase D rewrites — but it is not the same
event as the live router choosing a skill. A pass here is not a claim about production routing, and
the D.4 report should say so, the same way the baseline already qualifies its non-interactive runs.

## Division of labor

The runner does **not** spawn model runs. It owns case management, sandbox provisioning, skill
projection, programmatic grading, provenance verification, baseline storage, and delta reporting —
all of which work offline. The orchestrating skill turns `plan`'s output into subagent dispatches,
and is responsible for two things the runner cannot do for it: creating each sandbox with the
emitted `sandbox.create` command, and passing each run's `skills.instruction` through to the
subagent so it loads the skill by path instead of by name.

```text
runner.js plan  ──▶  orchestrator: sandbox.create (projects core/shared/skills → <sandbox>/.claude/skills)
                          │
                          ▼
                     subagent reads <sandbox>/.claude/skills/<skill>/SKILL.md
                          │
                          ▼
                     runs/<iteration>/<skill>/eval-N-name/  (+ skill_source.json)
                          │
    runner.js grade  ◀────┘   verifies provenance, then assertions
          │
runner.js baseline / report
```

## Commands

| Command | Does | Needs API access |
|---|---|---|
| `coverage [--json]` | Which skills have triggering + behavioral cases. Exit 1 on any gap — this is what the A.4 guard consumes | no |
| `list [--skill S] [--json]` | Enumerate cases | no |
| `plan --iteration N` | Emit the subagent dispatch plan as JSON: output paths, pinned model, sandbox commands, and each run's skill path + expected hash | no |
| `grade --iteration N` | Verify each run's skill provenance, evaluate programmatic assertions, write `grading.json` | no |
| `baseline [--from N]` | Freeze an iteration as the committed baseline, recording the commit it was taken at and how many cases proved their skill source | no |
| `report --iteration N` | Per-case delta against the baseline, with a `source` column marking rows whose delta is unmeasured | no |

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
| `skill_source.json` | **Which SKILL.md the run actually followed.** Without it the run is graded `unrecorded` and its pass rate is not evidence about this repo |
| `outputs/` | Any artifacts the case produces |
| `timing.json` | `total_tokens`, `duration_ms` from the task notification — capture on arrival, it is not persisted elsewhere |

`skill_source.json` is three fields, written after reading the skill:

```json
{
  "skill": "do-code-review",
  "path": "/abs/path/.doflow/worktrees/<id>/.claude/skills/do-code-review/SKILL.md",
  "sha256": "f98813e5eff914c709be5579ad5b3410893109666ebe5d8ec4c1e56f8f22d3d1"
}
```

`path` must be the file the run actually opened — copying the plan's expected path without reading
that file defeats the whole check. `sha256` is `shasum -a 256 <path>`. `grade` compares both against
`core/shared/skills/<skill>/SKILL.md`: a path outside the sandbox is `global-fallback`, a sandbox
path with the wrong hash is `mismatch`.

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

The `source` column is the exception worth reading first. A row reading `unrecorded→unrecorded`
carries a delta that is arithmetic, not evidence: neither side can prove which SKILL.md it measured.
Runs captured before this provenance check existed all read that way, correctly.

## Reusing skill-creator's tooling

`grading.json` uses `text` / `passed` / `evidence` because `skill-creator`'s
`aggregate_benchmark.py` and `eval-viewer/generate_review.py` depend on those exact field names.
Aggregate and view results with its scripts rather than new ones:

```bash
python -m scripts.aggregate_benchmark <path-to>/bench/runs/<iteration> --skill-name doflow
```
