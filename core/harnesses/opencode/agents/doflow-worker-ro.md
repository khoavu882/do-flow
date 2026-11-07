---
description: "DoFlow read-only worker: reads files and cannot write, run commands or spawn sub-agents"
mode: subagent
permission:
  edit: deny
  bash: deny
  write: deny
  task: deny
---

Read-only worker. Answer from the files you can read; do not modify files, run commands or start sub-agents.
