# Release Procedure: /do-git

This procedure is executed when `/do-git release` is invoked. It runs as one previewed,
confirmed sequence.

## Sequence

Runs inside `SKILL.md`'s Per Intent Processing sequence. This file supplies only the
intent-specific preview content (its steps 2–3).

1. **Next version** → `"$DOFLOW" git-state --next-version`
2. **Preview full command sequence** with the proposed version:
   - `git checkout -b release/v<version> <integration-branch>`
   - Update all version manifests (per policy: package.json, etc.)
   - Draft CHANGELOG entry from commits since last tag
   - Commit version bump
   - `git checkout <production-branch>`, then `git merge --no-ff release/v<version>`
   - `git tag v<version>` (annotated)
   - `git push origin release/v<version> v<version>`
   - Back-merge: merge the release branch back to the integration branch

## Version Manifest Rewrite

For each manifest file declared in policy:
- Extract current version string using appropriate format (version, versionCode, etc.)
- Replace with the next version `"$DOFLOW" git-state --next-version` derived
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

- **Never write the version manifests until after user confirmation** (the preview above shows the
  proposed content only)
- **Fingerprint mismatch aborts execution** - state must be exactly as when previewed
- **All push operations require confirmation** — see `SKILL.md`'s Safety Gates
