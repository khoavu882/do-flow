# Development Estimation Reference

Guidelines for generating scoped estimates:

## Sizing Dimensions
1. **Time/Effort**:
   - Anchor against historical commits (`git log`) for comparable features in this repo.
   - Account for cross-module boundaries, third-party integrations, and testing scope.
2. **Complexity**:
   - Rate Low, Medium, or High based on blast radius, concurrency/state management, and schema changes.
3. **Range and assumptions**: give a range (`2-4 days`), state the assumptions that set its width
   and the unknowns that would narrow it. The assumptions are the honest expression of what is not
   yet known — never attach a numeric or percentage certainty to the range.
