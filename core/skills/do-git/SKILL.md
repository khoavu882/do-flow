---
name: do-git
description: "Git operations with intelligent commit messages and workflow optimization"
argument-hint: "[operation] [args] [--smart-commit] [--interactive]"
effort: low
---

# do-git

Run a git operation with the safety checks from RULE_01_SAFETY applied by default — check state
before anything that could discard work, confirm before anything hard to reverse.

## Invocation
```text
/do-git [operation] [args] [--smart-commit] [--interactive]
```

## Behavioral Flow
1. **Check state first**: `git status` (and `git branch` for any operation that switches/creates a
   branch) before running `[operation]` — always, not just for destructive ones.
2. **Gate on reversibility**: `checkout`/`restore`/`reset`/`clean` that could discard uncommitted
   work → stash (`git stash -u` if untracked files matter) or confirm with the user first, per
   RULE_01_SAFETY. `push --force`, `push` to `main`/`master`, or rewriting published history →
   always confirm first, never assume prior approval carries over.
3. **`--smart-commit`**: run `git diff --cached` (or `git diff` if nothing's staged yet — stage
   first, showing what was added) and generate a commit message from the actual diff content —
   summarize the *why* where inferable from the changes, not a generic "update files."
4. **`--interactive`**: show the planned command before running it and wait for confirmation,
   for any operation beyond a read-only `status`/`log`/`diff`.
5. **Execute** the operation, then **report**: what ran, the resulting state (new HEAD, branch,
   or status), and a concrete next-step suggestion if the state suggests one (e.g. untracked files
   after `status` that look like they should be added).

## Boundaries
**Will:** run git operations with state checks and reversibility gates applied by default;
generate commit messages from actual diff content under `--smart-commit`.
**Will Not:** force-push to `main`/`master` even with `--interactive` confirmed, without the user
explicitly naming that branch; modify `.git/config` or repo-level git settings; resolve a complex
merge conflict without surfacing the conflicting hunks for the user to decide.
