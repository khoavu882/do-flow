# Release Procedure: /do-git

This procedure is executed when `/do-git release` is invoked. It runs as one previewed,
confirmed sequence (FR-005).

## Sequence

1. **Dry-run fingerprint** → Call `do-git-state.sh --fingerprint`, record F1
2. **Next version** → Call `do-git-state.sh --next-version`
3. **Preview full command sequence** with the proposed version:
   - `git checkout -b release/v<version> <integration-branch>`
   - Update all version manifests (per policy: package.json, etc.)
   - Draft CHANGELOG entry from commits since last tag
   - Commit version bump
   - `git checkout --no-ff production-branch`
   - `git tag v<version>` (annotated)
   - `git push origin release/v<version> v<version>`
4. **User confirmation** → If confirmed, proceed to step 5
5. **Re-fingerprint** → Call `do-git-state.sh --fingerprint`, compare F2 to F1
6. **If fingerprint differs** → Abort, state changed; return to step 1 with updated state
7. **Execute commands** → Run each command from the previewed sequence
8. **Back-merge** → Merge release branch back to integration

## Version Manifest Rewrite

For each manifest file declared in policy:
- Extract current version string using appropriate format (version, versionCode, etc.)
- Replace with next_version derived by do-git-state.sh
- Leave format intact; only change the value

## CHANGELOG Drafting Instruction

Generate a Keep-a-Changelog style entry for `[Unreleased]`:
- Group commits by type (feat, fix, BREAKING CHANGE)
- For each group, list commits as bullet items
- Include scope where inferable from changed paths
- Use conventional commit message format as-is

Example:
```markdown
## [v1.0.0] - YYYY-MM-DD
### Added
- Feature X by user

### Fixed
- Bug Y reported by user

### Breaking Changes
- Changed API Z
```

## Constraints

- **Never write the version manifests until after user confirmation** (step 3 shows preview only)
- **Fingerprint mismatch aborts execution** - state must be exactly as when previewed
- **All push operations require confirmation** per FR-010 safety gates
