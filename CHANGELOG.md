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
