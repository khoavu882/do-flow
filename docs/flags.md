# Flag Index

A flag-first index of every flag declared in a skill's `argument-hint`, one row per (skill, flag)
pair, sorted by flag name so same-named flags cluster together. This complements, rather than
duplicates, two other references:

- [`reference.md`](./reference.md)'s "Full Skill Reference" table is organized **by skill** — one
  row per skill, its full `argument-hint` verbatim — and is kept in sync with each skill's
  frontmatter by `test/guards/reachability.test.js` (G8).
- [`FLAGS.md`](../core/shared/guidance/FLAGS.md) documents only cross-cutting *behavioral* flags
  that have a guidance-tree consumer (`--iterations`, `--focus`, `--validate`); it deliberately
  excludes skill-local invocation flags like `--depth` or `--type` (see its guard,
  `test/guards/flags.test.js`, "G4", and that guard's `NOT_FRAMEWORK_FLAGS` map).

This file owns exactly the gap between the two: every skill-local flag, organized **by flag**
rather than by skill, so a reader can see every place a given flag name is used without reading 13
separate `argument-hint` strings — and so that inconsistent reuse of the same flag name (different
allowed values across skills) is visible side by side instead of hidden in separate rows of
`reference.md`. A mismatch surfaced here is a content judgment to resolve in a later remediation
phase, not a guard failure by itself.

| Flag | Skill | Values | Purpose |
|---|---|---|---|
| --all | do-execute-plan | (boolean flag) | execute all pending tasks |
| --amend | do-constitution | (boolean flag) | amend existing constitution vs create |
| --clean | do-test | (boolean flag) | clean before build/test run |
| --confirm | do-git | (boolean flag) | explicit go-ahead for mutating op |
| --contracts | do-execute-plan | (boolean flag) | generate cross-service contract code frames |
| --coverage | do-test | (boolean flag) | measure line and branch coverage |
| --depth | do | shallow \| normal \| deep | multi-part request decomposition depth |
| --depth | do-brainstorm | shallow \| normal \| deep | exploration breadth |
| --depth | do-document | quick \| standard \| deep | research depth |
| --depth | do-plan | normal \| deep | planning task granularity |
| --estimate | do | (boolean flag) | produce scope/effort estimate |
| --fix | do-diagnose | (boolean flag) | apply remediation after approval |
| --focus | do-diagnose | quality \| security \| performance \| architecture | narrow analysis domain |
| --format | do-design | diagram \| spec \| code | design output format |
| --from | do-flow | brainstorm \| design \| plan \| implement \| test \| review | override phase auto-detection |
| --from-review | do-implement | (boolean flag) | work from review findings |
| --iterations | do-diagnose | n (integer) | improvement cycle count |
| --next | do-execute-plan | (boolean flag) | select next pending task |
| --no-review | do-execute-plan | (boolean flag) | skip post-execution review pass |
| --phase | do-execute-plan | N (integer) | target one specific phase |
| --resume | do-execute-plan | (boolean flag) | resume interrupted execution |
| --review | do-execute-plan | (boolean flag) | run post-execution review pass |
| --strategy | do-brainstorm | systematic \| agile \| enterprise | discovery approach shaping depth |
| --strategy | do-plan | systematic \| agile | planning approach |
| --sync | do-execute-plan | (boolean flag) | sync dispatch state fallback |
| --tools | do | (boolean flag) | select optimal capability/tool |
| --trace | do-diagnose | (boolean flag) | enable execution tracing |
| --type | do-design | architecture \| api \| component \| database | design artifact type |
| --type | do-diagnose | bug \| perf \| security \| refactor | diagnostic mode selection |
| --type | do-document | api \| guide \| impl \| index \| research | documentation artifact type |
| --type | do-test | unit \| integration \| e2e \| build \| all | test mode selection |
| --validate | do-diagnose | (boolean flag) | pre-execution risk assessment gate |
| --watch | do-test | (boolean flag) | interactive watch mode |

`do-code-review` declares no `argument-hint` and contributes no rows.
