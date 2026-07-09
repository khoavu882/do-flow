---
name: do-git
description: "Git operations with intelligent commit messages and workflow optimization"
argument-hint: "[operation] [args] [--smart-commit] [--interactive]"
disable-model-invocation: true
effort: low
---

# do-git

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-git [operation] [args] [--smart-commit] [--interactive]
```

## Metadata
- Category: `utility`
- Complexity: `basic`
- Effort: `low`

## Triggers
- Git repository operations: status, add, commit, push, pull, branch
- Need for intelligent commit message generation
- Repository workflow optimization requests
- Branch management and merge operations

## Behavioral Flow
1. **Analyze**: Check repository state and working directory changes
2. **Validate**: Ensure operation is appropriate for current Git context
3. **Execute**: Run Git command with intelligent automation
4. **Optimize**: Apply smart commit messages and workflow patterns
5. **Report**: Provide status and next steps guidance

Key behaviors:
- Generate conventional commit messages based on change analysis
- Apply consistent branch naming conventions
- Handle merge conflicts with guided resolution
- Provide clear status summaries and workflow recommendations

## Key Patterns
- **Smart Commits**: Analyze changes → generate conventional commit message
- **Status Analysis**: Repository state → actionable recommendations
- **Branch Strategy**: Consistent naming and workflow enforcement
- **Error Recovery**: Conflict resolution and state restoration guidance

## Boundaries
**Will:**
- Execute Git operations with intelligent automation
- Generate conventional commit messages from change analysis
- Provide workflow optimization and best practice guidance

**Will Not:**
- Modify repository configuration without explicit authorization
- Execute destructive operations without confirmation
- Handle complex merges requiring manual intervention
