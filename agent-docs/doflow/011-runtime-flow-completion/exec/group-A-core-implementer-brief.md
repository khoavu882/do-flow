# Group brief: A:core-implementer

> Composed from plan.md, requirement.md and design.md. This brief covers multiple tasks that share an owner.

## Shared context

### Where this fits

Three phases ordered by what each depends on, not by conceptual grouping. Phase A wires primitives
that already exist into the skills that should call them — every task edits a different skill file,
so the whole phase runs in parallel. Phase B builds the two new runtime modules; each verb's module,
its dispatcher registration and its documentation land as a single task, because the guards treat
those as one namespace and a partial edit fails the suite. Phase C adds the guard that prevents the
wiring gap recurring, and it must land last: a guard asserting every verb has a caller cannot pass
until every caller from Phases A and B exists.
The key technical decision is that nothing in this plan changes routing. Freshness is recorded and

### Global constraints — these bind every task

- **NFR-001 (No numeric verdicts):** Every state this feature introduces or consumes — readiness,
  retrieval coverage, task outcome — MUST be a discrete state from a stated vocabulary. Score-shaped
  inputs MUST continue to be refused by name. The reason is evidential rather than stylistic: a
  number invites arithmetic across items that were never measured on the same scale, and hides the
  difference between a check that failed and a check that never ran.
- **NFR-002 (Harness parity):** Every behaviour added here MUST reach all seven installed tools
  identically. A gate that fires in one harness and not another is worse than no gate, because it
  makes the guarantee unreliable rather than absent.
- **NFR-003 (Test scoping preserved):** The default test command MUST remain scoped to the test
  tree. Anything this feature adds that produces test-shaped files outside it MUST NOT become
  reachable by the default run.
- **NFR-004 (Skips are as visible as blocks):** Where FR-002 exempts a run from a gate, and where
  FR-010 reports an unreached item, the report MUST make the skip as prominent as a failure. A
  silently skipped check reads as a passed check, which is the failure this feature exists to
  remove.

## Task order

A.1 → A.2 → A.3 → A.4 → A.5   (write each task's report before starting the next)

## Task A.1

A.1 [P] [US1] [US3] Add readiness evaluation, the standalone exemption and context-pack compilation to do-implement — owner: core-implementer; files: core/shared/skills/do-implement/SKILL.md

### Why (user story)

**US1 (P1):** As an engineer working in a repository that installed DoFlow, I want readiness to
  actually gate my bug, refactor and dependency-change work, so that the templates those classes
  declare protect me rather than merely describing an intention.

### Requirements — build exactly these

- **FR-001:** `do-implement` MUST evaluate the readiness contract for the task class it is serving
  and MUST refuse to modify source when the resulting state is `BLOCKED`, reporting which
  requirement is unmet and what evidence would satisfy it. This applies to every class that names
  `do-implement` as its implementation stage and declares a `readinessTemplate` — `bug`,
  `refactor`, `dependency-change` and `trivial-edit` — with no exemption for `trivial-edit`
  (see A2). The three non-blocking states MUST NOT prevent the edit.
- **FR-002:** When `do-implement` is invoked standalone — no recorded task state for the id it is
  given — it MUST proceed as it does today, without evaluating readiness and without compiling a
  context pack. The escape hatch that `do-implement` exists to provide MUST survive this feature.
  The exemption MUST be reported when it applies, so a skipped gate is visible rather than silent.
- **FR-012:** The pre-implement-gate hook MUST retain its current behaviour and scope. Readiness
  evaluation inside the skill and file-existence checking inside the hook are two independent
  layers, and neither may be made to depend on the other.

### Files you own

core/shared/skills/do-implement/SKILL.md

### Verification bar

| FR-001 | A `bug`-class task with a `BLOCKED` readiness state cannot edit source through `do-implement` |
| FR-002 | A standalone invocation with no evidence record completes, and its report names the skipped gate |
| FR-012 | CH9 pins the pre-implement-gate hook's behaviour |
- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;

## Task A.2

A.2 [P] [US3] Add context-pack compilation to do-design, do-plan and do-execute-plan, each stating its empty-pack handling — owner: core-implementer; files: core/shared/skills/do-design/SKILL.md, core/shared/skills/do-plan/SKILL.md, core/shared/skills/do-execute-plan/SKILL.md

### Why (user story)

**US3 (P2):** As an agent executing a stage, I want the evidence and claims earlier stages
  recorded to be compiled and handed to me, so that my work rests on what was established rather
  than on what I can re-derive.

### Requirements — build exactly these

- **FR-003:** `do-design`, `do-plan`, `do-execute-plan` and `do-implement` MUST obtain their prior
  context by compiling the recorded evidence and claims for the task, rather than by re-reading
  artifacts directly. Discovery stages remain producers only: they have no prior context to
  compile.
- **FR-004:** The empty-pack failure contract MUST NOT change — nothing recorded stays distinct
  from nothing needed. Each stage added by FR-003 MUST decide for itself what an empty pack means
  and report that decision, rather than the runtime deciding on their behalf.
- **FR-005:** `do-code-review` MUST record its findings as evidence with locators, and its
  conclusions as claims, using the same provenance vocabulary as every other recording stage. A
  finding derived from reading code and a finding asserted from judgement MUST remain
  distinguishable.
- **FR-006:** `do-document` MUST record the factual basis for what it writes as evidence, and its
  conclusions as claims. This is the safeguard its own workflow class names: the characteristic
  failure of documentation work is asserting something nobody checked.

### Files you own

core/shared/skills/do-design/SKILL.md, core/shared/skills/do-plan/SKILL.md, core/shared/skills/do-execute-plan/SKILL.md

### Verification bar

| FR-003 | Each of the four stages issues a context-pack call; asserted by the CH8 guard's caller scan |
| FR-004 | `context-pack`'s exit-1-on-empty behaviour is unchanged; each new call site states its handling |
- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;

## Task A.3

A.3 [P] [US3] Add stage-boundary evidence and claim recording to do-code-review — owner: core-implementer; files: core/shared/skills/do-code-review/SKILL.md

### Why (user story)

**US3 (P2):** As an agent executing a stage, I want the evidence and claims earlier stages
  recorded to be compiled and handed to me, so that my work rests on what was established rather
  than on what I can re-derive.

### Requirements — build exactly these

- **FR-003:** `do-design`, `do-plan`, `do-execute-plan` and `do-implement` MUST obtain their prior
  context by compiling the recorded evidence and claims for the task, rather than by re-reading
  artifacts directly. Discovery stages remain producers only: they have no prior context to
  compile.
- **FR-004:** The empty-pack failure contract MUST NOT change — nothing recorded stays distinct
  from nothing needed. Each stage added by FR-003 MUST decide for itself what an empty pack means
  and report that decision, rather than the runtime deciding on their behalf.
- **FR-005:** `do-code-review` MUST record its findings as evidence with locators, and its
  conclusions as claims, using the same provenance vocabulary as every other recording stage. A
  finding derived from reading code and a finding asserted from judgement MUST remain
  distinguishable.
- **FR-006:** `do-document` MUST record the factual basis for what it writes as evidence, and its
  conclusions as claims. This is the safeguard its own workflow class names: the characteristic
  failure of documentation work is asserting something nobody checked.

### Files you own

core/shared/skills/do-code-review/SKILL.md

### Verification bar

| FR-003 | Each of the four stages issues a context-pack call; asserted by the CH8 guard's caller scan |
| FR-004 | `context-pack`'s exit-1-on-empty behaviour is unchanged; each new call site states its handling |
- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;

## Task A.4

A.4 [P] [US3] Add stage-boundary evidence and claim recording to do-document — owner: core-implementer; files: core/shared/skills/do-document/SKILL.md

### Why (user story)

**US3 (P2):** As an agent executing a stage, I want the evidence and claims earlier stages
  recorded to be compiled and handed to me, so that my work rests on what was established rather
  than on what I can re-derive.

### Requirements — build exactly these

- **FR-003:** `do-design`, `do-plan`, `do-execute-plan` and `do-implement` MUST obtain their prior
  context by compiling the recorded evidence and claims for the task, rather than by re-reading
  artifacts directly. Discovery stages remain producers only: they have no prior context to
  compile.
- **FR-004:** The empty-pack failure contract MUST NOT change — nothing recorded stays distinct
  from nothing needed. Each stage added by FR-003 MUST decide for itself what an empty pack means
  and report that decision, rather than the runtime deciding on their behalf.
- **FR-005:** `do-code-review` MUST record its findings as evidence with locators, and its
  conclusions as claims, using the same provenance vocabulary as every other recording stage. A
  finding derived from reading code and a finding asserted from judgement MUST remain
  distinguishable.
- **FR-006:** `do-document` MUST record the factual basis for what it writes as evidence, and its
  conclusions as claims. This is the safeguard its own workflow class names: the characteristic
  failure of documentation work is asserting something nobody checked.

### Files you own

core/shared/skills/do-document/SKILL.md

### Verification bar

| FR-003 | Each of the four stages issues a context-pack call; asserted by the CH8 guard's caller scan |
| FR-004 | `context-pack`'s exit-1-on-empty behaviour is unchanged; each new call site states its handling |
- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;

## Task A.5

A.5 [P] [US4] Add a recorded-run observability read to the do dispatcher — owner: core-implementer; files: core/shared/skills/do/SKILL.md

### Why (user story)

**US4 (P2):** As a DoFlow maintainer, I want recorded runs to be readable by something that runs,
  so that decisions about routing and readiness become measurable instead of argued.

### Requirements — build exactly these

- **FR-007:** At least one skill MUST read recorded-run observability, so that the measurement
  DoFlow already collects is consumed by something that runs. Analysis that cannot be settled from
  recorded metadata MUST continue to report an undetermined result rather than a clear one.
- **FR-009:** No skill that does not already resolve information needs through the capability
  router MUST gain that behaviour in this feature. The router's current reach is treated as a
  deliberate posture pending measurement, not as an incomplete rollout.

### Files you own

core/shared/skills/do/SKILL.md

### Verification bar

| FR-007 | `do` reads observability; asserted by the CH8 guard's caller scan |
| FR-009 | CH9 pins the set of router-resolving skills; a change to it fails the suite |
- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;

