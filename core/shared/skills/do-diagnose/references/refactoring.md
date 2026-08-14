# Targeted Refactoring Reference

Patterns for non-breaking code improvements:

## Clean Code Principles
1. **Single Responsibility**: Break god-classes/methods into cohesive single-purpose units.
2. **Interface Segregation**: Keep client contracts narrow and purpose-specific.
3. **Dead Code Elimination**: Prune unused exports, obsolete fallback branches, and commented-out blocks.

## Safety Rules
- Refactor with test harnesses in green state before starting.
- Keep semantic behavior identical; verify regression tests after each incremental refactoring step.
