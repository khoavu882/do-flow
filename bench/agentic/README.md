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
never runs them. The cap is a projected ceiling: `execute` starts a run only while recorded spend
plus one `maxTokensPerRun` is at most the cap. A run can overshoot that reservation because usage is
known only at turn end. The worst case is the cap plus one run's overshoot, bounded only by
`timeoutSeconds`. If spend passes the cap, `execute` exits 3 and prints
`cap exceeded by N tokens on <task>`. Accepting this cap meaning is O-1, the user's decision at gate-b.
`execute` counts a run with unknown usage at `maxTokensPerRun`. On SIGINT, SIGTERM or SIGHUP, it stops
the worker's process group, removes the scratch profile and workspace, counts the interrupted run at
`maxTokensPerRun`, then re-raises the signal as exit 130, 143 or 129, respectively.

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
| R rehearsal, one train task per arm | `npm run bench -- agentic execute --iteration rehearsal-N --arm N --tasks DC-011 --cap 250000`, then the same with `rehearsal-D` and `--arm D` | 500,000 tokens (2 x 250,000) | 2 x 120,000 |
| N arm N, k=3 | `npm run bench -- agentic execute --iteration n-r1 --arm N --cap 5000000` (`n-r2`, `n-r3`); `grade --iteration n-r1` (each); `noise --iterations n-r1,n-r2,n-r3 --out bench/agentic/results/noise.json` | 15,000,000 (3 x 20 x 250,000) | 7,200,000 |
| D arm D, k=3, after the band is read | `npm run bench -- agentic execute --iteration d-r1 --arm D --cap 5000000` (`d-r2`, `d-r3`); `grade --iteration d-r1` (each); `report --iterations d-r1,d-r2,d-r3 --decision-out bench/agentic/results/decision.json` | 15,000,000 | 7,200,000 |
| Total | | 30,500,000 | 14,640,000 (122 runs at 120,000) |

Each iteration holds one arm, so the rehearsal uses two iteration names. Sources for the figures:
`maxTokensPerRun` 250,000 is `bench/agentic/config.json` (provisional; the rehearsal resets it); the
floor of 63,066 tokens per trivial read-only run (7,694,052 over 122 runs) and the 120,000 planning
figure are from the feature's cost estimate, where 120,000 is an INFERRED value no search run has
measured. There is no price sheet in the repository, so no currency cost is stated.

| Decision | Value |
|---|---|
| O-1 cap and staging | Stage R, then N, then D, each under the `--cap` above |
| O-2 model | `model.label` in `config.json`: `codex:gpt-6-luna:medium`. The only harness with a verified headless read-only worker is the one the registry selects (`harness.select: worker.readOnly`) |
| O-5 credential copy | Only the harness auth file (`home.copy`) is copied into a mode-0700 temp home outside the repository, removed after each run |

## 5. Isolation and tokens

| Rule | How |
|---|---|
| Scratch HOME | Each run gets a fresh mode-0700 directory under the OS temp dir with its own `HOME` and harness home, holding only the credential file (mode 0600); removed after the run, on an executor error and on SIGINT, SIGTERM or SIGHUP. The caller's global guidance and MCP tools never reach the run |
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
changes, change this page in the same commit.
