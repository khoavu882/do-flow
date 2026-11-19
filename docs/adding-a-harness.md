---
description: How to add a harness to DoFlow, from its registry rows and descriptor to a field map and the conform check.
---

# Adding a harness

## What a harness is in DoFlow

A harness is a coding tool that DoFlow installs into and can run as a worker. Most of what DoFlow knows about one is data in `core/registry/`. A small part is still code. This page covers both, and ends with a check you can run.

The registry rows for a harness:

- [`harnesses.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/harnesses.json): the harness itself. Its id, display name, adapter, install paths, capabilities, `worker` descriptor and `sessionEffort` entry.
- [`assets.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/assets.json): which shared assets the harness gets and how each is rendered for it.
- [`lifecycle.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/lifecycle.json): which hook event, if any, carries each lifecycle policy for the harness.
- [`contracts.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/contracts.json): the skill and agent fields the harness accepts.
- [`guidance-caps.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/guidance-caps.json): the size limits on the harness's instruction files.
- [`transcripts.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/transcripts.json): where the harness keeps its session transcripts.
- [`telemetry.json`](https://github.com/khoavu882/do-flow/blob/develop/core/registry/telemetry.json): the closed list of harness names that telemetry accepts (`vocabularies.harness`).

Lists of harness ids are not edited by hand. `src/registry/harness-ids.ts` reads the ids and binary names from `harnesses.json` when it loads, and the install targets and lifecycle views use that. Adding a harness edits the registry and one test pin, the list in `test/registry/harness-ids.test.ts` ("the active harnesses are exactly these"). Every other list in source and tests is derived from the registry, and guard G83 fails on a stray one.

## Step 1: the descriptor

The descriptor is the `worker` block of the harness row in `harnesses.json`. A package can also contribute one through the `worker` contribution point. Its keys are checked by `validateWorker` in `src/registry/index.ts`.

Required keys: `profile`, `billing`, `modelChecks`, and one capability entry each for `cli`, `oneShot`, `structuredOutput`, `readOnly`, `spawnDenial`, `runnableProbe`, `hooksProbe`, `guidanceProbe`, `loginProbe`, `persistentSession`, `resume` and `controlChannel`. Optional keys: `isolatedEdit`, `model`, `provider`, `effort`, `mainSession`, `family`, `modelList`, `wideningFlags` and `secretFlags`.

Every capability entry has `status` (`supported`, `unsupported` or `unknown`), `evidence`, `verification` and `verifiedOn`.

- `supported` and `unsupported` need at least one evidence path. `unknown` needs a `reason`.
- Evidence is a record under `core/worker-evidence/<id>/`. `doflow worker --action evidence` writes one from a free check or a finished run.
- A recipe field (`argv`, `promptVia`, `parser`, `fieldMap` and so on) is allowed only when the status is `supported`.
- No recipe may carry a flag that widens what the harness can do. The registry refuses it.
- `structuredOutput` names its parser by `parser`, by an inline `fieldMap` (Step 2), or by both. When both are present, `parser` must equal `fieldMap.id`. `mainSession.parser` is a code parser id, or the `fieldMap.id` of the same worker.
- A package worker carries `fieldMap` and no `parser`. Its map id must not be the id of a code parser.

Two per-id fact pins in `test/guards/worker-descriptors.test.ts` are still added by hand, with the evidence: `PARSER_BY_HARNESS`, and `MAIN_SESSION_PARSER_BY_HARNESS` when `mainSession` is supported. They are not id lists. Each records, for one harness, which parser the evidence shows. Guard G41.3 asks for a pin for every supported `structuredOutput`. A supported `controlChannel` adds two more: `CHANNEL_PARSER_BY_HARNESS` (the parser its entry names) and `CHANNEL_TEMPLATES`, which pins the entry's `argv`, `messages`, `turn`, `answer` and `commandPrefix` as literals, so a changed record shape is an edit a person makes beside the evidence that backs it.

### Provider, effort and the model list

A tier binding can carry a provider and an effort beside the model id (`{"model": <id>, "provider": <p>, "effort": <e>}`). The `provider` and `effort` entries say how each reaches the harness, as data; no code names a harness for this. Both are capability entries, so the rules above hold: `supported` cites evidence and carries the recipe, `unknown` carries a `reason`. A harness with no evidence for a part is `unknown`, and `models --action bind` and a prepared run refuse that part (`unknown` and `unsupported` alike).

- `via` is the transport. `provider` takes `flag` or `id-prefix`; `effort` takes `flag` or `id-suffix`.
- `via: "flag"` carries `argv`: `["--provider-flag", "{provider}"]`, or for effort `["--effort-flag", "{effort}"]` or `["-c", "<key>={effort}"]`. A provider flag must not appear in `readOnly`, `spawnDenial` or `isolatedEdit`, and where another recipe carries it, it must have a fixed value.
- An effort flag appears in no recipe argv at all, with a fixed value or without one: not in `oneShot`, `structuredOutput`, `mainSession`, `controlChannel`, `readOnly`, `spawnDenial` or `isolatedEdit`. An effort comes only from a binding or the session ([Session effort](reference.md#session-effort)); with neither, the harness runs its own default. The registry refuses such a descriptor with `transport flag '<flag>' must not appear in <recipe>: an effort comes only from a binding or the session`.
- `via: "id-prefix"` or `"id-suffix"` carries `separator` (one of `/`, `:`, `#`, `@`) instead of `argv`: the provider is joined before the model id, the effort after it.
- `effort` may carry `levels`: a list of 1 to 16 distinct names, lowest first, or `"per-model"` when each model lists its own. The order is data: a session level the worker lacks is mapped down along it. The registry refuses two harnesses whose lists hold two shared names in opposite order; it cannot prove that one list ascends. `offLevel` names the level that switches reasoning off and needs a list. `mayLower: true` says the harness may run a lower level than bound when the model cannot run the one asked for; every display of such a binding says so. Pi sets it.
- `effort` may carry `overrideEnv`: 1 to 4 distinct variable names (`^[A-Z][A-Z0-9_]{0,63}$`) that the harness lets take precedence over its effort argument, backed by the entry's evidence. When DoFlow passes an effort it drops them from the worker's environment, so the passed level holds; with no effort passed they stay, as the person's own setting. Claude declares `CLAUDE_CODE_EFFORT_LEVEL`.
- `provider` and `effort` need `model` to be `supported`. Every level, and a sample provider value, is put through the widening and secret-flag checks, so a level cannot add a widening flag.
- `modelList` (when `supported`) may add `columns`, an object from a field (`provider`, `displayName`, `contextTokens`, `maxOutputTokens`, `reasoning`, `imageInput`, `effortLevels`) to a header of the listing's table, which needs `parse: "table-column:<id column>"`, and `providerInId: true`, which says each listed id is `<provider><separator><id>` and needs `provider` to be `supported` via `id-prefix`. A column for a provider needs `provider` `supported`; one for `effortLevels` or `reasoning` needs `effort` `supported`.

The evidence bar is the same as for every other entry: a `supported` provider or effort cites a recorded check that establishes it (add the check to `core/worker-evidence/<id>/checks.json`; guard G41.4 recomputes it from the record). When the CLI cannot be run, a record may hold matched lines copied verbatim from a capture or an earlier record, if it carries a top-level `handAdded` string that says which file the lines come from and that no CLI was run. No evidence means `unknown` with the reason, not a guess. `doflow worker --action conform` has a `provider` and an `effort` part that check the composed argv against the fake harness.

### The session's effort (`sessionEffort`)

`sessionEffort` is a top-level key of the harness row, beside `primaryProbe` and outside `worker`: it describes the harness as the main session, which a harness can be without being a worker. It says how DoFlow reads the effort that session runs at, so a worker launched from it takes the same level ([Session effort](reference.md#session-effort)). It is checked by `validateSessionEffort` (`src/registry/session-effort.ts`), and every shipped harness declares it.

- `status` is `supported` or `unknown`. Declare `unknown` until you have evidence: it needs a `reason` (one line, at most 240 characters) and a `verification` that names the check which would open it, may carry `evidence` and `verifiedOn`, and carries no `marker` and no `sources`.
- `supported` needs `evidence` (not empty), `verifiedOn`, `verification`, a `marker` and `sources`, and the harness's `worker.effort` must be `supported`, since its `levels` check the value read.
- `marker` is `{env, equals}`: a variable (`^[A-Z][A-Z0-9_]{0,63}$`) and a value (1 to 32 printable ASCII characters) that only this harness sets, in its own tool shells. It proves DoFlow runs inside that harness's session; without it nothing is read.
- `sources` is 1 to 8 entries, highest precedence first, each `{kind, name, modes}`. `kind` is `env`, the only kind: a source is one environment variable the session sets. There is no configuration-file kind; one is added with the first harness whose session level lives in a file and has the evidence. `name` follows the same pattern, is not the marker's own variable and is distinct across sources.
- `modes` is 1 or 2 distinct of `subscription` and `api-key`: the login modes your evidence shows the variable is set in. Declare a mode only on evidence. A source declared for one mode is not read when the session's login mode is unknown or is the other one.
- `note` is optional, at most 240 characters. The whole entry serializes to at most 2 KiB.

The shipped Claude entry:

```json
"sessionEffort": {
  "status": "supported",
  "marker": { "env": "CLAUDE_CODE_CHILD_SESSION", "equals": "1" },
  "sources": [
    { "kind": "env", "name": "CLAUDE_EFFORT", "modes": ["subscription", "api-key"] }
  ],
  "note": "effortLevel is not read: CLAUDE_EFFORT is unset exactly when the model takes no effort",
  "evidence": ["https://code.claude.com/docs/en/env-vars"],
  "verification": "Read the env-vars page for CLAUDE_EFFORT and CLAUDE_CODE_CHILD_SESSION; in a Claude Code Bash tool run `printenv CLAUDE_EFFORT` once per login mode.",
  "verifiedOn": "2026-11-19"
}
```

Evidence is the harness's own documentation for the variables, or a capture of them: run `env` once in one of the harness's tool shells, once per login mode you declare, and record what you read in `verification`. A setting the harness reads at startup is not a source unless it is the level the session runs: Pi's `defaultThinkingLevel` is not one. Every marker and source name you declare joins the variables DoFlow drops from the environment of each worker, started session and Console verb it launches, so DoFlow in a child never reads the parent's session as its own. The Console keeps its own copy of that list (`SESSION_VARIABLES` in `console/src/verb-runner.ts`, since the Console imports nothing from the core), and guard G86 (`test/guards/session-effort.test.ts`) fails until the copy equals the registry's names.

### The login recipe

`loginProbe` says how DoFlow learns that the harness is logged in. Declare it `supported` only when the harness's own help or published docs, cited in `evidence`, show a status command and what its exit codes mean; otherwise leave it `unknown` with the reason, never a guess. DoFlow runs that argv and nothing else, and never opens a credential file. `secretFlags` adds flags or subcommands that print a credential, which no argv may carry. Both are in [Login state](reference.md#login-state); conform checks the recipe.

### The control channel

`controlChannel` says whether a started session of the harness can be sent a message while it runs, and how. It replaces the old `steering` entry, which only recorded a status: a descriptor that still carries `steering` is refused, and the message names `controlChannel`. Declare it `supported` only when the harness's own help or documentation, cited in `evidence`, shows a mode that reads one JSON record per line on stdin and the events that mark a turn; otherwise leave it `unknown` with the reason, or `unsupported` when the record shows the harness cannot. You write no code: the channel is data and one generic runner drives it. A package worker declares it in the same `worker` block, through the `worker` contribution point; there is no separate point.

A `supported` entry holds:

- `argv`: the arguments that start the harness in that mode. No `-` or `--` element and no placeholder, and the same widening-flag and secret-flag checks as `mainSession.argv`. Keep the trust flags the harness's `mainSession` recipe keeps.
- `framing`: `jsonl-lf` (one JSON object per line, LF-terminated), the only value.
- `parser`: the parser that reads the harness's stdout, a code parser id, this worker's `structuredOutput.fieldMap.id`, or `null`.
- `messages`: three record templates, `followUp`, `stop` and optionally `steer`. A template is an object of literals and two whole-string placeholders: `{text}` (the person's message, exactly once in `followUp` and `steer`, never in `stop`) and `{id}` (a correlation id `d-<n>`, present in every template exactly when `answer` is declared). A placeholder is never part of a longer string. DoFlow fills the template, serializes it with `JSON.stringify` and adds a line feed, so the text cannot break out of its record. The first prompt of a session is sent as a `followUp` record.
- `turn`: `working` and `settled`, each a list of 1 to 8 tests in the field-map test grammar (Step 2). The state a person sees, Working or Waiting for you, comes only from an event that meets one list; no event may meet both.
- `answer` (optional): `id` (the path where the harness repeats the record's `{id}`), `accepted` and `refused` (test lists). With it, a message's ledger entry says whether the harness accepted it.
- `close`: `{stdinEof: "exits", graceSeconds}`. DoFlow closes stdin when the supervisor ends, so a harness that does not exit on end of input is a defect, and conform fails it.
- `commandPrefix` (optional): 1 to 4 characters. A harness that runs a message starting with it as its own command (Pi: `/`) gets no such message: DoFlow refuses it `command-not-allowed` and does not escape or rewrite it.
- `unverified`: 1 to 8 short phrases naming what only a live run can show. It is required unless an `evidence` item is a `live-run` record of this harness, and the start form shows "Talking to it is not verified on a live run".

Evidence comes from documentation as well as from `--help`. A check in `core/worker-evidence/<id>/checks.json` may name `doc`, a path relative to a docs root, instead of `argv`; `doflow worker --action evidence --harness <id> --checks <path> --out <path> --docs-root <dir>` reads each doc (inside the root, at most 1 MiB), tests the check's `expect` patterns against its lines and records the file's SHA-256 and the matched lines, never an absolute path. Each part of the channel is established by checks whose `establishes` carry `controlChannel:argv`, `controlChannel:messages`, `controlChannel:turn` and `controlChannel:close`, and `controlChannel:answer` when `answer` is declared. Guard G41.4 counts the entry established only when every one of them is, recomputed from the record.

Prove the entry with `doflow worker --action conform --harness <id>` (Step 5). Its `control-channel` part starts the argv under a fake with stdin kept open, writes a follow-up, a steer (when declared) and a stop, and checks that the fake received exactly the bytes DoFlow frames for each, that the turn reads working after the follow-up and the steer and waiting after the stop, that each answer carries its record's id, and that the fake exits within `graceSeconds` after stdin closes. The part is `unchecked` when the entry is not `supported`.

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

It checks ten parts, in this order: `binary`, `one-shot`, `prompt-transport`, `model-flag`, `provider`, `effort`, `main-session`, `control-channel`, `stream` and `login`. A part reads `passed`, `failed` or `unchecked`. A part is `unchecked` when its descriptor entry is not `supported`, or when a part it needs failed. For the `stream` part, conform builds the smallest event for each rule of the field map, one that meets every test of the rule together, and checks the report it gives. It also reports a rule that an earlier rule hides, including the cases the registry cannot decide from a pair of rules. A harness with a code parser leaves `stream` unchecked.

Exit 0: every part that was checked passed. Exit 1: at least one part failed, and each is named. Exit 2: a usage error, an unknown harness, an unsupported platform or no scratch directory.

The harness is accepted when `doflow worker --action conform --harness <id>` exits 0.
