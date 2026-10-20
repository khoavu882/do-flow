Hand-built run directories for test/bench/agentic-grade.test.js (feature 097, IC-006).

These are test fixtures, not captures: no model or harness produced them. Each folder is one run
directory (run_status.json, transcript.jsonl in codex-exec-json-v1 shape, last-message.txt,
timing.json). The task and arm each one is graded as are declared in the test's scenario table, not in
the folder, so the same folder can be graded as either arm. No folder holds a launch.json: the tests
that go through gradeIteration write one for the task and arm they grade as (C-8), and gradeRun alone
grades without one (only system paths allowed by the outside-path rule).

full-answer                     answer lists the one relevant file of DC-011 (score 1.0)
partial-answer                  hits one of two relevant files of a derived two-qrel task (score 0.5); fenced JSON
no-answer                       completed, events present, no JSON object (model failure, score 0)
timeout / api-error             infra run statuses with partial transcripts
silent                          completed, no events, empty last message (no-output)
empty-transcript                completed, answer present, transcript has no event (isolation unverifiable, no turn end: truncated)
leak-doflow-retrieve            arm N ran `doflow retrieve`
leak-doflow-run-retrieve        arm N ran `doflow-run retrieve`
leak-node-doflow-retrieve       arm N ran `node bin/doflow.js retrieve`
clean-rg-retrieve-src           arm N ran `rg retrieve src` (the word, not the verb)
clean-rg-doflow-retrieve-docs   arm N ran `rg -n "doflow retrieve" docs` (the phrase as a search term)
mcp-call                        one mcp_tool_call event (leaked in both arms)
arm-d-two-retrieves             arm D ran `doflow retrieve` twice
twelve-files                    12 distinct paths; the relevant file is the 11th, so it does not count
