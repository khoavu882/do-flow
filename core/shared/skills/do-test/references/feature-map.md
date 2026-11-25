# Feature map

A feature map lists the user-facing flows of a feature and the outcome each is expected to show, so
"it works" rests on a run. `$DOFLOW` is the runtime resolved in step 1 of the skill.

Two files are read, and a flow id in both is a finding that uses neither copy: `<project>/.doflow/feature-map.json`
(the project's map, committed by the person; never write it) and
`<feature dir>/test/feature-map.json` (this feature's map, written by this skill).

```json
{ "version": 1, "flows": [ { "id": "<lower-case-dashes>", "title": "<one line>", "expect": "<one line>",
  "drive": { "kind": "command", "argv": ["<cmd>", "..."] },
  "critical": false, "property": "<invariant, one line>", "concurrency": false } ] }
```

`drive` is that command form (run from the project root) or `{ "kind": "browser", "start": "<url or path>",
"steps": "<one paragraph>" }`; leave it out when no means to drive the flow exists.

## Write the feature's map

From the requirement's acceptance scenarios, one flow per scenario: `title` from the scenario, `expect`
from its observable outcome, `drive` only where you can name the command or the page and steps. Mark a
flow `critical` only when the requirement or the person says it is, and name its `property`;
`concurrency` is true when the invariant is about interleaved actors. Invent no flow.

## Run it

```bash
"$DOFLOW" verify --action feature-map --task-id "<task id>" [--flow <id>]... --json
```

Exit 1 means the map is invalid or absent: print the `findings` and stop. Command flows run and are
recorded by the verb. Report every flow: `ran`, `agent` (flows left for you), `unreached` (with the
reason) and `proposals`. A flow that failed or was unreached is never reported as passed.

## Browser flows

For each `agent` entry with `browserTool: present`, drive it with `agent-browser` (open `start`, follow
`steps`, take a screenshot) and record what you saw:

```bash
"$DOFLOW" evidence --action add --task-id "<task id>" --kind runtime-observation --provenance extracted \
  --provider agent-browser --capability feature-map --locator "<screenshot path>" \
  --content "<what you observed, one line>" --establishes "flow:<id>" \
  --observed-command "<the browser command you ran>" --observed-exit <0 if the outcome matched expect, else non-zero>
```

With `browserTool: absent` the verb has already recorded the flow as unreached: say so; neither ask for nor run
an install. Relay each critical-flow follow-up in `proposals` to the person or a worker; write no property
test and no proof here.
