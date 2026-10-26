# V8 transcript fixtures

NO REAL CONTENT. Every file here is synthetic: hand-designed from the key structure in the 093 research
(`research/v8-fleet.md` section 3), never copied from a real transcript, and holding no value from any real
machine. Cwd values are `/work/fixture-project` and `/work/other-project`; session ids are `fa000000-0000-4000-8000-...`;
emails end in `@example.invalid`; model ids are `*-fixture-1`. A fixture is refreshed by editing it, never by
pasting a real record.

Each harness directory is the content of that harness's transcript directory (the `home` location in
`core/registry/transcripts.json`), so a scratch HOME is built by copying `v8/<harness>/` to
`LOCATION_ROOTS[<harness>]` in `scan.ts`. Two places differ from the real tree because git ignores them
(`logs/`): Antigravity's file is `<id>/transcript.jsonl`, whose real place is `<id>/.system_generated/logs/transcript.jsonl`.

| Harness | Fixtures |
|---|---|
| claude | a main file, two sub-agent files with `.meta.json` at spawn depth 1 and 2, and a second project's file |
| codex | a main rollout, a sub-agent rollout (`session_meta.source` is a `SubAgent`) and a second project's rollout |
| kiro | `<id>.jsonl` with its `<id>.json` (per-turn tokens, `parent_session_id`) |
| copilot | `<id>/events.jsonl` with a `subagent.started`, cumulative usage records, and `workspace.yaml` |
| pi | a main file, a child file (`parentSession` set) and a second project's file |
| antigravity | one brain transcript that no reader opens (`events-only`, join `none`) |
| opencode | `opencode.db`, `opencode.db-wal`, `opencode.db-shm`: fixed bytes that no reader opens (V.0 verdict: OpenCode is not promoted) |

## Markers

Every text-bearing fixture (a harness's transcript file) plants each marker below in the record shape that
harness uses; `scan.ts` fails when one is missing. A marker is absent from every reader output, or appears only as `<masked>` or `<email>`.

| Marker id | Planted as | Where |
|---|---|---|
| secret-reply | `password=fx-Secret-4471-reply` | reply text |
| secret-args-plain | `password=fx-Secret-4471-args` | tool arguments |
| secret-args-escaped | `\"token\":\"fx-Secret-4471-esc\"` | tool arguments, JSON text inside a string (escaped quotes) |
| email | `fixture.person@example.invalid` | reply text |
| thinking | `FIXTURE-THINKING-MARKER-7f3a` | a thinking / reasoning record or block |
| user-prompt | `FIXTURE-USER-PROMPT-MARKER-91c2` | a user prompt record |
| attachment-user-email | `"userEmail":"fixture.attach@example.invalid"` | an attachment or context record |
| unknown-record-type | `fixture-unknown-record-type` | a record of a type no reader knows |
| missing-keys-record | `fixture-missing-keys-record` | a record without the registry's `requiredKeys` (one per file, under 20 %) |
| path | `/work/fixture-project/notes/private.txt` | the unknown record |
| tool-result-text | `FIXTURE-TOOL-RESULT-TEXT-5e1d` | a tool result |
| other-project-reply | `FIXTURE-OTHER-PROJECT-REPLY-2b8d` | the second project's files only |

`scan.ts` also fails when a fixture holds this machine's home path, the user's email (from git config) or a
session id (the directory names under `~/.claude/session-env/sessions` and the DoFlow config home's
`session-env/sessions`, read as names only), and when the files here differ from the list in `FIXTURES`.
V.4's reader tests reuse `FIXTURES`, `MARKERS` and `scanFixtures`.
