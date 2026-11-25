# Feature map

A feature map lists the user-facing flows of a feature and the outcome each is expected to show, so
"it works" rests on a run. `$DOFLOW` is the runtime resolved in step 1 of the skill.

## The map

Two files are read, and a flow id in both is a finding that uses neither copy:

- `.doflow/feature-map.json` — the project's map. DoFlow never writes it; the person commits it
  beside `.doflow/settings.json`.
- `<feature dir>/test/feature-map.json` — this feature's map, written by this skill.

```json
{ "version": 1, "flows": [
  { "id": "checkout-pays-once", "title": "A shopper pays for a cart",
    "expect": "the order page shows one charge",
    "drive": { "kind": "browser", "start": "http://localhost:3000/cart", "steps": "Add the first product, pay with the test card, read the order page." },
    "critical": true, "property": "a retried payment never charges twice", "concurrency": true },
  { "id": "export-csv", "title": "An admin exports orders",
    "expect": "the command exits 0 and prints a header row",
    "drive": { "kind": "command", "argv": ["npm", "run", "export", "--", "--format", "csv"] } }
] }
```

`id` is lower-case letters, digits and dashes, at most 48 characters. `title`, `expect` and
`property` are one line of at most 200 characters. `drive` is `command` (an `argv` array run from the
project root) or `browser` (a `start` url or path and `steps` in one paragraph); leave it out when no
means to drive the flow exists. `critical` and `concurrency` default to false. Unknown keys, more than
64 flows in a file and malformed values are findings, and an invalid map is refused whole.

## Write the feature's map

From the requirement's acceptance scenarios, one flow per scenario: `title` from the scenario,
`expect` from its observable outcome, `drive` only where you can name the command or the page and
steps. Mark a flow `critical` only when the requirement or the person says it is, and name its
`property`; `concurrency` is true when the invariant is about interleaved actors. Do not write a
project map. Write only the flows the scenarios give; invent none.

## Run it

```bash
"$DOFLOW" verify --action feature-map --task-id "<task id>" [--flow <id>]... --json
```

Exit 0 means the map was read, even when a flow failed; 1 means it is invalid or absent (print the
`findings` and stop); 2 is usage. Command flows run and are recorded by the verb. Report every flow:
`ran` (action, result, locator), `agent` (flows left for you), `unreached` (with the reason), and
`proposals`. A flow that failed or was unreached is never reported as passed.

## Browser flows

For each `agent` entry with `browserTool: present`, drive it with `agent-browser` (open `start`,
follow `steps`, take a screenshot) and record what you saw:

```bash
"$DOFLOW" evidence --action add --task-id "<task id>" --kind runtime-observation --provenance extracted \
  --provider agent-browser --capability feature-map --locator "<screenshot path>" \
  --content "<what you observed, one line>" --establishes "flow:<id>" \
  --observed-command "<the browser command you ran>" --observed-exit <0 if the outcome matched expect, else non-zero>
```

With `browserTool: absent`, or on a harness with no browser tool, the verb has already recorded the
flow as `unreached: agent-browser not found`. Say so and ask for no install; never run
`doflow tools --action install`.

## Critical flows

The verb files one follow-up per critical flow: a property-based check proposed (a formal
specification when `concurrency` is true), or, with no `property`, a request to name it. Relay them
to the person or a worker. Write no property test and no proof here.
