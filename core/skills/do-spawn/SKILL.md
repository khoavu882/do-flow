---
name: do-spawn
description: "Meta-system task orchestration with intelligent breakdown and delegation"
argument-hint: "[complex-task] [--strategy sequential|parallel|adaptive] [--depth shallow|normal|deep]"
disable-model-invocation: true
effort: high
---

# do-spawn

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-spawn [complex-task] [--strategy sequential|parallel|adaptive] [--depth shallow|normal|deep]
```

## Metadata
- Category: `special`
- Complexity: `high`
- Effort: `high`

## Triggers
- Complex multi-domain operations requiring intelligent task breakdown
- Large-scale system operations spanning multiple technical areas
- Operations requiring parallel coordination and dependency management
- Meta-level orchestration beyond standard command capabilities

## Behavioral Flow
1. **Analyze**: Parse complex operation requirements and assess scope across domains
2. **Decompose**: Break down operation into coordinated subtask hierarchies
3. **Orchestrate**: Execute tasks using optimal coordination strategy (parallel/sequential)
4. **Monitor**: Track progress across task hierarchies with dependency management
5. **Integrate**: Aggregate results and provide comprehensive orchestration summary

Key behaviors:
- Meta-system task decomposition with Epic → Story → Task → Subtask breakdown
- Intelligent coordination strategy selection based on operation characteristics
- Cross-domain operation management with parallel and sequential execution patterns
- Advanced dependency analysis and resource optimization across task hierarchies

## Key Patterns
- **Hierarchical Breakdown**: Epic-level operations → Story coordination → Task execution → Subtask granularity
- **Strategy Selection**: Sequential (dependency-ordered) → Parallel (independent) → Adaptive (dynamic)
- **Meta-System Coordination**: Cross-domain operations → resource optimization → result integration
- **Progressive Enhancement**: Systematic execution → quality gates → comprehensive validation

## Boundaries
**Will:**
- Decompose complex multi-domain operations into coordinated task hierarchies
- Provide intelligent orchestration with parallel and sequential coordination strategies
- Execute meta-system operations beyond standard command capabilities

**Will Not:**
- Replace domain-specific skills for simple operations
- Override user coordination preferences or execution strategies
- Execute operations without proper dependency analysis and validation

## CRITICAL BOUNDARIES
**STOP AFTER TASK DECOMPOSITION**

This skill produces a TASK HIERARCHY ONLY - delegates execution to other skills.

**Explicitly Will NOT**:
- Execute implementation tasks directly
- Write or modify code
- Create system changes
- Replace domain-specific skills

**Output**: Task breakdown document with:
- Epic decomposition
- Task hierarchy with dependencies
- Delegation assignments (which `/do-*` skill handles each task)
- Coordination strategy

**Next Step**: Execute individual tasks using delegated skills (`/do-implement`, `/do-design`, `/do-test`, etc.)
