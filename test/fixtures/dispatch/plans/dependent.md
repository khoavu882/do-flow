# Implementation Plan: dispatch fixture, dependent tasks

**Task graph:** v1

> 082 IC-041: three tasks; the third depends on the first two.

## 8. Tasks

### Phase A

- [ ] A.1 Write the first module — owner: core-implementer; files: src/one.js

- [ ] A.2 Write the second module — owner: core-implementer; files: src/two.js

- [ ] A.3 Join the two modules — owner: core-implementer; files: src/join.js; depends-on: A.1, A.2
