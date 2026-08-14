# Development Estimation Reference

Guidelines for generating scoped, confidence-banded estimates:

## Sizing Dimensions
1. **Time/Effort (`--type time`)**:
   - Anchor against historical commits (`git log`) for comparable features in this repo.
   - Account for cross-module boundaries, third-party integrations, and testing scope.
2. **Complexity (`--type complexity`)**:
   - Rate Low, Medium, or High based on blast radius, concurrency/state management, and schema changes.
3. **Confidence Banding**:
   - Always provide a range (e.g. `2-4 days`), stating assumptions and what unknowns would narrow the band.
   - Point estimates without confidence intervals are prohibited.
