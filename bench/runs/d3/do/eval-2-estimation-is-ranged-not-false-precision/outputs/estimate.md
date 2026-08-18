# Estimate — add an eighth harness adapter

Produced by `do --estimate`. No files were edited: `do` stops after the estimate.

## Range

**2–4 engineer-days** at the scope the request names — registry entry, `src/adapters/<id>/index.js`
implementing the six-function contract, dispatch wiring, and the guard/test updates that keeps —
for someone already familiar with the registry/adapter seam.

**4–7 engineer-days** if the eighth harness also needs its own hook tree. The request does not say,
and this is the single largest width-setter (see assumptions).

**Complexity: Medium.** The blast radius is wide (registry, adapters, dispatch, targets, docs,
guards) but nothing about it is novel: the pattern has been executed seven times, all seven adapters
delegate materialisation to `src/adapters/copy-tree.js`, and there is no concurrency, no schema
migration, and no third-party integration.

## What the range is anchored to

This repo has done the work twice, recently, and the commits are measurable.

| Commit | Date | Scope | Files | Insertions |
| :-- | :-- | :-- | --: | --: |
| `ec9333d` | 2026-08-17 | declare copilot + kiro in the registry, extend targets to seven | 7 | 352 |
| `96006da` | 2026-08-17 | the two adapters + dispatch across all seven | 12 | 1374 |
| `8a87059` | 2026-08-17 | kiro's hook tree (out of the named scope) | 21 | 1149 |

The first two commits are the in-scope analogue: **1726 insertions over ~17 file touches for two
adapters**, i.e. roughly **860 insertions and ~9 file touches per adapter**. The third is the
hook cost, and it is why the range doubles when hooks are in scope.

File scope for the eighth, by inspection:

- `core/registry/harnesses.yaml` — ~93 lines per harness (186 for the two)
- `core/registry/assets.yaml` — ~35 lines per harness; `contracts.yaml` ~11; `lifecycle.yaml` ~4
- `src/adapters/<id>/index.js` — the seven existing run 228 (pi) to 578 (codex) lines, median 326
- `src/targets.js:14` — the hand-maintained `VALID` array plus a `toolDirs` entry
- `bin/doflow.js` and `src/lifecycle-view.js` — ~13 and ~9 lines of dispatch
- `test/<id>-adapter.test.js` — the existing per-adapter suites run 270–385 lines
- guards: G5 `registry.test.js` iterates `registry.harnesses` rather than naming them, so it extends
  automatically and starts failing until `VALID`, the adapter, and `core/harnesses/<id>` agree.
  `ec9333d` needed only 4 lines there and 36 in `test/doflow.test.js`.

## Assumptions that set the width

1. **Hooks are out of scope.** The request lists registry, adapter, dispatch, guards — not hooks.
   If the harness needs them, `8a87059` says that is 1149 insertions across 21 files on its own,
   and the range moves to 4–7 days. This is the dominant term.
2. **The harness's on-disk layout is expressible through `copy-tree`'s projection model.** All seven
   current adapters are, but within the same contract codex is 578 lines and pi is 228 — a 2.5x
   spread. A harness needing bespoke materialisation lands at the top of the range.
3. **No new native content under `core/harnesses/<id>/`** beyond what the projection covers
   (settings, native agent definitions). Kiro needed a tree there; opencode and pi did not.
4. **Docs updates are mechanical.** "seven" is prose-hardcoded in README.md:5, docs/overview.md:41
   and :52, docs/setup.md:21, docs/architecture.md:39/111/113, docs/capability-map.md:48/56/80/160/161,
   and in comments across seven test files. No guard enforces the harness count (G6 checks skill and
   agent counts only), so this is cheap to do and easy to forget — hours, not days, but unguarded.
5. **The engineer has read `docs/architecture.md`.** A newcomer to the registry/adapter/lifecycle
   boundary widens the low end by roughly a day of orientation.
6. **No MCP catalog work.** `core/registry/mcp.yaml` is 7 lines and neutral; if the harness needs a
   per-harness MCP writer that is additional, unmeasured scope.

## Unknowns that would narrow the range

- Naming the actual harness and its config layout — resolves assumptions 2, 3 and 6 at once and
  would collapse most of the width.
- A yes/no on the hook tree — resolves the dominant term.
- Whether `--target <id>` needs global-scope asymmetry the way copilot (`.github` vs `~/.copilot`)
  and opencode (`~/.config/opencode`) do; `src/targets.js`'s `toolDirs` comments show these are
  decided per harness, not derived.

No certainty figure is attached to this range. The six assumptions above are the honest statement of
what is not yet known; a percentage would only disguise them.
