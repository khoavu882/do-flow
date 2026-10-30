# `bench/agentic/` — agentic retrieval baseline

Measures whether giving a coding agent the shipped `retrieve` command changes how well it finds the
right files. It does not measure skills, guidance or the whole DoFlow install (see
[`bench/README.md`](../README.md) for the skill benchmark and
[`bench/retrieval/README.md`](../retrieval/README.md) for the retrieval benchmark).

**Status: no paid run has been made.** Stage 1 (this feature) is offline: the protocol, the task set,
the harness verified against a fake worker, and the cost projection. Every number below that is a
planning figure is labelled INFERRED; none was measured on a real harness.

## 1. What it measures

| Item | Value |
|---|---|
| Contrast | One tool. Arm N: the harness's own tools only. Arm D: the same, plus `doflow retrieve` (lexical default) on `PATH` and named in one prompt paragraph (`arms` in `config.json`) |
| Task kind | Code localization: the agent answers with up to 10 repository-relative paths, graded by `fileRecallAt10` (`scoreTask` in `bench/retrieval/lib/metrics.js`). Nothing is edited |
| Tasks | 20: 12 train (referenced from `bench/retrieval/tasks/dev.json` by id, listed in `tasks.json`) and 8 heldout (`HC-901`..`HC-908`, `tasks-heldout.json`) |
| Band and decision | The 096 rules in `bench/noise.js`, unchanged: arm N repeats make the noise band, arm D repeats are the candidate. Parameters (`k`=3, `mde`, `headroom`, `maxInfraShare`, `seed`) come from `noise` in `bench/config.json` |
| Executor | Bench-local over the harness registry (`core/registry/harnesses.json`): read-only one-shot argv, prompt on stdin. Not `worker run` (that prepends a context pack to both arms) |

## 2. Verbs

Run as `npm run bench -- agentic <verb> [flags]` (or `node bench/runner.js agentic <verb>`). An unknown
verb or flag, or a missing required flag, exits 2.

| Verb | Flags | Spawns | Exit codes |
|---|---|---|---|
| `plan` | `--iteration`, `--arm` (required); `--tasks <id,id>`, `--json` | no, offline | 0; 2 invalid input |
| `execute` | `--iteration`, `--arm`, `--cap` (required); `--tasks <id,id>`, `--json` | **yes, the only verb that does** | 0 done; 2 refused before any spawn (no or invalid `--cap`, `--cap` below the iteration's ceiling, dirty working tree, existing run directory, harness binary missing, a second arm in an existing iteration, another execute holds the iteration lock, symlinked run root or run entry); 3 stopped by the cap or after `cap exceeded by N tokens on <task>`; 130/143/129 interrupted signal re-raised after cleanup (SIGINT/SIGTERM/SIGHUP) |
| `grade` | `--iteration` (required); `--json` | no, offline | 0; 2 invalid input |
| `noise` | `--iterations a,b,c` (required); `--out <file>`, `--json` | no, offline | 0 band `usable`; 1 any other noise verdict; 2 invalid input. Arm N iterations only |
| `report` | `--iterations a,b,c` (required); `--noise <file>`, `--decision-out <file>`, `--json` | no, offline | 0; 2 invalid input. Arm D iterations only |

`plan` prints the projection (runs, `maxTokensPerRun`, ceiling) and the paid stage commands as text; it
never runs them. The cap is a projected ceiling for one `execute` command: `execute` starts a run only
while recorded spend plus one `maxTokensPerRun` is at most the cap. A run can overshoot that reservation
because usage is known only at turn end. The worst case for one command is the cap plus one run's
overshoot, bounded only by `timeoutSeconds`. The cap applies per command, not per stage: a stage of k
commands can end at k times its cap plus up to k one-run overshoots, and `plan` prints that figure per
stage (`stage figures:`). If spend passes the cap, `execute` exits 3 and prints
`cap exceeded by N tokens on <task>`. Accepting this cap meaning is O-1, the user's decision at gate-b.
`execute` counts a run with unknown usage at `maxTokensPerRun`, and a run that did not complete
(interrupted, timed out or truncated) at the larger of its reported usage and `maxTokensPerRun`, since a
turn may have been in flight. On SIGINT, SIGTERM or SIGHUP, it stops the worker's process group, removes
the scratch profile and workspace, records the usage the worker already reported (so an overshoot
followed by an interrupt still stops the next `execute`), then re-raises the signal as exit 130, 143 or
129, respectively. SIGKILL (`kill -9`) of the executor cannot be caught, so none of that cleanup runs;
this residual is known and not fixed. The worker keeps running and spending with no timer to end it, so
that run's overshoot is no longer bounded by `timeoutSeconds`; its scratch profile, holding the
credential copy, stays under the OS temp dir; the iteration lock stays. The next `execute` on that
iteration refuses with `iteration-locked`, names the left profile (`profileRoot` in the run's
`launch.json`) and says to end the worker, delete the profile, then remove the lock.

## 3. What each result triggers

The mapping is fixed here, before any paid run (requirement FR-008; DEC-006 as accepted in the gate-a
decisions D-ORCH). `overfitSuspected: true` (train gains, heldout does not) downgrades a corpus gain to
`within-noise` for this mapping.

| Result | Action |
|---|---|
| Arm N `noise` verdict `no-headroom` (the agent already finds the files) | Semantic-arm feature does not start; roadmap row 083 stays deferred |
| Corpus decision `within-noise` or `regression`, or `gain-above-noise` with `overfitSuspected: true` | Semantic-arm feature does not start; row 083 stays deferred |
| Corpus decision `gain-above-noise` and `overfitSuspected` not `true` | Semantic-arm feature may start; row 083 is re-assessed |
| Corpus decision `inconclusive` (also any noise verdict other than `usable`) | Decides nothing; no feature starts or stops on it |

| `report` run | Output |
|---|---|
| Without a noise file (`bench/agentic/results/noise.json` absent, no `--noise`) | Decisions `inconclusive`, reason `no-noise-band`; the token table still prints |
| With a noise file | `corpus`, `train` and `heldout` decisions against the arm N band, `overfitSuspected`, excluded-run counts per side, then the token table |

## 4. Paid stages

Nothing paid runs without the user's approval of the cap, the model and the credential copy. The
decisions are the user's, asked at gate-b: O-1 (cap and staging), O-2 (model), O-5 (credential copy).
Stage D waits until the arm N band has been read.

| Stage | Command (copied from `plan`; stage N and D repeat for `r1`..`r3`) | Ceiling | Planning figure (INFERRED) |
|---|---|---|---|
| R rehearsal, one train task per arm | `npm run bench -- agentic execute --iteration rehearsal-N --arm N --tasks DC-011 --cap 250000`, then the same with `rehearsal-D` and `--arm D` | 500,000 tokens (2 x 250,000), plus up to 2 one-run overshoots | 2 x 120,000 |
| N arm N, k=3 | `npm run bench -- agentic execute --iteration n-r1 --arm N --cap 5000000` (`n-r2`, `n-r3`); `grade --iteration n-r1` (each); `noise --iterations n-r1,n-r2,n-r3 --out bench/agentic/results/noise.json` | 15,000,000 (3 x 20 x 250,000), plus up to 3 one-run overshoots | 7,200,000 |
| D arm D, k=3, after the band is read | `npm run bench -- agentic execute --iteration d-r1 --arm D --cap 5000000` (`d-r2`, `d-r3`); `grade --iteration d-r1` (each); `report --iterations d-r1,d-r2,d-r3 --decision-out bench/agentic/results/decision.json` | 15,000,000, plus up to 3 one-run overshoots | 7,200,000 |
| Total | | 30,500,000, plus up to 8 one-run overshoots (one per `execute` command) | 14,640,000 (122 runs at 120,000) |

Each iteration holds one arm, so the rehearsal uses two iteration names. Sources for the figures:
`maxTokensPerRun` 250,000 is `bench/agentic/config.json` (provisional; the rehearsal resets it); the
floor of 63,066 tokens per trivial read-only run (7,694,052 over 122 runs) and the 120,000 planning
figure are from the feature's cost estimate, where 120,000 is an INFERRED value no search run has
measured. There is no price sheet in the repository, so no currency cost is stated.

| Decision | Value |
|---|---|
| O-1 cap and staging | Stage R, then N, then D, each command under the `--cap` above. The cap is per command: a stage ends at most at its ceiling plus one run's overshoot per command (2 in R, 3 in N, 3 in D), bounded by `timeoutSeconds` except after a SIGKILL of the executor |
| O-2 model | `model.label` in `config.json`: `codex:gpt-6-luna:medium`. The only harness with a verified headless read-only worker is the one the registry selects (`harness.select: worker.readOnly`) |
| O-5 credential copy | Only the harness auth file (`home.copy`) is copied into a mode-0700 temp home outside the repository, removed after each run. Residual: after a SIGKILL of the executor the copy stays until the user deletes the profile the next `execute` names (section 2) |

## 5. Isolation and tokens

| Rule | How |
|---|---|
| Scratch HOME | Each run gets a fresh mode-0700 directory under the OS temp dir with its own `HOME` and harness home, holding only the credential file (mode 0600); removed after the run, on an executor error and on SIGINT, SIGTERM or SIGHUP, but not after a SIGKILL of the executor (section 2: the next `execute` names it for deletion). The caller's global guidance and MCP tools never reach the run |
| Fixed PATH | A per-run `bin` directory holding one symlink per tool in `path` (`node`, `rg`, `git`), then system `/usr/bin:/bin`; no caller directory is on the run PATH (a directory shared with other binaries such as the harness or `doflow` would expose them); arm D adds a per-run `doflow` shim |
| Own workspace | The workspace is its own git root under the OS temp dir. No checkout path is handed to the worker: paths in argv and env, the shim, and the `-o` file are under the scratch profile. The arm D shim runs a pruned export of `HEAD` containing only `bin/`, `src/`, `core/`, `types/` and `package.json` |
| Read isolation | Isolation is by detection, not by the sandbox: `-s read-only` limits writes, not reads. A command naming a path outside the workspace and profile, or naming `tasks-heldout`, `bench/retrieval/tasks` or `bench/runs`, grades `source-unverified` in both arms. The check is conservative: any word starting with `/` outside those roots counts as a path, so a search pattern such as `rg '/api/'` also excludes the run (it is never scored wrongly, but it raises the excluded share). No harness provides a hard read boundary; the user may override this default at gate-b |
| Capture identity | `report` refuses when the arm N band and arm D iterations were captured from different inputs: snapshot, harness version, model, capture config, or a source change outside `agent-docs/`, `bench/agentic/results/` and `CHANGELOG.md`. `grade`, `noise` and `report` refuse a run whose launch key or prompt digest no longer matches the current task |
| Clean tree | `execute` refuses when the checkout has uncommitted changes, so the measured source is a commit |
| Leak patterns | `arms.<arm>.leak` in `config.json`, matched against each simple command after the shell text is split (quotes, `;`, `&&`, pipes, `$(...)`, `sh -c`) and wrappers such as `env`, `npx` and `node` are stripped: arm N running `doflow retrieve` in any of those forms, or either arm calling an `mcp` tool, makes the run `leaked`. A quoted string that only mentions the command is not a call. `grade` writes the precise verdict to `grading.json` |
| `source-unverified` | A leaked or unreadable run is excluded from the band and counted under the 096 mark `source-unverified`; it scores `null`, never 0 |

The token report is descriptive and carries no verdict (DEC-004): per arm the runs, recorded and unknown
usage, total and median tokens, repeat means, the arm D to arm N median ratio and the arm N repeat-mean
range beside it. The 096 rules define no token rule.

## 6. Records

| Path | Content | Tracked |
|---|---|---|
| `bench/runs/agentic/<iteration>/` | `iteration.json` and, per task, launch, transcript, last message, run status, timing and grading | no, gitignored under `bench/runs/` |
| `bench/agentic/results/noise.json`, `bench/agentic/results/decision.json` | Output of the `noise` and `report` commands in stage N and D | yes, once written; `test/guards/eval-noise.test.js` (G60) validates them |

## 7. Keeping this page current

The commands are checked against `plan` output (`node bench/runner.js agentic plan --iteration dry --arm N`,
which spawns nothing). The CLI is exercised by `test/bench/agentic-e2e.test.js` against
`test/fixtures/agentic/fake-worker.js` with three train and three heldout tasks. Numbers come from
`config.json`, `bench/config.json` and the cost estimate. When a verb, flag, exit code or ceiling
changes, change this page in the same commit. Section 8 is exercised by `test/bench/agentic-ab-unit.test.ts`
and `test/bench/agentic-ab-e2e.test.ts` (fake Claude worker in the same fixture) and its plan by
`npm run bench -- agentic plan --config bench/agentic/ab/config.json --iteration dry --arm A`.

## 8. With/without DoFlow A/B

A second mode of the same executor, selected by `"mode": "ab"` in
[`ab/config.json`](ab/config.json). It compares arm A (bare Claude Code, empty scratch HOME) with arm B
(DoFlow installed into the scratch HOME) on six tasks from [`ab/tasks.json`](ab/tasks.json): routing,
unnecessary pauses, refactor-shared-format (T3), review-113 (T4), doc-options-sync (T5) and
conflicting-instructions (T6). The plan is `agent-docs/briefs/ab-bench-plan-result.md`. Arm names come
from `config.roles` (baseline `A`, candidate `B`); the retrieval mode above keeps `N` and `D`
unchanged. One real run exists (`r1`, task `routing`, both arms, 2026-10-30): it showed the permission
problem below, settled the items listed under `settled` in [`ab/recipe.json`](ab/recipe.json)
(hooks fire and exit 0 in arm B, the config-dir scrub does not break them, the parser's totals equal the
result event's, the init tool names) and left the `unverified` ones open (tool use under the fixed mode,
resume cost, subagent attribution, the OAuth path). The stream shapes in the older fixtures are
synthetic; `test/fixtures/claude-headless/real-arm-{a,b}.stream.jsonl` are the real transcripts.

```bash
npm run bench -- agentic plan --config bench/agentic/ab/config.json --iteration dry --arm A   # spawns nothing
npm run bench -- agentic execute --config bench/agentic/ab/config.json --iteration r1-a --arm A \
    --cap <tokens> --max-tokens-per-run <tokens> --max-budget-usd <usd> [--tasks routing]     # paid
npm run bench -- agentic grade  --config bench/agentic/ab/config.json --iteration r1-a --corpus <review-miss corpus.json>
npm run bench -- agentic noise  --config bench/agentic/ab/config.json --iterations r1-a,r2-a --corpus <corpus.json>
npm run bench -- agentic report --config bench/agentic/ab/config.json --iterations r1-b,r2-b --corpus <corpus.json> [--fixed-cost fixed.json]
```

**Task kinds.** `edit`: the prompt and workspace files come from a case in `bench/native/cases.json`;
its hidden checks run after the worker exits, outside the workspace. `review`: the worker writes
`review.json` for a fixed revision and scope; `review-adapter.ts` turns it into a review-miss
repeat that the existing scorer (`bench/review-miss/grade.ts`) scores. Malformed output is zero
findings, a miss. The review corpus (`bench/runs/review-miss/corpus.json`) is built offline with
`review-miss corpus --records agent-docs/doflow`; the runner refuses `corpus-missing` without it.

**Arms.** Arm A runs with an empty scratch HOME and nothing from DoFlow on PATH. Arm B first runs
`bin/doflow.js install -g -f -t claude --mcp none` from the pruned export inside that HOME, with no
credential in the environment (`home-setup.json` records the result), then the worker. Credentials
reach only the worker, by environment-variable name from `credentialEnv`; `launch.json` records the
names present, never values. Arms are interleaved per repeat: run `r1-a`, `r1-b`, `r2-a`, `r2-b`.

**Refusals before any spend (exit 2).** `max-tokens-missing` and `max-budget-missing` (`maxTokensPerRun`
and `maxBudgetUsd` are `null` in the committed config; the user sets both at run time with
`--max-tokens-per-run` and `--max-budget-usd`, or in a copy of the config, after approving the caps),
`over-cap` (`--cap`), `credential-missing`, `tree-dirty`, `harness-binary-missing`, `tool-missing`,
`review-rev-missing`, `workspace-contaminated` (a task file or review scope would bring `.claude`,
`CLAUDE.md`, `AGENTS.md` or `.doflow` into the workspace), `proof-empty`. `--max-budget-usd` goes into
both arms' argv as a hard stop inside the run (result `error_max_budget_usd`, recorded as a budget
stop and censored like a token-cap stop). Whether the dollar limit applies per invocation or across
`--resume` is not observed.

**Exit codes of `execute`.** 0 when every planned run was attempted, including a run that hit its own
per-run cap (that run is recorded as truncated and censored, and the summary prints a `!!! CAP HIT`
line and a mark on the run); 3 only when `--cap` stopped later runs or the total spend passed `--cap`;
2 on a refusal.

**Credentials and the environment.** Credentials enter only by environment-variable name
(`credentialEnv`). Both arms get `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (documented to strip credentials
from the Bash, hook and MCP subprocess environments; it also removes `CLAUDE_CONFIG_DIR` there, so
hooks fall back to `$HOME/.claude`, not observed). Whatever is saved is redacted first: every
credential value (exact and JSON-escaped, 8 characters or more) and the `sk-ant-...` and `sk-...`
token shapes become `[redacted]` in `transcript*.jsonl` and, after the run, in every text file under
the run directory (the copied workspace, `review.json`, install tails). Retrieval-mode (N/D) runs are
unchanged.

**Permission mode.** `--permission-mode bypassPermissions` was reported as `default` by both arms in the
first real run and every Write, Edit and writing Bash was denied: with
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, claude 2.1.308 forces the default mode ("Declare allowedTools
explicitly, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0"). No settings key or flag undoes that offline
(probe table in the recipe's `--allowedTools` entry). The recipe keeps the scrub, passes no mode flag
and an explicit `--allowedTools Bash,Read,Edit,Write,NotebookEdit,Skill,Task` in both arms (identical,
no settings.json difference between the arms), and expects `init.permissionMode` `default`. Two
guards remain: `execute` kills a run at once when init reports another mode and records
`permission-mode-not-effective` (no more spend); `grade` excludes any run whose stream holds a
`system/permission_denied` event or a non-empty `permission_denials` (`exclusionReason`
`permission-denied`, count in `permissionDenials`; the shared exclusion mark is `truncated`). A final
message that says permissions stopped the run is counted as `blocked`, neither a pause nor an offer
(a wording heuristic, `closingKind`).

**Exclusion, never a score.** `grade` compares each run with the proof expected from the checkout
(skills and agents under `core/shared/`). Arm A must show none of it in init; arm B must show P1
installed, P2 skills and agents in init, P3 SessionStart fired. One classifier checks both arms for
commands that read the benchmark's own truth (the checkout, `core/shared`, `doflow-agentic-tool`, the
pruned export, the hidden checks) or leave the run roots; only the "DoFlow present" checks differ.
Arm A's leak patterns match an *invocation* of the doflow binary in command position (after `env`,
`npx`, `node` wrappers), so `rg -n "doflow roadmap" src/` is clean in both arms and `doflow retrieve`
is a leak in arm A; network commands are a leak in both. Path words are expanded before the roots
check: `~` and `$HOME` resolve to the scratch HOME, `$PWD` to the workspace, `$TMPDIR` and other
unknown `$VAR/...` words are flagged, never skipped. Grep and Glob `path`, `glob` and pattern-as-path
inputs are kept in the tool calls and checked, and a Bash command is stored up to 4000 characters
before the check (display truncates only). A run that fails is `leaked` (A saw DoFlow or ran a
forbidden command) or `not-loaded` (B did not load it) and is excluded as `source-unverified`, with
the evidence in `grading.json`. Timeouts, API errors and runs stopped by the cap are excluded from the
quality scores too; the report shows a sensitivity line that scores capped edit runs 0.

**Censored runs (cost and wall).** A run stopped by the per-run token cap, the dollar stop or the
timeout leaves the quality scores but stays in cost and wall time: a capped run counts at no less than
the cap value in tokens, a timed-out run at its elapsed time, and both are marked `censored` in
`grading.json`. Dropping them would bias the arm that runs long. With any censored run on either side
the report prints no gain or regression word for cost or wall time; the verdict is
`censored-lower-bound` with the censored counts per arm, and Part 4 lists the keys.

**Pauses (decision D3).** When a run ends on a blocking question (an `AskUserQuestion` call, or a final
paragraph that asks the user to decide), it is resumed with `--resume <session_id>` and the neutral
reply "No further input is available. If the task as stated is complete, stop. Otherwise continue with
the task as stated and change nothing outside it.", at most twice. A final paragraph that is only an
offer ("Want me to ...", "Should I also ...", "Would you like ...") is counted as a closing offer and
never resumes the run; the report shows blocking pauses and closing offers per arm. The split is a
text heuristic (`closingKind` in `ab/claude-stream.ts`) with a known error in both directions: a
blocking question worded as an offer is not resumed, and an offer worded in another way is resumed
once. Each pause and resume is counted, segments are kept as `transcript.jsonl`, `transcript.2.jsonl`,
... and `segments.json`, and the cost and token totals of the last segment are taken as the run total.
That the totals are cumulative across `--resume` is from the documentation (Claude Code 2.1.277 and
later), not observed: `grade` records `claudeCodeVersion` from init, and a resumed run from an older or
unknown version has `costBasis` `cumulative-unverified`; the report then prints that verdict instead
of a word for total tokens and cost USD. Check one real resumed run before trusting a cost comparison.

**Metrics** (`grading.json`, from the Claude stream parser in `ab/claude-stream.ts`): tokens
(input, output, cache creation, cache read, total, whole tree including subagents), `subagentTokens`
and `byModel` (from `modelUsage`), `costUsd` (`total_cost_usd`), `wallMs` (the result event's `duration_ms`, summed over segments; `wallMsProcess` is the process wall time from `timing.json`, 1.8-3.2 s longer for start-up), `turns`,
`toolCalls`, `toolCounts`, `subagentCalls`, and questions (`pauses`, `offers`, `blocked`, `resumes`, `unanswered`). The
per-run cap counts cache reads, stops a run in flight from main-loop assistant usage (best effort) and
again on the reported total.

**Report.** Part 1 quality (success on edit tasks, review recall, with the number of review findings produced and the number that matched no known key, per arm) under the 096 noise rules from an
A/A noise artifact (`noise`, arm A iterations only); Part 2 cost and behaviour per task with a
verdict word per metric on relative change, band = max(A/A range, mde), questions as counts only (blocking pauses, closing offers, resumes);
Part 3 fixed cost from `--fixed-cost` (`{"rows":[{"item","value","source"}],"hookLatencyMsP50":n}`),
otherwise "not supplied"; Part 4 validity: exclusions per arm, P1-P3 counts, routing (P4, reported
not gating; name level only), cap sensitivity, prompt equality, spend including excluded runs. P5
(first-request context delta) is deferred.

`noise` and `report` write `ab-noise.json` and `ab-decision.json` to the untracked
`bench/runs/agentic/ab/` unless `--out` or `--decision-out` says otherwise; `report` reads the band from
there when `--noise` is absent. Nothing is written under the tracked `bench/agentic/results/`.
