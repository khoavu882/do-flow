# Specs: [FEATURE NAME]

**Feature:** [NNN-slug] · **Design:** ./design.md · **Maturity:** Draft · **Created:** [DATE]

> Machine-checkable interface/schema contracts split out of design.md's own narrative — endpoints,
> CLI verb signatures, repository/service interfaces, data schemas and file formats a design
> decided. Reads ./design.md; distinct from it the way a contract is distinct from the rationale
> that produced it.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, the document-level `Maturity` is `Draft`, `In review` or `Approved`, the item-level
> `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §2.

## 1. Interface Contracts

<!-- Document endpoints, CLI verb signatures, and repository/service interfaces that anchor
     implementation — one IC-### entry per contract, so plan.md and downstream implementation can
     cite a specific contract precisely instead of a paragraph of prose.

     The index carries a `Family` column, and the detail below is grouped under
     "#### Family: [name]" headings. Contracts are ordered within a family, and families are ordered
     as the index lists them. Each contract carries its own "#### IC-###: [summary]" heading so a
     reader can link to and cite one contract without scanning the block around it. A heading of
     that form counts as the contract's detail entry only when the same ID also appears in the first
     column of the index above; an ID-shaped heading with no matching index row is ignored. Grouping
     is navigation: it never shortens the normative text a contract carries. Write "N/A: [why]" in
     place of the index and detail when the feature introduces no interface contract. -->

| ID | Contract | Family | Kind | Status |
|---|---|---|---|---|
| IC-001 | [one-line summary] | [family name] | endpoint / cli-verb / schema / file-format | Live |
| IC-002 | [one-line summary] | [family name] | endpoint / cli-verb / schema / file-format | Live |

**Detail**

#### Family: [family name]

#### IC-001: [one-line summary]

[the full normative shape — for an `endpoint`: method, route, request/response
payload, status codes; for a `cli-verb`: verb name, flags, arguments, exit codes; for a `schema`:
repository/service interface (`interface` → `concrete` → `mock` pattern) or service method
signature (`[serviceMethod](params): ReturnType`); for a `file-format`: the file's key
fields/shape — every qualifier and exception intact].

#### IC-002: [one-line summary]

[the full normative shape, every qualifier and exception intact].

## 2. History

<!-- Superseded contracts move here; the index row above stays as a tombstone with
     `Superseded → <ref>`. -->

None — initial version.
