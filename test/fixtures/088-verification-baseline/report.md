# Verification Baseline Report

**Verdict:** verdict not yet derivable
**Measurement Window Progress (D-16):** 1 of 5 loops, 1 of 2 harnesses

## Input Table

| Metric | Basis | Records Read | Uncaptured Inputs | Cause |
|---|---|---|---|---|
| loopWallMs | derived | task-run history start/resume, activity endpoints, trace span window | open-ended spans without completion events | derived as last span end minus first span start across trace spans |
| verificationWallMs | derived | verify.run spans, outside-verb test spans | tests on unobserved harnesses (OpenCode, Copilot) | union of verify.run intervals and outside-verb test intervals |
| totalTestMs | derived | executed verify.check spans, outside-verb test spans | per-check timing on pre-FR-016 records, test durations on non-Claude harnesses | sum of executed check durations (excluding in-run and follower) + outside-verb test durations |
| implementationMs | derived | loop wall time, verification union wall time, idle intervals > 30 min | fine-grained model thinking / editing time outside observed commands | goal loop wall time minus verification wall time minus idle gaps > 30 min |
| ratio | derived | verificationWallMs, loopWallMs | none beyond constituent metrics | verificationWallMs / loopWallMs |
| share | derived | verificationWallMs, loopWallMs | none beyond constituent metrics | verificationWallMs / loopWallMs |
| duplicates | derived | executed verify.check spans with check_key, outside-verb test spans by session and test_class | edit hook lines not available in 088, so all repeated tests in session are candidate duplicates | exact check_key duplicates + candidate same-class test repeats in a session |
| fullSuiteRuns | derived | executed broad-tests checks, test.full outside-verb test spans | none | sum of executed broad-tests checks and test.full runs |
| cpuMs | unreached | verify.check spans with resource_basis proc-children | non-Linux platforms (darwin, win32) and unkeyable/read faults | child CPU ticks unreached on non-Linux platforms |
| peakMemory | unreached | none | process peak RSS memory measurement | no portable zero-dependency child memory sampling while spawnSync blocks |
| idleGapsMs | derived | inferred from timestamps between consecutive activities | sub-30-minute idle pauses treated as implementation time | sum of activity gaps exceeding the 30-minute session threshold (D-8) |

## Observed (n=1), not a result

| Metric | Observed | Basis |
|---|---|---|
| cpuMs | unreached | unreached |
| duplicates | 0 | derived |
| fullSuiteRuns | 2 | derived |
| idleGapsMs | 0 | derived |
| implementationMs | 22563 | derived |
| loopWallMs | 23665 | derived |
| peakMemory | unreached | unreached |
| ratio | 0.0466 | derived |
| share | 0.0466 | derived |
| totalTestMs | 775 | derived |
| verificationWallMs | 1102 | derived |

## Goal Loops

Total loops recorded: 1

### Goal Loop 1: 7dd7bc7144d5aed7feddb5289f6260a9
- **Harness:** claude
- **Window:** 2026-10-18T15:21:22.547Z .. open
- **Loop Wall:** 23665 ms (upper bound: open (unbounded))
- **Verification Wall:** 1102 ms (upper bound: open (unbounded))
- **Total Test Time:** 775 ms (upper bound: open (unbounded))
- **Implementation Time:** 22563 ms (upper bound: open (unbounded))
- **Verification Ratio:** 0.0466
- **Idle Gaps (> 30 min):** 0 ms (0 gap(s))
- **Duplicates:** 0 (exact: 0, candidate: 0)
- **Full Suite Runs:** 2
- **CPU Time:** unreached
- **Peak Memory:** unreached

## Context: Survey Proxies

> [!NOTE]
> pre-telemetry proxies from research/baseline-survey.md §4, context only, never a result

| ID | Proxy | Share | Bias |
|---|---|---|---|
| A | Ledger dispatched time | 87.0 % | Denominator is only DoFlow verbs; excludes agent, edit and Bash time. Says verify dominates DoFlow verb time, nothing about goal loop. |
| B | Idle-gap session wall | 1.34 % | 30-minute gap is an inference; single-record sessions have 0 wall; overnight idle excluded only when gap > 30 min. |
| B2 | Sessions containing verify | 4.14 % | Selects sessions where verification happened, biased upward. |
| C | Orchestration records | 1.1 % | Stages are completion intervals; verification stage closed almost immediately; suite reruns land in implementation. |
| total | Verify verb vs orchestration totalMs | 0.49 % | Understates verification time; reruns happened outside the verb. |

## Sampling Rule and Biases

**Sampling Rule:** controlled goal loop on a pinned snapshot with run identity and FR-016/FR-019 telemetry

**Biases:**
- union assumes overlapping verification intervals reflect concurrent execution or waiting
- outside-verb tests observed with completion duration on Claude only; other harnesses record duration as unreached
- child CPU ticks recorded on Linux proc-children only; unreached on Darwin/Windows
- peak memory unreached on all platforms
- candidate test duplicates treat all same-class repeats within a session as candidates due to absence of edit hook lines
