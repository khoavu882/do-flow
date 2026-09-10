# Native-session evaluations

This corpus tests ordinary requests in Codex and Claude with all shipped skills available through
the host's native discovery. It complements the existing per-skill benchmark, which explicitly
loads a selected skill. Five cases cover routing, unnecessary pauses, authorization retained across
turns, process restarts, and conflicting instructions in retrieved content.

No live results have been captured for this corpus. Offline tests validate the broken fixtures and
the grader; they do not establish native-host quality. Live sessions may incur model usage charges.

## Running a case

```bash
node bench/native/runner.js list
node bench/native/runner.js prepare routing codex /tmp/native-routing MODEL HOST_VERSION
node bench/native/runner.js grade /tmp/native-routing
```

Use an explicit model identifier and the installed host's version. `prepare` creates a new directory
and refuses to overwrite an existing run. Execute the returned installation argument vector to
project this checkout into `workspace/`. Use a dedicated host profile without globally installed
DoFlow skills, then open that workspace in the selected native host. Only send `messages`, in order;
keep the grader, expected skills, and source hashes outside the model's workspace. Do not preload a
skill, tell the model which one to use, or replace the host's discovery with a subagent prompt.

For `restart`, end the host process after the first message finishes. Hash each `checkpointFiles`
entry before ending the process and again before sending the second message in a fresh process.
Reuse the same workspace. Record both process identities and both sets of hashes.

## Controller record

Save the raw host event export as `transcript.jsonl` beside `plan.json`. A controller or human
reviewer, outside the measured agent, produces `session.json` from that export:

```json
{
  "version": 1,
  "completed": true,
  "harness": "codex",
  "model": "the actual model",
  "hostVersion": "the actual version",
  "transcriptSha256": "SHA256 of the raw export",
  "events": [
    {"type": "user-message"},
    {"type": "skill-read", "skill": "do-implement", "projected": true, "sha256": "hash of the file actually read"},
    {"type": "tool-call"}
  ],
  "usage": {"inputTokens": 100, "outputTokens": 50, "durationMs": 1000}
}
```

Record every user message, tool invocation and question, including questions asked in prose.
`skill-read` must come from a native invocation or file-read event; verify the actual resolved path
is in the installed project and hash that file. A model's statement that it used a skill is not
an observation. Count a question tool call as both `tool-call` and `question`. Mark `completed` only
after the host reaches its final response, including a response that stops prematurely. For restart,
add a `restart` event with `previousProcess`, `nextProcess`, `checkpointHashes`, and `resumedHashes`.

This normalized record is a controller trust boundary, not an automatically authenticated transcript
parser. Retain the raw export for audit. The grader checks its hash and host identity but cannot
detect a dishonest controller's omissions. Do not ask the evaluated model to grade its own run.

## Results

The grader runs case-owned assertions against the final files. It reports task success, observed
routing, extra user turns, questions, tool calls, duration, tokens and cost separately. Missing cost
or token usage stays `null`. Missing transcript or routing evidence is `INCONCLUSIVE`, never a pass.
A restart must preserve the checkpoint across distinct processes. Compare runs only with matching
case hashes, source hashes, model and host versions; retain `plan.json`, the raw export, controller
record and grading JSON together. Keep live records under ignored `bench/runs/`, not in the corpus.

The default `npm test` runs the corpus's offline regression tests without launching either host.
