# Capability Router & Provider Matrix

**The router is authoritative; this page is a summary that can lag it.** Resolve a real information
need by querying it, not by reading the table below:

```bash
doflow capabilities            # provider health per capability, live on this machine
doflow capabilities --json     # same, machine-readable
doflow capabilities --check    # deep smoke check rather than presence-only
```

`doflow capabilities` reports which provider is actually *available here* — Semble and Graphify
degrade to Ripgrep when absent, and the router picks accordingly. A table cannot know that; only the
command can. Prefer it whenever the answer affects which tool you run.

## Intents

The router resolves an **intent**, not a capability directly. Each intent names a preferred
capability plus a fallback chain of *other capabilities* to try if it is unavailable.

| Intent | Capability | Providers (in preference order) | Capability fallback chain |
| :--- | :--- | :--- | :--- |
| `locate-known-symbol` | `code.exact-search` | `native.rg` (Ripgrep, degrades to grep) | — |
| `locate-concept` | `code.semantic-search` | `semble.search` → `native.rg` | `code.exact-search` |
| `trace-dependency` | `code.relationships` | `graphify.query` → `native.rg` | `code.exact-search` |
| `estimate-blast-radius` | `code.impact-analysis` | `graphify.query` | `code.relationships` → `code.exact-search` |
| `inspect-history` | `history.search` | `git.native` | — |
| `verify-runtime-behavior` | `behavior.verify` | `native.test` (the project's own test command) | — |
| `compress-command` | `command.compress` | `rtk` | — |

Two distinct fallback layers, easy to conflate:

- **Within a capability** — an ordered provider list. `code.semantic-search` prefers `semble.search`
  and falls back to `native.rg` as a degraded regex approximation. Still the same capability.
- **Across capabilities** — the intent's `fallback` chain. `estimate-blast-radius` gives up on
  `code.impact-analysis` entirely and re-asks the question as `code.relationships`, then as
  `code.exact-search`.

## Progressive escalation

1. Exact symbol or path known → `locate-known-symbol`. Do not reach for a graph or semantic index.
2. Concept or behavior, name unknown → `locate-concept`.
3. Structural question (callers, blast radius) → `trace-dependency` or `estimate-blast-radius`.

## Not router capabilities

`context7` and `sequential-thinking` are **MCP servers**, not entries in the capability registry —
they are selected with the `--c7` and `--seq` flags documented in `FLAGS.md` and `MCP_INDEX.md`, and
`doflow capabilities` will not list them. Asking the router to resolve `docs.lookup` or
`reasoning.structured` raises `Unknown capability`; those two names appeared in an earlier revision
of this table and never existed in the registry.
