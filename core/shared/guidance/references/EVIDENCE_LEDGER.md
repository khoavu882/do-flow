# Evidence Ledger — item schema, provenance, and what the runtime refuses

The shape of an evidence batch is the same for every stage that writes one, so it is stated once
here. A stage's own SKILL.md names the two commands it runs and what *its* items are; everything
below is common to all of them. Read this before writing a batch.

## The batch

One pass at the stage boundary, never one call per fact. The batch file is a JSON array, one object
per item — scratch input, deleted after the write. It is validated whole: **one rejected item writes
nothing**, so a half-written stage never reads as complete.

## Per item

- **`kind`** — one of `exact-search`, `semantic-retrieval`, `structural`, `historical`,
  `documentation`, `test-result`, `runtime-observation`, `user-statement`, `diff`,
  `generated-analysis`.
- **`provenance`** — `extracted` | `inferred` | `asserted`, with **no default**. An unstated
  provenance is refused rather than filed as repository fact.
- **`source`** — `provider` + `capability`. There is no `unknown` stand-in; if you cannot name what
  produced the item, you do not yet have the item.

Pairing rules: `extracted` needs a `locator`; `inferred` and `asserted` need `content`;
`generated-analysis` and `user-statement` can never be `extracted` — that pairing is how a reading
of the evidence stops being distinguishable from the evidence.

## The accepted set is closed

An item carries exactly `kind`, `provenance`, `source`, `locator`, `content`, `taskId` — nothing
else. Any other key is refused and the whole batch writes nothing, so a field you invent costs the
batch, not just the field. The list below is what people reach for most, and why each is absent:
`id`, `freshness`, `supports`/`contradicts`, `stage`, any score field. Freshness is measured at the
write, not declared by the writer; the ledger assigns the id; and evidence attaches to a claim by
linking (below), not by a field on the item.

## Claims

Each conclusion is added as a claim in the same pass and is stored as a `hypothesis`. It becomes
supported only through linked evidence — the `claim` verb's link action, naming the claim id, the
evidence id, and the relation, spelled exactly `supports` or `contradicts`. An earlier stage, a subagent, or
an artifact from a previous session having asserted something is not support.

The link refuses an evidence id the ledger does not hold: exit 2, naming the id, not a low grade.
Record the batch first, link afterwards. A claim carrying both fresh support and fresh
contradiction becomes `conflicted`.

## Relevance is not confidence

A match count, a ranking, a "best hit", a profiler's top hot path — each is a property of the query,
not of the fact. Record the locator. Never a score, a percentage, or a confidence.

## Readiness belongs to the stage that edits source

A stage whose `readinessTemplate` is `null` does not call `readiness`, and does not report one as
skipped: there is no source edit for it to gate. The per-class readiness contract itself is owned by
the `do-execute-plan` skill's own `readiness_gate.md` reference, not restated here.

## Source is not inference in the report either

The same items are the stage's completion report: per item, what was found, its source, its locator,
and whether it is **extracted** (read verbatim from the repository or a command) or **inferred**
(your analysis). Never merge those two provenances into one reported line.
