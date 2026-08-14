---
name: do-git
description: "Git operations with lifecycle-aware intents and safety checks"
argument-hint: "[intent] [args...] [--confirm]"
effort: medium
---

# do-git

Cycle-aware git operations via named lifecycle intents. Reads policy from the repository's
constitution or falls back to opinionated defaults. All mutating operations require explicit
confirmation per FR-010.

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

This satisfies NFR-002: existing `/do-git [operation]` invocations keep working.

## Behavioral Flow

### Per Intent Processing

1. **Read repository state** → `do-paths.sh --json`, `do-git-state.sh` as needed
2. **Dry-run fingerprint** (for mutable intents) → record for FR-005 change detection
3. **Compose preview sequence** → exact commands with concrete values, no placeholders
4. **User confirmation** → explicit go/no-go before execution
5. **Re-fingerprint** → if changed since step 2, abort and re-preview

### Raw Operation Passthrough Flow

1. **Check state first** (`git status`) for any operation that could discard work
2. **Gate on reversibility**: stash or confirm before destructive operations
3. **Execute** the raw git command
4. **Report** result, next-Step suggestion if applicable

## Safety Gates (FR-010 preserved)

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
- Generate commit messages from actual diff content (FR-009)
- Derive branch names purely from policy + do-git-state.sh (FR-002)

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
/do-git log --oneline             # Raw git passthrough (NFR-002)
```
