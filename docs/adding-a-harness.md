---
description: Adding a harness to DoFlow, starting with the per-harness code that is still not data.
---

# Adding a harness

| Module | Harness | Kind | Why it is not data yet |
|---|---|---|---|
| `parsers.ts` `createJsonlV1` | (DoFlow's own) | parser | DoFlow's protocol, not a harness's |
| `parsers/antigravity.ts` | antigravity | parser | `event` or `type` as the type, nested-or-self objects, a cleaned reason, and `total_tokens` |
| `parsers/claude.ts` | claude | parser | an "any element of an array" test, a numeric `spawned > 0` test, and denials built from an array with field fallbacks |
| `parsers/copilot.ts` | copilot | parser | denials joined to tool calls through a `toolCallId` map, plus camel and snake token names |
| `parsers/kiro.ts` | kiro | parser | the base object is `data.update` or `data` (coalesce), and spawn is a text prefix match (`/^\s*subagent/i`) |
| `parsers/opencode.ts` | opencode | parser | usage accumulated with all-or-nothing validity, a `finish-<reason>` reason built and cut, and a conditional error precedence |
| `parsers/pi.ts` | pi | parser | usage and cost summed over `message_end` events, `messages[-1]` indexing, text blocks joined, the aborted modifier, and a `/subagent/i` match |
| `probes/index.ts` `PROBES` (7) | all | probe | each probe parses its own CLI's text or JSON output; `loginCheck` moves to the login recipe (row 172) and model lists to row 169 |
| `transcripts/readers/*.ts` (5) | claude, codex, copilot, kiro, pi | transcript reader | each harness's on-disk session format; no shared grammar yet |
| `src/adapters/<id>/` (7) | all | install adapter | each writes its tool's config format (TOML, JSON, settings merge) |
| `hooks/adapters/antigravity.js` | antigravity | hook adapter | translates Antigravity's hook payload |
| `fleet/tree.ts` branches and `ENCODE` | claude, codex, copilot, kiro, pi | other | the session-file location, how each harness encodes a cwd, and its companion files |
