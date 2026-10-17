# Spec: the candidate and evidence boundary

Contract document for feature 074 (P0). It separates a retrieval candidate, which may carry a rank
or score, from evidence, which never does, and it states what an empty or unreached answer may and
may not be taken to prove. It changes no runtime behaviour. The score refusal it describes is
enforced today by `assertNoScoreFields` (`src/runtime/cli.ts:244-250`) over the names in
`EVIDENCE_SCORE_FIELDS` (`src/runtime/cli.ts:229-232`); the binding of evidence to a query or
attempt is a `target` that the current ledger only partly meets (see Evidence).

## Candidate

A candidate is a possible answer a provider returned for one query. It is a pointer, not a fact.

| Field | Meaning |
|---|---|
| `locator` | Where the candidate is: file and line, or a URI |
| `provider` | The provider id that returned it |
| `queryRef` or `attemptRef` | The query, or the task attempt, that produced it |
| `sourceVersion` | The version of what was searched: a commit, a file hash or an index build |
| `rank` or `score` | How the provider ordered it |

The rank or score exists only on a candidate. It is a property of one search, not of the thing found,
so it is dropped when a candidate is turned into evidence. An illustration of one candidate, which the
evidence of the first example below was recorded from:

```json
{
  "locator": { "file": "src/runtime/retrieval-plan.ts", "line": 251 },
  "provider": "ripgrep",
  "queryRef": "plan-074#need-2",
  "sourceVersion": "3fc988bc519cd7ac289f6db64dfa15b78457cf1b",
  "rank": 1
}
```

A reader who can see where a fact came from
does not need to be told how sure to be.

### Code retrieval candidates

The code-scoped retrieval response uses an inclusive span `{file, line, endLine}` and may include
all contributing provider origins, ranks, fused score and a provider snippet. Those fields remain
candidate data. Provider snippets are ignored for verification: the runtime reads the admitted live
source file, checks containment, membership, range and file identity, and uses only that bounded
live read for delivered content. Index identity and the later live `sourceVersion` remain separate.

The evidence projection function `projectEvidenceCandidates` (`src/runtime/knowledge/code-validation.ts`)
is a library function with no production caller; only tests call it. Evidence for a code candidate
remains an explicit caller action (`evidence add`), and the candidate response never writes evidence
(follow-up FU-rkt8hs). When called, the projection creates one item per contributing provider and keeps only the registered
provider, capability, declared need, locator, measured source version and validated content. It
drops ranks, scores, fused ranking values, origin arrays and untrusted provider snippets. Query and
active task-attempt references are stamped from the stored retrieval plan and attempt, never taken
from candidate-supplied fields. Returning a candidate does not itself write evidence or derive a
`RETRIEVED` attempt.

## Evidence

Evidence is a recorded fact with a locator and content. It carries no field named in
`EVIDENCE_SCORE_FIELDS`: `confidence`, `score`, `relevance`, `relevanceScore`, `similarity`,
`certainty`, `probability`, `rank`, `distance` and `weight`. The ledger refuses these names at three
input surfaces: argv, a batch file and a verb's option object.

Evidence binding is implemented. Passing `--need <intent>` resolves the task's current plan and
stamps `source.queryRef`; when a task attempt is active, the writer also stamps
`source.attemptRef`. Binding by provider alone is not enough, because two queries to one provider
yield different evidence and a provider name cannot tell a reader which query an item answers.
Query-bound plans link evidence by `source.queryRef` and compatible attempt reference. Legacy plans
without a `planId` keep provider matching for compatibility.

## Absence

One empty provider response does not establish repository-wide absence. A provider that answered
empty has searched one index or one tree, with one query, at one version.

- The vocabulary is preserved from `src/runtime/retrieval-plan.ts:65 and :74`: results `RETRIEVED`,
  `EMPTY`, `UNREACHED` and `UNVERIFIED`; freshness `FRESH`, `STALE`, `UNKNOWN` and
  `NOT_APPLICABLE`. This document adds no word.
- `UNREACHED` means the provider was never asked. It is not `EMPTY`.
- An empty answer from an index whose freshness is `UNKNOWN` becomes `UNVERIFIED`; one from a `STALE`
  index stays `EMPTY` with the staleness marked beside it (`src/runtime/retrieval-plan.ts:87-92`).
- `STALE` and `UNKNOWN` may suggest locators to check and cannot prove absence. A claim that something
  does not exist needs a fresh answer from a provider that was reached, or a direct read of the source.

## Examples

Each example is a fenced `json` block directly under its marker line. The marker names the example and
says whether the contract accepts it. The block under `invalid-score-evidence` is rejected by
`assertNoScoreFields`; the other two invalid examples break the binding and absence rules and are
rejected by this document, not by that function.

<!-- example: valid-1 valid -->
```json
{
  "evidence": {
    "kind": "exact-search",
    "source": { "provider": "ripgrep", "capability": "code.exact-search", "queryRef": "plan-074#need-2" },
    "locator": { "file": "src/runtime/retrieval-plan.ts", "line": 251 },
    "content": "function evidenceIdsFor(need, items) {",
    "freshness": { "status": "FRESH" }
  }
}
```

<!-- example: invalid-score-evidence invalid -->
```json
{
  "evidence": {
    "kind": "semantic-retrieval",
    "source": { "provider": "semble", "capability": "code.semantic-search", "queryRef": "plan-074#need-3" },
    "locator": { "file": "src/runtime/context-pack.ts", "line": 459 },
    "content": "uncapped context-pack verb",
    "score": 0.83,
    "freshness": { "status": "FRESH" }
  }
}
```

<!-- example: invalid-provider-binding invalid -->
```json
{
  "evidence": {
    "kind": "exact-search",
    "source": { "provider": "ripgrep", "capability": "code.exact-search" },
    "locator": { "file": "src/registry/index.ts", "line": 410 },
    "content": "for (const [capability, declaration] of Object.entries(harness.capabilities))",
    "freshness": { "status": "FRESH" }
  }
}
```

<!-- example: invalid-stale-absence invalid -->
```json
{
  "id": "ev_076_0004",
  "kind": "structural",
  "provenance": "extracted",
  "source": {
    "provider": "graphify.query",
    "capability": "code.dependents",
    "queryRef": "rp_m1x2y3_ab12#impact.dependents",
    "attemptRef": "A.1#1"
  },
  "locator": {},
  "content": "no dependents of fuseHybridResults",
  "establishes": ["architecture_mapped"],
  "result": "EMPTY",
  "freshness": {
    "gitCommit": "6ae3de7...",
    "fileHash": null,
    "isDirty": null,
    "treeFingerprint": "sha256:...",
    "observedAt": "2026-10-14T00:00:00.000Z",
    "status": "STALE"
  }
}
```

## Refresh

- Trigger: a change to `EVIDENCE_SCORE_FIELDS`, to the result or freshness vocabulary in
  `src/runtime/retrieval-plan.ts`, or to the way the evidence ledger binds an item to a query or attempt.
- Owner: the author of the feature that changes the retrieval plan or the evidence boundary, reviewed
  at that feature's design gate.
