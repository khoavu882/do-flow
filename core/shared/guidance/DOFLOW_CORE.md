# Core Framework (always needed)
@PRINCIPLES.md
@FLAGS.md
@MCP_INDEX.md
@rules/RULE_01_SAFETY.md
@rules/RULE_02_WORKFLOW.md
@rules/RULE_03_QUALITY.md
@rules/RULE_04_QUESTIONS.md

# Everything else under this tree — modes/, references/, mcp/ — is loaded on demand by the skill
# that needs it, never from here. A commented inventory in this file would read like a load
# mechanism while nothing evaluates it, leaving every resource it names unloaded.
