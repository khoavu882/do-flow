# `bench/review-miss/` — review-miss suite

Measures whether a reviewer re-finds defects that earlier reviews of this repository found and later
fixes confirmed. It does not measure skills or retrieval (see [`bench/README.md`](../README.md) for the
skill benchmark and [`bench/agentic/README.md`](../agentic/README.md) for the agentic retrieval
baseline).

**Status: offline verbs only.** Every verb here reads files, writes files under `bench/runs/` (or the
path given), and runs no model. The only subprocess is read-only `git`, run by `corpus` and `lint`. The
paid scored runs and the k = 3 noise band over them (stages E and F of feature 095b) are the user's
own: nothing in `npm test` or in these verbs makes them.

## 1. What it measures

| Item | Value |
|---|---|
| Question | Given the code as it stood before a fix, does a review report a finding at the span the fix changed |
| Source of truth | The converged findings of the repository's own `review/findings.json` records that are `status: "fixed"`, have a `fixedIn` commit with a parent, and have severity `blocker` or `should-fix` (`severities` in `config.json`) |
| Case | `id`, `key`, `split`, `source`, `rev` (the parent of the fix), `scope` (every parseable converged locator path of the same record that exists at `rev`; a path absent at `rev`, such as a feature record or a file the fix added, is dropped) and `expected` (`path`, `startLine`, `endLine`, `severity`). A case carries no fix commit, summary, evidence, proof or seat text |
| Split | `heldout` when the first hex digit of sha256(`id`) is below `heldoutBelow` in `config.json`, else `train`; roughly 19 percent are heldout |
| Found | A converged finding in the reviewer's `findings.json` with status `open`, `fixed` or `user-accepted` (a `refuted` one does not count) on `expected.path`, at a severity at least the expected one (`blocker` above `should-fix` above `note`), with a locator span that overlaps the expected span widened by `tolerance` (3) lines each way. A range is one span and counts only up to `maxSpan` (60) lines wide; a comma list is separate single-line points (`a.ts:50,9999` is a hit through line 50, `a.ts:1,9999` is a miss), never the lines between |
| Band and decision | The 096 rules in `bench/noise.js`, unchanged; parameters come from `noise` in `bench/config.json` |

## 2. Cases are generated, never edited

`corpus` writes `bench/runs/review-miss/corpus.json` (gitignored with the rest of `bench/runs/`) from
the review records. Cases regenerate from the records with `corpus` and are never hand-edited: each
case `key` ends in the first 8 hex digits of a digest over `rev`, `scope` and `expected`, so a changed
truth changes the key and `lint`, `grade` and `noise` refuse a corpus or a repeat that no longer
matches. The file has no timestamp and is sorted, so two runs over the same records are byte-identical.
A record that fails `validateFindings` is skipped whole and listed under `record-invalid`; every other
ineligible finding is counted under one skip reason (`not-fixed`, `severity`, `locator`, `no-parent`,
`path-absent`).

## 3. Verbs

Run as `npm run bench -- review-miss <verb> [flags]` (or `node bench/runner.js review-miss <verb>`). An
unknown verb or flag, a missing required flag or an unexpected argument exits 2.

| Verb | Flags | Does | Exit codes |
|---|---|---|---|
| `corpus` | `--records <dir>`, `--out <file>`, `--json` | Generate cases from the records. Default records root is `<feature root>/agent-docs/doflow` as the runtime's feature resolver reports it (it needs an active feature, else pass `--records`); default output `bench/runs/review-miss/corpus.json` | 0 written; 1 no eligible case; 2 usage or unreadable records root |
| `lint` | `--corpus <file>`, `--json` | Check a corpus file: key set of a case, duplicate `id`, `key` against its digest, `rev` 40-hex and resolving, every `scope` path present at `rev`, `expected.path` inside `scope`, line numbers, severity, and at least one heldout case from 5 cases | 0 clean; 1 any problem (one line each); 2 usage or unreadable file |
| `grade` | `--iteration <name>` (required); `--corpus <file>`, `--json` | Score `bench/runs/review-miss/<name>/` and write its `grade.json` | 0 graded; 2 usage, missing `iteration.json`, unreadable or untrusted corpus, or a case directory that is not in the corpus |
| `noise` | `--iterations a,b,c` (required); `--out <file>`, `--json` | The A/A band over at least k graded iterations; refuses iterations that differ in model, commit or case keys | 0 band `usable`; 1 any other noise verdict; 2 invalid input |
| `report` | `--iterations a,b,c` (required); `--noise <file>`, `--decision-out <file>`, `--json` | The decision of candidate iterations against the band; with no `--noise` the verdict is `inconclusive` with `no-noise-band` | 0; 2 invalid input |

## 4. Iteration layout

`grade` reads `bench/runs/review-miss/<name>/`:

| File | Needed | Content |
|---|---|---|
| `iteration.json` | yes | `{ "model": "<id>", "sourceAt": "<commit>" }` |
| `<case id>/findings.json` | per case | A schema 1 `review/findings.json` the reviewer wrote for that case. Missing or failing `validateFindings`: the case is excluded as `malformed`, never scored 0 |
| `<case id>/run_status.json` | optional | `{ "status": ... }` using the 096 run statuses; an infrastructure class excludes the case |

`grade.json` is `{ schema: 1, iteration, model, commit, runs }`, where `runs` maps each case `key` to
`{ kind: "review-miss", split, passRate, excluded }` (`passRate` 1 found, 0 not found, null excluded).
That is the repeat shape `bench/noise.js` reads. Running a reviewer over each case's `rev` and `scope`
to produce the `findings.json` files is done by the person running the suite; no verb does it.

## 5. Handing a case to a reviewer

Give the reviewer a `git archive <rev>` export of `scope` (for example
`git archive <rev> -- <scope paths> | tar -x -C <empty dir>`), never a clone and never a live
checkout. A clone carries the fix commit in its history (`git log --all`), and a live checkout carries
the gitignored feature records that hold `review/findings.json`, which is the answer. The export holds
only the files as they stood at `rev`; that is why `corpus` drops scope paths absent at `rev` and
`lint` refuses a case that lists one.
