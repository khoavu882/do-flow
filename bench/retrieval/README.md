# Retrieval Benchmark and P0 Contracts

Protocol description, benchmark configuration, evaluation methodology, and P0 gate record for DoFlow retrieval systems.

## Configurations

Evaluation tracks configurations A through F per ADR §6. Feature 074 evaluates configurations A and B; feature 079 evaluates configuration C; feature 083 evaluates configurations D and E; feature 084 evaluates configuration F.

| Configuration | Description | Status in 074 | Harness scope |
|---|---|---|---|
| A | measured current stack | Evaluated | Harness-independent: the runner invokes CLI tools directly; no harness session is involved |
| B | CLI lexical baseline | Evaluated | Harness-independent: the runner invokes CLI tools directly; no harness session is involved |
| C | lexical + semantic fusion | Feature 079 | Not run in 074 |
| D | C + task-specific graph | Feature 083 | Not run in 074 |
| E | D + selective rerank | Feature 083 | Not run in 074 |
| F | best validated configuration + local advisor | Feature 084 | Not run in 074 |

## Hybrid C protocol (079)

Configuration C is opt-in through the distinct `hybrid-c-v1` protocol. It runs A, B and C against
both corpora in one invocation; A/B code discovery is restricted to the pinned code manifest, and
C calls the production code retrieval coordinator. The protocol does not rewrite the historical
A/B baseline, thresholds, qrels or G33 checks. The legacy runner remains on its original A/B
protocol when `hybrid-c-v1` is not selected.

The C holdout invocation reserves all six prospective aggregate result slots atomically before
decrypting either corpus. Once evaluation begins, a failure consumes the reserved slots. Only a
failed pre-evaluation check may release the reservation, with an audit record. Holdout outputs
contain aggregate metrics and fixed causes only; task ids, queries, qrels, snippets and decrypted
content do not enter result files or the gate report. Comparisons are computed from aggregate files
and consume no additional result slot.

For development comparisons, prepare an isolated export of the pinned snapshot, a local Semble
0.7.0 Python environment with its required dependencies, and a compatible model already on disk.
Set `SEMBLE_MODEL_PATH` to that model directory before choosing the development run. The adapter
does not install packages or fetch models. Hybrid stays opt-in, and the promotion record remains
incomplete until repeated provider conformance and every required gate are established; paid
T-005/T-006 are unreached without separate authorization. See [Guide: code retrieval](../../docs/guide.md#retrieve-code-from-the-project)
for the runtime's explicit build, refresh and repair workflow.

## Corpora

The benchmark evaluates retrieval against two distinct corpora pinned in `bench/retrieval/snapshot.json` (commit `3fc988bc519cd7ac289f6db64dfa15b78457cf1b`, seed `20261012`) per IC-011:

- **Code corpus**: Scoped to `src/**`, `bin/**`, `core/registry/**`, `core/harnesses/**`, and `test/**`. Evaluated with k_max = 10.
- **Guidance corpus**: Scoped to `core/shared/guidance/**`. Evaluated with k_max = 5.

Each corpus is exactly its listed scopes (IC-011) at the pinned commit. Ground truth is defined in `tasks/dev.json` (74 dev tasks) and encrypted holdout generations (IC-013, IC-014).

## Metrics

Retrieval effectiveness is measured using deterministic metrics defined in IC-009 and statistical comparison methods defined in IC-010:

- **Ranking metrics**: Span recall (`recallAt{k}`), file recall (`fileRecallAt{k}`), Mean Reciprocal Rank (`mrrAt{k}`), `successAt1` (exact-lookup), and `ndcgAt10`.
- **Integrity and outcome metrics**: `locatorValidity`, `falseAbsence`, `statusMatch`, `missedDependencies` (impact-refactor), `mustIncludeMet` (oversized-context), and `mustSurviveMet` (verification-failure).
- **Statistics**: Seeded pseudo-random number generation via mulberry32, nearest-rank percentiles, Median Absolute Deviation (MAD), 95% bootstrap confidence intervals (10,000 resamples), and paired sign-flip randomization tests.
- **Reporting rules**: Results are reported by corpus, class, and harness, never blended. Model self-scoring is never the only metric.

## Orchestration evaluation

Orchestration evaluation measures multi-task and multi-agent coordination for feature 082 across manual, sequential, and bounded subagent execution:

- Verified parent completion and child lifecycle boundaries.
- Dependency ordering and readiness gating before implementation dispatch.
- Prevention of duplicate dispatch and concurrent edit conflicts.
- Detection of integration failures, retries, and automated replanning.
- Aggregate token and latency cost tracking under resource caps.

## Task success

End-to-end task success is measured by the agentic baseline, a paid and separately approved run: see [`bench/agentic/README.md`](../agentic/README.md) for the protocol, the cost ceilings and what each result triggers.

## Holdout

Holdout evaluation protects against benchmark overfitting per IC-014:

- Encrypted at rest under `bench/retrieval/holdout/` using AES-256-GCM and scrypt key derivation (N=32768, r=8, p=1; bench/retrieval/lib/seal.js KDF).
- Decryption keys are held strictly outside the repository (`~/.config/doflow/holdout.key` or `DOFLOW_HOLDOUT_KEY`) with 0600 POSIX permissions.
- **`sealedBy` rule**: Authors who author or seal holdout tasks (`sealedBy`) must not tune later configurations or author tasks for later features (barred from feature 079 and subsequent tuning).
- **Seal invalidation**: A fresh generation is required when holdout results fed tuning, when more than 6 runs have used the generation, or if plaintext or canary tokens leak into any tracked file.

Generation 1 was run once for configurations A and B (commit 8e7a0e5); its six per-class aggregate files are under bench/retrieval/results/. Generation 1 may not feed tuning; tuning on it requires generation 2. Generation 1 comparisons predate the headline-metric comparisons and unreachedCount (DEC-020) and cannot be recomputed.

## Refresh

- Trigger: The pinned commit changes (`retrieval migrate`) or a listed tool changes version.
- Owner: Maintainer.
- Command: `npm run bench -- retrieval migrate --to <commit>`.

## P0 gate

Benchmarks rerun against the same snapshot.
Evidence: On 2026-10-13, `npm run bench -- retrieval rerun` reproduced the committed baseline (`baseline.json`) on snapshot 1 (`3fc988bc519cd7ac289f6db64dfa15b78457cf1b`) with exit code 0. All metric diffs across code and guidance corpora matched within tolerance (summary lines: `290 of 290 aggregates within tolerance` and `latency not gated: thresholds.json has no latency tolerances`). Latency is not gated by rerun because `thresholds.json` has no latency tolerances.

Registry slots alone do not establish operational hybrid support.
Evidence: `bench/inventory/capabilities.json` gate evidence records confirm that registry declarations lack operational execution:
- `INV-012`: The registry validator allows the ids `dense`/`rerank`; `models.json` declares no retrieval slots (`src/runtime/model-router.ts:101`).
- `INV-014`: `fuseHybridResults` reciprocal-rank fusion is declared and unit-tested in `src/runtime/knowledge/hybrid.ts:92`, but has no production caller in any CLI verb or runtime execution path.

Tool replacement requires comparative evidence.
Evidence: `bench/inventory/tools.json` replacement statement: "No current-stack replacement is recommended." Basis: tools.json is a dated inventory (repo, version, licence, stars, maintenance, each with its source and verifiedOn) of the six classes, filtered at `starThreshold` 20000; no candidate was benchmarked against the current stack in 074, so no replacement can be justified yet, which is what the gate sentence requires.

Fix tolerances/cost caps in P0 benchmark configuration before viewing holdout results.
