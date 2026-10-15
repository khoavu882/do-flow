# Plan: 080 perf fixture

**Maturity:** Draft

A committed 30-task plan for deterministic task-attempt latency measurement (IC-022).

## 8. Tasks

### Phase A

- [ ] A.1 [US1] Benchmark task A.1 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/a/1-a.js, src/a/1-b.js
- [ ] A.2 [US1] Benchmark task A.2 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/a/2-a.js, src/a/2-b.js; depends-on: A.1
- [ ] A.3 [US1] Benchmark task A.3 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/a/3-a.js, src/a/3-b.js; depends-on: A.2
- [ ] A.4 [US1] Benchmark task A.4 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/a/4-a.js, src/a/4-b.js
- [ ] A.5 [US1] Benchmark task A.5 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/a/5-a.js, src/a/5-b.js
- [ ] A.6 [US1] Benchmark task A.6 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/a/6-a.js, src/a/6-b.js

### Phase B

- [ ] B.1 [US1] Benchmark task B.1 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/b/1-a.js, src/b/1-b.js; depends-on: A.1
- [ ] B.2 [US1] Benchmark task B.2 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/b/2-a.js, src/b/2-b.js; depends-on: A.2
- [ ] B.3 [US1] Benchmark task B.3 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/b/3-a.js, src/b/3-b.js; depends-on: A.3
- [ ] B.4 [US1] Benchmark task B.4 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/b/4-a.js, src/b/4-b.js
- [ ] B.5 [US1] Benchmark task B.5 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/b/5-a.js, src/b/5-b.js
- [ ] B.6 [US1] Benchmark task B.6 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/b/6-a.js, src/b/6-b.js

### Phase C

- [ ] C.1 [US1] Benchmark task C.1 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/c/1-a.js, src/c/1-b.js; depends-on: B.1
- [ ] C.2 [US1] Benchmark task C.2 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/c/2-a.js, src/c/2-b.js; depends-on: B.2
- [ ] C.3 [US1] Benchmark task C.3 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/c/3-a.js, src/c/3-b.js; depends-on: B.3
- [ ] C.4 [US1] Benchmark task C.4 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/c/4-a.js, src/c/4-b.js
- [ ] C.5 [US1] Benchmark task C.5 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/c/5-a.js, src/c/5-b.js
- [ ] C.6 [US1] Benchmark task C.6 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/c/6-a.js, src/c/6-b.js

### Phase D

- [ ] D.1 [US1] Benchmark task D.1 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/d/1-a.js, src/d/1-b.js; depends-on: C.1
- [ ] D.2 [US1] Benchmark task D.2 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/d/2-a.js, src/d/2-b.js; depends-on: C.2
- [ ] D.3 [US1] Benchmark task D.3 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/d/3-a.js, src/d/3-b.js; depends-on: C.3
- [ ] D.4 [US1] Benchmark task D.4 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/d/4-a.js, src/d/4-b.js
- [ ] D.5 [US1] Benchmark task D.5 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/d/5-a.js, src/d/5-b.js
- [ ] D.6 [US1] Benchmark task D.6 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/d/6-a.js, src/d/6-b.js

### Phase E

- [ ] E.1 [US1] Benchmark task E.1 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/e/1-a.js, src/e/1-b.js; depends-on: D.1
- [ ] E.2 [US1] Benchmark task E.2 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/e/2-a.js, src/e/2-b.js; depends-on: D.2
- [ ] E.3 [US1] Benchmark task E.3 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/e/3-a.js, src/e/3-b.js; depends-on: D.3
- [ ] E.4 [US1] Benchmark task E.4 for the task-graph latency fixture. — owner: research-writer; files: src/index.js, src/e/4-a.js, src/e/4-b.js
- [ ] E.5 [US1] Benchmark task E.5 for the task-graph latency fixture. — owner: core-implementer; files: src/index.js, src/e/5-a.js, src/e/5-b.js
- [ ] E.6 [US1] Benchmark task E.6 for the task-graph latency fixture. — owner: quality-guardian; files: src/index.js, src/e/6-a.js, src/e/6-b.js
