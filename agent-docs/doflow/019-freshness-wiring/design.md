# Design: Freshness Wiring

**Feature:** 019-freshness-wiring · **Requirement:** ./requirement.md · **Status:** Draft · **Created:** 2026-08-21

## 1. Architecture Approach

One call site and one memo. `handleReadinessCommand` already loads the ledger and constructs the
engine; freshness re-evaluation slots between those two steps. `FreshnessValidator` needs no new
capability — it needs a caller and a cache.

## 2. System Overview (C4)

### C1: System Context

```mermaid
flowchart TB
    subgraph actors["Actors"]
        ENG["Engineer<br/>(asks whether a task is ready)"]
    end
    subgraph system["DoFlow runtime"]
        RD["readiness verb"]
        FV["FreshnessValidator<br/>(read half, currently unwired)"]
    end
    REPO["The repository<br/>(git HEAD, working tree)"]

    ENG -->|"doflow readiness"| RD
    RD -->|"re-evaluates before counting"| FV
    FV -->|"git status / git diff"| REPO
```

### C2: Container

N/A: single process, no deployable boundary crossed.

### C3: Component

```mermaid
flowchart TB
    subgraph runtime["src/runtime/"]
        CLI["cli.js<br/>handleReadinessCommand"]
        LED[("evidence-ledger.js<br/>in-memory items")]
        FRESH["freshness.js<br/>FreshnessValidator"]
        RDY["readiness.js<br/>ReadinessEngine"]
    end

    CLI -->|"1. load"| LED
    CLI -->|"2. revalidate"| FRESH
    FRESH -->|"marks items STALE in memory"| LED
    CLI -->|"3. evaluate"| RDY
    RDY -->|"queries FRESH only"| LED
```

## 3. Components & Boundaries

| ID | Component | Kind | Serves | Status |
|---|---|---|---|---|
| C1 | Re-validation call in `handleReadinessCommand` | runtime module | FR-001, FR-002 | Live |
| C2 | Per-commit diff memo in `FreshnessValidator` | runtime module | FR-003 | Live |
| C3 | Stale reporting in the readiness verdict | runtime module | FR-004 | Live |

**Detail**

- **C1** → Calls `validateLedgerFreshness` on the loaded ledger before the engine evaluates, and
  never calls `ledger.save`. The ledger object is mutated in memory only, which is what keeps a read
  operation from writing.
- **C2** → A `Map` from commit sha to the modified-file `Set`, held on the validator instance and
  therefore per invocation. Evidence written in one batch shares one commit, so the common case
  collapses from one `git diff` per item to one per batch.
- **C3** → Reports the stale items by id and locator alongside the existing unresolvable list, so
  the two reasons a verdict moved stay distinguishable.

## 4. API / Interface Contracts

- **`FreshnessValidator`** gains no new public method. `getModifiedFilesSince(refCommit)` memoises
  on `refCommit`; `validateLedgerFreshness(ledger)` keeps its signature and return (count marked).
- **`handleReadinessCommand`** gains no new parameter. The re-validation is unconditional.
- **Readiness report** gains `staleEvidence: [{ evidenceId, locator, reason }]`, mirroring the
  shape of the existing `unresolvableEvidence`.

## 5. Data Model & Specifications

No stored shape changes. The `freshness.status` field on an item is written `FRESH` at record time
as before; the read-time overlay changes it in memory only and is never saved.

## 6. Sequence / Data Flow

```mermaid
sequenceDiagram
    participant E as Engineer
    participant C as handleReadinessCommand
    participant F as FreshnessValidator
    participant R as ReadinessEngine

    E->>C: readiness --task-id ...
    C->>C: ledger.load(taskId)
    C->>F: validateLedgerFreshness(ledger)
    F->>F: memo miss -> git diff <commit>
    F->>F: memo hit for every later item on that commit
    F-->>C: n items marked STALE (in memory)
    C->>R: evaluateReadiness(profile, ledger, claims)
    R-->>E: verdict, naming any stale items
    Note over C: ledger.save is never called
```

## 7. Design Risks & Alternatives Considered

| ID | Risk / Alternative | Disposition | Status |
|---|---|---|---|
| R1 | Gates that pass today begin failing | accepted | Live |
| R2 | Alternative: persist STALE on write | rejected | Live |
| R3 | Alternative: wire `invalidateFiles` instead | rejected | Live |
| R4 | git cost on every readiness call | mitigated | Live |

**Detail**

- **R1** → This is the point of the change, not a side effect: a gate that could never see stale
  evidence was reporting a confidence it had not earned. Accepted deliberately, and it is why this
  is a feature rather than a fix.
- **R2** → Rejected. A stored verdict goes stale itself, and the write path would have to guess a
  future in which the file might change.
- **R3** → Rejected. `invalidateFiles` takes a caller-supplied file list, which pushes the question
  of *which* files changed back onto every caller. `validateLedgerFreshness` answers it from git.
- **R4** → Mitigated by C2's memo. The floor is one `git status` plus one `git diff` per distinct
  recorded commit, and a task's evidence is usually written in one or two batches.

## 8. Assumptions

None — no design-level clarification questions were deferred.

## 9. History

None — initial version.
