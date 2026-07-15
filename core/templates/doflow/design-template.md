# Design: [FEATURE NAME]

**Feature:** [NNN-slug] · **Requirement:** ./requirement.md · **Status:** Draft · **Created:** [DATE]

> System shape — architecture, APIs, data/interface contracts. Reads ./requirement.md.
> Distinct from plan.md's HOW-to-implement; this is HOW-it's-shaped.

## 1. Architecture Approach
[Component boundaries, where this fits in the existing system, 2–4 sentences.]

## 2. System Overview (C4)
[The visual complement to Architecture Approach above — lets a reader unfamiliar with this
feature see the shape before reading prose. Skip only for a trivial, single-file change with no
new external interaction or deployable unit — write "N/A: [why]" instead of the diagrams.]

### Context (C4 Level 1)
[Who/what uses this system, and which external systems/services it talks to. One box per actor
or external system — do not enumerate internal components here, that's the Container level below.]
```mermaid
C4Context
    title System Context — [FEATURE NAME]
    Person(user, "[actor/user]", "[who or what initiates this]")
    System(system, "[this system]", "[one-line responsibility]")
    System_Ext(ext, "[external system]", "[what it provides or consumes]")
    Rel(user, system, "[interaction, e.g. Uses]")
    Rel(system, ext, "[interaction, e.g. Calls / Reads from / Publishes to]")
```

### Container (C4 Level 2)
[Which deployable services/apps/data stores this feature spans, and how they talk to each other.
One box per independently deployable unit (service, SPA, batch job, database) — implementation
detail inside a single container belongs in Components & Boundaries below, not here.]
```mermaid
C4Container
    title Container Diagram — [FEATURE NAME]
    Person(user, "[actor/user]")
    System_Boundary(boundary, "[system name]") {
        Container(app, "[container name]", "[tech stack, e.g. Spring Boot]", "[responsibility]")
        ContainerDb(db, "[data store name]", "[tech, e.g. PostgreSQL]", "[what it holds]")
    }
    System_Ext(ext, "[external system]")
    Rel(user, app, "[interaction]", "[protocol, e.g. HTTPS/JSON]")
    Rel(app, db, "[interaction, e.g. Reads/writes]")
    Rel(app, ext, "[interaction]")
```

## 3. Components & Boundaries
- [component] → [responsibility]

## 4. API / Interface Contracts
[Endpoints, method signatures, or interface definitions — or "N/A".]

## 5. Data Model
[Schema, entities, relationships — or "N/A".]

## 6. Sequence / Data Flow
[Key interaction sequences, if non-trivial — or "N/A".]

## 7. Design Risks & Alternatives Considered
- [risk/alternative] → [why this shape was chosen]
