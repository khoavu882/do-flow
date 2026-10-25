# Question & Clarification Rules

## When to Ask
- Ask ONLY for genuine user-owned decisions unresolved by the request, the code, or sensible defaults.
- Enough to act → act; don't ask to confirm the obvious (see RULE_02 Scope Discipline).
- One question that unblocks beats three that re-litigate settled choices.

## Non-Interactive Fallback
When no native interactive question tool (one that presents options and returns the user's choice) is available in the current session:
- Do NOT generate `{stage}-questions.md` files or halt execution waiting for manual file edits.
- Adopt the recommended default choice, record the adopted decision and rationale in the stage notes or artifact, and proceed with execution.
- If no sensible default exists and execution cannot safely proceed without user input, report the specific ambiguity and halt.
