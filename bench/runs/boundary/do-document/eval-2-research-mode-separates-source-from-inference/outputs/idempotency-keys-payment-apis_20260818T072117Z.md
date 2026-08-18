# Research report: current approaches to idempotency keys in payment APIs

**Query:** What are the current approaches to idempotency keys in payment APIs?
**Date:** 2026-08-18 | **Depth:** standard (default — no `--depth` flag was given)
**Overall confidence:** High for the mechanism and its two dominant real-world implementations
(directly confirmed against official docs); Medium for the emerging-standard status and for the
Airbnb case study (one source could not be fetched directly — see Methodology and the Citation
Table's confidence column).

---

## How to read this report

Every factual sentence below is tagged one of two ways:

- **[SOURCED: n]** — a claim traceable to a specific fetched/searched source, keyed to the
  Citation Table's numbering. Where I paraphrase rather than quote, the tag still means the
  underlying fact came from that source, not from me.
- **[INFERENCE]** — my own synthesis, comparison, or judgment across sources — a pattern I noticed,
  a reason I supply for why sources differ, or a recommendation. Nothing tagged `[INFERENCE]`
  should be treated as independently verified; it is this report's own reasoning layered on top of
  the sourced facts above it.

A paragraph with no tag is transitional prose (section framing), not a claim.

---

## Methodology

Followed this skill's `references/deep_research.md` process: query decomposition into independent
search vectors, batch (parallel) retrieval, and claim/source tracking. `references/RESEARCH_CONFIG.md`
names Tavily as the primary search tool with `native_websearch` as its documented fallback
**[INFERENCE: this environment has no Tavily MCP server available, so I used the fallback path
the config itself specifies — the WebSearch and WebFetch tools — rather than treating the
methodology as inapplicable]**. Six independent search queries were issued (payment-API best
practices, Stripe's own docs, the IETF standardization effort, distributed-systems design
patterns, PayPal's mechanism, and a follow-up on Airbnb's specific implementation), followed by
five targeted fetches of the most authoritative pages surfaced (Stripe's own API reference, the
IETF datatracker page for the current draft, a widely-cited Postgres implementation pattern
article, and two attempts at Airbnb's engineering blog post, both of which failed with a
connection reset — that source is represented below only through the search-engine snippets and a
secondary GeeksforGeeks/Medium summary of it, flagged accordingly in the Citation Table).

---

## Findings

### 1. The common mechanism: client-generated key + idempotent replay

Every payment provider examined uses the same base pattern **[SOURCED: 1, 2, 3]**: the *client*
generates a unique key (not the server) and sends it in a request header on a normally
non-idempotent write (`POST`); the server stores the key alongside the result of the first
request it processes for that key; any subsequent request carrying the same key gets back the
*stored* result instead of being reprocessed **[SOURCED: 1]**. Stripe's specific implementation:
header `Idempotency-Key`, applies to `POST` requests only (not `GET`/`DELETE`, which are already
idempotent by HTTP definition), recommends a V4 UUID or another random string with enough entropy,
allows keys up to 255 characters, and explicitly warns against putting sensitive data (emails,
personal identifiers) in the key itself **[SOURCED: 1]**. PayPal's equivalent is the
`PayPal-Request-Id` header, required on `POST`/`PUT` requests where supported (not universal
across all PayPal REST endpoints), recommended as a UUID to fit its 38-single-byte-character
limit, and unique per request *and* per API-call type **[SOURCED: 2]**.

### 2. Standardization is in progress but not yet finalized

The HTTPAPI working group at the IETF has an active Internet-Draft,
`draft-ietf-httpapi-idempotency-key-header` (at revision `-07` as of the draft dated 2025-10-15),
explicitly inspired by the existing PayPal and Stripe patterns and by an earlier "POST Once
Exactly" draft **[SOURCED: 3, 4]**. The draft defines `Idempotency-Key` as an Item Structured
Header whose value must be a string, recommends (does not mandate) a UUID, and specifies server
behavior for three scenarios: a first request (processed normally), a replayed request after
completion (server SHOULD return the prior result, success or error, unchanged), and a concurrent
retry arriving *before* the first attempt has finished (server SHOULD return a 409 Conflict)
**[SOURCED: 4]**. As of the fetch, the draft's status was "Expired Internet-Draft" with an intended
status of "Standards Track" but no RFC number yet assigned **[SOURCED: 4]** — **[INFERENCE: this
means "idempotency keys" as an HTTP-level concept is converging toward, but has not yet reached,
a single ratified standard; Stripe and PayPal's header-name and semantics differences (
`Idempotency-Key` vs `PayPal-Request-Id`) are the reason a common draft exists at all, and the
draft's own text crediting both as prior art supports reading it as a convergence effort rather
than a greenfield design]**.

### 3. Server-side implementation patterns

Two concrete, technically detailed implementation approaches surfaced:

- **Single-database row-lock + state machine** (a widely cited Postgres pattern, originally
  written up describing a ride-hailing-style payment flow): an `idempotency_keys` table keyed on
  `(user_id, idempotency_key)`, with a `locked_at` timestamp marking in-flight processing, a
  `recovery_point` text column tracking which step of a multi-step operation (e.g.
  `started` → `charge_created` → `finished`) has completed, and the full incoming
  `request_params` stored as JSONB so a retry with a *different* payload under the same key is
  rejected with 409 rather than silently reused **[SOURCED: 5]**. Concurrency is handled via
  Postgres `SERIALIZABLE` isolation — if two transactions race to lock the same key, Postgres
  aborts one — plus an explicit lock-timeout so a stuck in-flight request doesn't block retries
  forever **[SOURCED: 5]**.
- **Airbnb's "Orpheus" framework**, described in their engineering blog (accessed here only via
  search-engine snippets and a secondary summary, not a direct fetch — see Methodology):
  each payment request is split into pre-RPC, RPC, and post-RPC phases; a row-level database lock
  on the idempotency key gates each phase so a concurrent duplicate waits rather than proceeds;
  all idempotency reads/writes are routed to the database's master (not read replicas) specifically
  to avoid a replica-lag window in which a second request could believe no lock exists yet; the
  key space is sharded for even distribution; and Airbnb reported reaching "five nines" of
  payment consistency while payment volume doubled **[SOURCED: 6, LOW-CONFIDENCE — secondary
  source]**.

### 4. Points of consensus and points of disagreement across sources

**[INFERENCE — this entire subsection is my own comparison across the sourced facts above, not
a claim from any single source]**: The sourced material agrees on four points regardless of
provider — key is client-generated, key is bound to (or validated against) the exact request
payload so reuse-with-different-body is rejected, replay of an identical request returns the
original stored result rather than reprocessing, and a concurrent in-flight duplicate is rejected
(409) rather than allowed to race. Sources disagree, or simply don't overlap, on two points I did
not find fully reconciled: (a) key *retention window* — Stripe documents 24 hours minimum before a
key may be pruned server-side **[SOURCED: 1]**; a general best-practices summary (not
provider-specific) suggested "2–72 hours" as a sensible range without citing a specific provider
**[SOURCED: 7]**; PayPal's own docs describe retention only as "for a period of time" without a
concrete number in what I retrieved **[SOURCED: 2]** — so no single number for "the industry
standard" TTL exists in what was found. (b) *UUID version* — Stripe explicitly recommends V4
(random) UUIDs **[SOURCED: 1]**; a general best-practices summary suggested UUID v7 (time-ordered)
as an alternative for its database-index-friendliness, a consideration that postdates Stripe's own
public guidance and that Stripe's docs do not mention **[SOURCED: 7]**.

---

## Citation Table

| # | Source | URL | What it substantiates | Confidence |
|---|--------|-----|------------------------|------------|
| 1 | Stripe — official API reference, "Idempotent requests" (fetched directly) | https://docs.stripe.com/api/idempotent_requests | Stripe's exact mechanism: header name, UUID recommendation, 255-char limit, 24h minimum retention, POST-only scope, parameter-mismatch error behavior | High — primary source, fetched directly |
| 2 | PayPal Developer docs — "Idempotency" (via search synthesis, not a direct fetch) | https://developer.paypal.com/api/rest/reference/idempotency/ | PayPal's `PayPal-Request-Id` header, UUID recommendation, POST/PUT scope, concurrent-request behavior (first wins, second fails) | Medium-High — primary source, but retrieved via search-engine synthesis rather than a direct page fetch |
| 3 | Stripe engineering blog, "Designing robust and predictable APIs with idempotency" | https://stripe.com/blog/idempotency | Corroborates the client-generated-key mechanism as the general pattern, not just Stripe's specific header | Medium — search snippet only, not directly fetched |
| 4 | IETF HTTPAPI working group — `draft-ietf-httpapi-idempotency-key-header-07` (fetched directly via datatracker) | https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07 | Standardization status, header structure, the three server-response scenarios (first/replay/concurrent), draft's own citation of Stripe/PayPal as prior art | High — primary source, fetched directly |
| 5 | brandur.org, "Implementing Stripe-like Idempotency Keys in Postgres" (fetched directly) | https://brandur.org/idempotency-keys | The row-lock + state-machine + SERIALIZABLE-isolation implementation pattern, fingerprint validation via stored `request_params` | High — fetched directly; a widely-cited independent technical write-up, not official vendor documentation |
| 6 | Airbnb Engineering Blog via secondary summary (GeeksforGeeks + Medium "Book Club" writeup; two direct-fetch attempts on the original Medium post both failed with a connection reset) | https://medium.com/airbnb-engineering/avoiding-double-payments-in-a-distributed-payments-system-2981f6b070bb (original, unreachable) | The "Orpheus" framework name, row-level locking, master-only reads/writes, key sharding, the "five nines" claim | Low-Medium — secondary source describing a primary one I could not verify directly; treat the "five nines" figure especially as unverified restatement |
| 7 | General payment-API best-practices synthesis across several blog posts (Medium/apidog/nxtbanking, not individually fetched) | (aggregated from WebSearch result snippets; see search query "idempotency key payment API best practices 2026") | The 2–72 hour retention-window suggestion, the UUID v7 alternative, and the "bind key to a fingerprint of the payload" framing used generically (independent of any one provider) | Low — aggregated blog commentary, not a primary or standards source; use as directional signal only |

---

## What this report does not cover

Per `RESEARCH_CONFIG.md`'s `strategy_selection` guidance, this ran as a `planning_only` style pass
(clear, specific, well-scoped query — no clarifying question was needed or raised). It does not
cover: idempotency at the message-queue/event-streaming layer (Kafka-style exactly-once
semantics), non-HTTP payment rails (ACH batch idempotency, card-network-level dedup), or
jurisdiction-specific regulatory requirements around retry/replay in payments. A `--depth deep` or
`--depth exhaustive` pass, per this skill's own depth argument, would be the natural way to extend
into those areas.
