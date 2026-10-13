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

## Corpora

The benchmark evaluates retrieval against two distinct corpora pinned in `bench/retrieval/snapshot.json` (commit `3fc988bc519cd7ac289f6db64dfa15b78457cf1b`, seed `20261012`) per IC-011:

- **Code corpus**: Scoped to `src/**`, `bin/**`, `core/registry/**`, `core/harnesses/**`, and `test/**`. Evaluated with k_max = 10.
- **Guidance corpus**: Scoped to `core/shared/guidance/**`. Evaluated with k_max = 5.

Each corpus is exactly its listed scopes (IC-011) at the pinned commit. Ground truth is defined in `tasks/dev.json` (74 dev tasks) and encrypted holdout generations (IC-013, IC-014).

## Metrics

Retrieval effectiveness is measured using deterministic metrics defined in IC-009 and statistical comparison methods defined in IC-010:

- **Ranking metrics**: Span recall (`recallAt{k}`), file recall (`fileRecallAt{k}`), Mean Reciprocal Rank (`mrrAt{k}`), `successAt1` (exact-lookup), and `ndcgAt10`.
- **Integrity and outcome metrics**: `locatorValidity`, `falseAbsence`, `statusMatch`, `missedDependencies` (impact-refactor), `mustIncludeMet` (oversized-context), and `mustSurviveMet` (verification-failure).
- **Statistics**: Seeded pseudo-random number generation via mulberry32, nearest-rank percentiles, Mean Absolute Deviation (MAD), 95% bootstrap confidence intervals (10,000 resamples), and paired sign-flip randomization tests.
- **Reporting rules**: Results are reported by corpus, class, and harness, never blended. Model self-scoring is never the only metric.

## Orchestration evaluation

Orchestration evaluation measures multi-task and multi-agent coordination for feature 082 across manual, sequential, and bounded subagent execution:

- Verified parent completion and child lifecycle boundaries.
- Dependency ordering and readiness gating before implementation dispatch.
- Prevention of duplicate dispatch and concurrent edit conflicts.
- Detection of integration failures, retries, and automated replanning.
- Aggregate token and latency cost tracking under resource caps.

## Task success (paid, run per approval)

Task success evaluation measures end-to-end task outcomes in a throwaway git worktree:

- **Outcome evaluation**: Each task is evaluated using a fail-to-pass plus pass-to-pass test suite executed by the automated grader in an isolated worktree.
- **Sampling**: 3 runs per task and configuration, reporting success rate and pass^3 consistency.
- **Accounting**: Resource usage is recorded in `bench/README.md` `timing.json` shape, where unknown usage is never zero.
- **Cost ceiling**: Total token consumption is capped at `tasks × configurations × 3 × costCaps.maxTokensPerRun`.
- **User approval**: Nothing runs without explicit user approval prior to execution.

## Holdout

Holdout evaluation protects against benchmark overfitting per IC-014:

- Encrypted at rest under `bench/retrieval/holdout/` using AES-256-GCM and scrypt key derivation (N=32768, r=8, p=1; bench/retrieval/lib/seal.js KDF).
- Decryption keys are held strictly outside the repository (`~/.config/doflow/holdout.key` or `DOFLOW_HOLDOUT_KEY`) with 0600 POSIX permissions.
- **`sealedBy` rule**: Authors who author or seal holdout tasks (`sealedBy`) must not tune later configurations or author tasks for later features (barred from feature 079 and subsequent tuning).
- **Seal invalidation**: A fresh generation is required when holdout results fed tuning, when more than 6 runs have used the generation, or if plaintext or canary tokens leak into any tracked file.

Generation 1 was run once for configurations A and B (commit 8e7a0e5); its six per-class aggregate files are under bench/retrieval/results/. Generation 1 may not feed tuning; tuning on it requires generation 2.

## Refresh

- Trigger: The pinned commit changes (`retrieval migrate`) or a listed tool changes version.
- Owner: Maintainer.
- Command: `npm run bench -- retrieval migrate --to <commit>`.

## P0 gate

Benchmarks rerun against the same snapshot.
Evidence: `npm run bench -- retrieval rerun --json` reproduced the committed baseline (`baseline.json`) on snapshot 1 (`3fc988bc519cd7ac289f6db64dfa15b78457cf1b`) with exit code 0. All 290 metric diffs across code and guidance corpora matched within tolerance (`allOk: true`), and latency was compared on the same machine (`latency.compared: true`; rerun latency is same-machine-only per thresholds.json `rerun.latency`).

Registry slots alone do not establish operational hybrid support.
Evidence: `bench/inventory/capabilities.json` gate evidence records confirm that registry declarations lack operational execution:
- `INV-012`: `models.json` retrieval slots (`dense`, `rerank`) are declared but remain inactive with no production callers (`src/runtime/model-router.ts:101`).
- `INV-014`: `fuseHybridResults` reciprocal-rank fusion is declared and unit-tested in `src/runtime/knowledge/hybrid.ts:92`, but has no production caller in any CLI verb or runtime execution path.

Tool replacement requires comparative evidence.
Evidence: `bench/inventory/tools.json` replacement statement: "No current-stack replacement is recommended." Basis: tools.json is a dated inventory (repo, version, licence, stars, maintenance, each with its source and verifiedOn) of the six classes, filtered at `starThreshold` 20000; no candidate was benchmarked against the current stack in 074, so no replacement can be justified yet, which is what the gate sentence requires.

Fix tolerances/cost caps in P0 benchmark configuration before viewing holdout results.
