# Hotfix Procedure: /do-git

This procedure is executed when `/do-git hotfix` is invoked. It patches production and
propagates to every live line (.FR-004).

## Sequence

1. **Dry-run fingerprint** → Call `do-git-state.sh --fingerprint`, record F1
2. **Propagate targets** → Call `do-git-state.sh --propagation-targets`
3. **Preview full command sequence**:
   - Create hotfix branch from production: `git checkout -b hotfix/<slug> production-branch`
   - Cherry-pick or merge the fix commit(s)
   - Tag with patch version: `git tag v<major>.<minor>.<patch>` (annotated)
   - Merge to production without fast-forward
   - For each target in propagation targets:
     - If target is integration: merge hotfix branch into it
     - If target is active release branch: cherry-pick the fix commit
4. **User confirmation** → If confirmed, proceed to step 5
5. **Re-fingerprint** → Call `do-git-state.sh --fingerprint`, compare F2 to F1
6. **If fingerprint differs** → Abort, state changed; return to step 1 with updated state
7. **Execute commands** → Run each command from the previewed sequence

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
On a conflicting cherry-pick (FR-004):
1. Stop propagation immediately
2. Report all outstanding targets with conflict details
3. Do NOT report hotfix as complete
4. Report exact chain of commits that could not be applied

## Constraints

- **Hotfix merges directly to production first** before any other targets
- **Each target's propagation status is tracked** - no silent omissions
- **Conflict detection is required** - no forced cherry-picks without user intervention
