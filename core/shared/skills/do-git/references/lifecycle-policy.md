# Lifecycle Policy: /do-git default branching policy

## Default Policy Table

| Field | Value |
|---|---|
| `trunk_names` | `main`, `develop` |
| `feature_prefixes` | `feat`, `feature` |
| `fix_prefixes` | `fix`, `bugfix` |
| `integration_branch` | `develop` |
| `production_branch` | `master` |
| `tag_format` | `vX.Y.Z` (semver) |

## Tier-2 Constitution Override Shape

A repo may override the default policy by adding a block under `agent-docs/constitution.md`:

```markdown
## /do-git Policy Overrides

| Field | Value |
|---|---|
| trunk_names | Comma-separated list of trunk branch names |
| feature_prefixes | Comma-separated list of feature branch prefixes |
| fix_prefixes | Comma-separated list of fix branch prefixes |
| integration_branch | The integration branch name |
| production_branch | The production branch name |
| tag_format | The tagging format (semver or custom) |
```

Where absent, defaults apply.

## Forge Adaptation

The skill detects the forge from the configured remote URL and adapts vocabulary:

| Remote Pattern | Forge | PR/MR Vocabulary |
|---|---|---|
| `/[^/]+/[^/]+\.git$` (GitHub pattern) | GitHub | Pull Request |
| `/[^/]+/[^/]+\.git$` (GitLab pattern) | GitLab | Merge Request |

Detection failure or unknown remote degrades to plain git with ambiguity stated.

## Deviation Catalogue (FR-011)

What counts as a policy deviation and how it's reported:

| Observation | Classification | Action |
|---|---|---|
| Branch name doesn't match any defined pattern | Unclassifiable branch | Report deviation, continue |
| Release branch without corresponding tag | Missing tag | Report deviation |
| Hotfix not propagated to all active release branches | Incomplete propagation | Report outstanding targets |

Deviations are **reported**, never silently corrected.
