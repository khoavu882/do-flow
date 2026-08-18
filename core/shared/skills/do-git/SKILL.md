---
name: do-git
description: "Git operations with lifecycle-aware intents and safety checks — start, save, sync, ship, release, hotfix, backport, and status, plus raw git passthrough for anything else. Use when the user wants a git action performed with confirmation and lifecycle awareness rather than a code change, or says 'commit this' / 'ship this feature' / 'cut a hotfix for bug 123' / 'what's our git status' rather than asking to implement or review code."
argument-hint: "[intent] [args...] [--confirm]"
effort: medium
---

# do-git

Cycle-aware git operations via named lifecycle intents. Reads policy from the repository's
constitution or falls back to opinionated defaults. All mutating operations require explicit
confirmation.

## Invocation
```text
/do-git <intent> [args...] [--confirm]
```

### Intents

| Intent | Description |
|---|---|
| `start` | Start a new task on the appropriate branch type |
| `save` | Stage and commit current changes with intelligent message |
| `sync` | Sync local branches with remote state |
| `ship` | Ship the current feature/fix (merge to integration) |
| `release` | Run the release ritual as one previewed sequence |
| `hotfix` | Create and propagate a hotfix across all live lines |
| `backport` | Cherry-pick a commit to another branch |
| `status` | Report repository state and lifecycle position |

### Raw Operation Passthrough

Any unrecognized first token falls through to today's raw git operation behavior:
```text
/do-git status      # Today's raw git status (no prompt)  
/do-git log --oneline
/do-git diff HEAD~10
```

Existing `/do-git [operation]` invocations keep working.

## Behavioral Flow

Every DoFlow runtime call in this skill goes through the runtime seam. Resolve it **once** here and
reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```
Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

### Per Intent Processing

1. **Read repository state** → `"$DOFLOW" paths --json`, `"$DOFLOW" git-state` as needed
2. **Dry-run fingerprint** (for mutable intents) → `"$DOFLOW" git-state --fingerprint`, record it, so a later step can tell whether the working tree moved underneath the plan
3. **Compose preview sequence** → exact commands with concrete values, no placeholders. **The preview is the contract for this intent**: it is the complete set of commands that will run, in order, against the fingerprint from step 2. A command that is not in it does not run, and a step you cannot spell concretely is a step to stop on rather than to improvise at execution time
4. **User confirmation** → explicit go/no-go before execution
5. **Re-fingerprint** → `"$DOFLOW" git-state --fingerprint`; if changed since step 2, abort and re-preview
6. **Execute, then report against the preview** → every command in the previewed sequence gets a reported result; one the sequence listed and the run did not reach is reported as not run, never dropped from the report

### Raw Operation Passthrough Flow

1. **Check state first** (`git status`) for any operation that could discard work
2. **Gate on reversibility**: stash or confirm before destructive operations
3. **Execute** the raw git command
4. **Report** result, next-Step suggestion if applicable

## Safety Gates

The following behaviors from today's skill are carried over unchanged:

- **State checks** → `git status` before anything that could discard uncommitted work
- **Confirm before irreversible actions**:
  - Force-pushes to any branch
  - Pushes to production (`master`/`main`)
  - History rewrites (rebase, reset, tag force-overwrite)
- **No implicit approvals** → confirmation is per-command sequence, not broad permission

## Boundaries

**Will:**
- Run named lifecycle intents with full preview and confirmation
- Fall through to raw git operations for unrecognized first tokens
- Generate commit messages from actual diff content, never from the request's wording
- Derive branch names purely from policy plus `"$DOFLOW" git-state` — never invent one

**Will Not:**
- Forge API calls (PR/MR creation, pipeline watching) - excluded per scope boundary
- CI/CD setup or branch protection scaffolding - excluded per scope boundary
- Confirm multiple commands at once - each requires explicit go/no-go

## Reference Files

This skill loads the following reference files on demand (not parsed at runtime):

- `references/lifecycle-policy.md` - default policy + override shape + forge mapping
- `references/release-ritual.md` - release sequence, manifest rewrite, CHANGELOG drafting
- `references/hotfix-ritual.md` - hotfix propagation rules and halt-on-conflict behavior

## Examples

```
/do-git status                    # Report current lifecycle position
/do-git start                     # Prepare for a new task (feature/fix branch)
/do-git save                      # Stage and commit with intelligent message
/do-git ship                      # Merge feature to integration
/do-git release                   # Run full release ritual
/do-git hotfix 12345              # Create hotfix from fix #12345
/do-git log --oneline             # Raw git passthrough
```
