# Hotfix Procedure: /do-git

This procedure is executed when `/do-git hotfix` is invoked. It patches production and
propagates to every live line.

## Sequence

Runs inside `SKILL.md`'s Per Intent Processing sequence. This file supplies only the
intent-specific preview content (its steps 2–3).

1. **Propagation targets** → `"$DOFLOW" git-state --propagation-targets`
2. **Preview full command sequence**:
   - Create hotfix branch from production: `git checkout -b hotfix/<slug> production-branch`
   - Cherry-pick or merge the fix commit(s)
   - Tag with patch version: `git tag v<major>.<minor>.<patch>` (annotated)
   - Merge to production without fast-forward
   - For each target in propagation targets:
     - If target is integration: merge hotfix branch into it
     - If target is active release branch: cherry-pick the fix commit

## Propagation Rules

### Target Order
1. Production branch (merge hotfix)
2. Integration branch (merge hotfix)
3. Active release branches in order of creation (cherry-pick)

### Outstanding Target Definition
A target is "outstanding" if:
- It cannot receive the fix automatically (conflicting cherry-pick)
- It requires manual intervention

### Halt-and-Report Behavior
On a conflicting cherry-pick:
1. Stop propagation immediately
2. Report all outstanding targets with conflict details
3. Do NOT report hotfix as complete
4. Report exact chain of commits that could not be applied

## Constraints

- **Hotfix merges directly to production first** before any other targets
- **Each target's propagation status is tracked** - no silent omissions
- **Conflict detection is required** - no forced cherry-picks without user intervention
