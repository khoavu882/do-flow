# Changelog

All notable changes to DoFlow are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

**Versioning convention:**
- **MAJOR** — any breaking change: a removed/renamed CLI surface (subcommand, flag, script
  entrypoint), a changed installed-output shape/path, or a changed exported module API.
- **MINOR** — backward-compatible additions: new flags, skills, agents, hooks, install targets.
- **PATCH** — backward-compatible fixes, docs, or internal refactors with no observable behavior
  change.
- **Cadence** — cut a release when a feature branch merges to `develop` and this file's
  `[Unreleased]` section is non-trivial, not per commit. Fold follow-up fixes to not-yet-released
  work into the same pending bump instead of tagging a same-day patch on top of it.

## [Unreleased]

### Added
- **Issue #9 stage 3 (stage-to-pack link, FU-7j3k84):** a stage handoff now records the context packs that stage was handed. When `context-pack` records a delivery, it writes `{ taskId, digest }` onto the stage active at that moment. That stage belongs to the pack task's own run, or else to its feature's run, named by `--slug` or by the checkout's feature pointer. `complete-stage` copies these onto its history entry as `packs`. `digest` is the delivery store's own `packDigest`, so `context-pack --since` accepts it. `trace spans` puts `pack_count`, `pack_task` and `pack_digest` on the `stage` span. No run, a run at a gate, or an unreadable record records nothing. An identical pack delivered again in a later stage is recorded for that stage. Older records, and a malformed `packs` value, project as before and never block a completion. No new store or bus. **Not covered:**
  - A `--no-record` pack and a `context-emit` injection leave no link.
  - Two sessions in the same run and stage share one record.
  - The `doflow-run` ledger line still carries no digest.
- **`doflow rules`:** a read-only verb that prints the values the runtime owns for the project, each with its source: the review protocol per task class (attended and unattended, with the gate-b seat floor and the project gates override), gate floors and loop limits, tier bindings, and the effective review and autopilot settings. A field it cannot resolve prints `unresolved:<reason>`, never a guess. Usage errors exit 2.
- **`roadmap --action init-policy [--commit]`:** `init-policy` writes the packaged gate policy to `core/registry/gates.json` for review; with `--commit` it also commits that file onto local develop by plumbing, as an unsigned commit, and never pushes. It does so only when develop is not checked out in a worktree; otherwise it prints the commands to run there. Valid only with `roadmap`; any other verb refuses `--commit` as an unknown flag.
- **Roadmap cleanup keeps the feature folder:** before removing a merged feature's worktree, cleanup copies the worktree's gitignored feature folder into the main checkout, and keeps the worktree and branch if the copy fails.
- **`doflow ui --listen-address <private IP> --tls-cert <path> --tls-key <path>`:** serve the Console over HTTPS on a private interface for phone access. Both files must be absolute PEM paths and the certificate must carry an IP SAN for the address; a missing file, a certificate without that SAN or a key that does not match refuses before listening. Session cookies are `Secure` on the https listener.
- **Windows hook and runtime fixes (#11):** path spelling, folder `fsync`, lock directory creation, `PATHEXT` lookup and the working-directory hash on win32, plus the masking of a Windows home in captured output. The Windows CI leg stays informational.

### Changed
- **Journey-first `design.md`:** the design template now opens with Concepts and Journeys (a state diagram per stateful thing, a rules table, a worked example) and ends with Open Points for Review; component sections follow, readers find them by title, and nine-section designs on disk still parse.
- **Row 135 (feature pointer):** the runtime now keeps one file per checkout, `.doflow/state/feature/<id>.json`, naming the active feature. `lifecycle --action init` and a `feature` run started with `orchestrate` (a `start`, or the `catch-up` that begins the run) write it. A run that reaches COMPLETED, `lifecycle --action merged` and a confirmed `release` remove the file. `lifecycle --action status` with no `--slug` reads the calling checkout's entry and compares it with the branch. If they disagree it reports both sides with `slug: null` (`feature-mismatch`) and exits 1. `--slug` behaves as before. A feature the pointer names that `lifecycle` does not track now prints its slug and how to track it.
- **Row 135 (rules in every brief):** worker briefs now open with a "Rules that apply to you" block. It holds four RULES.md lines marked `<!-- must-carry -->`: finish what you start, build only what is asked, invent no sources, and say when you are not sure. The lines are copied into the `mustCarry` key of `core/registry/rules.json`, so an installed runtime can read them without `core/shared`; regenerate with `node src/runtime/brief-rules.ts --write`. New guard G78 (`brief-rules.test.ts`) fails when the key and RULES.md disagree. A missing ledger drops the block and names it in the brief record's `missing` list. `do-task-brief.sh`'s static fallback now prints the block too, read from the rule ledger. A brief's report format now asks for the `Tools used:` line just before the final `Status:` line. **Not covered:** the review package brief does not print the rules block.
- **Row 135 (agent tool scope):** `tool-scope: all` is gone. Each agent spec names the categories it needs: `reviewer` gets `read, shell, web, mcp`, `delivery-lead` gets `read, edit, shell, agents, mcp`, and the other five get `read, edit, shell, web, mcp`. `core/registry/harnesses.json` `agentLimits.toolScope` maps each built-in category to a harness's own tool names, citing the vendor page read on 2026-10-27. The `mcp` category becomes one selector per MCP server DoFlow's registry names (context7, graphify, semble, sequential-thinking), never a wildcard. Installed agents change:
  - Claude: a `tools:` line, with `mcp__<server>__*` for the MCP servers.
  - Copilot and Kiro: a `tools` list, with `<server>/*` or `@<server>`. Kiro's write agents drop `["*"]`.
  - OpenCode: a closed `permission` block, `"*": deny` and then one allow per declared tool and `<server>_*`.
  - Codex, Pi and Antigravity cannot express a scope, so they get no tool field, never a broader one. `doflow doctor` (`[Agent Tool Scope]`) and `capabilities` say which harnesses these are and why.

  `access` stays and must agree with the scope: it is `read-only` exactly when the scope has no `edit`. The read-only limit keeps the MCP selectors. New guard G77 (`tool-scope.test.ts`) checks all of this. **Known limits:**
  - `read` also carries the skill-loading and todo tools where the vendor docs name them: Claude `Skill`, `TodoWrite` and the `Task*` list tools, OpenCode `skill` and `todowrite`, and Copilot `todo`. Kiro names neither. No harness maps a tool that asks the user (Claude `AskUserQuestion`, OpenCode `question`), so a subagent never blocks on a person.
  - An agent loses every other tool outside its categories, including an MCP server the registry does not name.
  - research-writer's docs-only write path is not expressed.
- **Row 135 (hand-back status):** every agent spec ends its report with `Status: <status>`, one of `done`, `done-with-concerns`, `needs-context` or `blocked`. The enum, with each status's meaning and the caller's action, is defined once in `core/registry/workflows.json` `agents.handback`. The `delivery-lead` spec and do-execute-plan's `parallel_dispatch.md` branch on it in one line: `needs-context` resend with the missing context, `blocked` stop and surface it, `done-with-concerns` verify the concerns before accepting, `done` accept. do-implement dispatches no worker, so it has no branch line. New guard G76 (`handback-status.test.ts`) holds every spec's status line and every consumer's branch line to the enum. The `feature` context rail rises to 233,400 B (measured 233,319 B). The Codex agent TOMLs carry the same status line, and the Codex `delivery-lead` carries the branch line.

### Fixed
- **`--commit` is `roadmap`-only:** it was parsed for every verb, so `install --commit` and `protocol --action list --commit` were accepted; they now fail as unknown flags again (exit 1 and exit 2).
- **`doflow review` unknown flag exits 2:** `review --bogus` exited 1 while the reference documents exit 2 for a usage error.
- **A repeated `remove -t <harness>` exits 0:** when the ledger holds no resources for the harness and nothing would change, it prints `Nothing to remove for <harness>` instead of the empty-plan refusal (exit 1); an empty plan while resources are held is still refused.
- **Settings deprecation note:** the note that asks you to set a key in `settings.json` is no longer printed when `settings.json` already holds that key.
- **Correction to the 2.0.0-beta.7 notes (Feature 103):** they overstated the write-ownership admission controller and the reviewer independence guard. Only `doflow doctor` loads them; no dispatch path calls them, so neither is enforced yet.
- **`doflow doctor` git probe:** the git probe is retried once after a timeout, so a cold macOS git shim no longer makes the first `doctor` exit 1.
- Roadmap cleanup no longer loses a feature artifact: when the main checkout already holds a different copy, the worktree and branch are kept and the audit line names the file (main is never overwritten).
- `context-pack` no longer links a delivery to a run chosen by branch name alone; only `--slug` or a feature pointer on its branch selects the run.
- Hardened the context-pack stage link: it refuses a run folder swapped for a symlink mid-update, ignores malformed `packs` entries instead of throwing, and uses a legacy flat task run when it is this feature's.
- `task-attempt claim` accepts an owner that matches the plan's declared owner once its trailing parenthetical note is dropped (for example `quality-guardian (Opus)`), so `--owner-override` is no longer needed for it.

## [2.0.0-beta.7] - 2026-10-27

### Added
- **Feature 083 (Graph rerank ablation):** bounded graph traversal, a safe lexical fallback, and the G-P3 ablation harness for knowledge search.
- **Feature 084 (Advisor shadow):** per-kind shadow mode for advice, consequence correlation, and an elevation invariant.
- **Feature 085 (Rollout profiles):** rollout profiles, an instant rollback controller, and harness context profiles.
- **Feature 102 (Guidance ablation):** a rule ledger, a never-ablate safety invariant, and an ablation simulation engine.
- **Feature 103 (Agent teams):** an agent-teams coordination protocol, with a write-ownership admission controller and a reviewer independence guard as modules. Only `doflow doctor` loads them (its `team` report); no dispatch path calls them yet, so neither enforces anything in this release.
- **Feature 121 (Local model capabilities):** local-model capabilities, a capability-provider point, loopback execution, and data sanitization.
- **Feature 126 (Worker pool sync):** model catalogue sync, harness probes, the `models.enabled` setting, the `doflow models` command, and a worker-pool view in `doflow doctor`.
- **Row 131 (skill structure lint, G75):** a new guard fails when a skill reference names another reference its own SKILL.md does not name (reads stay one hop from SKILL.md), when a reference over 300 lines has no contents list, when an agent spec has no `tool-scope`, and when the agent specs' combined descriptions pass Claude Code's documented 15,000-token subagent listing cap or the 1,040-character growth ratchet that stands in for the harnesses whose vendors document no cap. `core/registry/guidance-caps.json` gains `agent_description_caps` (one row per harness, with its page and the date read) and `agent_description_ratchet`. The chained pointers in `do`, `do-document`, `do-execute-plan` and `do-flow` references are now either named in SKILL.md as well or point back to it; `scaffold.md` gains a contents list; every agent spec declares `tool-scope: all`, which no harness receives.
- **Row 131 (portable skill frontmatter, G22):** `argument-hint` and `effort` stay at the top of each source `SKILL.md`, and Claude Code still receives them there. Codex, OpenCode, Pi, Copilot CLI, Kiro and Antigravity now receive them under `metadata:` as quoted strings, because only Claude Code documents them; no harness documents rejecting an unknown key, so none is dropped. `core/registry/contracts.json` gains `agentSkillsSpec` (the six Agent Skills spec keys) and, for every harness, the `skillFields` its vendor page documents with that page and the date it was read (2026-10-27). G22 fails on a key outside those lists, and on a harness that would receive a key it does not read without its `skill-frontmatter-<harness>` transform. Pi's adapter now applies a projection's transform.
- **Row 130 (guidance size caps, G74):** `core/registry/guidance-caps.json` records each harness's vendor-documented cap on always-loaded guidance with its source page and check date: Claude Code 4 MiB per file, Codex `project_doc_max_bytes` 32 KiB combined, Antigravity 24,000 B per rule file after includes (its 20,000-token budget is noted, not byte-checked); OpenCode, Pi, Copilot CLI and Kiro document none and carry `null`. G74 fails when a projected always-on file, measured after its includes with `MCP_INDEX.md` at its largest, exceeds its harness's per-file cap, or a harness's combined startup load exceeds a chain cap. The registry ratchet G-B2 is 22 files.
- **Row 130 (agent count, G63):** the roster size stated in prose is now checked: G63 fails when `README.md`, `docs/`, `core/shared/guidance/` or `core/shared/skills/` states a number of archetypes, specialists or agents that differs from the spec files under `core/shared/agent-specs/` (seven today). G14 no longer asserts "the five archetypes"; it only requires that the spec directory resolves.
- **Row 135 (agent hand-backs, tool scope, brief rules, feature pointer):** every agent spec, and every Codex agent TOML, ends its report with one `Status:` line from the hand-back enum (`done`, `done-with-concerns`, `needs-context`, `blocked`), defined once in `workflows.json` `agents.handback`; `delivery-lead` and `do-execute-plan` branch on it (G76). Each archetype's `tool-scope` names abstract categories (`read`, `edit`, `shell`, `web`, `agents`, `mcp`) that `core/registry/harnesses.json` `agentLimits.toolScope` projects to each harness's own tool names (enforced on Claude Code, Copilot CLI, Kiro and OpenCode; Codex, Pi and Antigravity get no tool field); the read-only limit only narrows the scope, MCP is granted one selector per registry server and never by wildcard, and OpenCode's permission block is closed (G77). Every worker brief, the static fallback included, carries a generated "Rules that apply to you" block copied from the must-carry lines of `RULES.md` into `core/registry/rules.json`, and ends with `Tools used:` then the `Status:` line (G78). The runtime writes a per-checkout feature pointer (`.doflow/state/feature/<hash>.json`) on `lifecycle init` and a feature run's start (catch-up included) and clears it on merge, a confirmed release or a completed run; `lifecycle status` without `--slug` reads it and, when it disagrees with the branch, reports both sides and exits 1.
- **Feature 132 (Writer voice):** `do-document` (all modes) and the `research-writer` agent now follow the house prose rules: `do-document` reads the guidance tree's `ARTIFACT_VOICE.md` before drafting, and `research-writer` carries a short inline copy (an agent spec may not name a file, guard G14). Both gain a "when not to act" and preserve-facts clause: leave a plain sentence alone, and never add, drop or change a number, name, date, citation or link. `doc_quality_checker.py` gains `--voice`, an opt-in, deterministic, stdlib-only check that quotes overused and sales words, chatbot residue, knowledge-limit phrases, "serves as", dash and curly-quote habits, Title Case headings, bold density and repeated sentence openers, skips code, block quotes, front matter and link targets, shows a weak tell only when two other tells share its paragraph, and prints no score. It also gains `--facts-diff <before> <after>`, which compares numbers, capitalised names, dates, URLs and citation markers: a fact only in the rewrite is an error (exit 1), one only in the source a warning. The word lists are our own; no third-party rule text was copied. Fixtures are in `test/code-review-fixtures.sh`. `do-document/SKILL.md` is 6,657 B (cap 20,000 B).
- **Feature 133 (Console live discipline, 093.1):** the Console's refresh interval grows x10 while no run is live (RUNNING or at a gate, not stale), is at least nodes/1000 s for a large task graph, and the stale age allows for that deliberate wait; the hidden-tab pause and the 5/10/30 s failure backoff are unchanged. A Pause updates / Resume updates control (and the `p` key) suspends polling or the Fleet stream for a view, the connection pill reads Paused, and resume refetches the full state. After a resume, a stream reopen or a tab return of over 30 s, per-item announcements are muted and one "Reconnected" notice is spoken; notices come from a closed set in `console/web/notices.js`. One shortcut registry, `console/web/keys.js` (`g` then `r|w|s|f` to go to a view, `p`, `?`, Esc), builds the `?` help dialog; the views no longer compare `event.key` to Escape themselves. New checks: `console/scripts/check-diagrams.ts` enforces the `DIAGRAM_GUIDE.md` budget (12 nodes, 16 edges) and fails an edge that crosses a node on the nine workflow SVGs, and `console/DESIGN.md` (tokens, components, states, do/don't for agents) is generated from `tokens.css` and `app.css` with a drift test. No dependency added. Not yet checked in a browser: the pause control and the help dialog in both themes and at phone width, focus return after Esc, and screen-reader wording of the notices.
- **Feature 093 (Console web UI, separate package):** `console/` is a new package, `@khoavu882/doflow-ui` (version 0.1.0, marked `private` until its owner publishes it, no runtime dependency), and `doflow ui [<project>] [--port N]` starts it; exit 2 with an install hint when it is not found. The Console is a local, read-only web UI: it binds `127.0.0.1`, opens through a one-use launch link, answers only `GET` besides the `POST /api/session` exchange, runs a fixed list of read verbs, and sends the page CSP with no inline script or style. Views: Runs (stage rail with gate markers), Run (current activity, timeline, replay), Task graph, Workflows (diagrams built ahead of time with a pinned Pele, run by hand; see `console/README.md`), Sessions (checkouts, hook sessions, workers, slot holders and conflicts, with a footer of what it cannot see) and Fleet (every DoFlow project on the machine, the agent tree, traffic, "working together", and one agent's masked response stream over Server-Sent Events, polling when the stream is unavailable). Transcript text is masked, best effort. Fleet reads transcripts for Claude Code, Codex, Kiro, Copilot CLI and Pi; Antigravity (no session id) and OpenCode (no reader) show DoFlow's own records only, and Windows locations are unverified. **Core additions, all read-only and written to no store:** `orchestrate --action timeline`, an `attempts` field (with `worktreeKey`, `run` and `lineage`) on each task of `task-attempt --action inspect`, `primary --action observed`, `slot --action peek`, `fleet --action projects|tree`, `transcript --action read|stats`, and the registry `core/registry/transcripts.json`; `docs/reference.md` has a row for each. The Console needs Node 24.22.1 or later and a core in its `doflowCore` range. Not yet checked: the page in a browser (layout, themes, the live stream), which is a person's review.
- **Feature 122 remote packages:** `package --action add --source git:...|npm:...` now pins and fetches after an exact person fetch grant; `add --index <file> --id <id> [--version <v>]` selects an already pinned source from a bounded local index that grants nothing. Plans retain fetched snapshots for offline, digest-checked apply and record packages disabled with the pinned source; trust remains separate. UNVERIFIED: whether a particular git host permits fetch by commit, and whether `npm pack` of a registry spec runs lifecycle scripts; `--ignore-scripts` is always passed.
- **Feature 122 authoring:** `/do package <idea>` guides an idea through open contribution points and up to three questions into `doflow package --action new`, then follows its printed next steps. Checked stubs and a README live in `.doflow/package/<id>/` or `--dir`; the folder remains the author's source. The authoring loop covers edit, check, add, apply, enable and trust; every applied content change above inert needs a fresh trust line added by a person.
- **Feature 122 projection:** Package skills and agents are projected into the globally installed harnesses once a package is trusted and enabled, and removed on disable, revoke, remove, a digest change or a suspension; the session-start hook runs the check in the background.
- **Feature 122 (Extension model, local third-party packages):** `doflow package` adds a package from a local directory: `check --path` lists every finding of a package directory and writes nothing, `add --source` writes a plan and `add --plan` records the package switched off, and `enable` turns it on. A package contributes review and debate presets; they are data and run nothing. A package is refused when it carries a `settings`, `order` or `enabled` field or reuses a built-in preset id, and one whose `doflow` range excludes the running version is `incompatible` without affecting any other package or command. `disable`, `trust`, `exempt`, `revoke`, `verify` and `remove` manage it afterwards; `trust` and `exempt` print the line a person adds to `<config home>/packages/grants.jsonl`, and DoFlow never writes that file. Nothing is fetched: no package verb starts `git` or `npm`. **Downgrade limit:** recording a package writes the global lock as version 2, which an older DoFlow cannot read and refuses; `doflow package --action list` says so while the lock is version 2. Executable packages and remote sources are not part of this entry.
- **Feature 090 (Adaptive verification V2 & SDLC self-optimization):**
  - **Sound & Verb-Scoped Impact Selector (Task A.1, IC-001, IC-002):** Expands the dependency graph in `src/runtime/verification/impact.ts` to include non-test helper modules under `test/**` (`isGraphNode`), cutting false unknown-file expansions and resolving helper-mediated test suites. Implements CLI dispatch hub cutting (`bin/doflow.js`, `src/cli/index.ts`, `src/cli/runtime-commands.ts`) and lazy `handle*Command` function body scoping, creating precise verb-scoped spawn edges from CLI-spawning tests to invoked verb handlers. Non-code paths (`CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `docs/**`, `agent-docs/**`, `.doflow/**`) are classified as guard-covered (`isGuardCoveredPath`) when `guardDir !== null` (`test/guards/`), running the structural guard suite rather than triggering full-suite expansions. Exports `resolveTestsImportingHelper` for transitive test importer resolution with cycle termination.
  - **Progressive Verification & Targeted Selection Wiring (Task B.1, IC-003):** Adds `.test.ts` test pattern support in `src/runtime/verification/test-selection.ts` (`NODE_TEST_FILE`) and exports `formatSelectedTestPattern`. Wires `selectImpactedTests` into `VerificationEngine.resolveCommandTier` for `L1` (`LOW`) and `L2` (`MEDIUM`) `targeted-tests` tiers when `v0` is active and source files change, executing impacted tests + guards and falling back safely to broad tests (`unknown-files` or `not-scopable`).
  - **Failure-Aware Retesting & Granular Signatures (Task B.2, IC-004, IC-005):** In `src/runtime/verification/contract-runner.ts` `extractFailedFiles`, maps failure locations occurring inside `test/**` non-test helpers to importing `.test.*` files. In `src/runtime/verification/engine.ts`, enhances `failedFirstState` lookup to match by `check.name` across targeted-run pattern edits, resetting `strikes` to 0 when command hashes change. Extends `failureSignature` to incorporate sorted `failedFiles` and `failedTests` sets, preventing premature `NO_PROGRESS` recovery aborts when distinct tests fail across iterations.
  - **Historical Replay Evaluation:** Replayed across 60 historical non-merge commits (56 evaluated) with zero missed detecting tests (`missedTotal === 0`), verifying zero regression slippage.
- **Feature 120 (Primary session declaration and worker governance):**
  - **Primary Session & Probes (Phases A & B, US1, US2):** Adds `primary.harness`, `primary.model`, and `primary.onContradiction` settings keys. Session bridge hooks observe session model (`model-observations` storage) for codex, claude, antigravity, and pi (`primaryProbe.model: payload`). `doflow primary --action resolve` reports confirmed, unconfirmed, contradicted, or refused primary identity.
  - **Worker Enablement & Ordering (Phase C, US3):** Implements `workers.enabled` setting (`subset` combine, `narrow-only`), `activeWorkers`, `workerGate`, and `inSessionGate`. Dispatch loop and CLI enforce worker enablement; mid-run disabling narrows without widening; holds `workers-enabled-invalid` and `no-enabled-worker`; gaps `worker-disabled`.
  - **Per-Tier Model Bindings (Phase E, US5):** Adds `workers.models` setting (`worker-models` type, tier IDs: `light`, `standard`, `frontier`), `resolveBinding`, worker `--model` recipe capability for codex (`-m`) and antigravity (`--model`), and dispatch model recording (`model {tier, requested, source, served}`). Gaps include `binding:invalid` and `model-flag:unevidenced`.
  - **Reviewer Independence & INV-8 (Phase D, US4):** Implements authoring identities (`kind`, `harness`, `model`, `channel`) and invariant INV-8 in `core/registry/protocols.json`, ensuring headless and sequential dispatch workers never review their own work. `review --action start` outputs `authors` and `forbidden` pairs, refusing `primary-refused`. Gate-b gathers `authoring-identities` fact and denies `findings-invalid` on violation.
  - **Structural Guard & Documentation (Phase F, US6):** Guard G67 (`test/guards/primary-workers.test.ts`) verifies worker ID grammar, `workerGate` call site closure, decoupling, model defaults, and probe consistency. Updates `docs/settings.md`, `docs/reference.md`, `docs/guide.md`, `docs/architecture.md`, and changelog.
- **Feature 119 (Review and debate protocol):** `core/registry/protocols.json` holds the review and debate protocols in one place: the presets `review-deep`, `review-single`, `debate-2` and `debate-3`, the lens catalogue, `order`, `hardRoundCap` 3 and the locked invariants INV-1 to INV-7, read through one validating loader and held by guard G66. `doflow protocol --action list|resolve` prints the presets, or the protocol a run would use (exit 0 resolved, 1 refused, 2 usage), and writes nothing. `review --action start` prints and returns `protocol` (each value with its origin, plus `protocolDigest`), takes `--preset <id>` (a stricter or equal preset only; a looser one exits 1 with `preset-looser`), and reads `.doflow/gates.override.json` as roadmap gate-b does; seat counts now come from the presets (`verification.json` `reviewDepth.depths` is removed; `singleRisks` and `lightPaths` stay). `review/findings.json` may carry `protocol {id, digest}`, `author` and, per seat, `agent`, `session` and `family`; a seat with the author's agent, or with the author's non-null session, is an `independence` error (INV-1), `review.sameFamily` set to `warn` or `refuse` handles an equal known family (`same-family`) and an unknown one is `family-unverified`, `review --action check` reports a contradiction with the commit trailers or the task-attempt owners as an advisory, and the `review.run` telemetry line gains `protocol`. Roadmap gate-b also honours `review.sameFamily: refuse`. Seven settings keys are added (`review.preset`, `review.rounds`, `review.sameFamily`, `review.crossFamilyRereview`, `review.extraLenses`, `review.blockerClauses`, `debate.preset`) with a `string-list` type (each layer adds items, never removes) and an integer `max`. `doflow config schema|validate|set|unset` lists, checks, writes and removes settings per layer (`user`, `project`, `local`); it refuses security-relevant keys and `invariant.*`, applies the narrow-only rule at the project and local layers, and reports each refusal as an entry with `key`, `layer`, `code`, `message` and `allowed`. **Behaviour change:** `advice.model` is now security-relevant with a fail-safe on `advice.enabled`, so an invalid `advice.model` value in a user or project layer, including a malformed project `decision-model.json`, now turns advice off, and `doflow config list` exits 1 for it. `doflow config validate --prepared-run <file>` checks a prepared-run file (task class, `settings` entries judged as `--layer project`, `presets.review` and `presets.debate` against the preset the user, project and local settings give, with the file's own preset as the project layer, and `presets.review` against the class seat floor) and returns one entry per fault, without a harness, git, a model call or a write; the risk-policy step needs the diff and is not applied. Review seats are the `reviewer` agent, and `enforcement` in the resolved protocol reports per harness whether its read-only limit is enforced (codex, pi and antigravity are unenforced). **Review fixes:** `guard.workerDropDatabases` is security-relevant, so `config set` and `config unset` refuse it; a findings record's `protocol` is held to its preset (errors `protocol-rounds`, `protocol-seats`) and gate-b denies a record looser than a non-`auto` `review.preset`, or one with no `protocol` at all when `review.preset` is not `auto` (`protocol-missing`); the text protocol of `review --action start` and `protocol --action resolve` prints `protocol.rules` and `protocol.blocker` lines; an invalid project or local `review.*` value is unreadable (`start` and `protocol` refuse with `settings-unavailable`, `review --action check` exits 1 with `same-family-setting-unread`, gate-b fails closed); `config set` and `config unset` write under a per-file lock (`locked` after 2 s, naming the lock file and its age; a lock is never removed automatically, so a person removes a stale one; a changed file is re-validated, three tries), keep one `<file>.config.bak` and refuse a file over the reader's limit (`too-large`); `review.rounds` below the preset's `rounds.min` is refused as `not-narrower` (a note under `auto`); a preset added to `protocols.json` needs no `settings.json` or `telemetry.json` edit; a debate preset set by a layer names that layer as its origin, and an invariant may carry `kinds` (INV-6 and INV-7 apply to debates).
- **Worker billing record (maint-worker-billing):** New global-only, security-relevant settings key `workers.billing` (type `worker-billing`): an object keyed by worker id (a registry harness id), each entry exactly `{billing: free|metered, asserted: YYYY-MM-DD[, basis]}`, 1 to 16 entries, all-or-nothing. It is read only under `dispatch --billing-cap free` (the roadmap implementation envelope), once per selection pass: `free` lifts a registry `unknown` (every shipped harness declares `unknown`, G58), `metered` narrows, and a registry `metered` is never lifted. A malformed record, or one naming an id that is not a registry harness, makes every worker fail with reason `billing:record-invalid`; a project or local value is ignored (`ignored-scope`). Billing gaps carry `source` (`registry` or `user-record`), a candidate that clears the gate carries `billing`, and `dispatch --action start --billing-cap free` adds `billingRecord` to its JSON and prints `billing: <id> <free|metered> (user record, asserted <date>)` per recorded worker. Documented in `docs/guide.md`, `docs/reference.md` and `docs/settings.md`. Nothing was released.
- **Feature 118 (Agent roster):** The roster is seven agent specs: the two new ones are `delivery-lead` (plans tasks, writes worker briefs, dispatches, checks evidence, commits and merges; no product code) and `reviewer` (reviews a change it did not write). Every workflow stage in `core/registry/workflows.json` carries a required `agent` (lowercase kebab-case, checked in `src/runtime/workflow-engine.ts`): `feature` planning and implementation and `operations` state-check and execution are bound to `delivery-lead`, every review stage to `reviewer`. The `current` object that `doflow orchestrate` `start`, `status` and `handoff` print carries the stage's `agent` (`null` for a gate, and for a run journalled before the binding until it is restarted). Each spec's frontmatter declares `access: read-only|write`; only `reviewer` is `read-only`, the other six are `write`. The key is never projected under that name into any file of any harness (Codex Markdown agents go through a `codex-agents` transform that strips it); each harness turns it into its own limit keys. Each harness in `core/registry/harnesses.json` gains `agentLimits.readOnly` (`native` with the `apply` keys the adapter writes into a `read-only` agent file, or `unenforced` with a reason; every `evidence` entry is a non-blank http(s) URL) and `orchestration.nest`, a sixth operation (whether a subagent can start a subagent; `supported` on Claude, Copilot and Antigravity, `unsupported` on Gemini and Pi, `unknown` on Codex, OpenCode and Kiro, all falling back to `sequential`). **Installed output changes:** Claude, Copilot, Codex Markdown and Antigravity agent files go through a transform, and the `reviewer` carries the harness's limit keys (Claude `disallowedTools`; Copilot, Gemini and Kiro a `tools` list; OpenCode a `permission` block with `edit` and `bash` denied); a `write` spec carries no limit key on any harness and Kiro's `tools` stays `["*"]`; the Kiro install holds seven specialists plus the `doflow` agent. Codex keeps its hand-written TOMLs, one per spec, and only `reviewer.toml` writes `sandbox_mode = "read-only"`, but the vendor documentation says that key does not override the parent session, so the Codex, Pi and Antigravity limits are recorded `unenforced`. **Behaviour change:** `spec-analyst`, `system-architect`, `quality-guardian` and `research-writer` are `write`, so on OpenCode they no longer carry the `edit` and `bash` deny, and their Codex TOMLs no longer carry `sandbox_mode = "read-only"`; "no product code" (`delivery-lead`) and "tests only" (`quality-guardian`) are stated in the specs and hold by discipline, with no limit enforcing them. The dispatch review hold (`REVIEW_OWNERS`) is now `reviewer`, not `quality-guardian`, so a `quality-guardian` task at tier `standard` may step to the next rung under `--fallback auto`, `reviewer` never steps, and `delivery-lead` and `reviewer` are `frontier` in `dispatchTiers.byOwner`. `doflow plan-check` gains the warning `review-owner <id> 'quality-guardian'` for a `quality-guardian` task at tier `frontier` (one trailing parenthetical on the owner is ignored for this warning only; claim matching stays exact, followup FU-ep096r); the text line lists warnings (`; warnings: ...`) for an ok plan and for a plan with problems, and exit codes are unchanged. Agent specs are standalone: neither a shared spec nor a Codex TOML names a DoFlow verb, a `doflow <verb>` command, a state path, a record, a trailer or `DoFlow-Row` line, or a chain artifact name, apart from one hook line per spec and `core-implementer`'s five optional lines (an exact-line exception that fails when stale); the procedure lives in the stage skills. Guards G63 (`agent-roster.test.js`: binding, projection, no limit key on a `write` spec, and name-list parity) and G64 (`agent-budget.test.js`: at most 7 specs, 160 characters per description, 1,000 in all, `access` declared, the standalone scan). **Not verified:** the vendor limit keys and tool names for Gemini, Copilot and Kiro (`tools` lists) and the OpenCode `permission` keys were read from vendor documentation only (`checked: docs`) and never run against the live CLIs; the docs name `bash` as OpenCode's permission key, so FU-v4p417 stays open for the live check only; the Kiro `read`, `shell` and `web` categories are the CLI V3 vocabulary, a 2.x CLI also accepts `read` and `shell`, and only `web` is V3-only, so the list may be only partly recognised there; open followups FU-cqmhg8, FU-v4p417 and FU-q2pwes. **Known limits:** the `reviewer` runs without MCP tools on Gemini, Copilot and Kiro, because DoFlow does not project MCP selectors in 118: the vendors document per-server selectors and the servers DoFlow installs are listed in `core/registry/mcp.json`, but the global wildcards would also open write-capable MCP tools, and restoring per-server selectors for DoFlow's own servers is followup FU-83yxjr (the selector forms are in `docs/reference.md`); a Codex TOML that is no longer in the roster is not pruned on a downgrade (FU-gb1xhy), and `model` and `effort` reach the Copilot and Antigravity files (FU-zgnz9z), both existing behaviour.
- **Feature 095b (Review depth and verify precondition):** `doflow review --action start [--slug <name>] [--base <ref>] [--json]` checks that `HEAD` has a clean-tree verify PASS (the rule gate-b applies: `verify-missing`, `verify-not-pass`, `verify-flaky`, plus `tree-dirty`) and decides the review depth in one call. Exit 0 when ok or not applicable (`no-feature`, `no-run`, `class-exempt`), 1 when refused or when a run record cannot be read, 2 on usage; it writes no file and no telemetry line and never prompts. The depth rule is data: the new `reviewDepth` block in `core/registry/verification.json` (seats per depth, `singleRisks`, `lightPaths`) gives `single` only for a change confined to the light paths at a `singleRisks` risk, else `deep`, and the class's gate-b `minSeats` can raise the seat count; with the `advice` setting on, the `review-depth` advice kind can raise `single` to `deep` and never lower it. `review/findings.json` gains optional `depth` and `risk` (advisory `depth-unmet:<depth>` when the record has fewer seats than its depth), and the `review.run` telemetry line gains `depth`, `risk` and `head`. The roadmap loop applies gate-b's verify rule before it issues the review envelope and holds a failing row as `denied` at step `review`, spending no review seats. `bench review-miss corpus|lint|grade|noise|report` is an offline suite that scores whether a reviewer re-finds defects that earlier reviews found and later fixes confirmed; cases regenerate from the review records and are never edited by hand, and no verb calls a model. Guard G62 holds `do-code-review` to naming the verb and keeps every single-depth rule out of `core/shared/`. When the run or the active feature is uncertain (more than one run for the slug, an unreadable run or record, a run store or folder that cannot be listed, a flat run file that cannot be read and so cannot be ruled out as the slug's, a task class the workflows data does not know, a feature that cannot be resolved), `review --action start` exits 1 with `run-ambiguous`, `run-unreadable`, `records-unreadable`, `class-unknown` or `feature-unresolved`, no seats and `applicable: null`; only a resolver answer of `no-active-feature` (or no answer) is `no-feature` and exit 0, and any other resolver error or a feature slug that is not a plain name is `feature-unresolved`; an empty changed-path list is an unknown scope and gets `deep`. A runtime without this feature rejects a `review/findings.json` that carries `depth` or `risk` (`findings-invalid`, it fails closed), so install the runtime and the skills together. The paid scored runs and the noise band over them are the user's own.
- **Feature 117 (Behavioral verification, Phase B pilot):** Test-side only; no runtime code changes. `test/explore/ledger-sampler.js` is an opt-in seeded sampler outside `npm test`: it gates two real child processes per fs call against the task-attempt ledger, checks each schedule's acknowledged responses and final record against a hand-written sequential model, and exits 0 (every schedule completed, no violation within the bounds; not a proof), 1 (violation, with a replay string), 2 (usage) or 3 (any incomplete schedule, a kill switch, an interrupt, an unwritable report or a swapped-in sampling oracle; never a pass). `test/state/ledger-lock-race.test.js` adds three regressions for the stale-lock defect FU-8acds5 (a lost acknowledged finish, a resurrected cancel, two claims granted token 1), each reproduced under the fault assumption that a lock holder pauses longer than the 10 s stale age (or the clock jumps forward that far), on the runtime of develop `46df3b6c` and also without the gate by stopping a real holder with SIGSTOP; they were registered `todo` until the lock fix (Phase C, under Fixed) and are now required, with required completion checks, a gate self-test, oracle negative controls and a safeguard that fails when a marker outlives its settled followup.
- **Feature 087b (Docs site rework):** The docs site has five sections (Home, Get started, Use DoFlow, Reference, Contributing), a Settings page, and redirect stubs for the retired Overview and Refactor plan pages; `mkdocs.yml` validates omitted files, absolute and unrecognized links and anchors under `--strict`. `src/release/docs-blocks.ts` (`npm run docs:blocks`) writes or checks the generated tables (capability matrix, the two coverage matrices, task classes, settings keys, a command index from both help texts) and `docs/llms.txt` from the registries and nav; guard G61 fails when (a) a generated block or `docs/llms.txt` differs from what the generator renders; (b) a `BEGIN GENERATED`/`END GENERATED` marker on any docs page is not registered to that page, unpaired or nested; (c) a docs page is neither in the nav nor a redirect stub of the fixed shape; (d) a `doflow` or `doflow-run` verb a nav page names in a code span or code fence is not in that command's help; (e) `mkdocs.yml`'s `validation` block is not in block style with its four keys at `warn`; (f) an action in `docs.yml` is below its floor (checkout v7, setup-python v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5) or below the same action in another workflow; (g) `docs/llms.txt` exceeds 4,096 bytes. Every nav page's claims were audited against the code and the false claims the audit found were corrected; open followups FU-7bnh0m, FU-8wr394, FU-3mr2gz and FU-gx7grh remain. `docs.yml` uses checkout v7, setup-python v7, configure-pages v6, upload-pages-artifact v5 and deploy-pages v5. The site is published by `docs.yml` on a push to `main` that touches `docs/`, `mkdocs.yml`, `requirements.txt` or the workflow itself, or on a manual `workflow_dispatch` run.
- **Feature 106 (Model fallback ladder):** A failed dispatch is class `quota` only when its masked summary matches a harness's registry-declared `quotaSignals`; codex signals (`rate limit`, `usage limit`, `quota exceeded`, `too many requests`, `resource_exhausted`) remain `basis: unverified`, so fallback output says `signals unverified` until backed by a real transcript. Quota releases the 080 attempt, so it does not count toward the 082 repeat-to-BLOCKED rule, but it still spends one task-budget attempt; the quota-ed harness is exhausted run-wide. `--fallback off|ask|auto` is available on `start` and `resume`, and `--ladder <id>[,<id>…]` on `start` accepts registry harness ids once each, at most 8, without `--harness`; otherwise registry order applies. `dispatch.fallback` accepts `off` or `ask`, defaults to `ask`, and `auto` never takes effect from settings: a user-scope file naming `auto` is invalid and the fail-safe `off` applies, a project or local file naming it is ignored and the other layers decide (default `ask`); project settings may only narrow it to `off`. Ask holds with the next rung proposed, off holds without a proposal, and auto steps light and standard work. Every move off a quota-ed rung goes through these rules, including a move to an earlier rung that became eligible again. A task whose line says `tier: frontier`, a frontier-tier owner, `quality-guardian` and unknown owners never step; no remaining rung holds `ladder-exhausted` and never falls back to `sequential`. Holds do not wait or re-admit tasks: they appear as decide-phase gaps with cause `quota`; the run ends blocked when nothing else can progress. `resume --fallback auto` accepts each pending quota proposal once, bound to the proposed rung (if that rung is no longer the next one the task is held again with a new proposal), and leaves the run's mode unchanged; `off|ask` sets the mode and withdraws accepted proposals. Non-quota holds persist until the task succeeds outside dispatch via `task-attempt`, after which they no longer block completion. Quota, step and hold events print on `step` and `run`, are retained in `fallback.events` (newest 200, older counted in `eventsDropped`), and quota/step events are copied to the dispatch record; inspect text prints each hold and inspect JSON includes `fallback`. This changes 082's failure-class contract for quota only; other failure classes are unchanged.
- **Feature 095 (Review convergence, 095a):** `review/findings.json` schema 1 gains optional `rounds` and per-finding `origin`/`preExistingAt`/`escapedFrom`, `verification`/`verifiedBy` (a verifier must not be a seat that reported the finding; ids compared after NFKC, removal of invisible and format characters, dash unification, trim and case folding), `bugClass`/`sweep`, and `acceptedAs` (on user-accepted); the validator moved to `src/runtime/review/findings.ts` (`gates.ts` re-exports it); new `doflow review --action check [--slug|--path] [--json]`, which reads the record and writes only one counts-only `review.run` telemetry line (exit 0 valid, 1 invalid/missing, 2 usage; `preExistingAt` must be an ancestor of `reviewedHead`; advisories `unverified-blocker`, `round-cap` at 3, `bug-class-open`, `ancestry-unchecked`); new counts-only telemetry kind `review.run`; do-code-review names the fields, runs the check before its handoff, re-reviews only `reviewedHead..new head` and asks for an approach rethink at round 3. Gate-b behaviour is unchanged: no predicate reads the new fields, and every record valid before stays valid unless it puts an out-of-vocabulary value in a newly reserved key.
- **Feature 092 (Console API prerequisites):** Adds `orchestrate --action list` and `revision` in run snapshots; the `DOFLOW_UPKEEP=off` switch (every upkeep moment, after-verb, verify and install), `store-migration-pending` refusal and doctor note; and the tightened G45.5 guard. `list` shows one row per run (the copy `status` reads), never follows a symbolic link or blocks on a FIFO, and refuses every flag another action reads; `list` and `status` from a linked worktree no longer move records.
- **Feature 089 (Evidence-aware verification V1, reuse first):** `verify` can answer an L1 or L2 check from a recorded PASS instead of running it again. It ships off: writing `{"schema":1,"verify.reuse":"on"}` into `<config home>/settings.json` (global-only, default `off`; `config set` is not supported) turns it on, and `DOFLOW_VERIFY_REUSE=off` can only turn it off. Every level stores a PASS in the new `verification-reuse` store (`.doflow/state/verification/reuse`, newest 400, 2 days); a lookup refuses a record older than 24 hours, and L3 (HIGH or CRITICAL) always executes. The check key moves to payload version 2: it now also covers the sorted names of ignored entries, the bytes of the declared ignored inputs (`policy.reuse.ignoredInputs` in `core/registry/verification.json`) and the identity of `node` and of the command's first word on `PATH`, and a stored excerpt is bounded to 2,200 characters. A reused check is labelled `reused {ref, recordedAt}` in the report, its telemetry says `shared: "reused"`, and the run record gains a `reused` count before `reportSha256` only when reuse is on. A stored PASS is written only when the key's inputs are unchanged after the check ran, any executed non-PASS removes the stored PASS of its key while reuse is on, and the report counts gain `checksReused` (additive) with a `(R reused, not executed)` text label. Residual risk: Reuse trusts the key, and the key does not see: network, time, external services or flaky tests; files outside the repository, such as `~/.npmrc`, the global git config or `<config home>` files; the contents of an ignored directory whose name is unchanged (`dist/`, `node_modules/`); ignored inputs other than those declared, which are read only at the git root, so a subpackage `.env` is not seen; untracked files under `.doflow/`; and the dependencies of a wrapper (`npm run`, `npx`, `env`, `cd … &&`). A check whose command the key cannot parse safely (quotes, escapes, `$`, an inline `PATH=`), or that links to a directory outside the repository, is never reused. A check that changes the files it reads is never stored. Reusing a producer check (a build) skips its side effects, so a later check that executes may fail spuriously. An executed failure removes the stored PASS only while reuse is on, so a PASS stored while reuse was on can be reused for up to 24 hours after reuse is switched on again, even if a FAIL ran in between with reuse off. Use reuse only for deterministic checks. The 24-hour limit and the off default bound the rest. `npm run bench -- impact-replay [--rev <ref>] [--commits <n>] [--json] [--out <path>]` replays past commits offline (scratch `git archive` exports, no model call) and prints `insufficient-data`, `keep-off` or `selection-candidate`; its detecting set is a lower bound, the verdict enables nothing, and test selection is not wired into `verify`. See [Reuse of a recorded PASS](docs/reference.md#reuse-of-a-recorded-pass).
- **Feature 107-B (Guidance parity across harnesses):** Every harness now loads the same core guidance set, `DOFLOW_CORE.md` and the files it imports (7 files, 9,975 B), and nothing more, before the user types. **Installed output changes:** Kiro steering (`.kiro/steering/`) holds those 7 files instead of the whole guidance tree (27 files before); Copilot instructions hold the same 7 as `*.instructions.md` under an `applyTo: '**'` header, with the four rule files moved from `instructions/` to `instructions/rules/`; Antigravity `.agents/rules/` holds the 7 files flat (it held the 4 rule files), each under `trigger: always_on` front-matter, without which Antigravity discards a rules file (the `antigravity-always-on-rules` transform). The full tree stays in `.doflow/guidance` for on-demand reads. `doflow update` migrates existing installs: it removes the files the new projections no longer produce, keeps a file you edited (with one `kept hand-edited` notice) and leaves files of your own. The prose pointer that Codex, OpenCode, Pi, Copilot and Antigravity receive now tells the agent to read the core set unless it is already in its instructions, and other guidance files only when a skill names them; its guidance path is filled per scope (an absolute path under the home directory at global scope, `.doflow/guidance` at project scope), which fixes the global pointer path (FU-53rmvt). The core-set walk is the new `guidance-manifest` selector (`select` on a copy-tree projection, plus a `flat` layout); it refuses an import that leaves the guidance root, is absolute or is a symlink, and fails on a dangling import that is not generated (`MCP_INDEX.md` stays exempt). Shipped skill prose says "the question tool" where it named `AskUserQuestion`. Guards: G13 gains a per-harness parity check (each harness within the core set plus 1,024 B, measured through the registered selector and the rendered pointer, with controls for a dropped core file, an unselected tree and a ninth harness) and G24 a harness-only tool-name check and a doubled-determiner check, replacing one literal pair tied to the old pointer text. Global Antigravity and Copilot instruction files are not written (documented, not new). Verified once: a Codex run (`gpt-6-luna`, codex-cli 0.163.0) read all 7 core files and no other guidance file before answering. Not verified: that `agy` loads the always_on rules (the vendor page states it; no `agy` run was made), and pointer-following on Pi and OpenCode (no trace run).
- **Feature 115 (Parallel execution model):** `doflow plan-check <plan path> [--json]` prints the one plan verdict (`planVerdict`) that the task-attempt ledger and the roadmap facts now also take, so the three no longer judge a plan separately; it is read-only and exits 0 when ok, 1 on problems and 2 on a usage error or an unreadable file. `validate` calls it for each `plan.md` and reports every problem under the new rule `task-graph`, and the plan template's example task lines carry the `acceptance:` key. `doflow slot --action run|list|release` is a named, machine-wide queue with one holder per name: `slot run --name <name> [--timeout <s>] [--no-wait] -- <command>` waits its turn, runs the command with `DOFLOW_SLOT` set and exits with its code, or exits 75 when busy or timed out; `release` refuses a live holder and the verb never signals a process other than its own child; no verb takes a slot by itself. Its files live in the new `slots-user` store (`~/.doflow/state/slots`, newest 64, 30 days). `doflow-run paths --json` gains `feature_root`, the checkout that holds the feature folder, which `validate`, `render-audit` and the `decision` verb now use, and the freshness hash of a relative evidence locator is taken in the checkout the verb runs in. **Behaviour change:** run from a linked worktree, per-task records (evidence, claims, readiness, research requests, outcomes, delivery and orchestration runs) are now always read and written in the main checkout, including for projects that track `agent-docs/`; before, that happened only when the worktree lacked the feature folder. `context-emit` keeps its delivery record there too. Records a worktree already holds are moved to the main checkout by one locked sweep on every such call, whatever task it names; `store-conflict` (exit 2) now covers the whole sweep and names every pair that differs, is a link or is one file, and the files already moved stay moved. A DoFlow sandbox checkout keeps its own store. **Behaviour change:** every task id other than its feature's slug is now kept under `<store>/<slug>/` whenever a feature slug resolves (`--slug`, else the branch's), with or without a decision register, the orchestration run included (`orchestration/<slug>/<task>.json`); so new records of features without a register get a namespaced path, while their flat records stay readable in place and the first write lands in the namespace. The edit hook (and `verify`) read the main checkout's readiness record first from a linked worktree and refuse when the worktree holds a copy with other bytes. On POSIX, `slot run` starts the command through an `sh` exec wrapper only after its slot is durably recorded: the command exits 125 without running when the runner dies before the start, and a command that cannot be run reports `sh`'s exit 127 message. `plan-check` runs no storage upkeep. Features 066 to 071 now report `no-tasks` in `validate`. See [Where a task's records live](docs/reference.md#where-a-tasks-records-live). Nothing is released.
- **Feature 114 (Program mode in /do):** `/do program <goal>` (or an ask larger than one feature) enters program mode to research a programme-sized goal over up to 6 sub-questions, offer candidate roadmap shapes, write a roadmap draft, and check it with `roadmap seed --action check`; it operates in hand-over mode only, never writing the roadmap, never running the land command, and never delegating landing to a subagent or autopilot. `seed --action check` prints `land`, the command the person runs to land a clean draft (`--json` key `land`, last key; text line 2 `land (person only): ...`; a string only for `check` with `ok` true and every row sharing one `change`, `apply` for adds and `amend` for amends; otherwise `null`; also `null`, with no `land` line, when the root or draft path holds a control character: U+0000-U+001F, U+007F, U+2028 or U+2029). A missing `agent-docs/roadmap/rows.json` (`ENOENT` only) is read as an empty store on `check`, `apply`, and `amend` (`seed.sha256: null`, text line 1 ends `, store absent`), `apply` creates the directory, store, and table, and `amend` reports `row-not-found`; any other read error still exits 2. `--depth deep` now points at program mode (`references/program_mode.md`), replacing the Epic hierarchy. Bench cases `do/6` (`programme-ask-proposes-program-mode`) and `do/7` (`single-feature-ask-skips-program-mode`) are appended to `bench/do/evals.json` (baseline not captured). The G13 research rail is raised from 35,302 B to 37,840 B.
- **Feature 113 (Roadmap seed validator):** `doflow roadmap seed --action check|apply|amend --draft <path> [--json]` validates a draft of roadmap rows (`{schema:1, rows:[...]}`) against `agent-docs/roadmap/rows.json` and, for `apply` (add rows) and `amend` (replace rows not yet started), writes the store and `ROADMAP.md` by temp file and rename under the roadmap lease. Exit 0 clean or written, 1 finding or refusal, 2 usage; the result is one schema 1 JSON object or a text form capped at 12 lines, with write-set overlaps and rows that run alone listed. `apply` and `amend` refuse `needs-person` unless autopilot is verifiably off for the config home (a fail-closed seed switch reader, `readSeedSwitch`, that ignores `DOFLOW_AUTOPILOT_ENABLED` and refuses on any doubt) and `lease-held` while a loop step holds the lease; a static guard keeps the autopilot code away from the verb, which is a proxy for person-only, not proof of who ran it. A relative `--draft` resolves against the current directory and the optional `<project>` positional only locates the store. A `writeSet` entry must be a canonical repo-relative path, the store must carry `schema` 1, the validator is total on adversarial input, text output escapes line breaks to keep the 12-line cap, and a failed write removes its temp file. The store validator is tighter and `render --check` reports the same codes: the store now rejects an unknown `class` (`class-unknown`), a `needs` cycle (`needs-cycle`), unknown keys (`seed-unknown-key`) and malformed fields (`seed-invalid`), and a seed file that is not valid JSON is `seed-invalid-json`; the current store passes every rule. `needs-person` joins the closed `denyReasons` list. Guards G54 (seed person-only clause) and G57 (new store-rule fixtures and the `SEED_RULES` documentation clause) are extended; no guard file is added.
- **Feature 096 (Eval noise floor):** `bench noise --iterations <a,b[,c...]> [--out <file>] [--json]` measures eval noise floor over k baseline repeats (A/A range), verifying that iterations share model, commit and case set, and re-running programmatic grading twice in memory to check grader stability. `grade` classifies infrastructure statuses (`timeout`, `api-error`, `truncated`) and derives the `no-output` infra class when no transcript, `routing.json`, or `outputs/` artifact exists; `no-output` is not a `run_status` value. With-skill runs whose skill source is not `verified` are excluded as `source-unverified`. `bench report --iteration <a[,b...]> [--noise <file>] [--decision-out <file>]` requires candidate stamps with `model` and `sourceAt`, and checks that candidate, noise artifact, baseline and config models agree and that the noise artifact case set matches `baseline.json`. It evaluates gains against the measured noise band across corpus, train and heldout scopes with a 95% bootstrap confidence interval, reporting structured decisions (`gain-above-noise`, `within-noise`, `regression`, `inconclusive`), merge recommendations (`merge-candidate`, `do-not-merge`), and overfit detection (`overfitSuspected`; `null` when heldout is inconclusive). Guard G60 (`eval-noise.test.js`) verifies decision and noise-artifact consistency and closed vocabularies across tracked JSON, documentation and code. No band is committed.
- **Feature 097 (Agentic baseline, offline stage 1):** `bench agentic plan|execute|grade|noise|report` compares two arms on the same codex worker, which differ only in the retrieve paragraph and one PATH shim, over 20 tasks (12 train, 8 heldout); results go through the 096 band and decision. `execute` refuses without `--cap` (the per-command projected ceiling plus at most one run's overshoot). Each run gets a 0700 temporary home that holds only `auth.json`, removed after each run and on signals; each iteration holds a lock; spend is summed per turn, and an unknown or incomplete run counts at the per-run maximum. Heldout isolation is by detection only. No paid call has been made: the paid capture, Node 24 and the real worker behaviour are not reached.
- **Feature 104 (Design ideation research):** Feature discovery (`/do-brainstorm`) and design (`/do-design`) run a bounded ideation-research pass. A new `ideation` research-request reason exists, and an open ideation request holds the stage until it is resolved; the protocol is in `do-document/references/embedded-research.md`. Two bench cases were added as pending (not run).
- **Feature 108 (Roadmap loop):** `doflow roadmap --action render|status|next|audit` is a session-driven runner that does at most one step per call (pick, gate, merge, render or cleanup) or returns a `perform` envelope for a skill stage, with the closed outcomes `acted`, `perform`, `idle`, `denied`, `blocked` and `stopped`. The roadmap seed is `agent-docs/roadmap/rows.json` (identity, `needs`, class, write set, `requires`, optional `hold`); status is derived from git, and `render --check` reports drift. Gate policy is data in `core/registry/gates.json` (per-class predicates, protected paths, limits and a closed `denyReasons` list); a project override can only narrow it. `orchestrate --action decide-gate --policy <gate>` evaluates it from develop's committed head and records the decider `autopilot` (a new reserved `policy` decision channel) with the policy digest and the inputs; a deny leaves the gate pending, and it refuses `--decision`, `--forced` and any caller-named decider. Approved rows merge by git plumbing (`merge-tree`, `commit-tree`, `merge --ff-only`) with crash repair and `DoFlow-Row` and `DoFlow-Policy` trailers; the lifecycle status accepts the `DoFlow-Row` trailer as merge evidence. `verify --action report` appends a head-bound run record, `review/findings.json` (schema 1) is the do-code-review output contract the gate reads, and `dispatch --action start --billing-cap free` restricts a run to workers whose registry `billing` is `free` (every shipped harness declares `unknown`). The kill switch `autopilot.enabled` ships `off` (global-only; `DOFLOW_AUTOPILOT_ENABLED` and the `autopilot/off` sentinel can only turn it off). Review hardening: the kill switch fails closed (an unreadable sentinel counts as set, and the switch is read before every mutating act), cleanup proves the branch tip is on develop before it removes anything, autopilot cannot accept a blocker as `user-accepted`, and a plan with a `doflow-verification` block is denied at gate-a and gate-b. Nothing in the loop pushes, tags, publishes or installs. Guards G53 (roadmap git verbs), G54 (roadmap imports and spawns), G55 (gate vocabulary), G56 (decider channels), G57 (render check), G58 (worker billing) and G59 (review findings contract).
- **Feature 088b (Verification baseline V0; the 088 telemetry contract, hook lines, trace spans and `--paired-env` shipped in 2.0.0-beta.6):** Claude `post-shell-observe.sh` records tool runtime in `tool_duration_ms` (with `duration_ms:null`), verification levels L0–L3 and the `level` key in `verify.run`, V0 flag (`DOFLOW_VERIFY_V0=off` and sentinel `<config>/verify-v0.off`, recorded in `verify.run.v0`), failed-first execution order from file digests (`verification-v0` store), in-flight dedup with run-lock link primitive (shared leader/follower roles, bounded output excerpts in the in-flight store with a short TTL of about 2 minutes), `bench verify-baseline` entry over recorded snapshots, and controlled-loop baseline shown as observed, not a result: "verdict not yet derivable" (1 of 5 loops, 1 of 2 harnesses).
- **Feature 109 (Worker eligibility):** `worker --action evidence` records harness capability evidence from free CLI checks (`--checks <path>`) or completed worker runs (`--worker-run <w-id>`) into `core/worker-evidence/<harness>/` (FU-c1ydm1).
- **Feature 085a:** `release:rehearse` exercises release checks in an isolated clone and includes
  the `plantuml` and `raw-ts` seeded-fault modes. Preflight adds `stable-allowed`
  (`--allow-stable`), `version-ahead`, `changelog-names-merges`, and `tag-at-head`
  (`--tag-pushed`). Guards G50 (bare imports) and G51 (release-workflow rules) have negative
  controls.
- **Feature 091 (Trace analysis and OTLP export):** `doflow trace analyze` (three detectors: latency hotspots, redundant verification, retry loops; `--emit evidence|followups`; context section per session; exit 1 on a finding), opt-in `doflow trace export --otlp-http` (OTLP/HTTP JSON only, env vars OTEL_EXPORTER_OTLP_[TRACES_]ENDPOINT/HEADERS/TIMEOUT, empty counts as unset, at most 20 requests of 512 spans, `--dry-run` sends nothing; never prints endpoint, headers or bodies), no content capture, exported span ids are remapped at export time from payload values only (no local identifier is an input), `tool_call_id` is the only identifier exported raw, the three hook keys `emit_reason`, `emit_bytes`, `emit_digest` (digest is local, never exported), the real collector check is not done (user-run).

### Changed
- **Feature 107-C (Guidance rebalance):** the guidance rebalance removes the dead question fallback, anchors skill invariants, and tightens the G13 budget.
- **Feature 123 (Tests and bench in TypeScript):** the test and bench TypeScript migration is complete.
- **Feature 124 (context7 at every library-fact stage):** stages that state library facts now name the context7 server, and `doc_quality_checker.py` gains an advisory check for uncited vendor claims.
- **Row 134 (constitution MUST gate):** the Constitution Check is no longer advisory. `plan.md` §2 records one `| Principle | Tier | Result | How |` row per principle, and `orchestrate` handoff or `complete-stage` of the `do-plan` stage refuses a MUST principle marked FAIL or without a row, as does a `catch-up` that would backfill that stage; the roadmap loop records the refusal as `denied: plan-exit-refused` and keeps the row at planning. Each refusal names the principle and the unblock: revise the plan, or a person amends the constitution with `/do-constitution`. No waiver exists, and a headless run gets the refusal, never a prompt. A SHOULD FAIL is one note. Every base principle is MUST (`CONSTITUTION_BASE.md` 1.1.0); a tier-2 principle is MUST unless it says `**Tier:** SHOULD`. A plan written before this change needs the table before its planning stage can complete. Only visible Markdown counts (a table or an id in a fence or an HTML comment does not), a table needs its separator row, an overlay with no `## Principles` section or a duplicate id refuses naming the file, an overlay that downgrades a base MUST prints one note with its version, and an installed runtime reads the base from its guidance tree.
- **Row 134 (plan self-review, red flags, clarify coverage):** do-plan step 9 is a self-review that runs `plan-check`, which now prints `findings` with `path:line`: requirement ids the plan never names, placeholder lines, and the constitution rows. Its `ok` and exit code stay the task-graph verdict. do-diagnose gains a Red Flags table from the recorded bench failure `do-diagnose/1`. The brainstorm round log ends with a Clear / Partial / Missing / Deferred line per requirement area.
- **Row 131 (trigger-only descriptions):** the `do-execute-plan` and `do-flow` descriptions now say when to use each skill and when to skip it, not how it works (515 and 518 characters down to 368 and 494); `do-flow` names a single phase as a skip case.
- **Row 131 (skill headroom):** do-execute-plan, do-brainstorm and do-code-review move step detail into their own `references/` files (`state_checkpoint.md`, `intent_seed.md`, `round_log.md`, `handoff_branches.md`, `tools.md`, and new sections of four existing ones), each behind a one-line pointer, and now sit at 15,916 B, 15,295 B and 15,496 B against the 20,000 B G22 cap.
- **Row 130 (flags out of the core):** `FLAGS.md` is gone from the always-on set. Its rules (user input beats auto-detection, the `argument-hint` contract, the shared flags `--depth` and `--type`) and one sentence keeping all four runtime behaviours (a source-editing stage graded against its class contract first, a failed verification classified and retried under the runtime's bound, every call recorded and read back, a need routed to a healthy provider), each with its own `rules.json` row, sit in a `## Flags and runtime` section of `rules/RULES.md`; `--focus` is documented only in `do-diagnose`, which already owned it. G4 now reads that section and fails when the always-loaded set names any single-skill flag. The generated `MCP_INDEX.md` is unchanged.
- **Row 130 (guidance core trim):** the four always-on rule files `rules/RULE_01_SAFETY.md` … `RULE_04_QUESTIONS.md` are one `rules/RULES.md` with `## RULE_01` … `## RULE_04` sections, so every harness loads one rules file instead of four (Antigravity `.agents/rules/`, Kiro steering and Copilot `instructions/rules/` each hold one file fewer per rule). Two clauses that restated `PRINCIPLES.md` are gone ("Validate before execution, verify after", the loop; "evidence-based claims only", the core directive); every other rule sentence is kept. `doflow update` removes the four old files, and `FLAGS.md`, from an existing install, including one whose shared `.doflow/guidance` rows belong to a harness the run does not update (a v1.14.1 claude+pi install updated with `-t pi`): the orphan prune that already covered the runtime trees now also judges the shared guidance tree, deleting a retired file only when its bytes match what DoFlow recorded and keeping and naming one a user edited.
- **FU-qrg45y (advice from the orchestrator path):** `/do` now documents the optional `advise` second opinion at its decision points: `tier` before handing a package to a worker, `mcp-need` at capability routing, and `followup-triage` per pending follow-up in `/do maintain`, each with its `advise --action outcome` line (`task-class` is asked by `classify` and `review-depth` by `review --action start`, so they need no skill step). New guard G31.4 fails when a registered advice kind has neither a runtime ask nor a call site in a fenced bash block with an outcome line, and ignores comments and prose; `do-test`'s outcome command moved into a bash block for it. The call templates live in `core/shared/skills/do/references/advice_calls.md`, with one pointer line at each decision point. The `research` loaded-context rail rises to 38,900 B for the added text (measured 38,864 B; G13 counts a named reference in full).
- **maint-thin (thin defaults):** `review.preset` now defaults to `review-single` (1 seat, 1 round); `auto`, `review-deep` and `review.rounds` stay available and narrow-only still stops a project from going thinner than its user. The gate-b seat floor (`minSeats: 2`) binds unless autopilot is verifiably off (an uncertain switch binds it); a person-attended review follows the preset. A `review.preset` this install does not have blocks the review (`settings-unavailable`). `team.writerCap` defaults to 1. `roadmap seed apply|amend` no longer refuses while autopilot is on: the rows land `proposed`, autopilot skips them (`row-proposed`), and the new person-only `doflow roadmap promote <id...>` makes them ready; it needs an interactive terminal (`needs-person-tty`) and autopilot verifiably off. The pre-implementation gate's ignored-path skip never covers `.doflow/` or `agent-docs/doflow/`, so an edit cannot forge a readiness record. Readiness: the pre-implementation gate skips gitignored paths, `readiness` carries scope, verification plan and invariants from the last record, a directory locator is refused, and `evidence --action retire --stale` retires stale evidence. The debate default is unchanged.
- **BREAKING: Node 24.22.1 or newer is required; Node 22 is dropped (maint-node24-floor).** `engines.node` is `>=24.22.1` (it was `^22.18.0 || >=24.3.0`), the 2026-10-21 Node 24 security release (CVE-2026-111497). `doflow` exits 2 with `doflow: Node <version> is not supported; doflow needs Node >=24.22.1 (Node 22 and Node 24 before 24.22.1 are no longer supported).` on an older runtime, before it loads any module; Node 23, 24.3 to 24.21 and a prerelease of 24.22.1 are refused the same way; Node 25 and later are accepted. Upgrade Node before installing or updating DoFlow. `doflow doctor` now adds a warning (never a finding, exit code unchanged) when the running Node is below the patched release of its line, 24.22.1 or 26.12.1, naming the CVE (a line without a known patched release, such as 25 or 27, gets no warning). Every Node pin in `.github/workflows` is exactly `24.22.1` (a bare `24` resolves to the runner's cached 24.x, which can be older than the floor and is refused by `doflow`): the `cross-os-tests.yml` matrix, `shell-suites`, `drift.yml` and every `release.yml` job. Release rule R11 and guard G51 require every workflow pin and the `docs/reference.md` rehearsal command to equal the `engines.node` floor, and the beta-cut rehearsal (`rehearse --node`) needs that Node exactly. The docs (setup, quickstart, reference, llms.txt) state the new range, and guard G49 now also rejects a page that claims a Node 22 floor. The Node 22.18 to 24.2 wording in the setup page and the Node 22 comments are gone. Evidence: `test/e2e/node-floor-guard.test.js` (versions 22.18.0 to 24.22.0 refused, 24.22.1 and later accepted, red on the base), `test/runtime/doctor-node.test.js`.
- **Feature 095b (Review depth and verify precondition):** `/do-code-review` runs `review --action start` before any other review step and stops on exit 1; it takes the seat count from the result instead of a prose rule, and `MODEL_SELECTION.md` points to the verb. The verify run record (`.doflow/state/verification/runs/<taskId>.jsonl`) gains `risk` after `verdict` (the report's risk level; schema stays 1, and readers and gate-b ignore a missing one). The `review-depth` advice kind is now asked by the `review` verb (`askedBy`), and its static answer is the depth rule.
- **Feature 116 (PreCompact keeps acceptance criteria):** The Claude and Codex PreCompact hooks now take their text from one shared builder, `.doflow/shared/hooks/policies/compact-text.sh`. The text opens with the preserve list, which now also names "acceptance criteria and pending verification of the active task", so the 490-character cut can only shorten the git lines after it; recent commits come last and are joined by " | " (before, `paste -sd ' | '` joined them with a single space). Gemini's PreCompress line is unchanged. That Claude passes PreCompact stdout to the summary model is observed in Claude Code 2.1.304 and 2.1.308 (a read-only scan of both installed binaries; FU-w563w2, comment-only), not documented by the vendor; a live compaction check stays open. Not done: re-sending the active task pointer after compaction (FU-a5arwf).
- **Feature 109 (Worker eligibility), default change:** With codex probed (a probe stays valid 24 h), `dispatch --mode auto` (the default) and `worker --action select --edit` pick codex as a subagent worker, and each such run spends model calls; `--mode sequential` is the kill switch and applies when a dispatch starts. Codex worker eligibility rests on the free CLI checks in `core/worker-evidence/codex/2026-10-18-cli-check.json` and on one read-only and one edit live run (`core/worker-evidence/codex/2026-10-18-live-run-read-only.json` and `core/worker-evidence/codex/2026-10-18-live-run-edit.json`): both ran once on codex-cli 0.163.0, both reported success with an offered result, and the edit run was integrated as a commit by `DoFlow dispatch`. What is not established: that `.git` is read-only under workspace-write, spawn denial and permission-denial events were not exercised, and the evidence is not tied to the installed codex version.
- **Feature 085a:** The release workflow creates a draft GitHub Release, publishes prereleases
  under `beta-candidate`, verifies the registry install, promotes the dist-tag, then publishes
  the GitHub Release. Permissions are set per job; pins cover the external actions
  (actions/checkout, actions/setup-node) in release.yml; the reusable workflow call is a local
  path; `release-workflow` replaces the preflight `publish-dist-tag` check. See
  [Dist-tag policy](docs/reference.md#dist-tag-policy). The first tag cut after this change
  is the first to run the new pipeline. Trusted publishing remains design-only; publish and
  promotion use `NPM_TOKEN`.

### Removed
- **Gemini CLI harness (feature 127):** Gemini CLI was replaced upstream by Antigravity CLI, so the `gemini` harness, its adapter, hooks, probe and `--target gemini` are gone and DoFlow now projects into seven harnesses. The registry records `gemini` as retired with Antigravity as its replacement: `-t gemini` and `--target gemini` are refused with that pointer, and `workers.enabled`, `workers.models`, `workers.billing` and `primary.harness` report a retired id as an advisory and ignore it. An existing Gemini CLI install is released on the next `doflow install` or `doflow update` in that scope; files you edited are kept. At global scope Antigravity now writes its guidance-pointer section into `~/.gemini/GEMINI.md` and takes over the section a Gemini CLI install left there in one write; a file edited since is kept until `--force`. `install`, `update` and `reconcile` back up the files the release changes before applying it. `reconcile` is always forced, so it replaces an edited `GEMINI.md` DoFlow section (text outside the markers stays), and text a person wrote inside Gemini CLI's section is removed with it. The run's summary line reads `[RETIRED] gemini → antigravity: deleted N, stripped N, released N, dropped N, deferred N, kept N`. A full `rollback` restores every released Gemini CLI row and `targets.gemini`; `rollback -t <harness>` restores only the rows of the files it writes back. A lock that pins only `gemini` makes `reconcile` do nothing; run `doflow update` in that scope to release Gemini CLI's files.

### Fixed
- **Feature 084 re-review (also 083, 085, 103, 122):** adopted fixes from the six-row review and the 084 re-review: advice requests and endpoint DNS validation stop when the dispatcher budget ends, the bench bar and kind resolution fail closed, and package git commands strip inherited git location variables.
- **FU-5f7dwt (roadmap seed):** `proposed` is a known row key, so `seed --action check` no longer flags a store row that carries `proposed: true`. A draft row that sets `proposed` (true or false) is `seed-invalid`: only `seed apply` and `amend` write it, so a draft cannot pre-mark a row.
- **maint-p0 (roadmap seed amend):** `seed --action amend` on a live row that is `proposed` keeps it proposed; before, an unmarked draft replaced the row and promoted it when the call landed ready. Only `roadmap promote` clears the mark. The reference now says the terminal check is a speed bump, not proof of a person.
- **maint-patch2 (FU-3mr2gz):** the capability table now reports Copilot and Pi settings as unavailable, because DoFlow never wrote their settings files. Pi no longer declares a settings native target or path, the generated docs blocks are regenerated, and guard G5 now fails when a harness declares `settings: supported` but its adapter writes no settings file.
- **maint-patch (FU-aeyx13):** `doflow orchestrate --action start --dry-run` now exits 2 with a usage error. Before, the flag was silently ignored and a real start ran.
- **`doflow advise` broken in every packaged install (maint-advise-ext):** the advice registry check looked for the provider adapter at `<adapter>.ts`, but the package `build:package` stages ships every module as `.js`, so `doflow advise --action configure ...` on an installed package stopped with `advice registry is invalid: providers[0].adapter must name a file under src/runtime/advice/providers` and wrote nothing (the same check ran for `doctor`'s Decision Model section and every other advice verb). The adapter is a sibling module of the registry, so its file is now looked up with the registry module's own extension (`.ts` in a checkout, `.js` in the package); the safe-id pattern and the containment check under the adapter folder are unchanged. Two tests in `test/runtime/advice-registry.test.js` load the registry from a staged package and check a missing adapter, a `.ts` adapter in a `.js` tree and a path-traversing id are still refused. Swept the same class across `src/` and `bin/` (every `.ts` literal and `.ts` path built at run time, then every `src/`/`bin/`/`core/` path in a staged package checked for existence): this was the only runtime check; the adapter loader itself is a literal `require` map that `build:package` rewrites, and the other `.ts` literals are comments, target-repo analysis, or strings `build:package` rewrites together with the registry that holds their pair.
- **Load-dependent test flakes (FU-4jhpjj, FU-wdktxq):** Test-only; no production change. Waits and ceilings tuned to a quiet machine failed on a loaded one, and each now waits on the condition itself: the start wait in `test/runtime/slots.test.js` (5 s, now 60 s); the per-call, mirror and matrix timeouts in `test/e2e/telemetry-isolation.test.js` (5 s, 15 s, 119 s, now hang guards of 60 s, 120 s and 900 s; the end-of-matrix assertion `< 119000` is now `< 900000`); the IC-029 dispatch-controls test, whose fake worker slept 700 ms (the fake harness gains a `waitFor: <absolute path>` gate step); and the user-cancel tests in `worker-supervisor.test.js` (S-1) and `worker-secrets.test.js` (IC-030), which read the record the supervisor resolved instead of the settled one (both write orders now run, with no fixed delay). The IC-001 argv check in the dispatch-command test (FU-wdktxq) now removes the run id before the leak test, because a run id `p-e...` (1 in 16) contained the argv element `-e`; every leak shape is still caught.
- **Test fixtures in a live store under verify (FU-k9h1df):** `doflow verify`'s broad tier runs `npm test` with cwd in the calling checkout, and four tests in `test/runtime/context-pack-mandatory.test.js` called the context-pack handler without a state root, so their delivery records (`T.1`, `t-legacy`, `t-no-feat`, `test-spawn-count-task`) landed in that checkout's `.doflow/state/delivery` and then blocked record verbs with `store-conflict`. Each call now passes a temp state root; `test/runtime/verify-broad-tier-store-isolation.test.js` runs that file with verify's shell and cwd, from a linked worktree of a scratch repository with a scratch HOME and XDG_CONFIG_HOME, and fails when a file is added, removed or changed (compared by content hash) in the worktree's store, the main checkout's store, HOME or XDG_CONFIG_HOME; one writer control per root, plus overwrites of an existing store record and of `doflow/prune`, prove each shape is caught. It models cwd- and HOME/XDG-relative writes, not the caller's full environment. Test-only; verify itself is unchanged.
- **Compaction after a handoff from a linked worktree (FU-kda1bk):** `orchestrate --action handoff` looked for the feature folder to compact only in the calling checkout, so a linked worktree without `agent-docs` reported `skipped` and the main checkout's register and History were never folded. It now falls back to the main checkout's folder, through the same helper the policy gate decision uses, so the two cannot drift.
- **Verification reuse eviction (FU-kerery):** When the key read before a check faulted (null), the check's FAIL evicted nothing and an older stored PASS stayed reusable. The post-run tree read now also returns its key, and a FAIL (including a timeout or spawn error) evicts by it when the pre-run key is null. Reuse still ships off.
- **PreCompact text cut (FU-tsq77m, FU-zg76ce):** The shared PreCompact text (`compact-text.sh`, Claude and Codex) is capped at 490 bytes in every locale and no longer ends inside a multi-byte UTF-8 character. Before, under `LC_ALL=C` the cut could leave a lone lead byte that Codex's `jq --arg` rewrote to U+FFFD (so the decoded Codex message was longer than the Claude text), and under a UTF-8 locale the cap counted characters, not bytes. The preserve line still comes first.
- **Raw NUL bytes in a guard (FU-qk7n97):** `test/guards/reachability.test.js` held two raw NUL bytes inside template literals, which made grep treat the file as binary; they are now the `\0` escape. G23 (`hidden-unicode.test.js`) gains a scan that fails on a raw NUL byte in any tracked text file, `test/` included.
- **Feature 117 Phase C (stale task-state lock; FU-8acds5, FU-vgkrvd):** The per-file lock every task-state store writes through (`src/runtime/task-state.ts`: the task-attempt ledger, evidence, claims, readiness, retrieval, research requests, orchestration runs, delivery records, dispatch and worker stores, the decision register, the lifecycle event store and its upkeep) could be held by two processes at once: a lock older than 10 s was removed by name by whoever saw it first, and every release removed it by name, so two waiters that judged the same stale lock could both take it, and a holder paused past 10 s (a suspended machine, a debugger, SIGSTOP, a forward clock jump) kept writing after another process had taken over. A holder now marks the lock directory with its own `owner-<pid>-<random>` entry and holds the lock only while that entry is the only one in it; release removes only that entry and then the directory, if it is still the directory it held; a stale lock is reclaimed in place (the reclaimer enters it, checks it is the directory it judged, removes the judged entries by name), so no runtime moves a lock, and a reclaim adds its own entry before it removes any; a fresh acquire whose lock and entry are made more than 5 s apart removes its entry and starts over; and `updateTaskState` checks that its entry is still there after writing its temp file and before its rename, writing nothing when it is not (`lock-lost`; the temp file is removed; the task-attempt ledger re-runs the decision on the fresh store up to twice and then reports `lock-lost`, and context-pack records `delivery.reason: lock-lost`). The on-disk path is unchanged and the only new thing in it is `owner-*` entries; runtimes from before this fix wait on a fresh lock and fail closed on a stale one (`Could not lock`, `store-locked`) instead of taking it, cannot clear a crashed new holder's lock (their message says "retry shortly"; run any current DoFlow verb on that store, or remove `<file>.lock` when no DoFlow process runs), and their release of a lock reclaimed from them leaves the new holder's lock in place. Whatever a process leaves when it dies is reclaimed 10 s after the lock last changed, as before; a file inside a lock (no DoFlow runtime makes one) still blocks it until removed by hand, and `acquireLock`'s error now names it. Bounds, not covered (listed with the protocol in `docs/architecture.md`, "The task-state lock"): a holder whose lock has not changed for 10 s or more (a pause anywhere after its entry was made, or a forward clock step) that is then preempted between its ownership check and its rename long enough for a reclaimer to remove its entry and read (`--replay` of `LOST_ACK` in `test/helper/ledger-scenarios.js`); a holder that runs past 10 s where nothing checks it (an older runtime, storage pruning's record lock, and the stores that hold the lock around writes of their own: the decision register, the lifecycle event store and its upkeep, research-request runs, state-root moves); an older runtime's lock met by a by-name `rmdir` of an empty lock: two older runtimes breaking one stale lock at the same moment, which can also remove a new lock in its first two calls, and a new release paused past 10 s whose lock is replaced by an older runtime's between the release's identity check and its `rmdir`; an inode reused within one reclaim or one re-entry on a filesystem without birth times; the clock stepped back during an acquire, or file times coarser than 5 s; and, for liveness only, a lock left empty in rare cases waits out the 10 s. Locks with their own code are unchanged: storage pruning's record lock and upkeep's pass lock (the slot queue now uses this lock; see the FU-31dyvs entry). Evidence: the three regressions in `test/state/ledger-lock-race.test.js` are required and, for R-two-process and R-claim, are chooser rules rather than replay strings (each ends in an oracle violation on `e003dc0d`); `test/state/task-state-lock.test.js` pauses a process at every step of an acquire and of a reclaim while new and older runtimes act, and every check the protocol relies on (being alone, the publication bound, the reclaim's identity and listing re-checks, the re-entry's identity check and fresh name, the release's identity check, the pre-write check) turns at least one test red when removed; the sampler (seed 117) reports no violation and no incomplete schedule for S1 and S2 from a stale lock and S1 from none; and the SIGSTOP reproduction kept with the 117 feature records (`realpause.js`) gives PASS in all four runs where develop `e003dc0d` gives resurrected, lost-ack and two double-grants. macOS only; Linux and win32 were not run.
- **Slot lock (FU-31dyvs):** The lock of the machine-wide slot queue (`src/runtime/slots.ts`) was its own copy with the defect the task-state lock had before 117 Phase C: two processes that judged one stale or dead-owner lock both renamed it aside by name, so the second could move the first one's new lock and both held; the owner token was written after the `mkdir`, so a holder paused between the two could write its token into a lock another process had taken meanwhile; and its release had no `held()`, so a slot write whose lock had been reclaimed went ahead. The slot lock is now the task-state lock (`acquireLock` gains optional settings, the defaults unchanged): the same path and protocol, an `owner-<pid>-<start>-<random>` entry that names its owner, and a stale rule that keeps feature 115's, amended by the user: an entry whose owner is alive is never reclaimed, one whose owner is dead (or whose pid now has another start time) is reclaimable at once but, like every reclaimed lock, held only after a 10 s quiet hold (115 said "at once"), an unknown one, an empty lock or a directory of another name after 10 s; a process queued behind a holder that dies reclaims it without waiting out its budget; a file in the lock keeps it locked and the `Could not lock` error (after 30 s, or up to about 40 s when a quiet hold started just before then) names it. A slot change whose lock was reclaimed before its write or before deleting an emptied slot file changes nothing (`lock-lost`) and runs again on the fresh file, up to three runs. A lock left by an older runtime (`owner.json`) is judged by its token: a live owner's is waited on; a dead owner's token is removed in place only while it and the lock are still the ones judged. **Mixed installs:** older runtimes move a lock they judge stale aside by name whenever their move lands, so after any reclaim a current process keeps its entry in the lock for 10 s, holding nothing and keeping the lock young, before it uses it (every reclaim, because a current process that dies in its own quiet hold leaves a young lock with a dead entry that its successor must not use at once either); each reclaim costs those 10 s. Accepted cost (user decision): an older runtime still moves a current holder's lock aside once it is 10 s old and takes it; the current holder then writes nothing and runs again, each such move leaves a `<file>.lock.stale-*` directory that nothing removes, and an older runtime waits out the 10 s on a current lock whose owner died; also accepted (review C-3): an older runtime that stalls 10 s or more between creating the lock and writing its `owner.json` can end with two writers, and the first of the two writes is lost although both report success (two older runtimes have the same hole; it is gone once every runtime is current). Bounds (in `docs/architecture.md`, "The slot lock"): a pid reused within the same second as its first start counts as alive; an older runtime paused 10 s or more between judging a lock and moving it can still leave two writers; between a reclaim's token check and its unlink (one system call) an older runtime's new token can be removed, which leads to a second writer if that older holder runs 20 s or more, or 10 s or more when another older runtime is waiting; when two older runtimes judged one stale lock and the first released before a current process made a fresh lock, the second one's move can land on that lock with no pause at all (the older runtimes' own defect; the current holder writes nothing unless the move lands between its pre-write check and its rename); liveness needs one PID namespace; a stopped live holder blocks the lock until it resumes, as before. Evidence: `test/runtime/slot-lock.test.js` (competing reclaimers from three stale states, the publication window, a write and a delete after reclaim, the dead-token unlink race, an older runtime's move within 10 s of a reclaim for a dead token and for an old lock, a stray file, a dead holder ahead of a queued process, a SIGSTOP run with real processes, older-runtime locks dead and alive, pid reuse, and old/new real-process pairs against a frozen copy of the 115 lock in `test/helper/legacy-slot-lock.js`); the defect tests fail against `694ec9ba`, and the review's tests against the first version of this fix. macOS only. Nothing is released.
- **Slot lock starvation (release-beta7):** a `slot run` holder could stop with `Could not lock '<slot>.json' after 30s` before it registered its child or released the slot. Liveness probes (a `ps` each, slow on a loaded host) ran inside the slot lock, so every critical section cost one `ps` per queue entry, and every waiter took the lock on every poll even while a live holder held the slot, so the lock was rarely free and the holder could lose the unordered race for it for the whole budget. Liveness is now probed before the lock, from an unlocked read of the slot file (the death of a process is permanent; an entry not probed counts as alive until the next look); `slot release` leaves in place a holder that appeared after its probe; and a waiter whose grant cannot change (a live holder, or a live waiter ahead, and no dead entry) does not take the lock on that poll. Grants stay in arrival order and are decided under the lock only.
- **Feature 107-B readiness (separate from the guidance change above; FU-h6671a):** The readiness gate no longer lists a superseded evidence item as unresolvable, so superseding the item clears it. A claim of status `supported` now counts toward a requirement (the bug template's `root_cause`) only while at least one of its supporting items is live (active, fresh and bound); a claim whose only support was superseded no longer keeps the gate READY, and linking a valid replacement to the claim restores it.
- **Feature 112 — worker git exemptions:** Only exact worker sessions in canonical dispatch worktrees can exempt the bare reset shape containing `--hard` and the clean shape `(-[dfqxX]+|--force|--quiet)+` with exactly one `f` total. The hook also rejects `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, and `GIT_CONFIG_KEY_*`, and verifies the git directory and top level with `git rev-parse` under a clean environment. Only the git, rm, and find rules use the new command-position and wrapper handling; chmod, dd, and curl-to-shell keep their previous anchors.
- **Feature 112 — SQL text:** The SQL exception is a positive allow-list on the raw command: commit messages, selected echo/printf or cat literal/heredoc forms, and `gh pr|issue create|comment|edit` bodies. Only the forms listed in [Enterprise governance](docs/enterprise-governance.md#worker-exemptions-and-guard-scoping) qualify; every other command keeps its prior SQL verdict. Text written to a file that something else later executes is outside this guard.
- **Feature 112 — project database drops and Codex scope:** `guard.workerDropDatabases` is project-only; names match `[a-z][a-z0-9_]{0,62}` (at most 63 characters each), with at most 32 names and 1 KiB total. The launcher snapshots the list as `DOFLOW_GUARD_DROP_DATABASES`; IC-012 records up to seven launch variable names, with the seventh optional. Codex CLI 0.163 probes using `codex sandbox -P :workspace` denied `git reset --hard` in a dispatch worktree, `git clean` and writes in the main checkout, and writes to `<project>/.doflow/settings.json` when the project was outside sandbox-writable roots (not under `/tmp` or `$TMPDIR`, and not the command cwd); those operations succeeded with the project under `/tmp` or `$TMPDIR`. The production launch flag `-s workspace-write` was not probed separately. Codex `exec_command`'s per-command working directory is invisible to the hook, so exempt `git clean -f...` can act in any repository under a sandbox-writable root; the exemption remains for Codex because without it the feature has no effect for Codex workers. FU-gxbryp tracks the scope-specific possibility of planting a database name for a later launch.
- **Feature 111:** With `DOFLOW_CONFIG_DIR` unset, worker sessions' hook lines and the ledger lines
  of verbs they run, verify logs, and upkeep records now reach the project store. Before, hook lines
  were dropped until the first worker verb created `state/runs` in the worktree, after which hook
  lines landed there; verb ledger lines, verify logs, and upkeep records also landed there. Read-only
  workers on claim worktrees outside the project still have no route to the project store (follow-up).
- **Feature 110 (Trace join scope):** Worker runs join through their slug; hook lines and dispatch verify records join by explicit `worker_run` and `dispatch_run` ids when writers emit them, or by a labelled inferred activity window (`attrs.join: "activity"`) otherwise. In the kept live codex stores, the eight hook lines and two verify lines joined only by that inferred tier; no id join has been exercised by a real worker session, and worker-session verify is unreached. A line in an overlapping window with no single fitting activity stays ambiguous. Hook lines carry `role` and `worker_run`; the launch env carries `DOFLOW_WORKER_RUN`.
- Installed-runtime registry validation and real error reporting (FU-tz5h0m): `loadRegistry` and `validateRegistry` support a `sources` mode (`require` or `skip`). An installed runtime (holding only `bin/`, `src/` and `core/registry/`) defaults to `skip` mode via `registrySourceMode`, allowing registry-backed verbs to run outside a full source tree without requiring unprojected shared assets or native-projection sources. When a projected runtime fails registry validation, the dispatcher exits 2 (`stale-runtime`), reporting the runtime registry path and the first validation error verbatim (also for `worker` and `dispatch` under `--json`, whose own `registry-invalid` body is replaced) instead of asserting that the runtime appears out of date.
- Guidance truth and consistency (107-A): fixed shipped guidance, skills, and agent specs that contradicted each other or the code. `FLAGS.md` now names which skills own each flag. `DOFLOW_CHAIN.md` is the one place that states what the implement gate denies, and the constitution base, `do-plan`, `do-flow`, and its task-class reference point to it. The install-root search order, the Layout rows for shared policies, templates, and references, and the repo-layout rule now match the code and registry. Parallel work is conditional on disjoint write sets everywhere, including `MODE_Orchestration.md`. File-count and task-count thresholds agree, estimates use a range and its assumptions without confidence bands, and enforcement words name the policy script behind them. `CONSTITUTION_BASE.md` is v1.0.1 (PATCH). New guards G46 (`guidance-truth.test.js`) and G47 (`guidance-consistency.test.js`) check these statements against the scripts and registries that own the facts, and G4 (`flags.test.js`) and G24 (`instruction-lint.test.js`) are extended, including the stricter `default-vs-disjoint-parallelism` pair.
- **Feature 087a (Docs 2.0 facts):** Published docs site: the Mermaid diagrams (13 fences across five pages) now render instead of shipping as plain code, `/llms.txt` is served as an index of every page, and the quickstart and setup pages state the current install path and the Node range `^22.18.0 || >=24.22.1` (they no longer offer a clone-into-`~/.claude` install that the repository layout cannot satisfy). Architecture-page references to `.js` modules under `src/` now name the `.ts` files that exist. `requirements.txt` pins `pymdown-extensions` for the diagram fence, so the documented `pip install -r requirements.txt` and `mkdocs build --strict` work as written and the docs workflow installs from that one file. The pinned Mermaid build is loaded only on pages that hold a diagram, with a `sha384` Subresource Integrity hash. A new guard, `test/guards/docs-site.test.js`, fails when a nav page is missing from `llms.txt`, when any Node range in the quickstart or setup differs from `package.json`, when a page claims a Node 18 or 20 floor, or when a page holds a `mermaid` fence that `mkdocs.yml` and the pinned loader do not render.
- **git-state base tag (FU-c2amkb, FU-3wb6xx):** `do-git-state.sh --next-version` printed `base_tag` as the string `"null"` in a repository with no release tag (the argument was `${base_tag:-null}` and the jq test was for an empty string), where `--lifecycle` already printed JSON `null`; it now prints `null`. `find_base_tag` filtered only `v*`, so under the version sort a tag named `vx` outranked `v1.2.0` and proposed `next_version` `x.0.1`; it now filters with the same `vX.Y.Z[-pre]` pattern `--lifecycle` uses for `release_tags` (one `RELEASE_TAG_PATTERN`). `lifecycle-release.test.js` G1 asserted that `vnext` was the base tag (the bug, recorded as expected); it now expects `v1.0.0`. New `test/e2e/git-state-next-version.e2e.test.js`.
- **Detached upkeep leaves the hook's session (FU-0rgk31):** `storage_upkeep_async` in `hooks/policies/lib.sh` started the background `storage --action upkeep` with `nohup` only, so a harness that signals the hook's process group when the hook exits could take the upkeep down with it. It now runs it under `setsid` when `setsid` is on `PATH` (macOS has none, where it runs as before). Tests in `test/hooks/storage-upkeep-hook.test.js` use a stub `setsid` (present) and the plain path (absent, skipped where a real `setsid` exists). The group-kill effect was checked only with a simulated harness (a Linux container with util-linux `setsid`, bash 5.2: the upkeep survived the group kill with the change and was killed without it), not with a real harness; the test in `storage-upkeep-hook.test.js` checks that `setsid` is used, not the kill.
- **Retention count line singular (FU-rs5177):** the stderr line a retention pass prints read `retention: removed 1 event files older than N h` for one file; it now reads `1 event file` (other counts are unchanged). The two docs that described the unpluralised line are updated, and `removedLine` is exported so `test/runtime/lifecycle-retention.test.js` can pin both forms.
- **Crashed retention temp files are swept (FU-8g2g9z):** a verb that died between creating `.retention-<pid>-<chars>.tmp` (the retention journal) or `.migrated-<pid>-<chars>.tmp` (the migration marker) and renaming it left the file in `.doflow/state/lifecycle/` for good, because the storage sweep only matches `<name>.json.<pid>.tmp` inside record stores. Under the store lock, both the lifecycle verbs' upkeep and the storage engine's `lifecycle-events` pass now remove such a file once it is older than `staleTmpHours` (24; the engine passes the registry value, the verbs use `STALE_TMP_MS`, which a test pins to it). Younger files and every other name are left alone, and the removal is not counted in the `removed N event files` line. The sweep runs in any pass that takes the store lock (a migration or marker pass, or a retention pass), so a stale file waits until some pass does; in a bounded storage pass it checks the pass's stop before each unlink and counts each unlink against `maxFiles`, and a pass that stops there reports itself partial and leaves retention to the next one.
- **Backup temp owner start time (FU-kj372j):** `createFileBackup` wrote the temp directory's `.owner.json` `startedAt` from the caller-supplied backup date, and the stale-temp check ages a live owner's temp from that field, so a run given an old date had its live temp swept by another run's cleanup (the copy then failed with `ENOENT`). `startedAt` is now the time the run started. The backup's own id and manifest timestamp still follow the date passed in.
- **Backup id `.` and manifest entries without a mode (FU-fst0yq):** `assertSafeBackupId` accepted `.`, which `rollback` resolved to the backup root itself; it is now refused like `..`. A format-2 manifest entry whose `mode` is missing, not an integer or above `0o7777` made `chmodSync` throw inside the restore write (reported as the failure `ERR_INVALID_ARG_TYPE`, and the file had already been put in the pre-rollback snapshot); `planRestore` now refuses it with the reason `invalid mode`, after the existing path and content checks. `rollback` treats refused and failed files the same way (an error line each, exit 1), so only the reason and the snapshot change.
- **A resumed cancel no longer holds a task-attempts ledger open (FU-syq560):** the storage sweep's IC-028 check kept a `task-attempts` ledger open for any attempt in the `cancelled` state, including a cancel a later `resume` had cleared, so a feature that was ever cancelled was never pruned. It now uses the resume report's own `clearedCancels` (a cancel named in a resume's `cleared` list, or followed by a later resume) and leaves only uncleared cancels, active attempts and runs whose control is not `running` as open work. `task-run` is loaded only when a cancelled attempt is present. Cancelled attempts are paired with their resume by the attempt itself (`clearedCancels` also returns the attempt), so a malformed ledger with repeated or missing tokens can no longer make an uncleared cancel look cleared. `clearedCancels` also skips a null attempt entry instead of throwing, which would have failed the whole `task-attempts` pass for one malformed ledger.
- **Writer vs. empty-namespace sweep (FU-10t7cn):** the storage sweep removes an empty namespace folder with a plain `rmdir`, and `updateTaskState` made that folder and then took its `<file>.lock` (made without `recursive`) in a second step, so a sweep between the two made the writer fail with `ENOENT`. The folder and the lock are now taken together, and the folder is made again when the lock reports `ENOENT`, up to five times before the error is thrown. A held lock keeps its folder from the sweep, so nothing changes once the lock is taken.
- **Leading-zero retention window says why it is invalid (FU-k5g213):** `DOFLOW_RETENTION_HOURS=024` (or `007`) is rejected on purpose, since `024` reads as octal in many tools, but the warning only said "not a positive whole number of hours". The retention warning and the settings fault now add `(no leading zeros)` for such a value; the rejection itself is unchanged.
- **Retention keeps units that a newer DoFlow's events name (FU-dzzn17):** the fold ignores an event of a type it does not know (written by a newer DoFlow), so retention could delete a settled follow-up or goal that such an event refers to and leave that event behind as an orphan. `selectExpired` now keeps a unit when any string value or object key, at any depth, in the data of an unknown-type event (types taken from the fold's own `EVENT_TYPES`, no second list) equals one of its item ids. Matching is exact, so it keeps more than it needs rather than less. The selection is made exactly as before (a settled, expired unit that the fold can drop without changing anything else) and the protected units are removed from it afterwards, so the files deleted are always a subset of what the previous version deleted on the same events.
- **Backup pruning keeps concurrent backups and removes atomically (FU-j55357):** `applyRetention` kept the run's own backup plus the newest N and removed everything else, so `--prune 1` could delete a backup another run finished after this one's (and the other run then reported a restore point that was gone). A backup newer than the newest protected one is no longer a removal candidate (the run only reaps history older than its own backup). Each removal first renames the folder to `.tmp-del-<id>-<host tag>-<pid>-<hex>` and then deletes it, so a crash never leaves a half-deleted backup in the listing; a failed delete puts the folder back under its id and reports it as before. A `.tmp-del-*` left by a crash is deleted by the next pass at once, but only when its host tag (a hash of the hostname and, on Linux, the pid-namespace id from `/proc/self/ns/pid`; the hostname alone elsewhere) is this process's and its pid is no longer alive here: a live pass may still roll its folder back, so neither the prune nor the 24 hour `.tmp-` sweep ever deletes one by age, and another host's aside (a shared backup root) or a name without an owner is kept. A sweep under a different hostname, or in a different pid namespace, therefore keeps it. Two hosts that share a hostname and both sit in the initial pid namespace (or any platform that exposes no namespace id) get the same tag and are not told apart. If both the delete and the roll-back of a pass failed and it then exited, the next prune removes that backup, which that prune had already selected for removal. An aside is never listed or counted as a backup. "Newer" follows the backup sort order (the manifest timestamp, else the time in the id), so a backup dated in the future (clock skew, a hand-made id) sorts ahead of the run's own and is never pruned while its date is in the future. Apart from that one double-failure leftover, nothing is removed that was kept before. `backup-retention.test.js` test 1 now protects the newest backup, which is what a real run protects.
- **Space-separated flag values in the `do-*.sh` helpers (FU-r4ff7s, bash-args):** `do-paths.sh`, `do-git-state.sh`, `do-exec-paths.sh`, `do-review-package.sh`, `do-task-brief.sh` and `do-parallel-check.sh` read only `--flag=value`; `--flag value` fell through the argument loop with the flag dropped, so `do-paths.sh --json --slug 002-other` resolved the active feature instead of `002-other` (and `do-exec-paths.sh --task A.1` answered `missing-mode`) with no signal. A new sourced helper, `do-args.sh`, folds `--flag value` into `--flag=value` for the value flags each script declares (`--slug`, `--task`, `--group`, `--tasks`, `--base`, `--head`, `--harness`, `--phase`, `--class`), so both forms now give the same answer. The `=` form is unchanged, and a flag with no value after it (last, or followed by a word that starts with a dash) is still dropped as before. If `do-args.sh` is not beside a script, the script reads its arguments as before. `render-audit.sh`, `render-puml.sh` and `render-diagrams.sh` keep refusing the space form with exit 2. Test: `test/runtime/bash-args.test.js`.
- **Readiness locator root in a linked worktree (FU-tgrfdv, maint-runtime-b):** the readiness gate resolved a relative evidence locator against the record-store root only, so evidence for a file that exists only in the linked worktree the verb runs in was reported as an unresolvable locator (`file-missing`) and held the task at `NEEDS_EVIDENCE`. `ReadinessEngine` now takes `sourceRoot` (default: the project root), `evaluateTaskReadiness` passes it, and a relative locator resolves the way `evidence --action add` and the freshness check resolve it. With one root, behaviour is unchanged.
- **Readiness actions for stated inputs (FU-afkns5, maint-runtime-b):** an unmet `scope_clear` or `scope_verified` requirement now recommends passing `--scope "<boundary>"`, and an unmet `invariants_captured` requirement `--invariants "<invariants>"`; both fell to the generic `Gather evidence for requirement ...` action, which names no flag that can satisfy them. The requirements, the verdict and the flags are unchanged.
- **Namespaced runs were invisible to retention, `doctor` and `trace spans` (FU-c2ddw2):** Since 115 a run of a task id other than its feature's slug lives in `orchestration/<slug>/<taskId>.json`, but `listRunNames` in `src/runtime/storage/work-status.ts`, the `[MCP Consultations]` view in `src/runtime/health.ts` and the orchestration read in `src/runtime/trace/spans.ts` listed only the flat `orchestration/*.json`. A record whose run was RUNNING or AWAITING_GATE in a namespace was therefore judged `no-run` (and so finishable by age), `doflow doctor` counted none of those runs' consultations, and `doflow trace spans` dropped them (the trace never closed on their completion). All three now also read each `orchestration/<slug>/` directory (a `*.lock` directory is not a namespace); work status judges a record exactly as before namespaces existed (by the flat run copy alone, the same prefix rules and the record's own feature), and a namespaced copy can only keep a record: a RUNNING or AWAITING_GATE copy in the record's own namespace (for a flat record, the namespace its own `featureSlug`/`slug` names) keeps it open, an unreadable such copy (a link, a FIFO or a device there is read as unreadable and never blocks retention) keeps it `undecidable`, and a finished copy never makes a record finishable (a record under feature A is never judged by feature B's run of the same task id, and an own-namespace copy never overrides the flat run, its feature or its idle time); a flat record that names no feature and that more than one namespace holds a run for is `undecidable` and kept. A flat file whose namespaced copy exists (the seed `recordIn` leaves behind) is counted once. The doctor and trace output formats are unchanged; trace locators of namespaced runs read `orchestration/<slug>/<taskId>.json#...`.
- **Adopted-store declaration unguarded (FU-tbd9by):** `src/runtime/state-root.ts` takes the stores a linked worktree's records are adopted from out of `core/registry/storage.json` (the project-state stores that list it in `writers`), and only `test/runtime/state-root.test.js` pinned the seven current ones, so a store given `taskRecord`/`recordIn` without that declaration would never have its worktree records swept into the main checkout, and a declaration would outlive its last user. New guard G65 (`test/guards/adopted-stores.test.js`) cross-checks both ways: every store a helper call addresses through `taskRecord`, `taskStoreDir`, `recordIn` or `resolveTaskScope` is adopted, and every adopted store is addressed by one. Each call is tied to its own argument (a literal `store:`, or a `recordIn` `base:` resolved through a `'.doflow', 'state', '<store>'` path or `runStoreDir`/`RUN_STORE_REL`), so an unrelated `store:` literal in the same file is not attributed to it, and a call whose store cannot be resolved is reported instead of skipped. Its controls run on synthetic registries and sources and on the shipped sources with an adopter removed or added. Test and docs only; the guard inventory in `docs/architecture.md` lists it.
- **History compaction overwrote a concurrent artifact edit (FU-1jbmm3, history-compactor):** `doflow decision --action compact` read an artifact, wrote its archive chunk and then renamed a rewrite built from the text it had read, holding only the register lock, so an edit made to the artifact in between was lost. The rewrite now compares the artifact with the text it was built from after the temp file is written and just before the rename, and refuses with `<artifact> changed while it was being compacted` (reported in `failed`, the artifact keeps the editor's version, no temp file is left); the moved block is already in the archive and the next run does not copy it twice. This narrows the race to the gap between that read and the rename; it does not close it, which would take a lock on the artifact that its editors also take. `decision-register.ts` needed no change (its lock covers the register and views, not the artifacts).
- **Unknown-flag message and `--reason=x` (FU-8eqytg, cli):** the parser echoed an unrecognised argument whole, so a 300-character argument printed in full and an ESC byte reached the terminal raw. The message is now print-safe (`printSafe`: control characters become U+FFFD, a line break a space) and the echoed part is cut at 80 characters with `...`; the text of the error and exit code 1 are unchanged. `--reason=<text>` was refused as an unknown flag on every verb while `--reason <text>` was accepted (and ignored by `status`); the inline spelling now means the same as the spaced one (an empty `--reason=` is refused with exit 2, like the other inline flags). No verb gains or loses a flag.
- **Body masking misses command-shaped secrets (FU-ht8b3r, mask):** the body profile left `curl -u user:pw`, `mysql -psecret` and `password hunter2` as written, and kept another user's `/Users/<name>/` prefix, so a report body or excerpt could carry them. Rules 14 to 17 now mask the value of every `curl -u`/`--user` (also glued, `-uuser:pw`) and every password glued to `mysql`/`mysqldump`/`mysqladmin` `-p` within one command, a value that holds a non-letter after a bare `password`/`passwd` (plain prose such as "the password is required" is kept), and turn `/Users/<name>` into `/Users/<masked>` (`/Users/Shared`, `/Users/runner` and the running user's own home, already `~`, are untouched). They are body-only. Rules 14 and 15 are one left-to-right pass that tracks the current command: an unquoted value ends at a space, `|`, `;` or `&`, so the command text after it is kept, and a flag of another command (`sort -u`, `git push -u`, `mysql -P 3306`) is left as written. A command word (`curl`, `mysql*`, bare or as a path) is the command only at command position: the start of the text, a line or a segment after a break (`|`, `;`, `&`, a parenthesis, a backtick), the start of a quoted span, or after a wrapper word at the start of the segment (`sudo`, `env`, `exec`, `ssh`, `docker`, `sh`, `bash`, ...), after a prompt mark (`$`) or a variable assignment; a tool name inside a URL, a path or an argument (`curl https://h/mysql/x -u a:b`, `curl password mysql-8 -u a:b`) is not one, and a segment has one command. Quoted text is scanned, not skipped (`bash -c "curl -u a:b x"`, `ssh db1 'mysql -pS3cret'`), and a break inside quotes ends only the command inside them. The result is stable under a second application. The scan is linear, so a long line of repeated `curl `/`mysql ` words or quotes stays fast. A leading `Running:`-style label, prompt mark or variable assignment does not use up the command position. Known gaps: a command word after any other word (`please curl -u a:b`) is not seen, a command word that a wrapper only prints (`sudo echo curl documentation -u unique`) is, a plain-letter value after a bare `password `, a password of one to three digits (`reset password 2 times` is prose), `/home/<name>` and `C:\Users\<name>` homes, and other tools' secret flags (`sshpass -p`, `redis-cli -a`). The reports-home half of the followup was already done by `config-home.ts`.
- **`followup --action take` on an item shown done said "is taken" (FU-vc0agq, follow-up store):** a taken item whose feature finished is listed as `done` (derived on read), but `take` on it was refused with `<id> is taken; only an open item can be taken`. It now refuses with the same reason `settle` gives (`<id> is done because feature <slug> finished (derived from git and the release records, not recorded on the item); only an open item can be taken. Nothing was written.`). The refusal and its exit code are unchanged.
- **`failure --action settle` hung on a FIFO (FU-vc0agq, failure store):** `appendSettlement` opened `settlements.jsonl` with a plain append, so a FIFO at that path blocked the open for ever and a symlink there was followed. It now appends through the capture writer's regular-file check (`O_NONBLOCK`/`O_NOFOLLOW`, then `fstat`): a FIFO, link, device or unwritable file makes `settle` exit 1 at once with `<path> is not a regular file that can be appended to ... Nothing was written.`, and `--as imported` creates no follow-up.
- **Task-attempt ledger revision advanced by two per write (FU-08tzhg):** `mutate` in `src/runtime/task-attempts.ts` raised `revision` on the object read from disk, and `updateTaskState` then stamped that value plus one, so a store went 13, 15, 17 while each claim, finish or release result reported the value in between. A write now advances the stored `revision` by exactly one and the result reports the stored value; a refused or stale call still writes nothing. Existing ledgers keep their revision and continue from it. `revision` stays strictly increasing; the only readers of the ledger's revision are the `status` and `inspect` output.
- **Cancel cleared by wall clock (FU-82p04v):** `clearedCancels` in `src/runtime/task-run.ts` treated a cancelled attempt as cleared when any `resume` history entry of its run was stamped later than `cancel.at`, so a cancel written after a resume by a host whose clock was behind read as cleared and the task could be claimed again. A `resume` entry that carries a `cleared` list is now authoritative: it clears only the attempts it lists, whatever its stamp (every resume writes the list). Only a run none of whose `resume` entries carries a `cleared` list (a record written before the list existed) still clears by a resume being stamped later than the cancel. IC-005 row 4 (feature 080 design) is amended to say so.
- **File removed in the execution worktree read as unchanged (FU-ev7r3g):** `measureSources` in `src/runtime/task-sources.ts` tried the execution worktree and then the plan roots, so a declared file deleted in the worktree but still present in the main checkout was measured from the main copy and `resume` reported it unchanged. When the attempt's execution worktree exists it is now the only place an entry is read: a file absent there is `absent`, and `resume` reports it `removed`. The plan roots are used only when no execution worktree is recorded or it no longer exists (that task is `unverifiable` as before). IC-013 (feature 080 design) is amended to say so. A declared file that is untracked or ignored and so exists only in the main checkout now reads `absent` at claim and at resume instead of being measured there.
- **Worktree create and remove pruned unrelated worktree records (FU-mysatc):** `WorktreeManager.create`, `remove` and `removeVerified` ran `git worktree prune` on the user's repository, which also forgot every other worktree of the user whose directory was merely missing (an unmounted drive, a directory deleted by hand). They now drop only the administrative record of the worktree path they manage, and only when its directory is gone and the record is not locked; every other record survives.
- **Run store path named once (FU-mtjqt9 C-14):** No behaviour change. `src/runtime/implementation-gate.ts` exports `RUN_STORE_REL` and `runStoreDir(root)`, and the orchestrator's default state folder, its `list` action and its CLI handler take the run store path from there instead of each joining `.doflow/state/orchestration`. The store walker in `src/runtime/state-root.ts` (`storeFiles`) is still a separate walker from `runFilesAt`; merging them needs an edit to `state-root.ts` and is left open under FU-mtjqt9.
- **Lifecycle reads under `DOFLOW_UPKEEP=off` never make the store lock (FU-mtjqt9 C-10):** `readFold` fell back to one read under `events.lock` when the retention journal's generation moved on every one of three reads, which made the lock folder although the switch promises no upkeep writes. With `DOFLOW_UPKEEP=off` (exactly) it now throws `StoreLockedError`, which the lifecycle and failure commands already report as a `store-locked` refusal, and nothing is written. With the switch unset the fallback is unchanged.
- **A corrupt state file no longer echoes its bytes (FU-mtjqt9 C-13):** `readTaskState` put the `JSON.parse` message into its `store-unreadable` error, and that message quotes the first bytes of the file, so `orchestrate --action status` on a corrupt run journal printed a fragment of it. The error now names the file and `SyntaxError` only; the code, the exit status and the recovery advice are unchanged.
- **`orchestrate` read of a run file follows no link and cannot block (FU-16c2wz):** every action that reads a run (`status`, `annotate`, `complete-stage`, ...) read the run file with a plain `readFileSync`, so a FIFO at `orchestration/<id>.json` made `orchestrate --action status` hang until it was killed, and a run file or namespace folder that linked outside the store was read from the target. The read now uses the list action's policy: no link on the way to the file or at it, a regular file of at most 1 MiB, opened `O_NOFOLLOW|O_NONBLOCK`. A file that fails it makes the command exit 1 with `Run file '<path>' is not a regular file inside the run store ... Nothing was read.`; an ordinary run file reads as before. The same read now covers every probe that runs before it: the check that decides whether a flat run file is this feature's (a FIFO there no longer hangs `status --slug <feature>`), `verify`'s readiness check (a linked run file or namespace folder is refused, not followed), and the lookup of a run in another checkout (a linked run file or namespace folder is not matched).
- **`orchestrate --action status` finds a namespaced run without `--slug` (FU-wrnnaq):** a run started under `--slug aaa` lives at `orchestration/aaa/<id>.json`, and `status --task-id <id>` run from a branch that names no feature, or another one, answered "No workflow run" for a run `--action list` shows as running. With no `--slug`, `status` now falls back to the one run of that id under any feature namespace, in this checkout first and then the other checkouts, and exits 1 naming the candidate files when more than one feature holds the id (`--slug` then picks one). Only `status` falls back; every action that changes a run still needs the feature to resolve. A flat run file that names no feature and sits in another checkout is still not opened by `status`. The text form of `status` prints a `Feature: <slug>` line under the header, naming the feature whose run it opened.
- **Bash 3.2 regex negative control no longer fails on Bash 4+ (test-only, `test/settings/capture-agreement.test.js`):** the test "negative control: a bash block whose regex uses `\s` fails the corpus on bash 3.2" only fails on Bash 3.2 regex semantics, so it failed on every Ubuntu job of the beta.6 `test` run. It now reads the Bash major (`DOFLOW_TEST_BASH`, default `/bin/bash`) and skips on Bash 4 and later with a version-specific reason; the positive corpus guard stays active on every POSIX host.
- **HOME-less bash spawns in tests start clean (FU-85a127, test-only):** the beta.6 macOS test legs printed `Error: $HOME must be set to run brew.` from HOME-less `bash` spawns and broke the "writes nothing to stderr" asserts in `test/hooks/no-home-hooks.test.js`, `test/settings/config-home-parity.test.js` and `test/hooks/emission-faults.test.js`. `test/helper/home-less-bash.js` now starts bash with `--noprofile --norc`, drops `BASH_ENV` and `ENV`, and, with `HOME` absent, takes the Homebrew folders off `PATH` unless a hook tool (`jq`, `shasum`, `git`, ...) would vanish with them; the three tests use it with every assert unchanged, and `test/helper/home-less-bash.test.js` simulates two brew vectors. The failure does not reproduce on a local Mac and a fake-bash start-up simulation stands in for the runner, so the runner trigger is unproven: that this fixes the beta.6 macOS Release leg is expected, pending CI, and is proven only by the next tag run.

### Documentation
- **Orchestrator context modes spec (issue #9):** `docs/specs/orchestrator-context-modes.md` now gives the final status of the four stages: stage 2 is superseded by feature 075 item-level delivery, stage 3 is replaced by the run ledger and `trace spans` (with the missing pack-to-stage link recorded as a followup), and stages 1 and 4 are retired with reasons. Closes #9.

## [2.0.0-beta.6] - 2026-10-18

### Added
- `doflow config list [--json] [--show-origin] [-g]` displays the effective settings and their origins.
- Layered settings add user `settings.json`, project `.doflow/settings.json` and `.doflow/settings.local.json`, plus registry `core/registry/settings.json`.
- Feature 105 adds `doflow-run model-role --exclude-family` to filter declared model families and label candidates
  `cross-family`, `overlaps-author` or `unverified`; usage errors list known families and JSON reports dropped ids as `familyExcluded`. Registry `families` remains a stopgap.
- Feature 088 adds telemetry contract v1 in `core/registry/telemetry.json`; `DOFLOW_TELEMETRY=off` disables telemetry writes. The shared bridge
  writes hook lines; verification writes `verify.*` lines, and trace ids are carried on run records.
- `doflow-run trace spans` projects spans from the run ledger, telemetry and 080 records; paired-perf options
  were added under `bench/perf`, and guard G45 checks the contract. Phases E–H remain deferred; G-O1 worker-run parts were unreached.

### Changed
- **This release's config home follows one rule everywhere.** `XDG_CONFIG_HOME` when it is an absolute path, else `$HOME/.config` when `HOME` is an absolute path, else there is no config home. A relative or empty value is ignored and the account's home folder is never consulted. In 2.0 Node read the account's home when `HOME` was unset and the shell scripts aborted with `HOME: unbound variable`; with `HOME` unset or relative there is now no config home in Node and in shell alike.
- A relative `XDG_CONFIG_HOME` is ignored and `$HOME/.config` decides. In 2.0 the shell scripts and some Node code read the relative path against the working directory; users who had one will find their session state under `$HOME/.config/doflow/session-env` from now on, and the old folder is no longer read.
- With no config home the hooks no longer exit: `lib.sh` in the shared policies and in each harness continues, session hooks (`session-start`, `user-prompt-submit`, `stop-check`) skip their state work and exit 0, and a guard hook such as Kiro's `pre-bash-guard` reaches its own decision.
- `doflow advise --action configure` exits 2 with a usage message, and writes nothing, when there is no config home.
- Failure capture reads `failure.capture` from `<config home>/settings.json`. The dispatcher, the shell policies, the JS hook runner and Node apply one text rule: any value other than `"on"` means off, and a settings file that is unreadable or not a regular file means off. See [Config home](docs/reference.md#config-home).
- In this release, a linked worktree with no settings files in its own `.doflow/` reads project settings from the main checkout, including legacy `decision-model.json` and `prune` files. A worktree with its own settings continues to use them.
- `advise --action configure` and `failure --action capture --set on|off` write `settings.json`; legacy `decision-model.json` and `failures/off` remain untouched.
- Settings written by this release are not read by earlier betas or 2.0.x, which keep reading `decision-model.json` and `failures/off`.
- `doflow config list` redacts URL query values and user information in displayed settings, including opaque and malformed endpoint forms.
- A linked worktree writer targets the inherited main-checkout settings layer and reports that location without silently changing inheritance.
- Stop-check with no state allows the turn instead of repeating a prior block.
- `failure --action capture --set off` preserves malformed settings in a mode-0600 backup before replacing them; `--set on` resolves DoFlow-owned lexical duplicates, preserves an existing `failures/off` sentinel and reports `effective: off`.

### Fixed
- Settings JSON parse errors report the byte offset only; the file contents are not included in errors.

### Deprecated
- `decision-model.json`, the one-line `prune` files and the `failures/off` sentinel remain readable through 2.x. `doflow config list` identifies each legacy source with a deprecation note and the corresponding `settings.json` key.

## [2.0.0] - 2026-10-14

First stable 2.x release. It consolidates 2.0.0-beta.1 to 2.0.0-beta.4 (the TypeScript runtime, the perf budgets and retrieval benchmark, and the packed JavaScript npm package) with context delivery (075) and evidence attempts (076). Upgrading from 1.24.1 needs Node `^22.18.0 || >=24.3.0`; see the 2.0.0-beta.3 entry for the Node floor and the `.js` to `.ts` runtime rename.

### Added
- `doflow context-pack` caps the whole payload it emits, in both the markdown and the JSON form, in UTF-8 bytes. The cap is the task class's default, or `--max-bytes <n>`, or the budget of `--harness <id>`; when a harness declares no capacity the pack says so and uses the default. Defaults are 225000 (`feature`), 85000 (`dependency-change`), 71000 (`bug`, `refactor`), 57000 (`documentation`), 45000 (`operations`), 42000 (`review`), 35302 (`research`) and 30000 (`trivial-edit`).
- Context packs separate mandatory content (objective, acceptance criteria, constraints, verification requirements, blocking gaps) from optional content. The verb now reads the mandatory content from the task's recorded requirement; `--mandatory-file <path|->` supplies it from a file or stdin. Mandatory content is always emitted whole, in both forms.
- Optional content that does not fit is trimmed in a fixed order and every omission is listed with an id and a reason. Evidence left out because it is not `FRESH` is listed with its freshness state instead of being dropped without a record.
- A delivery record per pack: the pack digest, an estimated token count labelled `estimated:bytes/4` (the actual count is reported as unmeasured), and the reason for any later expansion. Records are kept under `.doflow/state/delivery/`, at most 5 per task. `--no-record` skips the write.
- Pointer delivery for material the receiver can load itself, with `--expand <pointerId> --reason <text>` to ask for the inline content, `--since <digest>` to request a delta, and `--bare` for a header, objective and end line only.
- `doflow evidence --action add --need <intent>` binds an item to one declared retrieval need and stamps `source.queryRef`; `source.attemptRef` is read from the active task attempt. `--absence` records an empty answer for a need (`result: EMPTY`) and measures the provider index's freshness at write time.
- `doflow retrieval-plan --action attempt --need <intent> --provider <id> --status EMPTY|UNREACHED|UNVERIFIED --reason <code> [--note <text>]` records a fallback or failed lookup as its own attempt. `declare` mints a `planId` and a `queryRef` (`<planId>#<intent>`) per need, and reports list `attempts[]` and an `unbound` count for evidence not linked to a current need.
- Evidence file items record the source version inside `freshness`: `gitCommit`, `fileHash` (file locators only) and `isDirty`.
- Readiness reason codes `stale-absence-unverified` and `unbound-retrieval-evidence`.
- The `doflow enforcement` verb and lifecycle coverage block report which harness/policy pairs are enforced and what they do not cover. Pi installs a `tool_call` guard extension; only the live-observed `cli-extension` gate row is blocking, while project-interactive and user-interactive coverage remains unknown. Added `DOFLOW_FAULT_PROFILE` for compat/strict fault behavior and `DOFLOW_BRIDGE_TRACE` for bridge decisions.

### Changed
- **`doflow context-pack` exits 3 (`OVERFLOW`) when mandatory content plus omission records exceed the cap.** The whole pack is still emitted and `overflowAction.message` says to split the task or its context, or start a new session. Exit precedence is 2, then 3, then 1 (empty pack), then 0.
- The markdown form of the context pack now carries constraints, verification requirements and conflicts, which it left out before.
- `retrieval-plan` matches evidence to a need by `queryRef` and `attemptRef` instead of by provider or capability, so two needs that share a provider no longer share evidence. A plan declared before this release has no `planId` and keeps provider matching.
- A claim backed only by evidence of `UNKNOWN` freshness stays a hypothesis; only `FRESH` evidence supports it, and `STALE` evidence invalidates it. Before, any evidence that was not `STALE` counted as support.
- Score-shaped fields (`score`, `confidence`, `relevance`, `rank` and the rest of the existing list) are refused on the programmatic and candidate-bridge write paths, as they already were on the CLI. Candidates are not persisted; rank and score are dropped before an item reaches the ledger.
- The context-mode spec (`docs/specs/orchestrator-context-modes.md`) is rewritten: no downgrade away from mandatory content on overflow, and each stage states its real status.
- Hook policies now accept envelope v1 only. Scripts that send native payloads directly to a policy must send v1 or invoke the shared bridge. Missing envelopes take the explicit out-of-step rule; a missing bridge gets a fixed native response, including in the Pi extension and the Antigravity runner.
- Lifecycle plans that change shared hooks refresh outdated front doors for other installed harnesses at that scope, with one backup and rollback. Edited companion doors refuse unless forced. The bridge preserves a caller-set `DOFLOW_AGENT` value.
- The Antigravity runner no longer carries the unused Gemini branch. The Antigravity plugin bundle no longer declares hook entries for files its projection does not install.
- Input without envelope v1, including a missing contract, follows the explicit out-of-step rule; a missing policy is an evaluation error (compat proceeds with a diagnostic, strict denies). Blocking evaluation errors use the IC-013 fixed reason. Strict-1 never fault-blocks Stop, though a real Stop deny still blocks; crashed Codex Stop stderr is suppressed. Bridge capture no longer depends on a temporary file, background jobs do not hold Stop or SessionStart open, and strict-1 renders native denies when `jq` is unavailable. Codex `update -t codex -f` re-merges edited `hooks.json` while preserving user entries.

### Removed
- Removed `gemini.js`, `arg-fields.js`, the shared hooks `hooks.json`, and Antigravity plugin hook declarations.
- **Breaking for direct policy callers:** removed the legacy native-field and unversioned `doflow_event` decoder. Scripts that pipe native hook payloads to policies must migrate to v1 or call `bridge.sh`.

### Fixed
- Linux CI: tests no longer depend on a global git identity, the host's mkdir error text, or an init process that reaps zombies; an early-exiting bridge is reported as `bridge-answer-invalid` instead of `bridge-spawn` by the Antigravity runner, and the session-start measure reports the hook's exit code instead of EPIPE.

### Upgrade notes
- A script that runs `doflow context-pack` and treats any non-zero exit as "no context" must now tell exit 3 (mandatory content over the cap; the pack is complete) from exit 1 (nothing recorded). The four skills that call `context-pack` (`do-design`, `do-plan`, `do-execute-plan`, `do-implement`) already handle exit 3.
- `recorded: false` with `reason: "store-locked"`, `"store-unwritable"` or `"store-unreadable"` in the pack means the delivery record was not written (the lock was held, the store is read-only, or an existing record file is torn or from a newer version); the pack itself is unaffected and the exit code does not change.
- Delta delivery is present but inactive: harness retention of earlier context is unproven for all eight harnesses, so `--since` is answered with a full pack and `deltaRefused: "retention-unproven"` or `"harness-unstated"`.
- Retrieval evidence for a plan that has a `planId` must be recorded with `--need <intent>`. An item recorded without it stays readable but is unbound: it is not linked to any need, and a readiness requirement that only unbound `FRESH` evidence could satisfy returns `NEEDS_EVIDENCE` with `unbound-retrieval-evidence`. Re-record it with `--need <intent>`.
- A caller-supplied `queryRef`, `attemptRef` or `result` on `evidence --action add` is refused with the command that fixes it (`--need`, a claimed task attempt, or `--absence --need`).
- A requirement that rests only on an empty answer from a `STALE` or `UNKNOWN` index returns `NEEDS_EVIDENCE` with `stale-absence-unverified`. Refresh the index and record the absence again, run the lookup with a live provider such as `native.rg`, or record a positive item. `retrieval-plan` does not run refresh commands.
- Outcome precedence for a need with several attempts is `RETRIEVED`, then fresh `EMPTY`, then stale `EMPTY`, then `UNVERIFIED`, then `UNREACHED`; ties go to the lowest attempt number. `RETRIEVED` is derived from bound evidence and cannot be entered with `--action attempt`.
- Existing evidence ledgers, retrieval plans and claim stores load unchanged.

## [2.0.0-beta.4] - 2026-10-13

Prerelease of 2.0.0 on the npm `beta` dist-tag (`npx @khoavu882/doflow@beta`). It replaces 2.0.0-beta.3, which is deprecated because it could not run when installed from npm.

### Fixed
- The npm package now runs when installed from npm. It ships JavaScript built at pack time from the TypeScript sources with Node's built-in type stripper and adds no dependency. Version 2.0.0-beta.3 is deprecated because it shipped `.ts` files under `node_modules`, which Node refuses to run.

### Changed
- The published package's runtime files are `.js` again; source checkouts keep `.ts`.

## [2.0.0-beta.3] - 2026-10-13

Prerelease of 2.0.0 on the npm `beta` dist-tag (`npx @khoavu882/doflow@beta`); `latest` stays 1.24.1. 2.0.0 stable follows once the
context-budget and evidence-attempt work (P1) lands.

### Added
- Benchmark baseline and contracts for the retrieval roadmap (P0): a retrieval benchmark under
  `bench/retrieval`, latency budgets under `bench/perf`, a tool inventory under `bench/inventory`,
  and a guard (G33) that keeps them consistent. `bench/` is not part of the npm package, so
  installs are unchanged.

### Changed
- **Breaking: the Node.js floor is raised from `>=18` to `^22.18.0 || >=24.3.0`** (`engines.node`). DoFlow's own
  runtime (`src/`) is now TypeScript, run directly by Node's native type-stripping, with no build
  step and still no runtime dependencies. Every module under `src/` is reachable from
  `bin/doflow.js` (156 of 156), so no part of the CLI can run on an older Node. Node 18 and 20 are
  no longer supported. The floor is where type-stripping is on by default and silent: Node 22.18.0 and
  24.3.0. Node 22.6 to 22.17 and 23.0 to 23.5 only strip types behind `--experimental-strip-types`,
  which DoFlow does not pass, so they are below the floor. Node 23.6 to 24.2 strip types by default
  but print `ExperimentalWarning: Type Stripping is an experimental feature` to stderr on every `.ts`
  load, so the floor skips them (Node 23 is end-of-life).
  - On a Node that cannot strip types (below the floor, or stripping turned off with
    `--no-experimental-strip-types`, for example through `NODE_OPTIONS`), `doflow` now exits 2 with
    one line naming the running Node, the required range and that flag, instead of a SyntaxError.
  - Check with `node -v`. On Node 18, 20 or an older 22.x/23.x, install Node 22.18 or later (or
    24.3 or later) before running `npx @khoavu882/doflow` or `doflow update`.
  - To stay on the last release for Node 18/20, pin `@khoavu882/doflow@1.24.1`.
  - `docs/setup.md` states the floor and the reason.
- **Breaking (installed output shape): runtime files under `.doflow/runtime` that were `.js` are
  now `.ts`** (for example `git.js` -> `git.ts`). `bin/doflow.js` stays `.js` and the `doflow` and
  `doflow-run` entry points do not move. A script of your own that requires an installed runtime
  file by its old `.js` path breaks; `doflow update` removes the old file (see Fixed).
- All of `src/` is TypeScript: 156 `.ts` modules, 0 `.js` under `src/`. CLI behaviour is unchanged.
  A guard (G30) fails if a plain `.js` is added under `src/`.
- Node's module compile cache is enabled at the CLI entry (`bin/doflow.js`), so the cost of
  transforming each `.ts` module is paid once per Node version and file content. It honours
  `NODE_COMPILE_CACHE` (cache directory) and `NODE_DISABLE_COMPILE_CACHE` (turns it off), and with
  neither set lives in Node's default location. If the API is missing or throws, the CLI still runs,
  without the cache.
  - Measured at 073's tip (452e881) on the development machine, interleaved runs under the same load, `--version` / `--help`:
    1.24.x source (837f8bf) 64 ms / 66 ms; this release with the cache 57 ms / 61 ms (25-30 runs);
    this release with the cache off 109 ms / 112 ms. The cache is what keeps the CLI at or below
    1.24.x; without it start-up is slower.

### Fixed
- `npm test` runs on the supported Node versions: the script discovers `test/**/*.test.js` with Node's own glob, because Node 22.18 and 24 do not recurse a directory argument. 2.0.0-beta.1 and 2.0.0-beta.2 were tagged but never published (their release gates failed: test discovery on the Node floor, and a test that needed PlantUML on the runner).
- Failures you settled on 1.24.x reappear once after upgrading. A failure's fingerprint includes the
  module path of its frame, which now ends `.ts` instead of `.js`, so each distinct failure shows up
  as a new, unsettled entry. List them with `doflow-run failure --action list` and settle each again
  with `doflow-run failure --action settle --fp <fp> --as noise|fixed|imported --reason "<why>"`.
- `doflow update` prunes runtime files a newer version no longer ships. A file under the shared
  runtime trees (`runtime.cli`, `runtime.lib`, `runtime.registry`) that the new version no longer
  produces is removed when its bytes still match what DoFlow recorded, including after a partial
  update that left out a harness still holding a record on it (a bare `update` targets Claude only).
  Previously such files, for example the `.js` copies left by the `.js` -> `.ts` renames, stayed.
  Verified on a scratch v1.24.1 Claude install updated through each of the 8 harnesses: 89 orphans,
  0 afterwards.
  - A file you edited, a file DoFlow has no record of, and a file whose real path leaves the
    tree (a symlink) are kept, and `update` names each one.
  - `doflow update --dry-run` lists every file it would prune or keep and deletes nothing.
- `doflow update` reports what it retained, after the run and under `--dry-run`, as `doflow remove`
  already did: files left in place because a harness outside the run still claims them.
- On a case-insensitive filesystem (macOS default), a rename that changes only letter case no
  longer deletes the file the same run just wrote, and `verify` now reports a file the run wrote
  that is missing. Reproduced three times on APFS before the fix.
- `doflow rollback` restores the ownership ledger (`.doflow/state/ledger.json`) together with the
  files, so `update` and `remove` work after a rollback. Before, they refused the restored files as
  "modified outside DoFlow" (reproduced: update, rollback, update exited 1 with 48 refusals; remove
  exited 1). Backups taken by `install` and `update`, and the snapshot taken before a rollback,
  now include the ledger.
  - Restored: the ledger only. Not restored: runs, evidence, recovery records, the lock and the
    install manifest.
  - A rollback narrowed with `--target` leaves the ledger as it is, because restoring it would
    rewind the other harnesses' records.
- `doflow update -t codex` no longer refuses an update whose only work is a runtime prune or the
  release of a stale ledger row.

### Known limitations
- After a rollback, files the rolled-back update created stay unowned until the next `update`
  adopts them.
- On a v1.24.1 Claude install, `install -t codex|gemini|kiro|antigravity` can refuse because
  `hooks.shared: policies/lib.sh` is reported modified. Seen at HEAD and at 8bf9644; not fixed here.
- A bare `doflow update` still targets Claude only; pruning follows the runtime files DoFlow
  recorded for every harness, but the update itself does not.

## [1.24.1] - 2026-10-11

### Fixed
- Unified Antigravity CLI (`agy`) and Antigravity IDE global and workspace skill discovery and runtime reachability:
  - Added user-scoped skills directory under `~/.gemini/config/skills` matching Antigravity's official customization specification.
  - Projected DoFlow skills and shared runtime (`~/.doflow/`) to global scope with full runtime reach (`doflow doctor` verified).
  - Allowed `managedInstruction()` to safely append DoFlow marker sections to existing project `AGENTS.md` files without throwing conflicts.

## [1.24.0] - 2026-10-11

### Added
- Decision model advisory routing via `doflow advise`: local loopback-only second opinions for `verify-risk`, `task-class`, `tier`, `followup-triage`, and `review-depth`, bounded by DNS resolution budgets and symlink write prevention.
- Context footprint budgeting with `compileBoundedContextPack`, partitioning mandatory and optional context slices under explicit byte ceilings with omission tracing.
- Ambient TypeScript declarations in `types/runtime.d.ts` included in the package distribution, alongside strict performance latency budgets.
- Hybrid RAG retrieval using Reciprocal Rank Fusion (RRF) for bounded lexical and semantic result merging.
- Storage retention, on by default. Every store DoFlow writes has one bound, declared in `core/registry/storage.json` and listed in `docs/reference.md`: the 40 newest verification logs within 30 days; per-task records 30 days after their work finished; run partitions after 180 days; the 3 newest recovery snapshots plus the one the ledger names; settled lifecycle events after 180 days; orphan report bodies after 24 hours; session folders after 30 days and project folders after 90 days. Open, waiting and unfinished work is never removed.
- Cleanup runs silently after runtime verbs (at most daily per root), after `verify`, after `install` and `update`, and from session hooks. Each pass stops after 750 ms or 5,000 removals, so the first passes after upgrading remove an existing backlog over several runs.
- `.doflow/state/.gitignore`, written once when the state folder exists, keeps runtime state out of `git add -A` except `ledger.json`. `doflow remove` deletes it with the other control files.
- `doflow storage [--action report|prune|upkeep] [--json] [-g]`: report every store and what a pass would remove, or prune now.
- The `prune` setting: `.doflow/prune` for a project and `~/.config/doflow/prune` for the user, `on` or `off`.
- `doflow orchestrate --action handoff --mcp-outcome <server>=<outcome>`, repeatable: records what a stage did with each MCP server it names, as `used`, `nothing-usable`, `skipped:<reason>` or `unavailable`. The outcome is stored on the run's history entry, and the `--json` snapshot gains `consultations` and `mcpWarnings`. A named server with no outcome prints a warning after the handoff; nothing here changes an exit status or blocks a stage. Any other action refuses the flag with exit 2.
- `doflow doctor` gains `[MCP Servers]` (per installed harness and scope, whether each server a shipped stage names is selected, configured, not selected, not taken or unknown, with the command that adds it) and `[MCP Consultations]` (per stage, the outcomes over the last 20 recorded runs and the runs with none), and `mcp.servers` and `mcp.consultations` in `--json`. Neither section enters `[Warnings]` or `[Findings]` or changes the exit status. Because finished orchestration journals are pruned 30 days after their work finished, the 20-run window counts only the runs still kept.
- `doflow-run brief-tools` and a tier, tools and report-format block in every generated dispatch brief (`task-brief` gains `--harness` and writes a `*-brief.json` record beside the brief). The block names the model tier for the task's owner, the tool that answers each kind of search on this machine (as the harness's MCP tool name where it has that server, else the command), and the MCP servers the current stage expects, and asks the report to end with a `Tools used:` line that the next handoff reads. If the verb fails, the brief says so in that place and is otherwise unchanged.
- Guards G28 (`test/guards/mcp-claims.test.js`: every MCP server a skill or guidance file names is in the registry, a skill step and the registry's `steps` agree, `docs/setup.md` carries each trigger verbatim, and no text claims an optional server is always used) and G29 (`test/guards/brief-tools-registry.test.js`: the brief block follows the registries and names no provider or server in code).

### Changed
- Settled follow-up and goal events are pruned after 180 days by default. `DOFLOW_RETENTION_HOURS` still sets the window when present, and still applies while the `prune` setting is `off`.
- `trace`, `stats` and `discover` without `--days` cover at most the last 180 days, since older run partitions are pruned.
- The MCP steps of `do-brainstorm`, `do-design` and the research reference of `do-document` now state use as conditional on a concrete trigger (a named library's behaviour stated as fact; a decision with more than one interacting part or competing option) and ask for one recorded outcome per server, replacing wording that read as if the servers were consulted on every run. The always-loaded `MCP_Context7.md` and `MCP_Sequential.md` guidance now carries only that registry trigger sentence in place of their keyword and example lists (1,745 and 2,012 bytes down to 902 and 830). The servers remain optional and opt-in. `docs/setup.md` lists each server's trigger and the outcome labels.

## [1.23.0] - 2026-10-09

### Added

- A standalone-prompt nudge on Claude Code and Codex. On the first prompt of a session that reads as a clear imperative code-change request (a change verb that names a code thing or a file path) and names no `/do-*` skill, the existing per-prompt hook adds one advisory note suggesting `/do`; the model still does the task, and a session is nudged at most once. It makes no model call, stores no prompt text and never blocks a prompt. The other six harnesses have no hook for this and get only the rewritten skill descriptions below.
- The nudge is switched off with a one-line `prompt-nudge` setting file holding `off`: `<repo root>/.doflow/prompt-nudge` for a project, `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/prompt-nudge` for a user. `on` or no file leaves it running; when both files exist the project file decides alone, and a file that is unreadable, empty or holds any other word counts as `off`.
- The nudge rules are data, not code: the `promptNudge` object in `core/registry/workflows.json` (message, verbs, nouns, lead-ins, blockers, path pattern), read by `core/harnesses/shared/hooks/policies/prompt-nudge.jq`. Guard G25 (`test/guards/prompt-nudge-registry.test.js`) checks the object's shape.
- A labelled prompt corpus (`test/hooks/prompt-nudge.corpus.json`) and its runner (`test/hooks/prompt-nudge.test.js`) in the normal test suite. A prompt labelled silent that nudges fails the test; recall on the prompts labelled as requests is printed as a diagnostic line and never asserted.
- The `description` of `do`, `do-implement` and `do-flow` now steers a plain change request that names no `/do-*` skill to `/do` first. This is the only steer on harnesses without a prompt hook (Gemini CLI, Antigravity, OpenCode, Pi, Copilot CLI, Kiro).

- The shipped quality rules (always loaded) now also say to state uncertainty plainly, never invent sources, figures, citations or quotes, warn when a claim may be outdated, and never attribute a statement to a real person without verification. This adds 389 bytes to the always-loaded guidance of every session on every harness (9,603 to 9,992 bytes of the 10,245-byte G13 ceiling).

### Changed

- Claude Code now receives the first-prompt context. The hook emitted the Git block, up to 4,000 characters of the previous compact summary and the prior-session warning in a form Claude Code ignores, so none of them reached the model. It now uses the nested `hookSpecificOutput` form Claude honours (Codex already did). A live run confirmed that Claude receives the Git context and the nudge. The first prompt of every session start therefore carries that context, which costs tokens once per session start (including after compact, clear or resume). The hook now emits the `branch — sha` session title in the form Claude Code documents; the hook's own rule is to leave a title the session already has. That the title is applied was not checked. The nudge's decision cost no longer grows with the length of the prompt, and the hook stays near its existing 100 ms budget on an idle machine.
- The `do-implement` bench case now expects a plain change request to resolve to `do`, matching the rewritten descriptions.
- Runs started before DoFlow 1.22.0 recorded readiness no longer get a grace: their implementation handoff (and `complete-stage`) is refused until a READY readiness record exists for the task, with the refusal naming the `readiness` command to run; `verify` reports `INCONCLUSIVE`, and the pre-implementation hook holds their source edits to the same readiness rule as any other run. New runs no longer write the `readinessFloor` key; run files that carry it stay valid and need no migration.

### Fixed

- `update` no longer refuses guidance files whose bytes another harness's install recorded. A Pi, OpenCode, Copilot or Kiro install made by v1.14.x next to a Claude install was refused as "modified outside DoFlow" because only the four runtime assets accepted a sibling's recorded bytes; the guidance tree (`guidance.context-layer`, `kiro.guidance-tree`) now does too, which supersedes the runtime-only limit of 1.15.0 (hand-edited files are still refused). The replacement notice now reads "replaced shared files written by ..." instead of "shared runtime files".

## [1.22.1] - 2026-10-09

### Fixed

- The wait for a state-file lock is now bounded by elapsed time as well as by attempts, so a slow host no longer outlasts a live holder's 10 s staleness window and takes its lock; this showed up as the decision-register and readiness-record lock tests failing on macOS CI.
- The Cross-OS Tests workflow now runs the Node test matrix on pull requests and pushes. Its `os_matrix` input exists only for `workflow_call`, so the matrix job was never created outside release tags and macOS was only tested at release time.

## [1.22.0] - 2026-10-09

### Added

- `verify --scope <path>[,<path>…]` bounds the change-scope tier for a task with no plan, and is added to a plan's bound when there is one without narrowing it. A trailing `/` is a directory; one path that is empty, absolute, `.`, contains whitespace or climbs out with `..` refuses the whole value. A `bound:` line under the tier names where the bound came from, and when nothing bounds the change the tier lists where `verify` looked and the command that bounds it.
- Every `readiness` call records its evaluation under `.doflow/state/readiness/`, whatever its state, and prints a `Recorded:` line (`record` and `declaredScope` in `--json`). A `--scope` that is a list of paths is also the task's declared scope for `verify`. A previous record that cannot be read is moved to `<record>.unreadable` and a `Replaced:` line says so; a record written by a newer DoFlow is never replaced, and the call exits 1 and says so.

### Changed

- `verify` finds the feature's plan from a linked worktree: `--plan-path`, else the feature folder in the current checkout, else the main checkout's. The `bound:` line names the plan it used and which checkout it came from.
- `orchestrate` `handoff` and `complete-stage` of a gated `implementation` stage refuse, before changing anything, unless a READY readiness record of the stage's template was made before the call; run the `readiness` command the refusal prints to clear it. `--verification-plan`, `--scope` and `--invariants` on those two actions no longer satisfy the check, and a note says they were not read. A run started in another checkout of the same repository is read and updated where it lives.
- A `verify` report that would pass is `INCONCLUSIVE` while the task's run has its gated stage pending and no READY readiness record exists.
- The pre-implementation hook also checks readiness and reads the main checkout's feature folder, records and runs from a linked worktree. It now refuses a source edit on Claude Code, Codex (after its hook review), Gemini CLI, Antigravity and Kiro in two cases: a feature branch with all three artifacts and a decision register but no READY record, and an open `bug`, `refactor` or `dependency-change` run with its implementation stage pending; both also apply from a linked worktree. OpenCode, Pi and Copilot CLI have no hook layer and are checked at the handoff and by `verify` only, and `trivial-edit` is held at the handoff and by `verify` only on every harness. Runs now store `featureSlug` and `readinessFloor`, and the frozen-behaviour guard now forbids the hook script from invoking the runtime rather than from naming `readiness`.
- A run started before this release gets a warning in place of the handoff refusal, and keeps its `verify` status, until 1.23.0, which ends that grace. The hook treats such a run as no run.

## [1.21.0] - 2026-10-08

### Changed

- `install`, `update`, `remove`, `reconcile` and `rollback` take a run lock, so one runs at a time per scope. A second run prints a waiting line, waits up to 60 seconds, then exits 1 and changes nothing. A lock is stale after 10 minutes or when its holder is gone; after Ctrl+C the next run clears it and prints one `Cleared a stale DoFlow run lock` line. `--dry-run` and the read-only commands never take it. It is not supported on network file systems or Windows.
- `install`, `update`, `remove` and `reconcile` without `-g` refuse a project root that is your home directory: one `[ERROR]` line pointing to the `-g` form, exit 1, nothing changed. A ledger that already mixes project rows into the global scope keeps them, and no command removes them.

### Fixed

- Codex: an `[mcp_servers.X]` table you wrote in `config.toml` under the same name as a DoFlow server is left untouched and is not recorded as DoFlow's. `install` and `update` say so when they skip it.
- Codex: `config.toml` and the other files DoFlow rewrites keep their file mode.
- Codex: a ledger row that 1.18 to 1.20 recorded for a table of yours is released with `doflow update -g -t codex --mcp <your other DoFlow servers, or none>`; the `modified outside DoFlow` conflict now names that command. DoFlow then stops managing the table and keeps it.
- Codex: an empty `[features]` table, or root-level `features.x` keys, no longer gets a second `[features]` table, and the line DoFlow adds to an empty `[features]` table carries a DoFlow comment. A `features` value that cannot take a new key is refused with the file unchanged.
- `update` removes the installed copy of a source file DoFlow no longer ships, for Claude, Codex, Kiro, OpenCode and Pi, as Copilot and Gemini already did. A copy you edited is kept and reported.

## [1.20.0] - 2026-10-08

### Changed

- `install` and `update` back up only the files the run changes or owns, and record the files the run creates, in a per-file copy with a format-2 manifest, instead of archiving whole harness homes. An earlier DoFlow cannot restore these backups: DoFlow 1.19's `rollback` of one takes a whole-home snapshot, restores nothing, and still reports success, so keep that in mind before downgrading.
- A file that holds only MCP entries is never backed up, for `install` as well as `update`.
- After each `install` or `update`, DoFlow keeps the newest 3 backups of that scope; `--prune N` keeps N and `--prune 0` keeps all. An `update` with nothing to change prunes nothing, so the first run after upgrading that prunes is an `install`, or an `update` that changes files; it removes the older DoFlow-written backups beyond 3 and says how many it removed. `--dry-run` shows that count first. The legacy `.claude/backups` folder is never pruned.
- `rollback` restores what the backup holds, lists the files the run created and leaves them in place, and exits 1 when a file cannot be restored. With no `--target` it restores the whole backup. Backups made by 1.19 restore as before.
- The pre-rollback snapshot holds only the files the rollback overwrites.
- `list-backups` shows each backup's origin and size.
- `--dry-run` reports how many files and bytes a backup would hold and what retention would remove.

## [1.19.0] - 2026-10-07

### Changed

- The lifecycle store moved from `agent-docs/lifecycle/events/` to `.doflow/state/lifecycle/events/` at the repository root. It is local to the machine and not shared; DoFlow still never stages, commits or pushes it and adds no ignore rule. The first `followup`, `lifecycle`, `goal` or `failure --action settle --as imported` command copies an existing store once and leaves the old folder untouched; a marker, `.doflow/state/lifecycle/migrated.json`, records the copy so the old folder is never read again. Every lifecycle command prints a line saying the old folder can be deleted for as long as it exists. A failed copy exits 1 with `store-migration-failed`, changes nothing, and the next command retries.
- `--mcp` now applies to every targeted harness that takes MCP servers and is recorded per harness in `doflow.lock`; `update` reuses each harness's own selection. A non-interactive run with no `--mcp` takes, per harness, the selection recorded in `doflow.lock`, else the servers an installed harness already has, else none, so a Pi, Kiro, OpenCode, Copilot or Antigravity install no longer registers the whole catalog by default.
- `remove` now deletes the MCP entries DoFlow owns for Claude, Kiro, OpenCode, Copilot and Antigravity, and a narrower `--mcp` removes the deselected servers from them; entries you wrote or edited stay.
- Pi removes the MCP entries it owns when the selection is empty and no longer prints the selection notice.
- `install` and `update` print one `MCP selection:` line naming each harness's servers and where the selection came from.
- `update` no longer backs up a target whose only changes are MCP entries.
- `status` prints an `MCP selections:` line with each harness's recorded selection, and `status --json` reports them under `mcpSelections`.

### Added

- `DOFLOW_RETENTION_HOURS`: set to a positive whole number of hours, each lifecycle command removes the event files of settled follow-ups and goals whose newest event is older, never open, taken or unfinished ones, and prints one stderr count line. Unset keeps everything; an invalid value warns and removes nothing. Run state and the old `agent-docs/lifecycle/` folder are never cleaned.
- `doflow.lock` keeps the rows of harnesses a run did not target, and a harness leaves it only when its last owned resource is removed.
- `reconcile` warns about a harness installed in the ledger but missing from the lock, and `--json` lists it under `unpinned`.

### Fixed

- Claude, Kiro, OpenCode, Copilot and Antigravity MCP entries are owned per server through ledger rows, so a same-named entry you added is never overwritten, taken over or deleted. DoFlow takes over an unrowed entry only when a 1.18.0 install recorded writing it, and a run that changes no file still records the entries DoFlow owns and says so.

## [1.18.0] - 2026-10-06

### Added

- Pi MCP registration: DoFlow writes the selected MCP servers into Pi's own config, `~/.pi/agent/mcp.json` (global; `$PI_CODING_AGENT_DIR/mcp.json` when that variable is set) and `.pi/mcp.json` (project; Pi reads it only after the project is trusted). Entries are spliced into the file's own bytes, so your entries, formatting and file mode survive install, update and remove; a same-named entry is never overwritten; an entry you edit becomes yours; remove deletes only what DoFlow added, and a file only if DoFlow created it. A malformed file blocks install and update but not uninstall, and no file text appears in errors or recovery records. Pi's MCP capability is now `supported`.
- Kiro installs a copy of the shared guidance tree under `.doflow/guidance`, and `retrieve` finds its tree the way the dispatcher does: the nearest `.doflow` that has one, then `~/.doflow`.
- `status` reports a harness DoFlow never installed as `not-installed`.
- G23 flags every Unicode default-ignorable code point (variation selectors, soft hyphen, fillers and the rest) and keeps a leading byte-order mark; an emoji presentation selector after a pictograph is allowed.
- The committed bench baseline is captured on claude-sonnet-5-5 for all 46 cases with each case's side and token usage; `bench/config.json` pins that model and sets the per-run token ceiling to 250,000. `bench parity` reports a duplicate baseline key and the report prints `unknown` for a null cell.

### Changed

- `pre-bash-guard` also blocks `git push -f`, `+refspec` and `git -C x push --force` (`--force-with-lease` stays allowed), `find` deletes with no scoping predicate, `~user` and `/Volumes` deletes, here-string and ANSI-C-quoted shell, and `sudo -u`, `xargs -n` wrappers; matching stays case-insensitive.
- The implementation gate hook applies to `feat/`, `feature/` and unprefixed or other-class branches; fix, bugfix, refactor, chore, release and hotfix branches are no longer blocked.
- The `stop-check` prose filter is fence-aware, ignores URLs and headings but not a marker next to them, runs in linear time on long lines, and sends linter output to stderr.
- Removing Claude or Codex leaves nothing of DoFlow behind: an instructions file that held only DoFlow's section is deleted, the user's own bytes are handed back unchanged, Codex hook scripts that match the shipped bytes and an emptied `config.toml` table are removed, the Copilot adapter removes files an update drops, removal prunes `agents` and `skills` folders it emptied, and a Codex plan with broken DoFlow markers is refused before anything is written.
- `doctor` reach reads every ancestor ledger up to HOME and names each install root and what hides it.

### Fixed

- `verify-hooks.sh` runs hermetically under a fresh HOME and XDG_CONFIG_HOME; `user-prompt-submit` creates its session directory before writing; the compaction hook reads its branch through `run_with_timeout`.

### Known limits

- No Pi binary was run: the Pi version floor and trust behaviour come from Pi's public docs.
- A Pi-only install registers every catalog server, and `--mcp` narrows the selection only when claude or codex is also targeted; `PI_CODING_AGENT_DIR` moves only `mcp.json`.
- A project install rooted at HOME shares one ledger with the global install; Codex removal is scope-aware, but the lifecycle's move sweep is not.
- Five triggering bench cases assert behavior a routing-only run cannot produce, so they read lower than in the old baseline.

## [1.17.0] - 2026-10-06

### Added

- Bench corpus: 13 should-not-trigger cases (one per skill) graded by the new `skill_not_routed` assertion over `routing.json`, and a `split` field (train or held-out) on every case with `plan --split`.
- Bench usage record: a validated `timing.json` per run (`total_tokens`, `duration_ms`); a missing or malformed record reads as unknown, never 0.
- Bench token ceiling: `costCeiling` in `bench/config.json`; `plan` exits 2 on a known projection over it and warns when the projection is unknown; `report` warns only.
- Bench without-skill arm: `plan --arm without-skill` for behavioral cases, graded `withheld`, `leaked` or `unrecorded`, with an `armDelta` in `report`.

### Changed

- `bench parity` and `bench report` mark cases added since the committed baseline as pending, awaiting a paid baseline capture, instead of failing.

### Fixed

- `bench plan` output piped to another process was cut at 64 KiB because the runner exited before stdout drained.

### Known limits

- No paid bench run was made: the new cases and the without-skill arm have not been measured against a model, and the committed baseline is unchanged.
- `parity` compares a case's side only for cases whose baseline result recorded a `split`; the committed baseline has none.

## [1.16.0] - 2026-10-06

### Added

- G23 (`test/guards/hidden-unicode.test.js`) fails on Unicode tag characters, zero-width and bidirectional controls in shipped prose and code.
- G24 (`test/guards/instruction-lint.test.js`) checks that `doflow-run` verbs and anchored path references in guidance, skills, agent specs and pointers exist, and flags declared opposite-default pairs; exceptions are declared with a reason in `test/guards/instruction-lint.json`.
- G22 guards the total of all skill descriptions against Codex's 8,000-character fallback, and G13 prints the always-loaded size per file and per harness projection.

### Changed

- The Codex registry rows record all 12 hook events (`PermissionRequest`, `PostCompact` and `Interrupt` as `different`) and cite learn.chatgpt.com; the Copilot row records the global `~/.copilot/copilot-instructions.md`; the Kiro hook-trust note says untrusted workspaces still ask before shell commands. The format-drift baseline is refreshed.

### Fixed

- Gemini agents were installed where Gemini CLI does not read them and with a frontmatter key its schema rejects. They are now written flat to `.gemini/agents/<name>.md` (project) and `~/.gemini/agents/<name>.md` (global) with only the documented keys; Antigravity keeps its folder form. An update moves installed agents, and a hand-edited agent at the old path is kept with a notice naming it.

### Known limits

- Gemini CLI discovery of the new layout was verified against its documentation and the installed files, not by running the CLI.

## [1.15.0] - 2026-10-05

### Added

- The `doflow-run` verbs and the guidance tree reach Pi, OpenCode, GitHub Copilot CLI, Kiro and Antigravity after a standalone install, at project scope and, where the harness has skills, at global scope. Antigravity global installs no skills and no runtime and prints a notice saying so.
- `doflow doctor` reports static runtime reach per harness and scope: a `[Runtime Reach]` section, additive `harnesses[].reach[]` JSON, and exit 1 when an installed harness cannot reach the runtime. The doctor text line now reads `adapter PASS`.
- An offline smoke test (`test/e2e/runtime-reach.e2e.test.js`) installs all eight harnesses into scratch directories and runs the installed resolver, shim and read verbs under an emptied environment.

### Changed

- The "no runtime found" hint names the harness: `install -t <harness>`. The install help lists all eight targets and the real default (`claude`).
- A shared runtime file is accepted as known-good when a sibling harness's ledger row recorded its bytes; replacing it prints a notice. Only the four runtime assets qualify, and a hand-edited or foreign file is still refused.

### Fixed

- `stop-check.sh` never fired on Claude Code or Codex: it read a top-level role their transcripts do not write. It now reads the payload's `last_assistant_message` or the real transcript shape, honours `stop_hook_active`, blocks a given message once, and the Codex front door passes exit 2 through.
- The compact summary was re-injected into every new session with no expiry. It is now injected once, claimed atomically, cut to 4,000 characters, and can no longer fail a prompt.
- An Antigravity project install no longer needs the current directory to be the checkout.

### Known limits

- Installs of the five harnesses made before this release report no runtime reach until `doflow update -t <harness>`.

## [1.14.2] - 2026-10-05

### Changed

- `do-code-review` keeps its guardrails inside the compaction window. Its `SKILL.md` was 22,393 bytes, so `## Boundaries` started past the 5,000-token window that is re-injected after compaction and was dropped there. The maintainer-only sections (adding a language, regression fixtures) moved to its README and the directory tree was removed; the file is now 18,840 bytes with `## Boundaries` at byte 16,784. No review rule, threshold or step changed.
- `RULE_02_WORKFLOW.md` asks for a task list "when the session offers one" instead of naming `TodoWrite`, a Claude Code tool, for all eight harnesses.
- Documentation says eight harnesses where it meant eight, and `docs/architecture.md` states the five harnesses the guidance layer applies to (Claude Code, Codex, Gemini CLI, Kiro and Antigravity).

### Added

- Guard G22 (`test/guards/skill-caps.test.js`) enforces the skill size caps: a skill's `description` plus `when_to_use` at most 1,536 characters, each `SKILL.md` at most 20,000 bytes with `## Boundaries` starting by byte 19,000, and each workflow's skills at most 100,000 bytes in total (estimates at 4 bytes per token). Each assertion has a control that proves it can fail.

### Fixed

- The dispatch guard (G9) built its archetype pattern with a `.md` suffix that skills never write, so it matched nothing in any skill; it now matches the bare names and has a control.
- The loaded-context rails are unchanged and every class measures lower: `feature` 221,311 of 225,000 bytes, `review` 38,192 of 42,000, `dependency-change` 81,609 of 85,000.

## [1.14.1] - 2026-10-05

### Changed

- Skills and agents write clean context. `ARTIFACT_VOICE.md` gains a "Dead context" rule: a status section states only what is true now and is rewritten in place, a resolved blocker or finished phase leaves the page, a fact lives in one artifact that others cite, and an agent's report holds outcomes, evidence locators, deviations and open questions without restating the brief. The state template, the `state.md` step of `/do-execute-plan` and the five agent specs carry the same rule; the specs gain a one-line "Hand-back" section. The loaded-context rails are unchanged (the `feature` class measures 224,670 bytes against its 225,000 rail).

## [1.14.0] - 2026-10-05

### Added

- Four runtime verbs keep what a feature leaves behind: `followup`, `lifecycle`, `goal` and
  `failure`, reached through `doflow-run <verb>` (and `doflow <verb>`). They are available wherever
  the DoFlow runtime is installed, which is the Claude Code, Codex and Gemini CLI targets today.
- `/do maintain` in the `do` skill walks every open report, follow-up and (inside the DoFlow
  repository) captured failure, and settles each with the user's answer: keep, dismiss, promote,
  start a fix, or done with evidence. It adds no skill and no task class, and edits no source file.
- A project follow-up list. `followup --action add|list|take|settle|promote|report` records what a
  feature deferred, with its source (the feature and stage, a run, a release, a report or a manual
  entry), a state (`open`, `taken`, `done`, `dismissed`) and the date added. Discovery
  (`do-brainstorm`) shows the open follow-ups before it asks a question; `lifecycle --action init`
  tracks the new feature and takes the chosen items; a taken item shows `done` once its feature is
  finished. `promote` turns items into a new intent under `agent-docs/intent/` and never touches an
  existing one. The handoff step records each deferral in the same step with
  `followup --action add --stage <stage> --statement "<one line>"`, taking the feature from the
  branch; an installed runtime finds the helper that resolves it next to the runtime. On a branch
  whose feature has no folder, such as a bug or refactor run, the call writes nothing, exits 2 and
  asks for `--slug <feature>` or `--source run --task-class <class> --task-id <id>`.
- The lifecycle store. One write-once JSON file per change under `agent-docs/lifecycle/events/`
  at the repository root (the first real working tree, so linked worktrees share it). There is no
  marker file: every read folds the events in time order, so two clones holding the same files agree.
  Feature status (`in-progress`, `awaiting-release`, `finished`) is derived from git on every read
  and is never written. A read costs a fixed number of git processes, not a number per feature.
  Measured by the implementer at 25, 100 and 300 features: about 22 git processes for the overview
  and 30 for a preview behind the tip, independent of the number of features. Counted from Node
  alone, a call starts 6 git processes for the overview, 16 for a preview behind the tip and 8 for
  a preview at the tip, at any number of features. The overview prints the newest 10
  finished and awaiting-release features with a count of the rest; `--json` keeps every one.
- Release detection. `lifecycle --action release --tag vX.Y.Z` previews the tracked features a
  release ships and writes nothing; after the tag exists, `--confirm` records the release locally, which
  finishes those features and the follow-ups they took. `--feature` adds a feature git could not
  detect and `--exclude` removes one. `lifecycle --action status` shows one feature's derived status
  and `lifecycle --action merged` records a merge git cannot show. The release ritual previews it.
- Reports. `followup --action report` files a product problem as a follow-up. The full body stays on
  this machine, masked and capped at 1 MiB, under `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/reports/`;
  the project store keeps only the id, a masked 2 KB excerpt and the size.
- Goals. `goal --action add|item|check|link|list|done` keeps one outcome and its checklist as
  DoFlow's own record, independent of any harness command of the same name. A feature may serve one
  goal and none has to. The agent proposes that a goal is done when every item is met; only a user
  channel (`question`, `gate`, `prompt`) closes it, and a goal with unmet items needs a reason.
- Machine-local failure capture. When a DoFlow command ends in an internal error (a programming
  error, a system error with a code, an escaped throw), the dispatcher crashes, or a guard hook
  fails open because its own install is broken, one masked line is appended to
  `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/failures/events.jsonl`. `failure --action list` folds the lines
  into entries by fingerprint (new, regressed, noise, fixed, imported); `settle` records a verdict,
  and in the DoFlow repository `--as imported` makes a follow-up. Capture is on by default; turn it
  off with `failure --action capture --set off` (creates an `off` file) or
  `DOFLOW_FAILURE_CAPTURE=off` (the file wins over the variable). Nothing is sent anywhere.
- `do-git-state.sh --lifecycle` reports the integration ref, feature branch prefixes, release tags
  and base tag for the lifecycle verbs, so bash and Node resolve them one way.
- What you need to know:

  - DoFlow never stages, commits or pushes `agent-docs/lifecycle/` or `agent-docs/intent/`, and writes
    no `.gitignore`, `.gitattributes` or `.git/info/exclude` rule for them. What to do with the folder is
    the user's decision.
  - Failure capture and report bodies stay on the machine that produced them. No part of this feature
    makes a network call. The verbs run local `git`, and `bash` for DoFlow's own `do-git-state.sh` and
    `do-paths.sh` helpers.
  - Stored text is shown print-safe. A follow-up, goal or failure line can come from another clone or a
    hand edit, so control characters (terminal escapes included) and bidirectional marks in it are shown
    as U+FFFD and line breaks as a space, both in the JSON a verb returns and in each printed line; a
    report excerpt keeps its line breaks in JSON. Nothing stored is changed.
  - The verbs treat a repository's files as untrusted. An event file is read only when it is a regular
    file of at most 256 KiB, never through a symlink, FIFO or device, and anything else is listed as
    unreadable with the reason; a symlinked `agent-docs/lifecycle` or `events` folder is refused with
    exit 2. Writes to the store take a lock. `--batch` and `--file` read only regular files of at most
    16 MiB. A report body has terminal escape sequences removed and is cut to a bounded size before it
    is masked. A FIFO or other non-regular file where a failure file should be is skipped by every
    capture writer and listed by `failure --action list`, so it never hangs a command or a hook. The
    project label in a failure line written by the Node CLI or the hook runner never carries the home
    path, whichever way home is spelled.
  - Nothing in the loop blocks an edit, a write or a commit, and capture never changes a command's
    output or exit status.
  - The loop runs on the Claude Code, Codex and Gemini CLI targets, which carry the runtime. On the
    other five targets the skills read but `doflow-run` is not projected, so the lines do nothing there.
    Extending the runtime to them is recorded as a follow-up.
- Known limits:

  - A merge git cannot show is not detected as shipped: squash merges, rebase then fast-forward, plain
    fast-forwards and cherry-picks give no evidence. They appear under `notDetected` in the release
    preview and are added with `--feature <slug>` or confirmed with `lifecycle --action merged`.
  - Release detection and pre-release tags: an unrecorded pre-release tag such as `v1.0.0-rc.1` can take
    its features out of the final release, and recording a release after a later tag exists credits the
    features to that later tag. The rule is not settled.
  - Masking is best-effort, not a guarantee. A random 40-character key that starts with `/` can stay
    unmasked (about 0.6% of such keys), and forms such as `curl -u user:pw`, `mysql -psecret` and
    `password hunter2` can survive into a one-line statement or an excerpt. The machine-local report body
    is the protection for what a report carries.
  - The lifecycle events folder has no compaction step and grows with use. A feature folder that exists
    only in a linked worktree is not tracked. An orphan report body is left if the process dies between
    the body write and the event write.
  - Goal checklist ids (`C1`, `C2`, ...) are numbered on each clone, so two clones adding an item at
    once can pick the same id. The first in event order wins; the other is shown under the goal's
    conflicts, with its text and a line saying how to add it again.
  - The bash failure writers (the dispatcher and the hook helper) only append and never rotate. The
    failure file is rotated the next time a Node writer or `failure --action list` runs.
  - `failure --action settle` appends to `settlements.jsonl` with a plain append, so a FIFO placed at
    that path blocks the settle until something reads it. Capture and every listing are not affected.
  - The bash failure writers write `~` only for a working directory under `HOME` as spelled; with a
    symlinked `HOME` or `HOME` unset they store the path as it is.
  - What ran on the Codex target: a real install into a scratch home, with the lifecycle verbs run through the
    projected Codex dispatcher and the release, report, goal and failure verbs run through the installed
    runtime. The Codex CLI itself and any model were never invoked, and no Gemini target run was made.
    Untested: a model driving the verbs on any target, and a project whose `v*` tags mix pre-releases.

### Changed

- `/do-execute-plan` no longer runs the per-phase quality review by default; pass `--review` to run it
  (`--review=false` is gone). Documented in `docs/flags.md` and `docs/reference.md`.
- No older behaviour changes. A feature, workflow run or folder created before this release works
  as under 1.13.0, and its earlier follow-ups are not collected. An end-to-end test extracts the
  v1.13.0 runtime with `git archive`, runs the chain verbs against it and against this checkout's
  runtime, and requires the same bytes apart from time and generated ids; it skips, naming the
  tag, when the `v1.13.0` tag is not in the clone. It compares the checkout, not an installed copy.
- `git-state --next-version` now takes its base tag from one shared function, `find_base_tag`, which
  the lifecycle output also uses; the proposal it prints is unchanged.
- The loaded-context rails in `test/guards/context-budget.test.js` were raised for the new guidance
  lines: the `feature` class from 224,000 to 225,000 bytes (the overview and init lines in
  `do-brainstorm` and the follow-up line in the handoff step) and the `documentation` class from
  56,000 to 57,000 (the handoff line). The always-loaded guidance did not grow.
- `src/runtime/cli.js` and `src/runtime/cli-result.js` usage helpers take an optional error so a
  programming error caught on a usage path is captured; the usage output and exit status are unchanged.

## [1.13.1] - 2026-10-03

### Fixed

- The shared Bash safety policy (`pre-bash-guard`, used by the Claude, Codex, Gemini and Kiro
  targets) no longer blocks a recursive delete of a path under `/tmp`, `/private/tmp` or
  `/var/folders`. It blocks recursive `rm` only when a target is the filesystem root, the home
  directory (`~`, `$HOME`, `${HOME}`) or a system directory (`/Users`, `/etc`, `/usr`, `/var`,
  `/private` and similar), in any flag spelling (`-r -f`, `-fr`, `--recursive --force`).
- Text inside quotes or a comment that merely mentions a dangerous command, such as a commit
  message or an `echo`, no longer trips the guard; a command run through `bash -c`, `sh -c`,
  `eval`, `$(...)` or backticks, including inside double quotes, is still checked.
- The normal pattern mode and the built-in fallback now apply the same recursive-`rm` rule,
  including after `sudo`, `env`, `command`, `time`, `nohup`, `xargs`, a pipe or `&`.
- The guard's cost no longer grows with the size of the command: an 800-line heredoc takes about
  90 ms, not 13 s.

## [1.13.0] - 2026-10-03

### Changed

- Features with a decision register keep their task records (evidence, claims, research, outcome,
  retrieval plans and context packs) in a per-feature folder, `.doflow/state/<store>/<slug>/`, so
  two features that use the same task id no longer read each other's records. The task-store verbs
  accept `--slug`. Features without a register keep the flat layout. **A feature that already had a
  register under 1.12.0 no longer reads the flat records it wrote before this release.** Those files
  stay on disk untouched.
- For features with a register, `verify`'s change-scope tier is now bounded by the files the plan's
  tasks list plus the feature folder, measured from the merge base with the integration branch.
  A changed file outside that bound fails the tier, so `verify` exits 1; nothing is blocked from
  being written or committed. Paths under `.doflow/` never count. Features without a register keep
  an unresolved change-scope tier.
- `git-state --next-version` takes its base from the highest `v*` tag merged into HEAD or into the
  production branch (local or remote-tracking), so a release tagged on a `main` merge commit is
  found from `develop`. The result gains a `warning` key when `package.json` disagrees with that
  tag.

### Fixed

- Every verb that takes a feature slug, in the runtime and in the bash helpers (`paths`, `prereqs`,
  `validate`, `render-audit`, `task-brief`, `parallel-check` and the rest), refuses one that is not
  letters, digits, dot, underscore or dash (starting with a letter or digit, no `..`) with exit 2
  and `{"error":"invalid-slug",...}`, before reading or writing anything. A slug derived from the
  branch names the branch in the message. An explicit `--slug` that names no feature is noted on
  stderr.
- `decision --action compact` attempts every artifact and reports the ones it could not compact in
  `failed[]`, with status `partial`, instead of stopping at the first. An unclosed fence or comment
  after the History section no longer refuses compaction.
- `validate` no longer reports a decision id inside a URL, a link target, a query string or a file
  name as stale or unknown; ids joined by `/` in prose are still checked. With a register, headings
  and checklist lines inside fenced examples are ignored.
- `decisions.md` escapes backslashes in a statement, so each decision renders as one table row.
- Handoff guidance: the decision step drops reworded copies of live decisions, fixes an `unknown`
  finding from the live list, and runs in `do-implement` on every run and on `do-flow`'s
  clarification path.

## [1.12.0] - 2026-10-03

### Added

- Decision register for features: `doflow decision` (`init`, `add`, `list`, `compact`) records every
  decision made during a feature in `decisions/register.json`, with `decisions.md` showing only the
  current decision per topic and `decisions/archive.md` keeping superseded decisions and rationale.
- Stage handoffs compact the History sections of requirement, design, specs, data-model and plan
  into `decisions/history/`, leaving a pointer, so later stages load current text only.
- `validate` reports `stale` and `unknown` decision references in features with a register; the
  resolver reports `decisions`, `decisions_register` and `has_decisions`; the context pack carries
  the live decisions.
- Chain skills register each stage's decisions before handing off, and `do-brainstorm` creates the
  register for new features. Features created before this release get no register and validate
  exactly as before.

## [1.11.0] - 2026-10-02

### Added

- Shared agent archetypes inherit the host's available tools, letting the orchestrator enable web
  and documentation MCP research tools according to each task's evidence needs.

### Fixed

- Markdown review recognizes agent definitions that omit a fixed `tools:` allowlist.

## [1.10.0] - 2026-09-29

### Added

- Feature stages can record conditional, source-linked external research requests without adding a workflow stage. Blocking unanswered requests prevent stage completion; research results remain tied to the feature task.

## [1.9.0] - 2026-09-27

### Added

- `doflow inventory` reports DoFlow's managed assets across the global and project scopes at once:
  it joins the copies that describe one logical asset, judges each copy's currency against what the
  current source would produce, names which copy a harness will actually load when two scopes hold
  one, and flags unmanaged files that a wholesale-loaded directory makes operative. A copy the
  report cannot judge is reported as unjudged rather than assumed current, and any finding the
  caller must act on produces a non-zero exit.

### Fixed

- `doflow list-backups` and `doflow restore` find backups again that were written before lifecycle
  metadata moved under `.doflow/`. The read path now covers the pre-`.doflow` root as well, while
  writes stay canonical, so a rollback is no longer silently empty on an install that predates the
  move.
- The cross-OS test suite reads a file mode portably. The previous BSD/GNU `stat` fallback ran both
  commands and concatenated their output, which failed every run of the suite since v1.7.0 and,
  because the release workflow gates publishing on it, silently blocked v1.8.0 through v1.8.3 from
  ever publishing.
- The documented-path guard no longer requires the two deliberately git-ignored `bench/` output
  directories to exist. It failed on every clean checkout while passing in any working tree where
  the bench harness had run.

### Changed

- `do-execute-plan`'s steps 3 and 10 moved into reference files, and dead code was removed along
  with the guard gaps that had let it stay unreferenced.

## [1.8.3] - 2026-09-18

### Changed

- Lifecycle backups and install metadata now live under the scope-neutral `.doflow/` root instead
  of a harness-specific directory. Native harness projections remain at their declared paths.

## [1.8.2] - 2026-09-18

### Fixed

- Codex `UserPromptSubmit` hooks now emit the native `hookSpecificOutput` envelope instead of the
  Claude-style top-level payload, preventing invalid user-prompt submit JSON.

## [1.8.1] - 2026-09-17

### Fixed

- `code_quality_checker.py` review-policy resolution (`load_policy`, the three-tier
  `review-policy.json` merge) is restored after an unreleased regression; `--json` output
  reliably carries the `policy` block again.
- The SessionStart hook (`session-context.sh`) no longer crashes on a repository with zero
  commits: `git log | jq -R . | jq -s .` piped through a trailing `|| echo "[]"` fallback could
  double-emit `[]\n[]` under `pipefail`, which `--argjson` rejected. The commit list now builds
  from captured output in a single `jq` call.

## [1.8.0] - 2026-09-16

### Added

- Chain artifacts now carry governed diagrams, with `doflow-run render-diagrams` as an optional
  seam that renders a fenced Mermaid block to an image without touching the committed Markdown.
  `DIAGRAM_GUIDE.md` sets per-type node and edge ceilings measured against a real corpus rather
  than chosen for roundness, and `render-audit` regenerates `audit.md` from the orchestration
  journal. The renderer is an optional dependency DoFlow never installs: absent, the verb reports
  how to obtain it and exits 0, because a missing optional capability must not read as a broken run.

- A feature may now author its C4 diagrams in PlantUML under `design/c4/` and have them projected
  into `design.md` §2, via `doflow-run render-puml` and the new `plantuml` external tool. The
  projection is lossy by design and refuses rather than degrades: a macro outside the recognized
  set — 20 element, 4 boundary and 18 relationship macros, verified against PlantUML 1.2026.8
  rather than transcribed from its docs — stops the projection naming the macro, file and line,
  because a skipped macro would emit a diagram carrying fewer elements than its source with nothing
  revealing the loss. Authoring C4 this way is opt-in per feature; a feature without `design/c4/`
  writes §2's Mermaid by hand exactly as before.

## [1.7.0] - 2026-09-14

### Added

- `doflow install` now says when an MCP selection is unchanged from the one already recorded. The
  same line was printed whether the selection came from an explicit `--mcp`, from the manifest, or
  from a genuine change, so a redundant `--mcp` was indistinguishable from a load-bearing one and the
  flag read as required when it is only ever an override. The resolution order is unchanged —
  explicit `--mcp`, else the recorded selection, else none on a first-ever non-interactive install —
  and so is what gets installed; only the output admits the flag did nothing. The note requires a
  *recorded* selection rather than merely an unchanged one, because a first-ever install whose
  selection happens to equal the whole catalog is also "unchanged" against that baseline and has no
  record to be unchanged from.

## [1.6.0] - 2026-09-14

### Added

- `doflow install --adopt` records ownership of a resource that exists with no ledger record, instead
  of refusing it. Codex's three native components — config entries, agent files and `hooks.json` —
  each refused such a resource and consulted no flag, so a tree written before the neutral ledger
  existed had no way back into management: the condition blocking the install was the condition an
  install had to run to clear, and `reconcile`, written to heal ownership drift, is refused by the
  same gate. `--adopt` is orthogonal to `--force` rather than a stronger form of it — adopt answers
  "there is no record", force answers "the record disagrees" — and the two compose. A codex dry-run
  decomposes cleanly across them: 28 conflicts with neither flag, 7 with `--force`, 21 with
  `--adopt`, 0 with both. Adoption never overrides a record that contradicts the bytes on disk; that
  stays a conflict.

### Changed

- `core-implementer`'s agent specification gains a seven-rung laziness ladder, the root-cause rule,
  and the working rules on unrequested abstractions and deliberate simplifications. The spec said
  what the agent is for and would not do, but nothing about how much code to write. The climb runs
  after understanding the problem, never instead of it: the smallest change in the wrong place is a
  second bug, not a small diff.
- `do-diagnose`'s complexity example drops its LaTeX delimiters. Agent specifications are handed to a
  subagent as plain prose with no renderer, so the Unicode superscript is the correct form and the
  skill was the outlier; both occurrences in the shared tree now agree.

## [1.5.2] - 2026-09-10

### Fixed

- `--force` was parsed, threaded onto the lifecycle view and into its adapter context, and consulted
  by `planTree`'s conflict predicate — while six of the eight adapters omitted it from their own
  `planTree` call. `planTree` declares `force = false` as a parameter default, so those calls silently
  received `false` in place of the user's flag, and nothing errored because a missing optional
  argument is legal JavaScript. The effect was that `doflow install --force` could not clear a single
  conflict on claude, opencode, pi, kiro, copilot or antigravity, leaving no supported path to
  reinstall over a tree whose ownership records had drifted — `reconcile`, the command written to heal
  exactly that drift, is refused by the same gate. Forwarding now follows the codex form,
  `!removing && context?.force === true`: force heals drift on apply, and a hand-edited file is never
  deleted on removal, forced or not. `antigravity` additionally needed `force` threaded through
  `planTrees`, whose signature did not carry the context the other adapters already had.
- `gemini` forwarded `force` ungated, handing it to the remove path as well. It was one of only two
  adapters forwarding the flag at all and so read as the reference implementation; the guard added
  with this fix found it. That defect predates this change and would have outlived it.

## [1.5.1] - 2026-09-10

### Fixed

- Five declared closed sets — `RUN_STATES`, `EVIDENCE_STATUSES`, `POLICY_STATUSES`,
  `RESOLUTION_REASONS` and `DERIVATIONS` — were frozen, exported and read by nothing, while every
  value they govern was written as a bare literal: documentation shaped like enforcement, and a
  second source of truth nothing reconciled against the first. Each is now consulted where its own
  module's risk lies. A typo in a run-state write produced a run that silently stopped responding to
  stage completions, since every branch tests `!== 'RUNNING'` or `=== 'COMPLETED'`. A registry status
  outside the policy set was carried onward as though it were real — that value is the one
  `renderPolicy` does not compute. An unrecognised evidence status read from disk had no safe
  default, because treating it as active would un-retire superseded evidence back into readiness and
  treating it as superseded would retire evidence nobody retired, so it is now refused by name rather
  than guessed at. An undefined resolution reason rendered identically to a defined one, hiding a
  resolver defect as a fact about the file. And a misspelled command derivation degraded into "not
  declared" without failing.

## [1.5.0] - 2026-09-10

### Added

- `doflow indicators` — workflow indicators derived from the orchestration record, exposed
  through both dispatch layers. Reports per-stage latency, gate waits separately from machine
  time, stage outcomes, backfilled stages and rerun counts, grouped per task class, and states
  in its own output what it cannot measure. Deliberately not folded into `stats`: a run-ledger
  record names no task, stage or class, so the question is not answerable from that file.
- Pre-branch intent: discovery reads an intent document when given its path, with a shipped
  template and the convention documented. Intents are unnumbered and sit outside the feature
  directory — an intent never built would consume a feature number and leave a gap.
- Review policy resolved from three tiers, with a generated `review-policy.json` artifact and a
  fallback to the working directory when the target resolves no policy. The prose points at the
  policy rather than re-transcribing its thresholds, and a guard prevents re-transcription.
- The evaluation corpus under `bench/` is tracked again, with its guard restored and a `parity`
  command gating the committed baseline against the committed corpus.
- Offline validation for `bench/native`, which its README already claimed existed — including the
  assertion that every case starts from a fixture that fails its own checks, since a case whose
  fixture already passes cannot measure anything and reads as a genuine PASS in a live run.

### Fixed

- The upstream format-drift watcher had been deleted while its scheduled workflow still invoked
  it. Restored, plus a guard that every `npm run` reference in a workflow resolves in
  `package.json` — one check that would have caught three separate instances of this class.
- A bench assertion-scope mismatch silently failed 15 shipped assertions across four skills
  whenever a run produced artifacts but no transcript. The gate was narrowed by scope rather than
  removed.
- `leak-scan --path <directory>` read no file yet serialized `findingsCount: 0` and exited 0 —
  indistinguishable from a genuinely clean scan for the JSON consumer. The report now carries
  `scannedCount` beside it.
- A tool-lifecycle wrapper could plan and execute an install in a single call, bypassing the
  confirmation `doflow tools` requires between the two steps. Removed; nothing called it.

### Changed

- `docs/capability-map.md`'s generated regions are compared against the registry cell by cell
  again. The generator, its npm script and the byte-for-byte guard had all been deleted while the
  `BEGIN/END GENERATED` markers stayed, leaving two regions of a shipped page announcing
  themselves as machine-written while hand-maintained with nothing checking them. The comparison
  is restored without restoring the generator.
- `docs/refactor-plan.md` is marked a historical record rather than open work, and records that
  its stage numbering runs 1–5 then 7.
- Guidance no longer tells readers to invoke a runtime helper by name; the seam's `validate` verb
  takes the same flags and the helper is not on `PATH`.

## [1.4.0] - 2026-09-08

### Added

- `design.md`/`specs.md` split into three chain artifacts — `design.md` (ADR-style narrative),
  `specs.md` (interface contracts only), and new `data-model.md` (entity/data model plus
  sequence/data-flow diagrams) — with `plan.md`'s path flattened from `plan/plan.md` to the
  feature root for newly-scaffolded features. `do-design` and `do-plan` read/write the new
  layout; guards and the chain-test fixture retargeted to it.

### Fixed

- The evidence ledger had no way to retire a stale item, so a task's own later implementation
  stage editing files its earlier discovery/design evidence described could permanently block
  `readiness` from ever returning `READY` again. Added `evidence --action supersede`, mirroring
  `claims.js`'s existing `retract`/`supersede`.

## [1.3.2] - 2026-09-07

### Fixed

- `orchestrate complete-stage`/`handoff` silently dropped `--invariants` at both the CLI dispatch
  and the internal readiness closure, unlike the standalone `readiness` verb which already
  forwarded it. No shipped skill was blocked by this (`invariants_captured` accepts `--scope` as
  an equally valid documented substitute), but a caller stating invariants specifically had that
  value discarded rather than recorded.

## [1.3.1] - 2026-09-07

### Fixed

- `do-implement` never recorded its own orchestrated stage completion, permanently blocking
  `bug`/`refactor`/`dependency-change`/`trivial-edit` workflow runs at the `implementation` stage.
  `do-brainstorm` and `do-execute-plan` migrated their remaining hand-rolled
  catch-up/complete-stage/annotate sequences onto the `handoff` API introduced in 1.3.0.

## [1.3.0] - 2026-09-07

### Added

- Evidence items can declare `establishes` (which readiness requirement they satisfy) and a typed
  `observation` (`{command, exitCode}`); claims can declare a `role` (e.g. `root-cause`). Kind
  alone no longer satisfies a readiness requirement.
- `readiness` and orchestrated stage completion take `--mode workflow|standalone`; every report
  carries a `stageEntry` decision (`ENTER`/`GATHER_FIRST`/`ASK_USER`/`STOP`) computed once by the
  runtime instead of re-derived per skill.
- `orchestrate complete-stage` takes `--result passed|failed`. Stage nodes record
  `executionStatus` (`completed`/`imported`) separately from `outcome`, so a stage `catch-up`
  backfills can never imply a verification nobody ran.
- New `orchestrator.handoff()` runtime call collapses the classify → catch-up →
  complete-stage/annotate sequence several skills previously spelled out by hand
  (`WORKFLOW_HANDOFF.md`).
- The shared `pre-implementation-gate` hook accepts a normalized `doflow_event` envelope from an
  adapter that has already decoded its native event, alongside the existing per-harness parsing.
- Failing or truncated verification checks persist their full output under
  `.doflow/state/verification/logs/` (`logPath`) and extract failing test identifiers
  (`failedTests`) from the untruncated stream; a repeated command within one verification run
  executes once.
- `doflow doctor` opens with an effective-identity block: installed source version, project root
  and git identity, and which capabilities actually have an answering provider.
- Plugin manifest versions (Codex/Claude/Copilot) are now projected from `package.json` by
  `src/release/sync-plugin-versions.js`, wired into the npm `version` lifecycle.
- Chain-artifact conventions are declared once and their transcription is guarded.

### Fixed

- Evidence freshness is measured against current file content, not only Git commit/dirty state,
  and `readiness` and orchestrated stage completion now share one evaluation — the two could
  previously disagree on the same evidence.
- Evidence, claims, and the workflow run file persist through a locked, revisioned read-merge-write,
  closing a lost-write case where two overlapping writers could silently collapse to one; evidence
  and claim ids are collision-resistant across processes.
- Capability routing builds an argument vector for execution instead of an interpolated shell
  string, so a routed query can no longer be interpreted as shell syntax; Semble routing uses the
  MCP tool's actual `repo` parameter; `native.test` health reflects whether the project's own
  manifests declare a test command instead of always reporting healthy.

### Changed

- `npm test` now runs `node --test test/` directly. The `scripts/` wrapper tooling (test runner,
  capability-map generator, format-drift watcher) was removed along with its guard coverage;
  `docs/capability-map.md` is hand-maintained.
- Adapter-owned normalization (Codex's native-projection shape, Gemini's hook-trust computation)
  moved out of the shared adapter/lifecycle modules into each adapter's own code.
- The always-loaded guidance budget guard gained a companion check measuring loaded context per
  task class (skill entry plus references, summed per workflow), with per-class drift rails.

### Removed

- The bench-only worktree sandbox manager (`src/runtime/worktree.js`) and its guard coverage, no
  longer needed with the eval corpus staying untracked.

## [1.2.1] - 2026-09-03

### Enhanced

- **Skill Creator Optimization across 11 Core Skills:**
  - Hardened frontmatter `description` fields with pushy triggers and clear operational boundaries to eliminate model undertriggering.
  - Grounded prompts with "Explain the WHY" architectural rationale across `do`, `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-diagnose`, `do-document`, `do-flow`, `do-git`, `do-implement`, and `do-test`.
  - Added strict URL validation for deep web research citations in `do-document`.
  - Explicitly prohibited placeholder stubs (`// TODO: implement`) and mock exceptions in `do-implement`.
  - Enforced Mermaid flowchart rendering for C4 diagrams in `do-design` for universal viewer compatibility.
  - Verified against the quantitative benchmark suite (`bench/runner.js`) with 4 improved metrics and zero regressions.

## [1.2.0] - 2026-09-03

### Added

- **Structured feature trail for the chain:** `WorkflowOrchestrator.catchUp()` as the single mechanism every chain skill uses to position a run, backfill non-mutating stages, and disambiguate two-occurrence stages (`do-test` in bug/refactor) — replacing six bespoke, independently-buggy implementations. Splits `design.md`'s interface contracts into `specs.md`, and adds `render-audit.sh` to project the orchestration journal into `audit.md`.
- **Tiered lifecycle policies:** every `lifecycle.json` policy now carries a `tier` (`core` — must stay universal across every integrated harness — vs `enhanced` — best-effort per harness) instead of reducing to the cross-harness intersection.
- **Heredoc blanking in do-code-review's complexity analyzer:** shell/Ruby/PHP heredocs are now correctly blanked before complexity analysis, fixing false-positive complexity counts from prose inside heredoc bodies.
- **Always-on context7/sequential-thinking in do-brainstorm and do-design:** both skills now unconditionally consult context7 (library/framework/API references) and sequential-thinking (multi-step/cross-domain reasoning), gated only by their own trigger condition, never by a flag.

### Fixed

- Hardened the catch-up primitive's stage-id validation and terminal-state handling, closing regressions found across five rounds of review on the structured-feature-trail work.

### Changed

- Normalized the hook runtime into a harness-agnostic canonical policy library (`core/harnesses/shared/hooks/policies/`), with claude/codex/gemini/kiro front doors rewritten as thin dispatchers; consolidated remaining front-door duplication and fixed a shared-library install gap that left the new library unreachable in a real install.

## [1.1.1] - 2026-08-25

### Added

- **Design Template Scaffolding for Database Schemas:**
  - Added Mermaid `erDiagram` visual scaffolding to `core/shared/templates/doflow/design-template.md` under `### Database Schemas (ORM / DDL)` to illustrate entity relationships, keys (PK, FK, UK), and cardinalities at a glance.
  - Enhanced table definitions into a structured Table Catalog (Table, Purpose, Primary Key, Foreign Keys & Relations, Key Indexes, Schema / ORM File).
  - Updated technical scaffolding documentation in `core/shared/guidance/references/ARTIFACT_FORMAT.md` §7.
  - Added regression test guard in `test/guards/docs.test.js`.

## [1.1.0] - 2026-08-24

### Added

- Structure refactor (docs/refactor-plan.md, stages 1-5), behavior-preserving throughout — proven by a 16-cell byte-identical install matrix across all eight harnesses and both scopes:
  - Registry family renamed `core/registry/*.yaml` to `*.json` (hard cutover; contents were always JSON).
  - CLI extracted from the 1215-line `bin/doflow.js` monolith into `src/cli/` (nine command handlers behind one `COMMANDS` table; three duplicate adapter-registry constructions collapsed into `buildAdapterRegistry()`); new cli-boundary guard.
  - Harness path facts declared in `harnesses.json` (`{base, segments}` per scope) and resolved via `src/helper/harness-paths.js`; adapters keep only justified logic residue; new G-Paths guard probes real installs against declarations.
  - `docs/capability-map.md` registry-derived regions now generated by `npm run gen:capability-map` between managed markers; G8 flipped from cell-compare to render-diff-empty.
  - Upstream format-drift watcher: `npm run drift` fingerprints the evidence URLs behind every capability claim (87 claims / 59 URLs derived from the registries); weekly CI opens one tracking issue on drift; auth-walled claims stay issue-tracked via a default-deny allowlist.
- Opt-in installer flags: `--permissions` projects the destructive-command blocklist into OpenCode's `permission.bash` (derived from the single authored Claude deny list); `--statusline` projects `doflow-statusline.sh` plus the managed `statusLine` key for Claude Code.
- Antigravity native hooks: pre-implementation gate as a documented-contract shim under `.agents/hooks.json`, plus a Stop-event stop-check shim mirroring Claude's gate semantics onto the documented `{decision:"continue"}` contract (fail-open-always; optional transcriptPath); `hooks.antigravity` moves different -> supported.
- Copilot plugin manifest at `core/.plugin/plugin.json`: skills-only, fully truthful today (declarative component paths; `.plugin/` is the real check location). Pi packaging assessed and declined with rationale in docs/distribution-notes.md.
- Optional dense/rerank retrieval slots in models.json: registry-validated, routed through the existing PATH-probe seam; absent = byte-for-byte current behavior.
- Orchestrator context-modes + event-bus design spec (docs/specs/orchestrator-context-modes.md) — implementation staged in the spec.

### Fixed

- Antigravity removal never deleted copy-tree files (`runTreeChanges` routed removals through applyTree); verification now journals real deletions.
- Antigravity was not installable end-to-end: lifecycle policy mappings, dir-per-file agent layout, and adapter layout passthrough all landed.
- Registry truth corrections from official-docs research: copilot settings supported / plugin different, opencode agents supported, codex PermissionRequest prose.
- Windows CI leg: ~95 failures root-caused and reduced to one flaky spawn class (exec-bit gates refusing hook installs on win32 was a product bug; plus .gitattributes EOL normalization, USERPROFILE redirects, separator-tolerant assertions). Leg stays informational pending runner-variance diagnosis (#11).
- Release workflow parsed-fail on every branch push (`needs:` reached into a reusable workflow's internal jobs); fixed at the source.

### Changed

- Documentation site now uses the Dracula theme.

## [1.0.1] - 2026-08-22

### Changed — MCP selection defaults to none for non-interactive installs

- `doflow install` without `--mcp` and without a TTY now registers **zero** MCP servers (was: the
  full catalog). Third-party servers are opt-in; a notice names the flag. Interactive installs are
  unchanged (checkbox, pre-seeded with the catalog).
- A remembered selection that ends up empty stays empty across updates and catalog reshuffles;
  the full catalog is never silently resurrected.

### Added — MCP selection keywords

- `--mcp all` adopts the whole catalog; `--mcp none` persists an explicit empty selection.
  Keywords cannot be combined with server names or with each other.

### Added — control-plane capabilities

- Content-addressed object store (`src/state/cas.js`); `doflow.lock` — a
  resolved-selections pin written by install/update/remove with reviewable diffs
  (`src/state/lockfile.js`); ledger v2 (additive: v1 ledgers stay readable, writes carry a
  tombstone log); `models.yaml` registry shell (providers × roles).
- `doflow reconcile` converges observed state onto the lock pin — drift report,
  CI-friendly `--dry-run` (exit 1 on drift), `--json`, confirmed heal. Claim relocations journal
  tombstones; stale copies are swept only when bytes still match the last-verified fingerprint.
  Fixed two latent bugs: removal left empty directory skeletons; a forced update silently skipped
  hand-edited destinations instead of restoring them.
- `WorkflowOrchestrator` + `doflow orchestrate` — deterministic stage/gate
  state machine over the workflow registry; human gates pause runs; source-mutating gated stages
  evaluate live readiness (anything but READY refuses); optional stages skip with anchored gates;
  run journals survive process death.
- Structure-aware markdown chunker; content-addressed guidance index under
  `.doflow/index/` (incremental rebuild by sha256); `doflow retrieve` (BM25, lexical-only until a
  dense provider is declared); @import-derived graph expansion (`viaGraph`); golden hit@k eval gate
  in `npm test`.
- Provider tiers in models.yaml; `doflow model-role` resolves roles to ranked,
  availability-annotated providers (`--exclude` implements cross-family review).
- Eighth harness adapter — **Antigravity CLI** (`agy`): managed AGENTS.md section
  (project), skills at `.agents/skills`, shared agents, locator seam, MCP via `.agents/mcp_config.json`
  / `~/.gemini/config/mcp_config.json` with remote `serverUrl` rewrite. Global instructions and
  user-scope skills are intentionally out of scope (documented contradictions/shared-file hazards).
- Copilot CLI hook surface recorded as `different` with per-event payload-coupling notes —
  nothing projected until its stdin schemas are verified live.

## [1.0.0] - 2026-08-21

First stable release. The beta line closes here: semver orders 1.0.0-beta.8 below 1.0.0, so this
promotes that line rather than starting a new one.

### Added
- Shell, YAML/JSON and OpenAPI review dispatch in `do-code-review`, plus a `leak-scan` verb
  reporting DoFlow's own vocabulary in files that ship.
- Claim lifecycle verbs `retract` and `supersede`, so an obsolete conclusion stops blocking the
  readiness gate without anyone editing state JSON.
- `verify --plan-path`, making a feature plan's `doflow-verification` override reachable from the
  CLI for repositories with no build manifest.

### Changed
- **Evidence freshness is now evaluated, not merely stamped.** The read half of the mechanism had
  no production caller, so every recorded item stayed `FRESH` for ever and the claim status
  `invalidated` could not occur. Gates that passed on evidence whose files had since changed will
  now report it.
- Evidence locators are checked for resolvability at write time, not just for shape.
- `code_quality_checker.py` accounts for every file it walks and reports partial coverage rather
  than averaging only what it recognised.
- Analysers no longer count keywords inside comments or string literals, and `pr_analyzer`'s
  case sensitivity is declared per rule rather than applied to all.
- `git-state` promotes a pre-release instead of bumping past it, checks tag availability before
  proposing one, measures integration distance against the remote-tracking ref, maps task classes
  onto branch prefixes it can classify, and chooses its base tag by version rather than by commit
  distance — the two diverge after any merge, so a release ritual made the older tag win.
- The `scaffold`, `trace` and `verification` runtime modules are grouped into directories, and the
  repository root is computed in one place.

### Fixed
- Absolute home-directory paths removed from all 181 tracked files that carried them, with a guard
  covering the whole tree.
- Chain artifacts under `agent-docs/doflow/` are versioned; they were excluded by a rule written for
  bench output.



### Added
- `doflow claim --action retract` and `--action supersede` (with `--replaced-by`). An obsolete claim
  that turned `conflicted` used to leave a hard `BLOCKED` on the readiness gate with no way out
  except hand-editing state JSON. Both are additive terminal states: the statement and its evidence
  links survive, and a terminal claim is no longer re-derived from its evidence on the next read.
- `doflow leak-scan --path <file>…` — reports DoFlow's own process vocabulary (`FR-###`, `US#`,
  `agent-docs/`, chain artifact names) in files that ship. One implementation, two callers: the
  Claude Stop hook scans the turn's edited files, `/do-code-review` scans the reviewed set.
- `doflow verify --plan-path <path>` — the `doflow-verification` override block in a feature's
  `plan.md` was fully implemented but unreachable from the CLI, so a specs-and-scripts repository
  with no build manifest could not declare its own verification commands.
- `do-code-review` gains Shell (`languages/shell.md`) and declarative YAML/JSON/OpenAPI
  (`content-types/config.md`), with matching analyser paths. Declarative files deliberately report
  no complexity, function count or SOLID verdict — those readings do not exist for config data.

### Changed
- Evidence with `extracted` provenance is now checked for **resolvability**, not just locator shape.
  A locator naming a line past end-of-file, a missing file, or an absent symbol is refused at write
  time, naming what the file actually offers; one refused item still discards the whole batch.
- The readiness gate reports supporting evidence whose locator no longer resolves, kept distinct
  from *stale*, and appended to the verdict so it cannot be overwritten by it.
- `code_quality_checker.py` accounts for every file it walks. It previously enumerated only
  recognised extensions and dropped per-file errors before averaging, so a change of nineteen YAML
  files and two TypeScript files reported "Files Analyzed: 2" and a score from the two. Results now
  carry `files_skipped`, `skipped[]` with a reason each, and a `coverage` of `complete`/`partial`.
- `ReadinessEngine` takes `projectRoot` separately from `repoRoot`: the latter locates the readiness
  templates in the DoFlow install, and resolving another project's evidence locators against the
  install was wrong in every case where the two differ.

## [1.0.0-beta.8] - 2026-08-19

### Added

- **Universal harness integration (`013-universal-harness-integration`).**
  - Added official Google Antigravity plugin bundle (`core/.antigravity-plugin/`) packaging `plugin.json`, `hooks.json`, and `mcp_config.json`.
  - Built JSON stdin/stdout streaming lifecycle hook runner (`core/harnesses/shared/hooks/stream-hook-runner.js`) supporting `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop` hooks with sub-20ms latency and fail-safe fallback.
  - Added target aliases `antigravity` and `agy` in `src/install/targets.js` mapping to Gemini / Antigravity project-scoped root `.agents/` projection.
  - Unified `mergeHooks` in `src/helper/settings-merge.js` across Claude Code, OpenAI Codex, and Google Gemini / Antigravity to preserve custom user hooks on install.
  - Added full 4-role specialist agent persona matrix (`system-architect`, `core-implementer`, `quality-guardian`, `research-writer`) in `core/shared/agent-specs/`.
  - Added cross-harness test suite (`test/install/universal-harness.test.js`, `test/hooks/stream-hook-runner.test.js`) with 646 passing tests.

## [1.0.0-beta.7] - 2026-08-19

### Added

- **Runtime flow completion (`011-runtime-flow-completion`).**
  - Added `retrieval-plan` runtime verb (`--action declare|report`) supporting 4-state vocabulary (`RETRIEVED`, `EMPTY`, `UNREACHED`, `UNVERIFIED`) and cached per-provider freshness probing.
  - Added `outcome` runtime verb (`--action record|show`) with closed terminal state records (`COMPLETED`, `BLOCKED`, `ABANDONED`, `INCONCLUSIVE`), zero-evidence completion refusal, and workflow-learned terminal stage gating.
  - Wired readiness checks, standalone exemptions, and context-pack evidence compilation across all stage skills (`do-implement`, `do-design`, `do-plan`, `do-execute-plan`, `do-code-review`, `do-document`, `do`).
  - Added Guard G17 (`test/guards/verb-reachability.test.js`) asserting all 25 dispatcher verbs have callers or allowlist rationales.
  - Added capability router freeze and hook independence assertions (`test/guards/frozen-behaviour.test.js`).
- **Enhanced requirement & design templates (`012-enhanced-requirement-template`).**
  - Enhanced `requirement-template.md` with hierarchical user story headings (`### Story X.Y: Title (P#)`) in §2 and Gherkin BDD scenario checklist blocks (`Given` / `When` / `Then`) in §6.
  - Enhanced `design-template.md` with dedicated technical scaffolding for REST Endpoints, Repository Patterns (`interface` → `concrete` → `mock`), Database Table Schemas, and UX Design Tokens.
  - Updated `ARTIFACT_FORMAT.md` authoring rules with story hierarchy and technical anchor routing conventions.
  - Added automated guard tests in `test/guards/docs.test.js` validating template structures.

## [1.0.0-beta.6] - 2026-08-19

### Refactored

- **Backend modularization and subtractive cleanup (`010-refactor-backend`).**
  - Deleted 4 unreachable runtime modules (`retrieval-bridge.js`, `context-router.js`, `evidence-normalizer.js`, `benchmark.js`; `-683` lines); added executable module reachability guard G16 (`test/guards/module-reachability.test.js`).
  - Reduced `bin/doflow.js` (1528 → 1003 lines); delegated 8 runtime verb handlers to backing `src/runtime/*.js` modules with `src/runtime/cli-result.js` to eliminate cycles.
  - Relocated Codex and Gemini harness modules behind `src/adapters/codex/` and `src/adapters/gemini/`; extracted generic TOML parser to `src/helper/toml.js`; moved `lifecycle-view.js` to `src/lifecycle/view.js`.
  - Unified all 7 harness adapters with a uniform `create<Name>Adapter()` factory export.
  - Partitioned `src/` top-level namespace into `src/helper/` (cross-layer primitives) and `src/install/` (installer domains); `src/` top level now contains only directories.
  - Deduplicated hook verification into `src/adapters/hook-commands.js`.
  - Decomposed oversized runtime modules (`verification.js`, `scaffold.js`, `trace.js`) while strictly keeping ledger write atomicity in `trace.js` per G12.
  - Reorganized all 43 test files into domain module directories mirroring `src/` (`test/adapters/`, `test/lifecycle/`, `test/runtime/`, `test/registry/`, `test/state/`, `test/helper/`, `test/install/`, `test/e2e/`).
  - Added `docs/how-doflow-work.md` and registered it into MkDocs navigation.

## [1.0.0-beta.5] - 2026-08-19

### Added

- **`doflow-run`'s Node-CLI resolution now finds a working checkout without `npm link`.**
  `resolve_node_cli` walks up from `$PWD` (not only from the dispatcher's own location) and falls
  back to `$HOME/.doflow/runtime` when a project's local `.doflow/` exists but lacks a materialized
  `runtime/`. Two new diagnostics distinguish the remaining failure modes: `unlinked-checkout` (a
  `bin/doflow.js` found nearby, names `npm link` as the fix) and `stale-runtime` (a resolved
  `runtime/` copy that's drifted from the working tree, caught via its stderr rather than surfaced
  as a raw registry dump).

### Fixed

- **`/do-execute-plan` now actually writes `state.md`.** The cross-session execution record
  `MODE_Task_Management.md` already described was never instructed in `do-execute-plan/SKILL.md`
  itself — it read and wrote nothing. Step 1 now reads it on resume; a new step creates/updates it
  at every phase checkpoint.
- **`do-git-state.sh --next-version` no longer crashes on a semver pre-release tag.** A base tag
  like `v1.0.0-beta.4` left an unstripped `-beta.4` suffix in the patch-bump arithmetic, crashing
  with a bash `invalid arithmetic operator` error instead of returning JSON.

## [1.0.0-beta.4] - 2026-08-18

### Added

- **One runtime seam between skills and the runtime.** Every runtime call a skill can make now goes
  through a single dispatcher, `.doflow/scripts/doflow/bin/doflow-run`, which owns the whole verb
  namespace and decides per verb whether a shell helper or the Node CLI serves it. Skills never name
  a helper. A verb-free locator shim is projected into every harness's own `bin/`, so adding a verb
  never edits seven files.
  Skills reach the dispatcher by **walking up from the working directory** to the nearest
  `.doflow/`, then `$HOME/.doflow`, then exiting 2 with a message naming both. Not by a
  repo-relative path: a relative path in a shell command resolves against the user's project root,
  not the skill's directory, and an earlier attempt that assumed otherwise broke all 27 call sites.
- **The Node runtime is projected into `.doflow/runtime/`.** `bin/`, `src/` and `core/registry/` are
  installed alongside the dispatcher, mirroring the repository layout so the modules' own root
  resolution finds the registries unchanged. Without this, eleven verbs — `readiness`, `evidence`,
  `claim`, `verify`, `classify`, `workflow`, `scaffold`, `route`, `trace`, `capabilities`,
  `discover` — answered `cli-not-found` after `npx @khoavu882/doflow install`, because npx leaves no
  package behind and the install directory is not inside a checkout. Zero runtime dependencies;
  ~1 MB.
- **Task-class workflows with caller fit-checking.** `core/registry/workflows.yaml` declares nine
  classes — `feature`, `bug`, `refactor`, `review`, `research`, `documentation`,
  `dependency-change`, `operations`, `trivial-edit` — each resolving to ordered stages naming skills
  that already exist. A class is proposed by the model and validated against the registry; an
  unrecognised one is rejected with the valid set rather than coerced into a default. `/do-flow` is
  class-aware: a review enters no implementation stage, research requires no implementation
  readiness, and `documentation` sequences repo documentation authoring (`do-document` → `do-test`
  → `do-code-review`) without forcing code-editing pipelines.
- **Caller fit-checking on `doflow classify`.** `doflow classify --task-class <class> --calling-skill <id>`
  validates that the proposed workflow contains a stage for the calling skill, preventing silent
  workflow misalignments (e.g. `do-diagnose` running under `research` which lacks an analysis stage).
  Rejections report actionable hosting classes that *can* accommodate the caller. Calls omitting
  `--calling-skill` accept for backward compatibility while honestly reporting `fit.state: NOT_EVALUATED`.
- **A risk-scaled verification contract.** `core/registry/verification.yaml` declares nine check
  tiers selected by one of four risk levels, which also sets the recovery-retry bound. The contract
  is compiled and reported *before* anything runs; the verdict is produced after. A required tier
  that was never evaluated yields `INCONCLUSIVE` rather than a verdict invented over missing
  evidence.
- **An evidence ledger with a write path, and four reachable readiness states.** Evidence is
  appended in validated batches, claims are supported only through linked evidence, and readiness
  reports one of `READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED`.
- **`/do-execute-plan --scaffold`** turns requirement + design + plan into signatures, types and test
  stubs under `agent-docs/doflow/<slug>/scaffold/`, never touching the source tree. Idempotent,
  refuses to overwrite a hand-edited file, and reports what it skipped as prominently as what it
  produced.
- **A committed evaluation harness** under `bench/`: 33 cases across all thirteen skills, run in
  isolated git worktrees. Each run records the sha256 of the skill file it actually read, so a run
  that resolved the globally installed copy — which differs from source in 12 of 13 skills — is
  rejected rather than silently averaged in.

- **Four new install targets — GitHub Copilot CLI, Kiro, OpenCode, and Pi Coding Agent —
  reaching CLI-level parity with the existing Claude/Codex/Gemini targets.** `--target` now
  accepts `copilot`, `kiro`, `opencode`, or `pi` alongside the existing three, each with its own
  registry declaration, capability contract, and dedicated adapter:
  - **Copilot** writes `.github/copilot-instructions.md` (project only — Copilot documents no
    global instructions file), skills to `~/.agents/skills` / `.agents/skills`, custom agents as
    `.agent.md` files to `~/.copilot/agents` / `.github/agents`, and MCP servers to
    `~/.copilot/mcp-config.json` / `.mcp.json`.
  - **Kiro** projects the full DoFlow guidance tree as steering files under `.kiro/steering/`
    (workspace wins over global on a naming conflict), skills to its own dedicated
    `.kiro/skills/` / `~/.kiro/skills/` system (`SKILL.md` + frontmatter, the same open Agent
    Skills format DoFlow already authors), agents to `.kiro/agents`, MCP to
    `.kiro/settings/mcp.json`, and real hooks — `SessionStart`, `PreToolUse` (pre-implementation
    gate and MCP-tool guard), and `Stop` — with no trust-gating step, unlike Codex.
  - **OpenCode** and **Pi** now materialise their own skills trees (`~/.config/opencode/skills` /
    `.opencode/skills` and `~/.pi/agent/skills` / `.pi/skills` respectively) instead of pointing
    at Claude's, following the same copy-tree-and-marker-merge shape every other adapter uses.
- `doflow status` now reports hook-wiring status (`active` / `installed-pending` / `absent`) for
  every harness that declares hooks — previously this was hardcoded to Codex only.
- Two new registry guards enforce the "adding a harness" contract mechanically: a declared
  harness must have an adapter module, exactly one `contracts.yaml` entry, and a valid
  `--target` id, and must be wired into every adapter-dispatch call site — not merely exist on
  disk. Both guards were confirmed to actually fail by deliberately breaking the contract and
  reverting.

### Removed

- **The parallel Python runtime is deleted.** `compiler.py`, `doctor.py`, `doflow.sh`, and the seven
  runtime modules behind them are gone; JavaScript under `src/runtime/` is the only runtime. The two
  implementations were compared by executing both before anything was removed. `do-code-review`'s
  own analyzers are Python and are untouched.
- **`--contracts` is replaced outright by `--scaffold`** — no alias, no deprecation window. The old
  flag named a narrow cross-service behaviour; the new one is driven by the chain artifacts and
  writes only under the feature directory. `templates/doflow/contract-doc-template.md` is renamed
  `external-contract-template.md`, and its `contract-doc:` field to `external-contract:`.

- **The skill flag surface drops from 33 flag/skill pairs across 20 names to 18 across 14.**
  **This is a breaking change** to every skill's invocation surface. The removed flags are
  absorbed, not dropped — the behaviour each one requested now applies unconditionally or is
  derived:
  - `--validate`, `--trace`, `--iterations`, `--tools` and `--sync` are gone because readiness
    gating, run-ledger tracing, recovery bounds, capability routing and ledger-backed state are
    always on. There is nothing left to opt into.
  - `--type` on `/do-diagnose` is gone: the investigation mode *is* the task class, and the
    classifier settles it. `--focus` remains for narrowing to a domain within that class.
  - `--type` and `--coverage` on `/do-test` are gone: which tiers run, and whether coverage runs
    with them, follows from the risk-scaled verification contract rather than from the caller.
  - `--format` on `/do-design` is gone: `ARTIFACT_FORMAT.md` §4 already fixes the diagram and
    section shape of `design.md`.
  - `--strategy` on `/do-brainstorm` and `/do-plan` folded into `--depth`, which is now
    `shallow|normal|deep` on both — two overlapping breadth knobs on one skill.
  - `--next`, `--phase N`, `--all` and `--resume` on `/do-execute-plan` collapse into
    `--scope next|phase:N|all|resume`, and `--review`/`--no-review` collapse into `--review`,
    on by default, with `--review=false` to skip.
- **`core/shared/guidance/FLAGS.md` is no longer a flag list.** It is the always-loaded statement
  of what the runtime does unconditionally; `--focus` is the one flag it still documents, because
  it is the only surviving flag that is not local to a single skill.

### Changed

- **Readiness is a four-state contract, not a numeric confidence.** Every numeric-confidence output
  path is removed. A gate reports which prerequisites are unmet and why, rather than a score.
- **Guidance and skill prose were rewritten against a prompting guide** — contract before findings,
  planning separated from execution, broad-to-narrow retrieval, source separated from inference,
  retrieved content treated as untrusted, and an explicit stopping rule on every eliciting or
  retrieving stage. The rewrite removed 14 duplicated blocks and 22 contradictions; shared runtime
  facts now have one owner in `guidance/references/EVIDENCE_LEDGER.md` instead of six drifting
  near-copies. The always-loaded set went from 10,240 to 8,894 bytes against an unchanged ceiling —
  most of the saving was content that was wrong rather than merely verbose, including a rule
  recommending a tool that does not exist.

- **`doflow install`/`update` with no `--target` now installs Claude only, not all valid
  targets.** Previously the default expanded to every target `VALID` declared, which meant an
  install with no flag silently wrote configuration into harnesses the user may not even have
  installed. As the target list grows past three, that cost rises with every addition; ask for
  the rest explicitly with `--target claude,codex,gemini,...`. **This is a breaking change** for
  any script or workflow relying on the previous all-targets default.
- Corrected OpenCode's documented global config path from `~/.opencode/` to `~/.config/opencode/`
  across the README and docs — the former was asserted incorrectly for several releases and does
  not match what OpenCode itself reads.
- Regenerated the capability and hook-event matrices in `docs/capability-map.md` from the
  registry (5 columns → 7), and corrected a stale claim in its Codex-detail appendix that
  OpenCode and Pi "have no entry in the registry."

### Fixed

- **`doflow install` aborted with exit 0 having written nothing.** With no stdin the confirmation
  prompt auto-declines, so a script or CI step believed the install had succeeded. All four abort
  sites now exit 1 — a declined prompt is a decision, not a completed run.
- **`parallel-check` reported `parallel_safe: true` over collisions it had found or never looked
  for.** A plan whose tasks were not under a `### Phase` heading parsed to zero tasks and was
  therefore "safe"; separately, the flag ignored group-level collisions, so it could report safe in
  the same object that named the file two groups both write. Since callers are told to branch on
  that field and never on the exit code, either shape authorised concurrent writes to one file. It
  is now `null` when nothing parsed and `false` when either collision set is non-empty.
- **The verification report could not contain a failure.** Captured output was truncated to the
  first 2000 characters, and every runner worth verifying summarises at the end — a red suite
  produced a report holding 2000 characters of passing subtests and no failure trace. The tail is
  kept now, with a marked elision.
- **`--prune` silently accepted a bad value** (`parseInt(val, 10) || 0`, so `--prune notanumber`
  meant "no pruning") and is read only by `install` and `update`, though `--help` advertised it
  generally. It now validates like its neighbour `--days`, and the help says where it applies.
- **`do-paths.sh` kept the branch prefix for any branch outside six known names.** The arm meant to
  strip it matched only a name ending in `/`, which git refuses to create, so it never once ran —
  `task/x` yielded a slug containing a path separator, which nests the feature directory a level
  deeper than every other and is rejected outright by the evidence ledger.
- **`/do-brainstorm` never created the feature directory on the path it normally takes** — the
  `mkdir` sat inside the branch for a slug the user had just invented, so a branch-derived slug
  wrote into a directory that did not exist.
- **`remove --target <one>` reclaimed a shared tree another harness still owned**, leaving the
  others with dangling ledger records and, where a global install existed, a silent fallback to a
  different runtime.
- **`requirement-template.md` spelled the clarification marker inside its own text for the
  zero-questions case**, so a correct artifact matched the check that forbids the marker.

- `doflow status --json` silently omitted Copilot, OpenCode, and Pi from its output; every
  harness now reports.
- `doflow remove --target opencode` left a stale `"instructions": ["AGENTS.md"]` entry behind in
  `opencode.json` instead of unmerging it.
- `core/registry/lifecycle.yaml`'s four behavioural hook policies (session-context,
  pre-implementation-gate, mcp-tool-guard, stop-check) threw for any harness without an explicit
  mapping — a gap that affected OpenCode and Pi from the commit that first declared them, not
  just the harnesses added here.
- A second, separate adapter registry inside `src/lifecycle-view.js` (used only for planning, not
  for apply/remove) had silently never been extended past Claude/Codex/Gemini, so a fully wired
  new harness would still fail during dry-run planning even after every other wiring point was
  correct.

## [1.0.0-beta.3] - 2026-08-17

Release-candidate for 1.0.0. No functional change to the installer or the projected config from
`1.0.0-beta.2`; this closes the distribution and packaging gaps found in the v1 release review, so
that the eventual `1.0.0` tag is a version bump over a validated artifact rather than the first
time any of this is exercised. Ships as a prerelease on npm — `1.0.0` follows once the published
package and the tag pipeline are confirmed working end to end.

### Added

- **`LICENSE`** — the MIT terms `package.json` has always declared now ship as a file, so the
  license is verifiable from the repository and the tarball rather than only asserted in metadata.
- **npm publish metadata** — `repository`, `homepage`, `bugs`, `author`, `keywords`, and
  `publishConfig.access`, so `npm bugs`, the package page, and provenance attestation all resolve.
- **`.npmignore`** — npm stops consulting `.gitignore` once `files` is set, so backup and editor
  artifacts inside the whitelisted `bin/`, `src/`, and `core/` trees were shipping in the tarball.
- **`test/guards/package.test.js` (G7)** — asserts the published trees stay free of `*.bak`,
  editor, and bytecode artifacts, and that publish metadata and the `LICENSE` file are present.
- **`.github/workflows/release.yml`** — a `v*` tag now runs the full cross-OS suite and publishes
  a GitHub Release, so no tag can be cut from a commit that never passed CI.

### Changed

- Published under the scoped name **`@khoavu882/doflow`**; the unscoped `doflow` name on the public
  registry belongs to an unrelated package. Install is `npx @khoavu882/doflow install -g`. Beta
  builds publish to the `beta` dist-tag, so reaching this one is `npx @khoavu882/doflow@beta`;
  `latest` stays empty until `1.0.0`.
- Cross-OS CI now also exercises **Node 18**, the floor declared in `engines`, alongside Node 20.

### Fixed

- **Upgrade path from pre-consolidation installs**, broken in two places by the same root cause — a
  lifecycle plan computed from the current registry meeting state written by an older one. Both
  affected every installation predating `1.0.0-beta.2`:
    - `install` and `update` aborted with `Unknown registry MCP server(s): …` when the saved
      selection named a server the registry had since retired (`chrome-devtools`, `playwright`).
      The persisted selection is now reconciled against the current catalog and the drop reported;
      an explicit `--mcp` naming an unknown server stays a hard error, since that is a typo.
    - `remove` aborted with `Lifecycle verification failed; ledger was not updated`, leaving the
      configuration half-stripped, because the verifier looked for the 5 consolidated agent
      archetypes and flagged as `missing` the 4 that install had never created on that machine. A
      resource the ledger has no claim on is now an expected absence; one it does claim still fails.
- Removed a stale `bin/doflow.js.bak` (a pre-refactor copy importing the deleted
  `src/adapter-wiring` module) and a redundant `core/registry/harnesses.yaml.bak` — together 47 kB
  of dead weight in the `1.0.0-beta.2` tarball.
- Corrected the `1.0.0-beta.2` note that cited `bench/evals/run_50_loop.py`; those benchmark files
  were removed and the evaluation entrypoint is
  `core/shared/scripts/doflow/evaluation/benchmark_runner.py`.
- README no longer describes DoFlow as targeting three harnesses while its own support table lists
  five, and no longer names `security`/`root-cause` agents that the 5-archetype consolidation
  replaced.

## [1.0.0-beta.2] - 2026-08-14
### Added

- **Consolidated 12-Skill Taxonomy**: Consolidated 28 skills into 12 high-cohesion skills (`do`, `do-flow`, `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-test`, `do-code-review`, `do-git`, `do-constitution`, `do-diagnose`, `do-document`) using 3-tier Progressive Disclosure with modular `references/` directories.
- **Consolidated 5-Specialist Archetypes**: Streamlined 14 micro-agents into 5 core archetypes (`spec-analyst`, `system-architect`, `core-implementer`, `quality-guardian`, `research-writer`), yielding a 90% reduction in agent spec token footprint.
- **AI Engineering Control Plane**: Decoupled control plane providing vendor-neutral evidence ledger, claim provenance, and multi-tier verification sandboxes with native parity across Claude Code, OpenAI Codex, Google Antigravity / Gemini CLI, OpenCode, and Pi Coding Agent.
- **Portable Relative References**: Eliminated all machine-specific absolute file links across all skill definitions and references.
- ~~**Trigger Benchmark & Evaluation Suite**: Added a 50-epoch stress-testing benchmark verifying 100% trigger accuracy and zero collisions across all 12 skills.~~ **Retracted — this measured nothing.** The originally-cited `bench/evals/run_50_loop.py` was removed, and the replacement entrypoint named in 1.0.0-beta.3, `core/shared/scripts/doflow/evaluation/benchmark_runner.py`, returned two hard-coded result dictionaries and printed them under a "Benchmark Results" heading. No epochs ran, no trigger accuracy was measured, and no collision check existed; the "100%" and "zero" figures were literals in the source, and the skill count was 12 when 13 ship. Independently confirmed twice while porting the runtime (feature 008). A real harness now lives in `bench/` — see `bench/README.md` — with per-skill triggering and behavioural cases; it reports what it actually measured and is deliberately excluded from `npm test` because it makes paid model calls.

### Changed

- Reduced per-turn system prompt token tax by **68%** (from ~967 tokens to ~312 tokens).
- Updated all documentation in `docs/*`, guards in `test/guards/`, and test fixtures across the full test suite (348/348 tests green).

## [1.0.0-beta.1] - 2026-08-14
### Added

- **Evidence Ledger & Claims Model**: Runtime state tracking for hypothesis classification, supporting/contradicting evidence provenance, and task readiness contracts.
- **Cross-Harness Parity Compiler**: Deterministic single-source projection compiler projecting canonical guidance into `CLAUDE.md`, `GEMINI.md`, and `AGENTS.md`.

## [0.18.0] - 2026-08-14
### Added

- **Grouped implementer dispatch by phase and owner:** `/subagent-driven` now forms dispatch groups `(phase, owner)` via `do-parallel-check.sh`, reducing agent startup costs and prompt reloading overhead by executing same-owner tasks sequentially per subagent (FR-001, FR-002, FR-003, FR-004, FR-006).
- **New `--group` and `--no-group` flags and `--group` mode for deterministic helpers:** `do-exec-paths.sh` and `do-task-brief.sh` support `--group=<phase>:<owner> --tasks=<csv>` for composing single group briefs with shared preambles and ordered task blocks, while `--no-group` restores per-task fan-out (FR-007, FR-008).
- **New lifecycle intents for `/do-git`:** `start`, `save`, `sync`, `ship`, `release`, `hotfix`, `backport`, and `status` — cycle-aware git operations via deterministic helper scripts (FR-001, FR-010).
- **`do-git-state.sh`:** New deterministic helper with modes for branch classification (`--state`), version bump proposals (`--next-version`), propagation targets (`--propagation-targets`), repository fingerprinting (`--fingerprint`), and branch-name construction (`--branch-name`) (FR-002, FR-003, FR-004, FR-005).
- **Policy-based branching:** Deterministic resolver reports `branch_class` field with values: `feature`, `fix`, `release`, `hotfix`, `trunk`, or `other`. Release and hotfix branches now correctly yield `null` feature slugs (FR-006).

### Changed

- **Implementer dispatch grouped by default:** `/subagent-driven` dispatches one implementer per `(phase, owner)` group with run-start reporting of task-to-dispatch mapping; single-task brief and path contracts remain byte-identical (FR-005, FR-009, FR-010).
- `/do-brainstorm` delegates branch name construction to `/do-git --branch-name`; observable behavior preserved (same name for same slug, non-git root skips branch creation) (FR-002).

## [0.16.1] - 2026-08-03

### Fixed

- **`do-execute-plan`'s frontmatter description named the wrong orchestrator.** It read "pm-agent
  orchestration over named specialists," but the actual Behavioral Flow and Boundaries section
  have always delegated task execution to `/subagent-driven` — `pm-agent` never appears in the
  file's body. Corrected to name `/subagent-driven`.
- **`do-execute-plan` and `subagent-driven` each ran the same write-set precheck for the same
  phase before dispatch.** `do-execute-plan` step 7 called `do-parallel-check.sh --phase=<X>`
  immediately before delegating to `/subagent-driven`, which runs the identical check again in
  its own step 3 before fan-out — same script, same phase, same answer, twice. Removed the
  redundant precheck from `do-execute-plan`; `/subagent-driven` remains the sole enforcement
  point.
- **`do-execute-plan` re-derived `DOFLOW_CONFIG_DIR` via a ~10-line directory walk at two separate
  points in the same flow.** Steps 1 and 2 each contained a near-identical resolver block.
  Consolidated to one resolution in step 1, reused by every later script call in the file.
- **`confidence-check` asserted fabricated precision/recall/ROI figures** ("Precision: 1.000,"
  "8/8 test cases passed," "100% precision and recall in production testing") with no benchmark
  harness anywhere in this repo to back them — a direct violation of this project's own
  Professional Honesty rule. Replaced with an honest statement that no such harness exists.
- **`do-troubleshoot` restated the "never skip/disable tests" rule inline at two points** instead
  of citing `RULE_01_SAFETY.md`, the single source of truth `do-test` already cites for the same
  constraint. Consolidated to a citation; the enforced rule is unchanged.
- **`do-review-package.sh` could silently produce an empty review package.** A commit range whose
  `--base`/`--head` both resolve to real git objects but span zero commits — e.g. from a single
  mistyped character in a base SHA that still happens to name some other real commit — wrote a
  syntactically valid but semantically empty package file instead of failing. A reviewer
  dispatched against it would see nothing and could report false "no changes, all clear." The
  script now exits 2 with an `empty-range` error and writes no file when the resolved range has
  zero commits. Added regression coverage for the new guard in `test/doflow-chain-test.sh`.

## [0.16.0] - 2026-08-03

### Removed

- **`--type feature` removed from `/do-document`.** Use `--type impl` instead — generates a narrative implementation summary (what was built, key decisions, deviations, changed surfaces) rather than the removed type's flow diagrams.

### Changed

- **`subagent-driven` reviews a phase as a unit, not each task in isolation.** Implementer dispatch is still per-task, but review now waits until every task in a phase reports done, then one reviewer covers the phase's whole diff — catching inconsistencies between parallel tasks in the same phase that per-task review structurally couldn't see. `do-execute-plan`, `task-reviewer-prompt.md`, and `re-review-prompt.md` updated to match.

## [0.15.0] - 2026-08-02

### Added

- **External-tool lifecycle management for RTK and Graphify.** `doflow tools` now inspects,
  installs, updates, or uninstalls the supported tools through evidence-backed registry contracts.
  Every external lifecycle command is displayed and confirmed individually; failures preserve
  independent processing and return a non-zero process result. Graphify uses an existing `uv`
  prerequisite, which DoFlow explains but never installs automatically.

## [0.14.0] - 2026-08-02

### Fixed

- **The dangerous-command guard (`pre-bash-guard.sh`) silently failed open on stock macOS.**
  `blocked-patterns.conf` and `mcp-tool-guard.sh`/`stop-check.sh`'s pattern matching used PCRE
  syntax (`(?:...)`, `\s`, and one true negative lookahead for `git push --force`) that BSD `grep`
  (macOS's default, non-interactive) cannot run — the guard's own PCRE-availability preflight
  detected this and printed a warning, then allowed every command through unfiltered, including
  `wget url | bash`, `chmod -R 777`, and `rm -rf $HOME`. All patterns are now POSIX ERE, portable
  across GNU grep (Linux, Windows Git Bash) and BSD grep (macOS) with no capability gap. A related
  scoping bug in the force-push guard's negative-lookahead workaround (an unrelated
  `--force-with-lease` occurring anywhere else in the command string disabled the block entirely)
  was found and closed in the same pass.
- **Session-log trimming and git-context hooks silently broke on macOS.** `realpath -e`, `flock`,
  and bare `timeout` are all GNU-only or Linux-only; on stock macOS the first silently degraded to
  an uncanonicalized path, the second is absent entirely (disabling `session-end.sh`'s log-trim
  block permanently), and the third simply doesn't exist without Homebrew coreutils. Replaced with
  portable equivalents (`cd -P`-based canonicalization, `mkdir`-based locking with stale-lock
  recovery, a GNU-verified `timeout`/`gtimeout` cascade with graceful no-budget fallback) across
  all three harnesses' `lib.sh`.
- Four additional pre-existing portability bugs found while validating the new CI workflow
  locally: `do-paths.sh` aborting under bash 3.2 on an empty candidate-slug array, a `jq` compile
  error in `do-parallel-check.sh` (OS-independent — this one broke every platform), a BSD-awk
  rejection of a multi-line `-v` assignment in `sync-context.sh`, and a BSD-`mktemp` template
  incompatibility in `test/verify-hooks.sh`.
- `test/guards/consumers.test.js` didn't recognize a skill's own `references/` subdirectory as a
  valid resource location, only the shared guidance tree — any skill-scoped reference file always
  reported as a dangling consumer reference regardless of whether it existed.

### Added

- **Windows support (Git Bash/MSYS2) for the bash script/hook layer.** `core/shared/scripts/doflow/bash/*` and every harness's hook tree now run correctly on Linux, macOS, and Windows Git Bash — no GNU-only flags, no bash-4-only syntax (stock macOS ships bash 3.2). WSL works via the existing Linux path with no special-casing needed.
- **`hasBashCapableShell()` preflight** in the lifecycle layer: `doflow install`/`update` now fails loudly with an actionable message ("install Git Bash for Windows, or run inside WSL") before writing hook-bearing changes for a harness, rather than installing hooks that would error silently at runtime on a bash-less machine. Exempt on removal, since uninstalling hook files doesn't require running them.
- **Cross-OS CI matrix** (`.github/workflows/cross-os-tests.yml`): runs `npm test` and the three shell-layer suites on `ubuntu-latest`, `macos-latest`, and `windows-latest` on every PR.

## [0.13.0] - 2026-07-30

### Fixed

- **A project-scoped Gemini install loaded none of the shared guidance.** The pointer source carries
  one hardcoded `../`, and the adapter copied it verbatim — but Gemini reads a project-level
  `GEMINI.md` from the workspace *root*, so the import resolved one level above the install at a path
  that does not exist. `PRINCIPLES.md`, `FLAGS.md`, `MCP_INDEX.md` and all four `RULE_0*` files
  silently never loaded, while the install reported success because the file was written correctly
  and only its content aimed at nothing. The prefix depends on **scope**, not harness — Gemini's
  instruction file is one level deep globally and zero deep in a project — so no static pointer can
  satisfy both; it is now computed at render time from `guidance.context-layer`'s `nativeDir`. Claude
  is deliberately untouched: its instruction file is always one level deep in both scopes, so `../`
  is always correct there.

### Added

- **`subagent-driven` skill** — the task-execution engine `do-execute-plan` now delegates its
  per-task loop to: one fresh subagent per task, a review returning **both** a spec-compliance and a
  code-quality verdict, and a bounded three-round fix loop (rounds 1–2 resume the implementer that
  holds the context, round 3 escalates a tier) with a circuit breaker that forces an explicit
  recorded ruling on every finding still open at the cap. Previously a task was checked off on its
  tests alone, so a task that passed its tests while missing a traced requirement was not caught
  until the end-of-chain review. Prompt bodies live in three bundled templates
  (`implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`) rather than inflating
  the skill file. Carries `disable-model-invocation: true`: it is a dispatch loop, and one supported
  harness blocks a subagent from dispatching further subagents outright.
- **Four deterministic helpers** under `scripts/doflow/bash/`, all `--json` like the existing
  resolver: `do-exec-paths.sh` (the single source of truth for a task's brief/report/workspace paths),
  `do-task-brief.sh` (composes a brief from plan/requirement/design — a DoFlow task is one checklist
  line, so a brief is composed rather than extracted, and `requirement.md`'s NFR section supplies the
  global-constraints block), `do-review-package.sh` (commit list + stat + diff to a file named per
  range, so a re-review never re-reads the diff the first review saw), and `do-parallel-check.sh`.
- **`references/MODEL_SELECTION.md`** — one home for tier-selection policy, loaded on demand by both
  dispatch surfaces so the tiers cannot drift between them. Tiers are named by capability, never by
  vendor model name, because rosters differ per harness and turn over faster than shipped guidance.
- **`--sync` and `--review`/`--no-review` on `do-execute-plan`** — `--sync` runs every selected task
  serially regardless of `[P]` and reports that fan-out was suppressed. The review flags resolve a
  tri-state defaulting to *auto*: on for `--all`, off for `--next`/`--phase`.
- **Write-set disjointness precheck** — `[P]` asserted at plan time that a task's `files:` set did not
  overlap its phase siblings', and nothing verified it; two agents dispatched onto one file lose an
  edit silently. `do-parallel-check.sh` turns the claim into a check, and a sequential sibling
  writing the same file is correctly not flagged, since it never runs alongside one.
- **Task Ledger and Findings sections in `state-template.md`** — per-task commit range, rounds used
  and review outcome, plus a home for parked rulings and deferred minors so no finding is discarded
  silently. The `Plan:` field is now documented as the record's identity: a record naming a different
  plan belongs to another run.

### Changed

- **Gemini now receives the helper-script and template trees.** Both capabilities were declared
  `unavailable` against a generic docs root, so no Gemini install got them — while every chain skill
  resolves its paths through `do-paths.sh`. Gemini CLI documents an executable `scripts/` directory
  in its own skill layout and a shell-execution tool to run it; the declarations now carry those
  specific pages as evidence. Verified end to end against Gemini CLI 0.50.0: a real install lands
  every helper and template, and an installed helper executes from its installed location. This is
  the same class of error as the Gemini `hooks` entry corrected in v0.8.0, and `test/guards/registry.test.js`
  (G5) is what would have caught a half-applied change — `validateRegistry` also refuses to render an
  unavailable capability, so the projection and the declaration cannot move independently.
- **`do-plan` now marks `[P]` by default** wherever a task's `files:` set is disjoint from its phase
  siblings', making an unmarked task the exception that owes a reason. The marker's syntax and
  meaning are unchanged — unmarked still means sequential. Inverting it was rejected deliberately:
  every deliberately unmarked task in an existing plan would have been reinterpreted as
  parallel-safe, which fails unsafe.
- **`parallel-agents` hardened**, additively — the mechanic that actually produces concurrency
  (dispatches issued together in one response run in parallel; one per response runs sequentially),
  why isolation cuts both ways, a worked exemplar dispatch, anti-pattern pairs, a pointer to the
  model-selection policy, and a spot-check rule for correlated errors: agents given similar prompts
  fail in similar ways, so N agreeing summaries are not evidence.

## [0.12.0] - 2026-07-30

### Changed

- **`code_quality_checker.py` now emits working-directory-relative paths** in its `--json` output
  (`file` and `directory`), instead of the absolute path it resolved internally. Input is still
  resolved so filesystem checks stay unambiguous; only the emitted value changed. This removes the
  root cause behind v0.11.1 rather than working around it: fixtures no longer need normalizing
  before comparison, so a newly added fixture cannot silently reintroduce the bug. It also makes
  the tool's output consistent with `pr_analyzer.py`, which already emits git-relative paths —
  `review_report_generator.py` merges findings from both into one report, and until now the same
  file could appear under two different path forms and never be grouped.
  Implemented with `os.path.relpath` rather than `Path.relative_to`, which raises for a target
  outside the working directory — a supported input here.

### Added

- **`test/code-review-fixtures.sh`** — runs all six analyzer fixtures and fails on drift. The guard
  existed only as a command in `SKILL.md` that someone had to remember, which is how it stayed
  broken unnoticed. Invoked by path like `verify-hooks.sh` and `doflow-chain-test.sh`, since
  `npm test` is `node --test` and discovers only `test/*.test.js`. Skips with exit 0 when `python3`
  is unavailable — this repo has no Python dependency, so a missing interpreter is not a failure —
  and also skips rather than reporting success when it finds no fixture pairs at all.

## [0.11.1] - 2026-07-30

### Fixed

- **`do-code-review`'s regression fixtures could never pass.** The analyzer resolves its input to
  an absolute path, so the committed `expected_outputs/*.json` pinned `file` to the machine that
  generated them — a path under `/home/user/claude-skills/…`. The documented `diff` therefore
  reported drift on every checkout except that one, which makes a guard worse than useless: it
  fails constantly, so it stops being read. The fixtures now store the repo-relative `assets/…`
  path and the documented command normalizes the live output to match, with a loop for checking
  all six at once. The analyzer itself is untouched — its `--json` shape is unchanged, and every
  field other than `file` already matched.
- **Private references removed from shipped content.** The six fixtures above carried another
  contributor's home directory, and `do-document`'s feature-flow template linked a private
  Confluence page. Both shipped verbatim into every install, where an absolute path is
  meaningless and an internal link is unreachable.

## [0.11.0] - 2026-07-29

### Added

- **`has_constitution_local` in the resolver's JSON.** `do-paths.sh` reported the tier-2
  constitution's *intended* path but never whether the file existed — unlike `requirement`,
  `design`, and `plan`, which each carry a `has_*` flag. Every consumer therefore had to
  re-implement its own existence check, contradicting the standing "no filesystem math in prompts"
  rule. The flag is computed at repo scope (a constitution exists or does not regardless of whether
  a feature is active) and outside the `--paths-only` skip, and `constitution_local` is still
  emitted when the file is absent, because that is exactly when `do-constitution` needs the path in
  order to create it. Purely additive: consumers that ignore the field are unaffected.
- **Six chain-suite assertions covering tier-2 resolution**, which previously had none while tier-1
  had three. Two of them exist specifically to catch mis-placement — a flag computed inside the
  feature-scoped block, or behind the `--paths-only` skip, passes a naive present/absent test — and
  each is paired with a precondition assertion proving it tests what it claims.

- **Artifact authoring convention** — `guidance/references/ARTIFACT_FORMAT.md`, a new on-demand
  reference defining how chain artifacts are structured: an index table above full `**Detail**` for
  every enumerated section, a closed `Live` / `Superseded → <ref>` status vocabulary, a History
  section that keeps superseded prose out of the live body, and the diagram rules for the scope
  boundary and C4 levels. Loaded only when a chain skill pulls it in, so it costs nothing at
  session start.
- **`scripts/doflow/bash/validate-artifacts.sh`** — advisory consistency checker for chain
  artifacts. Verifies index/detail parity in both directions, the status vocabulary, that
  ID-shaped supersede targets resolve, that superseded items have a History entry, and that
  `plan.md`'s phase rollup counts match its task checklist. Accepts `[--json] [--slug=<slug>]
  [<path>...]`; exits `0` clean, `1` on findings, `0` with a printed note when it cannot determine
  what to check. **No hook consumes it** — the framework's single hard gate is unchanged, and
  findings never halt the chain or get repaired automatically.

### Changed


- **The two-tier constitution is now described as what it is.** The documentation said
  `do-paths.sh` "resolved (base ⊕ local)" and that `/do-plan`'s Constitution Check "enforced" it.
  Neither was true: the resolver locates paths and never opens either file, nothing detects a
  conflict between the tiers, nothing validates the "tier-2 may not weaken P1" rule, and the Check
  is advisory — its verdict is recorded in `plan.md` §2 and blocks nothing. The overlay is
  performed by the chain skill reading both files, which is a legitimate design under DoFlow's
  deterministic/generative split; describing it in mechanism language was the problem.
  `DOFLOW_CHAIN.md` now carries a canonical table naming each step *computed*, *convention*, or
  *advisory*, and the other five locations point at it rather than restating it. This changes no
  behaviour — only what the documentation claims about it.

- **Chain templates restructured** for scannability. `requirement-template.md`, `design-template.md`
  and `plan-template.md` now open each enumerated section with an index table above the full
  detail, and each gains a `History` section. `requirement-template.md` adds a scope-boundary
  diagram; `plan-template.md` adds a `### Task Summary` phase rollup. Existing normative content was
  relocated, not condensed — the index is navigation, never a substitute for the detail.
- **`design-template.md` no longer uses the `C4Context` / `C4Container` diagram types.** C4 is kept
  as the conceptual zoom model, but every level now renders as a Mermaid `flowchart` with
  `subgraph` boundaries. The C4 types are experimental: they offer no direction control, route
  relationship labels into arrowheads, and render inconsistently across viewers. A conditional
  `C3: Component` level is added, required only when a feature touches 3+ components within one
  container.
- **`do-brainstorm`, `do-design` and `do-plan`** now read `ARTIFACT_FORMAT.md` before filling their
  template, and run `validate-artifacts.sh` after writing, surfacing any findings verbatim.

## [0.10.1] - 2026-07-29

### Fixed

- **A relocated asset's file at its old location leaked forever instead of being removed.**
  Found immediately after v0.10.0 shipped a real `nativeDir` change (`scripts.doflow`/
  `templates.doflow` moving to a shared `.doflow/` destination): `copy-tree.js`'s removal logic
  matched old-vs-new purely by `relPath`, so a relocated file's `relPath` being "still present"
  (just under a different `destDir` now) suppressed removal of the stale copy at its old location
  entirely — and separately, even a direct removal call recomputed the target from the *current*
  `destDir` instead of the file's actual recorded location, so it would have looked in the wrong
  place regardless. `planTree()` now tracks each previously-owned file's own recorded `target` and
  only treats it as "still needed here" when that target matches the current install's destination;
  otherwise it creates the new copy and removes the old one. The next `doflow update` on any
  project that installed v0.10.0's `scripts.doflow`/`templates.doflow` move will clean up the
  orphaned per-harness copies this introduced.

## [0.10.0] - 2026-07-29

### Changed

- **`scripts.doflow` and `templates.doflow` now project to a single shared `.doflow/scripts` /
  `.doflow/templates` destination** (claude + codex), instead of a separate copy per harness —
  the same mechanism `guidance.context-layer` already used. A project with DoFlow installed
  asymmetrically across harnesses (e.g. Claude project-scoped, Codex global) could have a skill's
  RESOLVER bootstrap silently pick up the wrong harness's `do-paths.sh`/`do-prereqs.sh`/
  `sync-context.sh` copy; with one shared location there's nothing to drift. The RESOLVER bootstrap
  in every skill that resolves DoFlow's own tooling (`do-flow`, `do-design`, `do-plan`,
  `do-execute-plan`, `do-brainstorm`, `do-constitution`) now does a single `.doflow`-relative
  upward walk instead of a three-branch harness/scope fallback; `do-paths.sh`'s own
  `constitution_base` search was updated to match its new install depth. Gemini was evaluated for
  the same move but is not included — `core/registry/harnesses.yaml` declares its `scripts`/
  `templates` capabilities `"unavailable"`.

## [0.9.2] - 2026-07-28

### Fixed

- **A single-target install could wedge its sibling harnesses.** `guidance.context-layer` projects
  one destination for all three harnesses, but ownership is recorded per harness, so a sibling's
  install legitimately rewrites bytes that another harness's ledger row still describes. The
  known-good check consulted that row first, making the situation indistinguishable from a hand
  edit and refusing the whole install with "was modified outside DoFlow". Recovery required
  installing every target or a clean reinstall.

  The check now treats "matches the source we are about to write" as untampered regardless of who
  wrote it, consulting the recorded fingerprint only as a fallback. This adds no new notion of
  safety — the same rule already applied whenever no ledger row existed; a present-but-stale row
  was simply preempting it. Genuine tampering, matching neither source nor ledger, is still
  refused.

  Reproducing it needs all three conditions: a prior multi-target install, then a source change,
  then a single-target install. A first install on a fresh machine was never affected.
- `DOFLOW_CORE.md` is now a pure import manifest. The trailing comment explaining why a resource
  inventory would be inert was itself commentary the file did not need to carry into every
  session.

## [0.9.1] - 2026-07-28

### Changed

- **`MCP_INDEX.md` imports each selected server's doc instead of naming it in prose.** The old
  `on use, read mcp/X.md first` line was prose describing a trigger, and nothing evaluates prose —
  the same shape this guidance layer removed from its behavioral modes in 0.9.0. A mode could bind
  to the skill that reads it at no context cost; a server doc has no per-server skill to bind to,
  so the choice was an import that loads or a sentence that hopes. Only selected servers are
  imported, so a one-server install pays for one doc and a zero-server install still writes no
  file. The file regenerates on install; no migration step.

### Fixed

- **The generated MCP index could never be updated on its own.** It is not a tracked resource, so
  it never appears in the change plan, and the CLI skipped the lifecycle — which owns the only
  call that writes it — whenever nothing else had changed. The index was rewritten only as a side
  effect of some unrelated asset changing, so an install could report success against a stale
  file. Changing the renderer, a server's `doc`/`shortFlag`, or the resolved selection silently
  did nothing on an otherwise-current tree.
- **Both `MCP_INDEX` anchor guards would have gone silently vacuous.** They parsed the rendered
  `on use, read X first` line; after the format change their parsers matched nothing, making every
  assertion below the parse trivially true — the same defect class those guards exist to prevent.
  Each now pins the number of emitted imports against the number of selected servers, so a format
  change fails loudly instead of disabling the check.

## [0.9.0] - 2026-07-28

**Upgrading.** Eleven documented flags are gone. None had a working implementation — each restated
a mechanism that already takes effect — so nothing you were relying on stops working, but the
names are no longer recognized. Reasoning depth is `effort` (skill/agent frontmatter, or a session
setting); parallel execution is the default stated in `rules/RULE_02_WORKFLOW.md`; a behavioral
mode loads through the skill that reads it, not through a flag.

### Removed

- **`--think`, `--think-hard`, `--ultrathink`** — superseded by `effort`, which every skill and
  agent spec declares and every harness honours. A flag could only ask for depth; `effort` sets it.
- **`--delegate` and `--parallel`** — both asked for behavior already mandated as the default.
  `--parallel` additionally appeared in two skills' `argument-hint` while appearing zero times in
  either Behavioral Flow: an advertised argument neither skill acted on.
- **`--brainstorm`, `--introspect`, `--task-manage`**, and the mode files' own "Manual flag" lines
  including an undocumented `--bs` alias — a mode's trigger is the skill that reads it, and a
  skill's `description:` is the only trigger all three harnesses evaluate.
- **`--research` and `--introspection`** — referenced in mode files, documented nowhere, wired to
  nothing.

`FLAGS.md` drops from 28 flags to 3 (`--iterations`, `--focus`, `--validate`), each naming the
skill that consumes it.

### Added

- **G4 reverse direction**: a flag referenced anywhere in the guidance tree must be documented in
  `FLAGS.md`. The forward check cannot see a reference left behind by a removal; adding the reverse
  one immediately found four such references that had survived a green suite.

### Fixed

- **G2 did not catch the defect its own design credited it with.** The design named v0.8.0's
  `MCP_INDEX` anchor bug as G2's purpose, but the implementation excluded `MCP_INDEX.md` and
  delegated elsewhere — reintroducing that defect produced zero failures from G2. It now renders
  the index and resolves each emitted path from the index's own location, catching all three
  mutations of the anchor where it previously caught none.

## [0.8.0] - 2026-07-28

**Upgrading.** This release changes the installed output shape, so an existing install needs a
clean reinstall rather than an update on top: run `doflow remove`, delete any `rules/`, `modes/`,
`mcp/`, or `references/` directories it leaves behind under `.claude/`/`.codex/`/`.agents/`, then
`doflow install`. If a previous `0.8.0` prerelease left a `.doflow/guidance/docs/` directory,
delete that too. First-time global installs on an already-configured machine now work — earlier
builds refused when `~/.claude/settings.json` already existed, which aborted the whole run.
Flags removed in this release (`--uc`, `--all-mcp`, `--safe-mode`, and 11 others) will simply not
be recognized; none had a working implementation.

### Added

- **Gemini CLI hooks.** `src/gemini-hooks.js` plans/deploys a `hooks` key merged into
  `.gemini/settings.json` (never a full-file replace — pre-existing keys like `mcpServers`/`ui`
  are preserved through both install and remove), with scripts ported to
  `core/harnesses/gemini/hooks/` and mapped onto Gemini's real event vocabulary (`SessionStart`,
  `SessionEnd`, `BeforeTool`, `AfterTool`, `PreCompress`). `UserPromptSubmit`, `Stop`, and the
  subagent events have no correct Gemini equivalent and are intentionally left unmapped rather
  than approximated.
- **Codex `PostToolUse`/`PreCompact` hooks**, closing a gap where Claude's `post-edit-lint.sh` and
  `pre-compact.sh` guardrails had no Codex counterpart. Codex's `apply_patch` reports edited files
  via a raw patch string, not a `file_path` field, and its `PreCompact` output must be JSON, not
  Claude's plain string — both scripts are adapted for Codex's actual contract, not copy-pasted.

- **Context-layer reachability guards** (`test/guards/`). Five families assert that a declaration
  connects to something real: recognized frontmatter fields (G1), resolvable paths (G2), a load
  point for every lazy resource (G3), a consumer for every documented flag (G4), and a registry
  that matches the code that ships (G5). Each was landed failing against the then-current tree and
  observed red before the content fix, because the defect class they exist to catch is an
  assertion that cannot fail.
- **`core/registry/contracts.yaml`** — a fifth registry file declaring what each harness *accepts*
  (legal skill/agent frontmatter fields, legal hook event names), kept separate from
  `harnesses.yaml`'s what-DoFlow-*supports*. Nesting them would make G5 validate the registry
  against itself. Claude's lists are verified against current documentation; Codex's and Gemini's
  are marked `lower-bound` — what DoFlow actually wires — rather than claiming coverage that was
  not independently checked.
- **Failure and permission hook paths on Claude**, each with its own handler.
  `post-tool-failure.sh` records a failed tool call — the one outcome nothing else logged — and
  deliberately does *not* reuse `post-edit-lint.sh`, which queues a path for end-of-turn linting
  and on a failed edit would queue a file that was never written. `permission-audit.sh` records
  refusals so the trail is no longer allow-only, and stays out of the subagent audit log, whose
  `agent_type`/`agent_id` a permission decision does not carry. Both degrade to a thinner record
  when optional payload fields are absent, and are no-ops without a session id.
- **Per-event hook support** (`capabilities.hooks.events`, optional and additive). A gap is now
  recorded with the reason no equivalent exists instead of being omitted, which was
  indistinguishable from an oversight. `docs/capability-map.md` publishes the resulting matrix.

### Fixed

- `README.md`/`docs/overview.md`/`docs/setup.md` claimed Codex had no file-based hook installer
  support; it already did (`src/codex-hooks.js` predates this release). All three now match
  verified installer behavior for both Codex and Gemini.
- `lifecycle-view.js`'s hook-trust status line hardcoded "(review required in Codex)" regardless
  of which harness produced it.
- **Per-install MCP short-flag index restored.** The guidance layer had no way to tell an agent
  which MCP servers a given install actually selected — a capability that existed before the
  `.doflow/guidance/` unification and silently disappeared with it. `core/registry/mcp.yaml`
  entries now carry `shortFlag`/`doc` fields; `applyLifecycle` renders and writes
  `.doflow/guidance/MCP_INDEX.md` from the resolved selection on every `install`/`update`
  (and removes it when the selection is empty or the harness is removed), imported unconditionally
  via a new `@MCP_INDEX.md` line in `DOFLOW_CORE.md`.
- **Every MCP doc pointer in the generated index resolved to a nonexistent file.** `mcp.yaml`'s
  `doc` values (`mcp/MCP_Context7.md`, …) are anchored at the guidance root, but `MCP_INDEX.md` was
  written one level deeper into `docs/`, so each `on use, read …` instruction pointed at
  `guidance/docs/mcp/MCP_*.md` — a path that never existed. The index is now written to the
  guidance root. The unit test that should have caught this only re-asserted its own input string;
  it is replaced by one that resolves each emitted path against the real tree.

- **The registry contradicted its own shipped code.** `gemini.hooks` was declared `unavailable`
  with the verification "do not render hooks" while DoFlow has shipped a Gemini hooks deployer,
  five wired events, and a test file since v0.8.0 — and `docs/capability-map.md` published that
  false status. A test asserted `status === 'unavailable'`, which is why it survived a green suite.
- **Six behavioral modes and one reference file were unreachable.** No skill loaded any of them;
  their only documented triggers were flags, two of which did not exist. A mode's own
  `## Activation Triggers` section is prose *about* a trigger — no harness evaluates it. Each mode
  now binds to its paired skill, and `references/RESEARCH_CONFIG.md` binds to `do-research`.
- **`do-document` instructed the agent to use three templates that do not exist**
  (`references/feature-flow.md`, `api-reference.md`, `user-guide.md`). Every invocation pointed at
  missing files.
- **14 agent specs carried an unrecognized `category:` frontmatter field**, inert on all three
  harnesses. The taxonomy moves into prose, where it costs nothing and claims nothing.

### Changed

- **Breaking (installed output shape): `guidance/docs/` is flattened into the guidance root.**
  `PRINCIPLES.md` and `FLAGS.md` move from `.doflow/guidance/docs/` to `.doflow/guidance/`, and
  `DOFLOW_CORE.md` imports them as `@PRINCIPLES.md`/`@FLAGS.md`. Every path the guidance layer
  depends on — `DOFLOW_CORE.md`'s `@`-imports and `mcp.yaml`'s `doc` values alike — is now anchored
  at a single directory, removing the split anchor that produced the broken MCP doc pointers above.
  It also drops a name collision with this repo's own top-level `docs/` (the MkDocs site).
  A stale `.doflow/guidance/docs/` left by a `0.8.0`-prerelease install is not removed
  automatically; delete it by hand if present.
- `DOFLOW_CORE.md` no longer carries a static "MCP Documentation → `@mcp/`" listing. It enumerated
  all four MCP docs regardless of what was installed, which the per-install `MCP_INDEX.md` now
  supersedes with the servers actually selected.
- **Breaking: shared guidance content is no longer duplicated per harness — it now lives once in
  `.doflow/guidance/` (project scope) or `~/.doflow/guidance/` (global scope), mirroring
  `core/shared/guidance/` byte-for-byte.** Each harness's native entry file (`.claude/CLAUDE.md`,
  Codex's `AGENTS.md`, Gemini's `GEMINI.md`) now carries only a short pointer into that shared
  tree instead of a full copy of the rules/modes/mcp/references content — an `@`-import for Claude
  and Gemini (both resolve `@file` imports natively), a prose read-instruction for Codex (no
  native import-expansion mechanism). The canonical root doc is renamed
  `core/shared/guidance/CLAUDE.md` → `DOFLOW_CORE.md` (harness-neutral, since it's read by all
  three). A new `core/shared/guidance/VERSION` file is the single source for the guidance-content
  layer's own version, independent of this package's version — no more editing `package.json` +
  `core/.claude-plugin/plugin.json` + `core/.codex-plugin/plugin.json` in lockstep for a
  content-only change. `.doflow/state/ledger.json` gains a `guidanceVersion` field recording which
  layer version is installed. **Existing installs need a clean reinstall, not just `doflow
  update`/`install` on top of what's there**: retiring the old per-harness `guidance.rules`/
  `modes.doflow`/`claude.mcp-docs`/`references.doflow`/`guidance.docs` asset ids means neither
  `install`, `update`, nor `remove` will delete the `rules/`, `modes/`, `mcp/`, `references/`
  directories those ids used to own — removing an asset id that no longer exists in the registry
  isn't yet an automatic lifecycle capability. Run `doflow remove` and delete any of those four
  directories it leaves behind under `.claude/`/`.codex/`/`.agents/`, then `doflow install`, to
  reach a clean state.

- **Breaking: 14 of 28 flags removed from `FLAGS.md`.** `--orchestrate`, `--token-efficient`,
  `--all-mcp`, `--no-mcp`, `--concurrency`, `--loop`, `--safe-mode`, `--scope`, the long aliases
  `--context7`/`--sequential`/`--playwright`/`--devtools`, and `--uc`/`--ultracompressed` routed to
  nothing. The four MCP short flags also leave: they are generated per install into `MCP_INDEX.md`
  from the servers actually selected, so `FLAGS.md` no longer names a server you may not have.
  The always-loaded guidance surface drops from 14,477 to 11,971 bytes — paid on every session, on
  every harness.
- **Breaking: `MODE_Token_Efficiency.md` and the `token-efficiency` skill are removed**, taking
  `--uc`/`--ultracompressed` with them. **Migration:** there is no in-framework replacement. The
  guidance instructed the model to compress what it *emits*; if you want output filtering, install
  a tool that does it. DoFlow ships no runtime dependency and does not assume one. Skill count
  drops 28 → 27.
- **Breaking: four read-only skills now enforce their own documented boundaries** via
  `disallowed-tools` (`do-estimate`, `do-select-tool`, `do-explain`, `do-analyze`). Only skills
  whose Boundaries state an *unconditional* no-edit are scoped; skills that say "in auto mode"
  keep the explicit-request escape their documentation promises, deliberately unscoped.
- `DOFLOW_CORE.md` no longer carries a commented resource inventory. It read like a load mechanism
  but nothing evaluated it, so every file it named went unloaded for as long as it existed.

## [0.7.1] - 2026-07-25

### Fixed

- **`templates/doflow/contract-doc-template.md` leaked its own pre-install source path.** It
  referenced `core/shared/skills/do-execute-plan/contracts.md` (a do-flow-repo-only path) instead
  of the installed, harness-relative `skills/do-execute-plan/contracts.md` — every fresh install of
  this template carried a broken reference. Same leak class as the one fixed once before in 0.3.0;
  swept the rest of `core/shared/` and `core/harnesses/` and found no further instances.

## [0.7.0] - 2026-07-25

### Added

- **Multi-harness registry architecture.** `core/registry/{harnesses,assets,mcp,lifecycle}.yaml`
  declares capabilities, shared assets, the neutral MCP catalog, and logical hook policies for
  Claude, Codex, and Gemini CLI. `src/registry/`, `src/adapters/{claude,codex,gemini}/`,
  `src/lifecycle/`, and `src/state/` implement a common discover/plan/apply/remove/verify contract
  per harness, with ownership tracked in a neutral ledger (`.doflow/state/`) instead of a
  Claude-anchored manifest. `install`/`update`/`remove` now route Claude and Gemini through the same
  live lifecycle path Codex already used.
- Generated `docs/capability-map.md` (registry-derived, three-harness) with a "Codex capability
  detail" appendix for surfaces too granular for the shared taxonomy.

### Changed

- **Claude's and Gemini's shared assets, hooks, and settings now install through the same
  registry/lifecycle path Codex already used**, via a new shared copy-tree engine
  (`src/adapters/copy-tree.js`) with per-file SHA-256 ownership tracking. `bin/mappings.conf`'s
  `[claude]`/`[codex]`/`[gemini]` sections are now fully empty — every asset those sections used to
  copy is adapter-owned; deployed output is unchanged (byte-identical, verified against this repo's
  own dogfooded install). Adding a new deployable file under `core/` now means declaring it in
  `core/registry/assets.yaml`, not adding a `bin/mappings.conf` line.
- **MCP server catalog consolidated to a single source.** `core/registry/mcp.yaml` is now the only
  MCP catalog; `core/.mcp.json` (the pre-registry duplicate) is removed. `src/mcp.js`,
  `src/codex-mcp.js`, and the Claude adapter's `discover()` all resolve known/selected servers from
  the registry.
- **Breaking (installed framework content — repository shape).** Canonical shared content moved
  from a flat `core/` into `core/shared/{guidance,skills,templates,scripts,agent-specs}/`; Codex- and
  Claude-native assets moved into `core/harnesses/{codex,claude}/`; Gemini's adapter defaults moved
  under `core/harnesses/gemini/settings/`. `core/.claude-plugin/` and `core/.codex-plugin/` remain at
  `core/` (required by each tool's plugin-discovery convention) with explicit `skills`/`agents` path
  overrides pointing at the new `core/shared/` locations. `bin/mappings.conf`,
  `core/registry/{harnesses,assets}.yaml`, and hardcoded source constants in `bin/doflow.js` /
  `src/adapters/gemini/index.js` were repointed accordingly; deployed output is unchanged
  (byte-identical, verified against this repo's own dogfooded install).
- Gemini's instruction file mapping corrected from a stale `AGENTS.md` copy to the registry-declared
  `GEMINI.md`, reconciled through the Gemini adapter's managed section instead of a plain file copy.
- Retired `docs/codex-capability-map.md` (merged into `docs/capability-map.md`) and
  `core/shared/content-index.json` (a Phase-B compatibility index superseded by the actual move
  above).
- Dropped the redundant `codex-` filename prefix from Codex's hook scripts
  (`core/harnesses/codex/hooks/`) — directory-level namespacing already disambiguates them from
  Claude's identically-named scripts.
- Centralized the marker-removal logic the Claude and Codex adapters each carried as an identical
  private copy into a single `removeMarkedSection(file)` in `src/marker-merge.js` (renamed from
  `claude-md-merge.js` now that it's shared, not Claude-specific).

### Removed

- **Breaking (CLI).** `bin/sync.sh` and the repo-root `./sync.sh` wrapper are removed. `doflow`
  (via `npx doflow` or `bin/doflow.js`) is the only installer; anyone still invoking `sync.sh`
  directly must switch to the equivalent `doflow` subcommand (see `docs/setup.md`).
- `bin/sync-legacy.sh` (the frozen bash reference implementation) and `test/cli-parity.sh` (the
  harness that diffed `doflow.js` against it) are removed, along with `package.json`'s `parity`
  script. The parity net served its purpose during the registry migration — every phase was
  validated against it before this final removal — and is no longer needed now that `doflow.js` is
  the only installer.

### Fixed

- **Codex lifecycle hooks were non-functional after the repository-shape move above.** Five hook
  scripts (`session-start.sh`, `session-end.sh`, `stop-check.sh`, `subagent-audit.sh`,
  `user-prompt-submit.sh`) were thin wrappers delegating to a differently-named real
  implementation; dropping their `codex-` prefix collided each wrapper's filename with its own
  delegation target, causing infinite self-recursion on every invocation. Separately,
  `deployCodexHooks` only ever copied files named literally inside a `hooks.json` command string,
  so `lib.sh` and two guard-config files (sourced/read at runtime, never named in a command) were
  silently missing from every real install. Both fixed: the deploy step now copies every file in
  the hooks source directory, and the five wrappers delegate to a distinctly-named `.impl.sh` copy
  instead of a same-named sibling.
- `update --dry-run` for an MCP-only change no longer falsely claims a backup will be created —
  its preview message now uses the same guard as the real backup-creation path.

## [0.6.4] - 2026-07-24

### Added

- **Claude Code marketplace plugin distribution.** `core/.claude-plugin/` now contains the
  marketplace registry and DoFlow plugin manifest, pointing to the canonical `core/` content tree.

## [0.6.3] - 2026-07-24

### Changed

- **`core/skills/` audited and rewritten for concrete mechanics.** A `/skill-creator` benchmark
  found `do-pm`/`do-spawn`/`do-task` functionally redundant (all three classify-and-delegate a
  request) and `do-improve`/`do-cleanup`'s boundary unenforced in practice (a cleanup-scoped run
  drifted into full logic restructuring on an ambiguous prompt). `do-spawn` and `do-task` are
  merged into `do-pm` (absorbing its Epic/Story/Task depth option and explicit Validate step);
  `do-cleanup` is merged into `do-improve` via a `--type cleanup` value. 16 of the remaining 26
  skills — `do-analyze`, `do-troubleshoot`, `do-reflect`, `do-build`, `do-test`, `do-git`,
  `do-estimate`, `do-spec-panel`, `do-select-tool`, `do-research`, `do-index`, `do-explain`,
  `do-implement`, plus a light touch on `do-document` — are rewritten from generic templated
  boilerplate to skill-specific Behavioral Flow steps, each benchmarked old-vs-new with zero
  regressions. Skill count in `core/skills/` drops from 31 to 28; `README.md`, `ARCHITECTURE.md`,
  `docs/index.md`, `docs/reference.md`, and `docs/guide.md` updated to match. `do-help` rewritten
  to enumerate the live skill set instead of a hardcoded table, so this doesn't drift again the
  same way. Full details: `agent-docs/doflow/010-skills-core-refactor/`.

## [0.6.2] - 2026-07-23

### Changed

- **`install`/`update` no longer overwrite a target project's existing `CLAUDE.md`.** doflow's
  content now lives inside a clearly delimited, always-regenerated marked section
  (`<!-- doflow:start -->` … `<!-- doflow:end -->`); a pre-existing hand-authored `CLAUDE.md`
  gets that section appended after its own content instead of replaced wholesale, and a file
  that already has the marked section only has that span refreshed — everything else in the
  file is preserved byte-for-byte. Applies identically to `install` and `update`, global and
  project scope. `.mcp.json` needed no change — it was already read-merge-write via `src/mcp.js`.

## [0.6.1] - 2026-07-22

### Changed

- **`do-brainstorm` and `do-design` now resolve every open question to zero before writing
  their artifact**, instead of letting up to 3 `[NEEDS CLARIFICATION]` markers pass through
  unresolved. Ambiguities surfaced during dialogue are partitioned into independent questions
  (batched up to 4 per `AskUserQuestion` call) and dependent ones (asked individually, in
  order); a user who explicitly defers is recorded as a traceable assumption in a new §8
  "Assumptions" section (added to both `requirement-template.md` and `design-template.md`)
  instead of leaving the ambiguity open. `do-flow`'s Gate 0 description is updated to reflect
  that it's now a safety net for an aborted session, not the normal path.

## [0.6.0] - 2026-07-21

### Added

- **`--contracts` now generates a `default/` artifact per dependency**, alongside the existing
  `code/`/`data/`/`mock/` frames: a compilable default implementation of the dependency's
  interface, so a reviewer (or the consuming task's own in-scope code) has something to read and
  compile against immediately, not just a shape to hand-implement first. Every method resolves to
  one pinned, language-family-specific "not implemented" signal (a new Default-Implementation
  Grammar table in `contracts.md` — e.g. Java/Kotlin throw `UnsupportedOperationException`, C#
  throws `NotImplementedException`, Python raises `NotImplementedError`, Go returns a zero value +
  error) — never real business logic, never a guessed behavior. Generated for both local-inference
  and documented (`contract-doc:`) dependencies alike; skipped entirely for the
  `inferred_language: unresolved` (generic-pseudocode) case, which has no execution semantics to
  carry a "not implemented" signal.
  This is the new default `--contracts` behavior, no flag required — `generation_hash` now also
  covers `default/`'s generated content, so a contract frame generated before this change is
  correctly flagged stale (not silently treated as current) the next time `--contracts` runs.

## [0.5.0] - 2026-07-17

### Added

- **`do-document --type feature`**: generates feature-level documentation (C4 context/container
  diagrams, sequence diagrams, a data model section, an API spec section) backed by new reference
  templates (`api-reference.md`, `feature-flow.md`, `user-guide.md`), alongside expanded usage
  examples and tool-coordination notes in `do-document/SKILL.md`.
- **`contract-doc:` field for `/do-plan` tasks**: an optional field, set alongside `depends-on:`,
  for a dependency with no local repo (a vendor API, a SaaS integration) that nonetheless has a
  documented contract. Points to a doc built from the new `templates/doflow/contract-doc-template.md`
  (pinned `## Methods`/`## Types`/optional `## Webhook` structure, reusing `--contracts`'s own
  generic-pseudocode grammar). When set, `/do-execute-plan --contracts` mechanically generates a
  real frame from that doc — `code/`/`data/`/`mock/`, rendered in the *consuming* task's own
  inferred language — instead of silently skipping the dependency, its default behavior when
  `contract-doc:` is absent. A non-compliant doc target surfaces an explicit warning rather than a
  silent skip or a guessed frame; multiple tasks referencing the same non-local dependency must
  agree on `contract-doc:` (same target, or none) or the same warning applies.

### Changed

- `--contracts` service-boundary detection is now generic: instead of matching a `files:`/
  `depends-on:` path against a fixed three-name root list (`sources/`, `sources-rf/`, `clients/`),
  it walks up to the nearest ancestor that is a distinct git repo or contains a known build/
  package manifest — the same signal step 4's language inference already uses — falling back to
  the path's own containing directory (never the consuming repo's own root) when no such ancestor
  exists. This means `--contracts` now works in any consuming repo's layout, not only one shaped
  like a specific multi-service container workspace. `integration_style` (`network`/`in-process`)
  is derived the same way — from how the boundary was found, not a named-root/known-monolith list.
  When a dependency's language can't be inferred, the generated frame is now structurally-valid
  generic pseudocode (`code/interface.pseudo`, `data/types.pseudo`, `mock/interface.pseudo` —
  fixed grammar, explicit banner comment) instead of a prose placeholder. Both are deliberate
  extensions of `--contracts`'s existing behavior, not bug fixes; the resolved-language success
  path (real native-language declarations) is unchanged.

## [0.4.0] - 2026-07-16

### Added

- **Cross-service branch management** for `/do-plan`/`/do-execute-plan`: when a feature spans
  multiple independent git repos, `do-plan` now derives a per-repo branch name (an optional
  PBI/ticket ID + the feature slug, e.g. `feat/EDP-147-some-feature`) and writes a Repo Branch Plan
  into `plan.md`, resolving each repo via a nearest-`.git` walk-up from task `files:`/`depends-on:`
  metadata rather than a hardcoded folder-name list. `do-execute-plan` lazily creates or checks out
  each repo's branch right before its first task, always checking for a dirty working tree before
  branch existence so it never silently continues over uncommitted work — and re-checks any repo
  left `blocked` rather than trusting a stale status. Status is tracked in a Repo Branch Status
  table in `state.md`. `do-brainstorm` gains an optional `**Ticket:**` header field, captured only
  when the user references a PBI/epic during discovery.

### Changed

- `--contracts` flag on `/do-execute-plan` now generates an actual code frame per dependency
  service — method/interface signatures and native-language type/DTO shapes only, zero
  implementation logic — instead of an empty `code/`/`data/`/`mock/` scaffold. Language is
  inferred from the dependency service's own repo (build/package manifest first, file-extension
  frequency fallback, generic placeholder if inconclusive), never hardcoded. This is a deliberate
  change to an already-shipped flag's behavior, not a bug fix; `manifest.yaml`'s `generation_hash`
  now also covers the inferred language and which signal produced it, so a change in the
  dependency service's own language/build setup between runs is still correctly detected as stale.

## [0.3.1] - 2026-07-15

### Fixed

- **Project-scoped resolver lookups:** the `RESOLVER`/`SYNC`/`PREREQ` bash snippets in
  `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan` (both its resolver and prereq-gate
  lookups), and `do-constitution` only checked the global config dir and the do-flow dev tree —
  neither matches a project-scoped install (a target project's own `.claude/`, e.g. doflow
  installed at a multi-service container workspace root). `/do-execute-plan --contracts` (and
  every other chain skill) failed to find `do-paths.sh` outright in this scope, reproduced against
  a real workspace. Now walks upward from `$PWD` looking for `.claude/scripts/doflow/bash/<script>`.
  `pre-implement-gate.sh` gets the equivalent fix via `${CLAUDE_PROJECT_DIR}` — the env var hook
  subprocesses actually receive (skills' own Bash calls do not, verified against official docs) —
  where it previously had no project-scoped fallback at all and silently fail-opened.
- **MCP config merge:** `mergeKnownServers` (backing both the global `~/.claude.json` and
  project-scoped `<dir>/.mcp.json` writers) reset a hand-edited known-server definition — a
  customized arg, an extra env var — back to its shipped `core/.mcp.json` default every time that
  server was reselected on install/update. Now only writes the shipped default the first time a
  name is newly selected; an already-present definition is left untouched.

### Changed

- Removed the dev-tree fallback branch (`core/scripts/doflow/bash/...`) from every resolver-lookup
  snippet above — it only ever matched inside the do-flow source repo itself, so it was dead
  code/token cost on every real install now that the project-scoped walk-up covers the do-flow
  repo's own dogfooded use equally well. Swept `core/` for the same core/-prefixed-path leak class
  already fixed once in 0.3.0 and found four more instances (`RULE_02_WORKFLOW.md`,
  `hooks/lib.sh`, `hooks/skill-config-audit.sh`, `scripts/doflow/bash/do-paths.sh`) plus the
  `DOFLOW_CHAIN.md` note describing the now-removed dev-tree special case.

## [0.3.0] - 2026-07-15

### Added

- `--contracts` flag on `/do-execute-plan`: scaffolds `agent-docs/doflow/<slug>/contracts/<service>/`
  (`code/`, `data/`, `mock/`, plus a `manifest.yaml`) for services a plan depends on but doesn't
  build itself, derived from `plan.md`'s task list — lets cross-service work proceed against an
  agreed contract instead of blocking on the dependency. Standalone and idempotent; does not
  change `--dry-run`'s existing no-op/preview semantics.
- `depends-on:` — new optional field on `plan.md` tasks (alongside `owner:`/`files:`), populated by
  `/do-plan` to mark a task's dependency on an external service with no owning task in the same
  plan. Read by `--contracts` to decide which services to scaffold.
- **C4 System Overview section** in `design-template.md` (Context + Container Mermaid diagrams),
  produced by `/do-design` as the visual complement to its existing Architecture Approach section.

### Fixed

- **Non-git root feature resolution:** `do-paths.sh` previously derived the active feature
  exclusively from the git branch, so a non-git root (e.g. doflow installed at a multi-service
  container root, above the actual git sub-repos) always reported `feature_slug: null` —
  a false "no active feature" gate failure regardless of whether `requirement.md`/`design.md`/
  `plan.md` genuinely existed. Now falls back to scanning `agent-docs/doflow/` directly: one
  candidate auto-selects; zero is genuinely no active feature; two or more surfaces via a new
  `candidate_slugs` field for the calling skill to disambiguate with `AskUserQuestion` (new
  `--slug=<slug>` override forces resolution after disambiguating). `do-brainstorm`, `do-design`,
  `do-plan`, `do-execute-plan`, and `do-flow` all updated to detect and resolve this case
  themselves, so a disambiguation made in one phase actually propagates to the next instead of
  silently creating a duplicate feature directory.
- `--contracts`'s idempotency no longer silently overwrites a contract scaffold when the source
  `plan.md` tasks have changed since it was generated — now warns instead of clobbering
  potentially manually-edited `code`/`data`/`mock` content.
- Candidate-slug scanning no longer misfires on a stray non-numeric directory under
  `agent-docs/doflow/` (a `notes/` folder, `.archive/`, a manual-cleanup leftover).
- Fully qualified previously-bare `contracts/<service>/...` path references to
  `agent-docs/doflow/<slug>/contracts/<service>/...` throughout `do-execute-plan`'s skill files.
- Installed docs (`DOFLOW_CHAIN.md`, `pm-agent.md`, two hook-script comments) no longer contain
  dev-tree-only `core/`-prefixed paths that read as broken once actually installed — confirmed
  live against a real installed copy, not just theoretically.

### Changed

- `do-execute-plan/SKILL.md`'s `--contracts` algorithm extracted to a co-located `contracts.md`,
  read only when `--contracts` is the active flag (progressive disclosure per Anthropic's Agent
  Skills best practices) — `SKILL.md` no longer pays that token cost on every other invocation
  (`--next`/`--phase`/`--all`/`--resume`/`--dry-run`). 105 → 87 lines.

## [0.2.0] - 2026-07-15

### Changed

- **Breaking (installed framework content):** consolidated the doflow spec-driven chain.
  `do-spec` merged into `do-brainstorm` (which now creates the feature branch/dir and writes
  `requirement.md` as part of its own Socratic-discovery flow); `do-tasks` merged into `do-plan`
  (writes the dependency-ordered task checklist as a rigid subsection inside `plan.md`, no
  separate `tasks.md`). `do-design` gained the same concrete resolver/file-write treatment,
  writing `design.md`. Artifact root renamed `agent-docs/specs/<slug>/` →
  `agent-docs/doflow/<slug>/`. The implement-phase hard gate now requires `requirement.md`,
  `design.md`, and `plan.md` (previously `plan.md`+`tasks.md` only — `design.md` is newly
  mandatory). `do-flow`'s auto-chain sequence and gate names updated to match; `do-constitution`
  no longer runs as an implicit phase-0 of `do-flow` — it stays a standalone, manually-invoked
  skill. In-flight `agent-docs/specs/<slug>/` feature directories from before this change are
  not auto-migrated.
- **Breaking:** retired `/do-load` and `/do-save`. Session-memory restoration
  (`last-compact-summary.md`, `uncommitted-warning.txt`) is now handled automatically by
  `user-prompt-submit.sh` — direct injection on the first prompt, no manual command needed.
  `pm-agent` reads/writes the underlying files directly.
- **Breaking (installed framework content):** replaced the `do-review` chain phase (code quality
  + `requirement.md`/`plan.md` traceability) with `do-code-review`, a portable, tool-agnostic
  code-quality skill covering 13 languages via dispatch rules, per-language rule files, and
  deterministic analyzer scripts (`pr_analyzer.py`, `code_quality_checker.py`,
  `review_report_generator.py`). `do-code-review` does not check requirement/task traceability —
  the doflow chain's Gate-B review step is now code-quality only. Every chain skill
  (`do-flow`, `do-brainstorm`, `do-execute-plan`, `do-pm`, `do-help`) and doc reference to
  `/do-review` was repointed to `/do-code-review`.
- **Breaking (installed framework content):** renamed `core/reference/` → `core/references/`;
  removed the standalone `JAVA_CODING_RULE.md`/`CODE_REVIEW_CHECKLIST.md` reference docs and the
  `code-conventions`/`java-conventions` skills (superseded by `do-code-review`'s per-language
  rule files). Removed the now-redundant `code-reviewer` agent (14 agents remain);
  `do-code-review` is self-contained and does not dispatch to it.

### Removed

- `do-spec`, `do-tasks`, `do-load`, `do-save`, `do-review`, `code-conventions`, `java-conventions`
  skills.
- `code-reviewer` agent.
- `core/reference/JAVA_CODING_RULE.md`, `core/reference/CODE_REVIEW_CHECKLIST.md`.

## [0.1.1] - 2026-07-13

### Fixed

- Retry `EAGAIN` on stdin reads left non-blocking by raw-mode prompts, instead of failing the
  prompt closed (`src/prompt.js`, `src/mcp.js`).

## [0.1.0] - 2026-07-09

### Added

- First public DoFlow release.
- Added the `doflow` CLI installer for Claude, Codex, and Gemini configuration targets.
- Added shared core rules, skills, agents, hooks, MCP configuration, and documentation.
- Added Node test coverage for install, update, rollback, diff, backup, MCP, and hook workflows.
