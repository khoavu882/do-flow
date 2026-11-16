---
description: How to add a harness to DoFlow, from its registry rows and descriptor to a field map and the conform check.
---

# Adding a harness

## What a harness is in DoFlow

A harness is a coding tool that DoFlow installs into and can run as a worker. Most of what DoFlow knows about one is data in `core/registry/`. A small part is still code. This page covers both, and ends with a check you can run.

The registry rows for a harness:

- [`harnesses.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/harnesses.json): the harness itself. Its id, display name, adapter, install paths, capabilities and `worker` descriptor.
- [`assets.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/assets.json): which shared assets the harness gets and how each is rendered for it.
- [`lifecycle.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/lifecycle.json): which hook event, if any, carries each lifecycle policy for the harness.
- [`contracts.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/contracts.json): the skill and agent fields the harness accepts.
- [`guidance-caps.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/guidance-caps.json): the size limits on the harness's instruction files.
- [`transcripts.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/transcripts.json): where the harness keeps its session transcripts.
- [`telemetry.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/telemetry.json): the closed list of harness names that telemetry accepts (`vocabularies.harness`).

Lists of harness ids are not edited by hand. `src/registry/harness-ids.ts` reads the ids and binary names from `harnesses.json` when it loads, and the install targets and lifecycle views use that. Adding a harness edits the registry and one test pin, the list in `test/registry/harness-ids.test.ts` ("the active harnesses are exactly these"). Every other list in source and tests is derived from the registry, and guard G83 fails on a stray one.

## Step 1: the descriptor

The descriptor is the `worker` block of the harness row in `harnesses.json`. A package can also contribute one through the `worker` contribution point. Its keys are checked by `validateWorker` in `src/registry/index.ts`.

Required keys: `profile`, `billing`, `modelChecks`, and one capability entry each for `cli`, `oneShot`, `structuredOutput`, `readOnly`, `spawnDenial`, `runnableProbe`, `hooksProbe`, `guidanceProbe`, `loginProbe`, `persistentSession`, `resume` and `steering`. Optional keys: `isolatedEdit`, `model`, `mainSession`, `family`, `modelList`, `wideningFlags` and `secretFlags`.

Every capability entry has `status` (`supported`, `unsupported` or `unknown`), `evidence`, `verification` and `verifiedOn`.

- `supported` and `unsupported` need at least one evidence path. `unknown` needs a `reason`.
- Evidence is a record under `core/worker-evidence/<id>/`. `doflow worker --action evidence` writes one from a free check or a finished run.
- A recipe field (`argv`, `promptVia`, `parser`, `fieldMap` and so on) is allowed only when the status is `supported`.
- No recipe may carry a flag that widens what the harness can do. The registry refuses it.
- `structuredOutput` names its parser by `parser`, by an inline `fieldMap` (Step 2), or by both. When both are present, `parser` must equal `fieldMap.id`. `mainSession.parser` is a code parser id, or the `fieldMap.id` of the same worker.
- A package worker carries `fieldMap` and no `parser`. Its map id must not be the id of a code parser.

Two per-id fact pins in `test/guards/worker-descriptors.test.ts` are still added by hand, with the evidence: `PARSER_BY_HARNESS`, and `MAIN_SESSION_PARSER_BY_HARNESS` when `mainSession` is supported. They are not id lists. Each records, for one harness, which parser the evidence shows. Guard G41.3 asks for a pin for every supported `structuredOutput`.

### The login recipe

`loginProbe` says how DoFlow learns that the harness is logged in. Declare it `supported` only when the harness's own `--help` shows a status command and what its exit codes mean; otherwise leave it `unknown` with the reason, never a guess. DoFlow runs that argv and nothing else, and never opens a credential file. `secretFlags` adds flags or subcommands that print a credential, which no argv may carry. Both are in [Login state](reference.md#login-state); conform checks the recipe.

## Step 2: the field map

A field map is a parser written as data. Its format is `jsonl-field-map-v1`. DoFlow reads one stdout line at a time. A line is an event when it is a JSON object and the value at `eventType` is a string. The rules are tried in order, and the first rule whose tests all hold is the only one applied.

A rule has `when` and `then`:

- `when` is 1 to 8 tests. A test reads one path and checks it with `equals` (one scalar), `in` (up to 32 scalars) or `is` (`string`, `number`, `integer`, `count`, `boolean`, `object`, `array`, `null` or `present`).
- A path is a list of 1 to 8 keys. It reads one own property at a time, with no array indexing. A step into anything that is not a plain object reads as absent.
- `then` is a non-empty set of actions: `final` (the result text), `spawn`, `denial` (an action and a detail), `usage` (a token sum over paths), `streamError`, and `terminal` (`completed`, or `failed` with a `summary` path).
- A map has 1 to 32 rules, and its serialized size is at most 16 KiB.

When the stream ends, the report follows a fixed order. A denial wins, then an oversize JSON line, then a spawn, then a failed terminal, then a completed terminal with a final message, then a completed terminal without one (`unparsed`, `no-final-message`), then a stream error, and last `missingTerminal`. `finalFallback: "last-message-file"` lets the file that the harness writes stand in for a missing final message.

The registry checks each map when it loads. Every `final`, `summary` and `streamError` path needs an `is: "string"` test on the same path in the same rule. Every rule tests `eventType`. At least one rule completes, and one gives a final message (or `finalFallback` is set). Two tests in one rule must not contradict each other. An `equals` or `in` on the `eventType` path must hold strings, because an event type is always a string. A `completed` rule must not also set `spawn`. A `completed` rule is refused when an earlier rule always hides it, if two rules are enough to tell: each test of the earlier rule is implied by a test of the later one (the same `equals`, an `in` that holds the value, an `is` kind that covers it, or `present` on a path the later rule tests). Any other shadowing is not decidable from a pair of rules and is left to the `stream` check of conform (Step 5). The map `id` must match `^[a-z][a-z0-9-]{1,47}-v[1-9][0-9]*$`. Free text is masked by DoFlow, not by the map.

Version 1 has no regex, no text prefix test, no array indexing, no accumulation across events and no cost. A harness that needs one of these keeps a code parser (Step 3).

The worked example is the codex map, copied from the `structuredOutput` entry of the codex row in [`harnesses.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/harnesses.json). Rule 1 takes the final message. Rule 2 marks a spawn. Rule 3 turns a declined command into a denial. Rule 4 completes the turn and sums the tokens. Rules 5 and 6 read a failed turn and a stream error.

```json
{
  "id": "codex-exec-json-v1",
  "format": "jsonl-field-map-v1",
  "eventType": ["type"],
  "missingTerminal": "no-turn-end",
  "finalFallback": "last-message-file",
  "rules": [
    {"when":[{"path":["type"],"equals":"item.completed"},{"path":["item","type"],"equals":"agent_message"},{"path":["item","text"],"is":"string"}],"then":{"final":["item","text"]}},
    {"when":[{"path":["type"],"in":["item.started","item.updated","item.completed"]},{"path":["item","type"],"equals":"collab_tool_call"},{"path":["item","tool"],"equals":"spawn_agent"}],"then":{"spawn":true}},
    {"when":[{"path":["type"],"equals":"item.completed"},{"path":["item","type"],"equals":"command_execution"},{"path":["item","status"],"equals":"declined"}],"then":{"denial":{"action":{"literal":"command"},"detail":{"path":["item","command"],"as":"text"}}}},
    {"when":[{"path":["type"],"equals":"turn.completed"}],"then":{"usage":{"tokens":{"sum":[["usage","input_tokens"],["usage","output_tokens"]],"require":"any"}},"terminal":{"outcome":"completed"}}},
    {"when":[{"path":["type"],"equals":"turn.failed"},{"path":["error","message"],"is":"string"}],"then":{"terminal":{"outcome":"failed","summary":["error","message"]}}},
    {"when":[{"path":["type"],"equals":"error"},{"path":["message"],"is":"string"}],"then":{"streamError":["message"]}}
  ]
}
```

## Step 3: what still needs code

These modules hold per-harness code that the registry cannot yet express. The table is checked against the files on disk by guard G83.4, so a new module has to be added here.

| Module | Harness | Kind | Why it is not data yet |
|---|---|---|---|
| `parsers.ts` `createJsonlV1` | (DoFlow's own) | parser | DoFlow's protocol, not a harness's |
| `parsers/antigravity.ts` | antigravity | parser | `event` or `type` as the type, nested-or-self objects, a cleaned reason, and `total_tokens` |
| `parsers/claude.ts` | claude | parser | an "any element of an array" test, a numeric `spawned > 0` test, and denials built from an array with field fallbacks |
| `parsers/copilot.ts` | copilot | parser | denials joined to tool calls through a `toolCallId` map, plus camel and snake token names |
| `parsers/kiro.ts` | kiro | parser | the base object is `data.update` or `data` (coalesce), and spawn is a text prefix match (`/^\s*subagent/i`) |
| `parsers/opencode.ts` | opencode | parser | usage accumulated with all-or-nothing validity, a `finish-<reason>` reason built and cut, and a conditional error precedence |
| `parsers/pi.ts` | pi | parser | usage and cost summed over `message_end` events, `messages[-1]` indexing, text blocks joined, the aborted modifier, and a `/subagent/i` match |
| `transcripts/readers/*.ts` (5) | claude, codex, copilot, kiro, pi | transcript reader | each harness's on-disk session format; no shared grammar yet |
| `src/adapters/<id>/` (7) | all | install adapter | each writes its tool's config format (TOML, JSON, settings merge) |
| `hooks/adapters/antigravity.js` | antigravity | hook adapter | translates Antigravity's hook payload |
| `fleet/tree.ts` branches and `ENCODE` | claude, codex, copilot, kiro, pi | other | the session-file location, how each harness encodes a cwd, and its companion files |

A harness whose parser needs something from the "Why it is not data yet" column keeps a code parser in `src/runtime/worker/parsers/<id>.ts`, listed in `PARSERS`. A harness that fits the grammar needs none of these parser rows.

## Step 4: the docs rows

Write these rows when you add the harness. G83.3 checks that they exist, not what they say.

- A row in the "Tool support" table of the `README.md`. Its first cell starts with the harness `displayName`.
- A row in the "Coding agents" table of [`setup.md`](setup.md#coding-agents). Its `--target` value is the harness id.
- The id in `vocabularies.harness` of `core/registry/telemetry.json`.

## Step 5: acceptance

Run the conform check:

```bash
doflow worker --action conform --harness <id>
```

For a package worker, `<id>` is `<package>.<local>`. Add `--json` for a machine-readable body of at most 4 KiB.

Conform runs the descriptor against a fake program, never the real harness. The fake is the only executable on `PATH`. The child gets an environment built from nothing (`PATH`, `HOME`, `LANG` and the conform variables), so no token reaches it. The scratch directory is made in the OS temp directory and removed afterwards, also when conform is stopped by Ctrl-C (SIGINT) or SIGTERM. That directory is its only write: conform writes no telemetry and no store, and no storage upkeep runs after it. It is not supported on Windows.

It checks seven parts, in this order: `binary`, `one-shot`, `prompt-transport`, `model-flag`, `main-session`, `stream` and `login`. A part reads `passed`, `failed` or `unchecked`. A part is `unchecked` when its descriptor entry is not `supported`, or when a part it needs failed. For the `stream` part, conform builds the smallest event for each rule of the field map, one that meets every test of the rule together, and checks the report it gives. It also reports a rule that an earlier rule hides, including the cases the registry cannot decide from a pair of rules. A harness with a code parser leaves `stream` unchecked.

Exit 0: every part that was checked passed. Exit 1: at least one part failed, and each is named. Exit 2: a usage error, an unknown harness, an unsupported platform or no scratch directory.

The harness is accepted when `doflow worker --action conform --harness <id>` exits 0.
