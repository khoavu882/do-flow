# Flag Index

A flag-first index of every flag declared in a skill's `argument-hint`, one row per (skill, flag)
pair, sorted by flag name so same-named flags cluster together. A second, separate table at the
bottom does the same for the `doflow` CLI's verb-local flags, which come from the CLI rather than
from any skill's frontmatter. This complements, rather than duplicates, two other references:

- [`reference.md`](./reference.md)'s "Full Skill Reference" table is organized **by skill** — one
  row per skill, its full `argument-hint` verbatim — and is kept in sync with each skill's
  frontmatter by `test/guards/reachability.test.js` (G8).
- [`FLAGS.md`](../core/shared/guidance/FLAGS.md) is the always-loaded statement of what the runtime
  now does unconditionally. The only flag it still documents is `--focus`, the one flag that is not
  skill-local; it deliberately excludes the rest, like `--depth` or `--type` (see its guard,
  `test/guards/flags.test.js`, "G4", and that guard's `NOT_FRAMEWORK_FLAGS` map).

This file owns exactly the gap between the two: every skill-local flag, organized **by flag**
rather than by skill, so a reader can see every place a given flag name is used without reading 13
separate `argument-hint` strings — and so that inconsistent reuse of the same flag name (different
allowed values across skills) is visible side by side instead of hidden in separate rows of
`reference.md`. A mismatch surfaced here is a content judgment to resolve in a later remediation
phase, not a guard failure by itself.

| Flag | Skill | Values | Purpose |
|---|---|---|---|
| --amend | do-constitution | (boolean flag) | amend existing constitution vs create |
| --clean | do-test | (boolean flag) | clean before build/test run |
| --confirm | do-git | (boolean flag) | explicit go-ahead for mutating op |
| --depth | do | shallow \| normal \| deep | multi-part request decomposition depth |
| --depth | do-brainstorm | shallow \| normal \| deep | exploration breadth |
| --depth | do-document | shallow \| normal \| deep | research depth |
| --depth | do-plan | shallow \| normal \| deep | planning task granularity |
| --estimate | do | (boolean flag) | produce scope/effort estimate |
| --fix | do-diagnose | (boolean flag) | apply remediation after approval |
| --focus | do-diagnose | quality \| security \| performance \| architecture | narrow analysis domain |
| --from | do-flow | brainstorm \| design \| plan \| implement \| test \| review | override phase auto-detection |
| --from-review | do-implement | (boolean flag) | work from review findings |
| --review | do-execute-plan | boolean, `=false` to skip | post-execution review pass, on by default |
| --scaffold | do-execute-plan | (boolean flag) | emit a reviewable code scaffold under the feature dir instead of executing |
| --scope | do-execute-plan | next \| phase:N \| all \| resume | which pending work this run executes |
| --type | do-design | architecture \| api \| component \| database | design artifact type |
| --type | do-document | api \| guide \| impl \| index \| research | documentation artifact type |
| --watch | do-test | (boolean flag) | interactive watch mode |

`do-code-review` declares no `argument-hint` and contributes no rows.

## Runtime verb flags

A separate index, because these flags belong to `doflow` CLI verbs rather than to a skill's
`argument-hint`, and the table above is defined by that frontmatter. Only verbs whose flags are not
already shared across the whole runtime surface (`--task-id`, `--task-class`, `--action`, `--json`)
appear here; the full per-verb contracts are in [`reference.md`](./reference.md)'s "Runtime &
Diagnostics Commands" table.

The flag column is backticked and the verb column is not a skill name, which is what keeps
`test/guards/flag-index.test.js` (G10) from reading these rows as stale skill rows — G10 owns the
skill table above and deliberately says nothing about this one.

| Flag | Verb | Values | Purpose |
|---|---|---|---|
| `--need` | `retrieval-plan` | an intent id, comma-separated or repeated | on `declare`, the information needs the stage intends to resolve; on `report`, the ones it states it actually asked |
| `--stage` | `retrieval-plan`, `outcome` | a stage id | on `retrieval-plan`, which stage declared the plan; on `outcome`, which stage is writing it — refused unless it is the class's terminal stage |
| `--state` | `outcome` | `COMPLETED` \| `BLOCKED` \| `ABANDONED` \| `INCONCLUSIVE` | the terminal state being recorded; anything outside the four is refused with the valid set |
| `--readiness` | `outcome` | `READY` \| `NEEDS_EVIDENCE` \| `NEEDS_USER_DECISION` \| `BLOCKED` | the readiness state the run states it saw; validated against `readiness`'s own vocabulary and recorded as stated, not measured. Omitted records `NOT_RECORDED` |
| `--verification` | `outcome` | `PASS` \| `FAIL` \| `INCONCLUSIVE` | the verification verdict the run states it saw; recording an outcome never re-runs the contract. Omitted records `NOT_RECORDED` |
| `--replaced-by` | `claim` | a claim id the store already holds | on `--action supersede`, the claim that replaces this one. Refused when it names a claim that is not recorded — a forward pointer to nothing is worse than no pointer |
| `--plan-path` | `verify` | a path to a feature's `plan.md` | the plan whose `doflow-verification` block overrides manifest detection, for a repository with no build or test manifest to detect |
| `--path` | `leak-scan` | a file path, repeatable | the files to scan for DoFlow-internal identifiers; each occurrence appends |
