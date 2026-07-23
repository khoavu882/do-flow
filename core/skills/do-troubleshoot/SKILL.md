---
name: do-troubleshoot
description: "Diagnose and resolve issues in code, builds, deployments, and system behavior"
when_to_use: Trigger automatically for diagnosis of errors, failing tests, build failures, runtime issues, deployment problems, and performance symptoms. Auto mode is diagnosis-first and must not apply fixes unless the user explicitly requests edits and confidence-check passes.
argument-hint: "[issue] [--type bug|build|performance|deployment] [--trace] [--fix]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-troubleshoot

Diagnose an active, reproducing issue — diagnosis-first by default. Distinct from `/do-analyze`
(proactive audit of code that isn't necessarily broken) — this starts from a concrete symptom.

## Invocation
```text
/do-troubleshoot [issue] [--type bug|build|performance|deployment] [--trace] [--fix]
```

## Behavioral Flow
1. **Reproduce** — run the failing command/test/build, or gather the exact error output, stack
   trace, or symptom the user described. If it can't be reproduced from what's given, say so and
   ask for the missing piece (exact command, environment, input) rather than guessing.
2. **Isolate** by `--type`:
   - `bug`: bisect via stack trace + recent `git log -p` on the affected file(s); form a hypothesis
     for the specific line/condition causing the wrong behavior.
   - `build`: read the actual build log (not just the final error), check dependency
     versions/lockfile against what's declared, verify the build environment matches what CI/docs
     expect.
   - `performance`: profile or time the specific operation named as slow; distinguish an
     algorithmic issue (see `/do-analyze --focus performance`) from an environmental one (network,
     resource contention, cold cache).
   - `deployment`: check the actual deployed config/env vars against what the service expects,
     check recent deploy history for what changed.
   `--trace` requests the full evidence chain in the report (every command run, every file
   inspected), not just the conclusion.
3. **Confirm root cause** — state the specific mechanism (not just "something's wrong with X"),
   and how you know (the evidence from step 1-2 that rules out alternative explanations). Per
   RULE_01_SAFETY, never propose a fix before this step is done.
4. **Propose fix options**, ranked, each with its risk/blast-radius — even under `--fix`, do not
   skip this: present the plan before touching files.
5. **Fix (only with `--fix`, only after user confirms)** — apply the smallest change that
   addresses the confirmed root cause; verify with the same reproduction from step 1 (now passing)
   plus the existing test suite if one exists. Never skip/disable a failing test to make it pass.

## Boundaries
**Will:** reproduce and diagnose an active issue with evidence; propose ranked, risk-assessed
fixes; apply a fix only with `--fix` and explicit user confirmation.
**Will Not:** apply any file change without `--fix`; skip reproduction/root-cause confirmation to
jump straight to a fix; disable or skip a test/gate to make a build pass.

## Next Step
Without `--fix`: re-run with `--fix` to apply the chosen option, or `/do-improve` if the finding is
a broader refactor rather than a targeted bug fix.
