# Diagram Guide — what a good chain diagram looks like

`ARTIFACT_FORMAT.md` §4 says which artifact carries which diagram slot. This file says what belongs
inside one. Read on demand by `do-brainstorm`, `do-design` and `do-plan` at the point each fills a
slot, and never loaded into a session by default.

**Scope.** These rules govern every Mermaid diagram in a feature directory, including ones in
`as-is/`, `target/` or any other subdirectory a feature grows. The slot registry in §4 of
`ARTIFACT_FORMAT.md` lists only the slots a template scaffolds, because those are the ones a stage
is accountable for; the conventions here are wider than that list.

## 1. Permitted types

| Type | Carries |
|---|---|
| `flowchart` | Structure, scope boundaries, C4 levels, dependency order |
| `sequenceDiagram` | Time-ordered interaction between participants |
| `erDiagram` | Entities with attributes, keys and cardinality |
| `stateDiagram-v2` | States, transitions and the guards between them |

**The admission rule.** A type joins this list when it renders in GitHub, the VS Code Markdown
preview and Obsidian with no plugin installed by the reader, and its grammar is not marked
experimental by Mermaid. Both halves matter: a type that renders today but whose grammar is still
moving will silently change shape under artifacts already written against it.

**C4 is a zoom model here, not a diagram type.** `C4Context`, `C4Container`, `C4Component` and
`C4Dynamic` are excluded by the admission rule's second half — Mermaid's own C4 syntax documentation
states the C4 diagram is experimental and that its syntax and properties can change in future
releases. The practical cost is visible in Mermaid's own examples: relationship labels are placed by
hand with one `UpdateRelStyle($offsetX, $offsetY)` call per relationship, and layout is nudged
through `UpdateLayoutConfig` rather than a direction keyword. Render every C4 level with `flowchart`
plus `subgraph` instead, which gives explicit direction and puts each label on its arrow without
per-edge tuning.

**Everything else is excluded too**, including types that do render widely — `journey`, `timeline`,
`quadrantChart`, `gitGraph`, `mindmap` — and every `-beta` grammar. Not because any one of them is
bad, but because each added type is another set of conventions to carry and another surface that can
drift between renderers. Four types cover what the chain actually needs.

## 2. Choosing between them

| When the content is… | Reach for |
|---|---|
| What is in and out of scope | `flowchart`, `subgraph IN` / `subgraph OUT` |
| Actors and external systems, or deployable units, or a container's internals | `flowchart` with `subgraph` boundaries, one per C4 level |
| Phases, tasks and what must finish before what | `flowchart`, direction `LR` |
| Who calls whom, in what order, with the failure branch | `sequenceDiagram` |
| Entities and the relationships between them, no attributes yet | `flowchart` |
| Entities with their fields, keys and cardinality | `erDiagram` |
| A run, a lifecycle, or anything with named states and guarded transitions | `stateDiagram-v2` |

Two rules of thumb. If a three-column table says the same thing, write the table. If the content
wants two of these at once, it is two diagrams.

## 3. Complexity budget

Each type is bounded on what actually makes that type illegible, not on one number applied to all.

| Type | Element ceiling | Link ceiling |
|---|---|---|
| `flowchart` | 12 nodes | 16 edges |
| `sequenceDiagram` | 8 lifelines | none |
| `erDiagram` | 8 entities | none |
| `stateDiagram-v2` | 10 states | none |

`subgraph` containers do not count toward the node ceiling; they are grouping, not content.

**Why only `flowchart` carries a link ceiling.** A `sequenceDiagram` lays out columnwise — lifelines
vertical, messages horizontal — so no routing decision is ever made and nothing can tangle however
many messages it carries. A `flowchart` is routed by the layout engine, and above a certain density
that engine produces edges that overlap each other or cross boxes that are not their endpoints. The
edge ceiling exists for that failure and belongs only to the type that has it. The same reasoning
applies to `erDiagram` relations and `stateDiagram-v2` transitions: a reader tracks entities and
states, and the links follow from them.

**Where the numbers come from.** They were measured against 56 Mermaid diagrams in a completed
feature, not chosen for roundness. Flowchart node counts were bimodal: eleven diagrams at six nodes
or fewer, four at seventeen or more, and nothing in between twelve and sixteen. The ceiling sits in
that empty band, so every diagram the corpus treated as reasonable stays legal and the four that
should have been split are the ones flagged. Sequence lifelines ran three to thirteen with
twenty-three of twenty-six at eight or fewer. Entity counts never exceeded six and state counts
never exceeded seven, so those two ceilings are stated intent rather than a constraint the corpus
tested. Re-measure against your own corpus before moving a ceiling, and move it with the count
rather than by preference.

## 4. When a diagram is over budget

Split it into an overview and a detail diagram. The overview keeps the boxes a reader needs to
orient, and one of them expands into the detail diagram beneath it.

Do not shrink labels, do not drop the arrow labels, and do not accept the crowding because the
content "really is that big". Content that big is the signal, not the exception: a diagram past the
ceiling is two ideas sharing a frame, and the split is what separates them.

The one legitimate alternative is deletion. Two nodes that always travel together are one node, and
a relationship obvious from the layout does not need its own line.

## 5. Conventions

**Direction is declared, never left to default.** Write `flowchart TB` or `flowchart LR`. Pick `LR`
for anything that reads as a progression (scope, phases, dependency order) and `TB` for anything
that reads as containment or hierarchy.

**Labels go on the arrow, not in the node.** `A -->|"reads"| B`, not a node named "reads from B".
Keep an arrow label to a short verb phrase: if it needs a clause, the relationship is doing too much
and wants two arrows or a different type. Quote every label, so a comma or a parenthesis inside it
cannot end the label early.

**Node ids are short and stable; the text lives in the brackets.** `SVC["Payment service"]`, not
`PaymentService["Payment service"]`. An id is an anchor a later edit reuses; the label is prose that
changes freely.

**`subgraph` marks a boundary, and its label is quoted**: `subgraph boundary["Payment platform"]`.
Use it for a trust boundary, a deployable unit, a C4 level or a scope partition. Do not use it to
group things that merely look similar.

**In a `sequenceDiagram`, prefer `rect` over `par` to mark a region.** `par` renders as a split
block that reads as "these happen simultaneously", which is a claim most groupings do not want to
make and cannot support. `rect` groups without asserting concurrency. Reserve `par` for genuine
parallelism, and use `alt` for a branch.

**Keep edges inside their boundary.** An edge that crosses a `subgraph` boundary is the one the
layout engine routes across other edges, and it is what produces overlapping arrows and labels
stranded mid-canvas. This is not a density problem and the node ceiling does not catch it: a
six-node diagram with two boundary-crossing edges tangles where a nine-node diagram whose edges all
fan into one sink stays clean. Prefer edges within a boundary, or between two boundaries at the same
level. When a node inside a `subgraph` must reach one outside it, the boundary is usually drawn in
the wrong place — move it, or lift the shared node out.

**Secondary and asynchronous relations use `-.->`.** Reserve the dashed arrow for what it says:
optional, deferred, or out of band. A dashed arrow used for variety costs the reader the one signal
it carries.

**Skipping a slot is `N/A: [why]`.** That escape is a format rule and is defined once, in
`ARTIFACT_FORMAT.md` §4. A slot left silently empty cannot be told apart from an oversight.

## 6. Anti-patterns

| Pattern | Why it fails |
|---|---|
| A node per step of a process that has no branches | A numbered list says it in fewer words and reads faster |
| Every node the same shape and weight | Shape is the only hierarchy a diagram has; spending none of it flattens everything |
| An arrow with no label | The reader can see two things are connected and has to guess how |
| A label long enough to wrap | A wrapped label pushes its own arrow around and reads as a sentence, not an annotation |
| Restating a table that sits directly above it | Two representations of one fact drift apart, and the reader has to work out which is current |
| One diagram carrying both the overview and the detail | Past the ceiling this is the shape the split rule exists to break up |
| Colour or `classDef` styling as the only way to read it | Styling varies by renderer and theme; anything load-bearing belongs in the structure or the labels |
| A diagram nobody would miss | If removing it costs the reader nothing, it was decoration |
