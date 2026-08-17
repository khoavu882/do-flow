# DoFlow shared guidance

Neither OpenCode nor Pi documents `@file` import expansion inside AGENTS.md, so this pointer names
the guidance tree explicitly rather than relying on an import that may never resolve. Before
proceeding, read `.doflow/guidance/DOFLOW_CORE.md` and the files it references under
`.doflow/guidance/` (`rules/`, `modes/`, `mcp/`, `references/`, `docs/`) for DoFlow's shared
engineering rules and workflow.

DoFlow's skills are registered with this agent by path rather than copied into its own tree — both
harnesses read skill directories from their settings, so there is one copy on disk and no drift
between them.
