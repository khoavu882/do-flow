# `bench/` — skill evaluation harness

The corpus in this directory is TRACKED: the runner, the per-skill eval definitions, `config.json` and
the sanitized baseline all ship with the repository, so the behavioral baseline is reproducible from a
clean clone. Only `bench/runs/` and `bench/reports/` stay local, being artifacts of paid runs rather
than corpus. `test/guards/evals.test.js` fails if the corpus stops being tracked. For native Codex/Claude discovery and session
behavior, use the separate [native-session corpus](native/README.md). It starts from ordinary user
messages and reports task outcomes and usage separately; the by-path skill benchmark below measures
a different surface.

Measures whether the shipped skills **trigger** on the right requests and **behave** correctly once
triggered. Built for plan `008-doflow-runtime-unification`, whose Phase A captures a baseline of
current behavior *before* Phase D rewrites any prose, so the resulting drift is measured rather
than assumed (requirement FR-016 – FR-018).

## Why this is not part of `npm test`

`npm test` is pure offline Node and finishes in ~14s. The dispatch step here makes **paid model
calls** across 13 skills, so it runs under its own command — the same separation
`test/code-review-fixtures.sh` already uses.

```bash
node bench/runner.js coverage     # offline, free
node bench/runner.js plan --iteration baseline > /tmp/plan.json
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

**What this does not cover.** The bench is Claude-specific: sandboxes are projected into
`.claude/skills/` and `config.json` pins a Claude model id, so it says nothing about how another
harness loads or routes the skills. A without-skill run cannot remove `~/.claude/skills`, which is
outside any sandbox; it relies on the run's instruction and is checked afterwards at grading.

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
| `parity [--json]` | Does the committed baseline still describe the committed corpus. Lists pending cases, exits 1 on a removed, renamed or kind-changed case, a split-changed case whose baseline result recorded `split`, or a wrong `caseCount` | no |
| `list [--skill S] [--split train\|heldout] [--json]` | Enumerate cases, optionally one side of the corpus | no |
| `plan --iteration N [--skill S] [--split train\|heldout] [--arm without-skill]` | Emit the subagent dispatch plan as JSON: output paths, pinned model, sandbox commands, each run's skill path + expected hash, and the projected cost against the ceiling. Exit 2 when a known projection is over the ceiling | no |
| `grade --iteration N` | Verify each run's skill provenance, evaluate programmatic assertions, read `timing.json`, write `grading.json` | no |
| `baseline [--from N]` | Freeze an iteration as the committed baseline, recording the commit it was taken at, how many cases proved their skill source, each case's side and its usage | no |
| `report --iteration N` | Per-case delta against the baseline, with a `source` column marking rows whose delta is unmeasured, pending rows, usage, the ceiling check and, when without-skill runs exist, the per-skill delta | no |

`--split` is accepted by `plan` and `list` only, `--arm` by `plan` only; any other command refuses
either flag with exit 2, as it does an unknown option.

## Case format

`bench/<skill>/evals.json` extends `skill-creator`'s schema with a `kind` field so triggering and
behavioral coverage can be counted separately, and a `split` field naming the case's side of the
corpus (`train` or `heldout`; see [Held-out cases](#held-out-cases)). Every case has a side.

```json
{
  "skill_name": "do-brainstorm",
  "evals": [
    {
      "id": 1,
      "kind": "triggering",
      "split": "train",
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
| `skill_resolved` | The run read this repo's copy of `skill`: its `skill_source.json` grades `verified` |
| `skill_invoked` / `skill_not_invoked` | `invoked_skills.json` contains (or does not contain) `skill`. Undecided (`passed: null`, left for the grader) on a by-path run, whose `invoked_skills.json` is empty by contract |
| `skill_not_routed` | `routing.json` records `{"skill": <skill>, "routed": false}`. Decides every with-skill run; a missing, unreadable or mismatched record fails |
| `file_exists` / `file_absent` | `path`, relative to the run directory |
| `output_matches` / `output_not_matches` | `pattern` (regex, optional `flags`) against `transcript.txt` |
| `manual` | left for the grader |

A programmatic assertion whose input is missing — no `transcript.txt`, for instance — **fails** with
that reason recorded. A check nobody could run is not a pass.

### Should-not-trigger cases

A triggering case may assert the opposite of routing: a near miss of a skill's description, which
uses the skill's vocabulary but asks for something the description assigns elsewhere or excludes.
It carries `skill_not_routed` and passes when the run judged from the sandbox copy's frontmatter that
the request does not route to the skill. `skill_not_invoked` cannot grade it, because it is undecided
on every by-path run. Such a case is graded from `routing.json`, which a with-skill triggering run
must save (below).

## What a dispatched run must save

Into its `outputDir` from the plan. The orchestrating agent creates each sandbox with the emitted
`sandbox.create`, passes each run's `skills.instruction` through unchanged, and stops dispatch at
`costCeiling.budget` (see [Cost ceiling](#cost-ceiling)).

| File | Written by | Arm | Content |
|---|---|---|---|
| `transcript.txt` | run | both | Full run text; `output_matches` reads this |
| `invoked_skills.json` | run | both | JSON array of skill names actually invoked |
| `skill_source.json` | run | with-skill | **Which SKILL.md the run actually followed**, `{ skill, path, sha256 }`. Without it the run is graded `unrecorded` and its pass rate is not evidence about this repo |
| `skill_source.json` | run | without-skill | `{ "skill": "<skill>", "withheld": true }` |
| `routing.json` | run | with-skill, triggering cases | `{ "skill": "<skill>", "routed": true or false }`, the decision judged from the frontmatter |
| `outputs/` | run | both | Every artifact the case produces, including any timing file the case itself makes |
| `timing.json` | orchestrating agent | both | `total_tokens` (integer >= 0) and `duration_ms` (number >= 0) from the task notification. Written on arrival, since it is not persisted elsewhere; a value the notification did not report is omitted, never written as 0 |

For a with-skill run, `skill_source.json` is three fields, written after reading the skill:

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

## Held-out cases

Every case sits on one of two sides of the corpus, named by its `split` field: `train` or `heldout`.
`plan --split heldout` and `list --split heldout` select the held-out side, `--split train` the
other, and without the flag both sides run. The side is a convention that whoever tunes a skill
honours: iterate against the `train` cases and read the `heldout` cases only to check that an edit
generalised. The runner does not stop a tuner from looking at either side; it records each case's
side in every plan row, grading, report row and baseline entry so the split can be audited. Every
skill keeps at least one held-out case and a case chooses its side in the edit that adds it. A
baseline capture records each case's side, and `parity` fails a case that has moved to the other side
only where its baseline result recorded `split`. The committed baseline predates `split` and records
none, so no case is compared on its side yet; the check starts applying case by case once a
re-captured baseline records it.

## Pending cases

A case present in the corpus but absent from the committed baseline is **pending**: it awaits a
paid baseline capture and has no baseline result. Pending is not a failure, because no offline
change can give a new case a measured result.

- `parity` prints one `PENDING <skill>/<id> (...)` line per such case and exits 0 when nothing else
  differs.
- `report` marks the row `pending` instead of computing a delta, counts it in the summary and adds a
  note.
- A baseline capture whose iteration contains the case's key clears it.

A removed, renamed or kind-changed case still fails `parity`, and so does a case moved to the other
side when its baseline result recorded `split`: the baseline then describes something the corpus no
longer holds. A baseline result with no recorded `split` is not compared on its side.

## Cost ceiling

`config.json` declares `costCeiling`: the `unit` (`total_tokens`), `maxTokensPerRun`, and a `note`.
The value is provisional, set before any run recorded usage; reset it from the first paid capture
that did. The budget of a set of runs is `maxTokensPerRun` times the number of runs.

Usage comes from each run's `timing.json`. `grade` reads it with a status of `recorded`, `partial`,
`invalid`, `malformed` or `unrecorded`, and a field that is absent or invalid is **unknown, never
zero**: it is left out of every sum and counted separately, so totals are lower bounds and an
unmeasured run cannot look free. A file in another tool's shape, such as one with only
`total_duration_seconds`, is `invalid` rather than misread.

- `plan` projects each run at what the committed baseline recorded for the same case and arm. A run
  with no baseline usage is unknown. When the known total already exceeds the budget it prints the
  numbers on stderr and exits 2 without a plan; when the result is unknown it prints the plan with a
  warning, and the orchestrating agent enforces the budget at dispatch.
- `report` only warns. It never changes the exit code, because drift is reported, never blocking.
- A missing or malformed `costCeiling` block is refused, not defaulted, so the check cannot be
  switched off by accident.

## Without-skill arm

`plan --arm without-skill` adds, after each **behavioral** case's with-skill run, the same case with
the skill under test withheld, to measure what the skill adds. The case's prompt is sent with its
leading `/<skill>` token stripped, since that token names the skill being withheld; a case whose
prompt is only that token has nothing left to ask and is not run in the arm. Triggering cases get no
such run: their question is whether a description routes, and a run with the skill withheld has no
description to judge. The arm is opt-in because it roughly doubles the behavioral runs, and so the
cost.

A without-skill run differs from its pair in these ways:

- Its output directory is the with-skill one plus `--without-skill`, and its sandbox id ends in
  `-noskill`.
- Its `sandbox.create` deletes the skill's copies from the sandbox after projecting it, drops the
  skill's entry from the sandbox's `.doflow-skill-source.json`, and marks the tracked deletions
  skip-worktree so they do not appear in the sandbox's `git status` or `git diff`. `bench/` stays,
  because cases work on `bench/runner.js`. The plan lists the skill's copies in
  `skills.withheldPaths`. `~/.claude/skills` is outside any sandbox and cannot
  be removed that way, so its `skills.instruction` forbids reading or invoking the skill, and
  `grade` checks afterwards.
- Its `skill_source.json` is `{ "skill": "<skill>", "withheld": true }`, and `grade` classifies the
  run `withheld`, `leaked` or `unrecorded`. A recorded path, a missing `withheld: true`, a skill
  listed in `invoked_skills.json`, or a transcript or output that names `skills/<skill>/SKILL.md` (with `/` or
  `\` separators) is `leaked`: the run reached the skill and its pass rate is not a without-skill
  measurement. No record, one that is not valid JSON or not a JSON object, or one naming another
  skill is `unrecorded`, never `withheld`, because silence is not proof.
- `skill_resolved`, `skill_invoked`, `skill_not_invoked` and `skill_not_routed` are left undecided on
  it; every other assertion grades as usual.

What the arm does not prevent, because the sandbox is a git worktree of this repo and not an empty
directory:

- The corpus is readable: `bench/<skill>/evals.json` stays in the sandbox with each case's
  `expected_output` and assertions, and the sandbox is nested at `<checkout>/.doflow/worktrees/<id>`,
  so `../../../bench/...` and `../../../core/shared/skills/<skill>` are plain reads of the checkout.
  A corpus read names no `SKILL.md`, so `leaked` grading does not catch it.
- Git history is still readable: `git show HEAD:<path>` returns the skill's files that were deleted
  from the working tree. So are the sandbox's `.doflow` ledger and recovery records, which name the
  skill's path. A run that reads them and so names `skills/<skill>/SKILL.md` in its transcript or
  outputs is graded `leaked`.
- Invoking the skill by name, which loads `~/.claude/skills/<skill>/`, is graded `leaked` when
  `invoked_skills.json` lists it.

`baseline` stores these runs as `withoutSkillResults`, beside `results`. `report` adds an `armDelta`
table with one row per skill: the mean pass rate with the skill, without it, and the difference,
over the behavioral cases where both arms are decided, the with-skill run is `verified` and the
without-skill run is `withheld`. A case that fails any of those is left out rather than counted as
0, so a leaked or unrecorded run cannot move the delta; a skill with no such case reports a null
delta and the reason.

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

One exception: `aggregate_benchmark.py` reads a missing `total_tokens` as 0, which is the misreading
[Cost ceiling](#cost-ceiling) rules out. `report` is the source for usage, because it keeps an
unmeasured run unknown.
