# Question & Clarification Rules

## When to Ask
- Ask ONLY for genuine user-owned decisions unresolved by the request, the code, or sensible defaults
- Enough to act → act; don't ask to confirm the obvious (see RULE_02 Scope Discipline)
- One question that unblocks beats three that re-litigate settled choices

<important if="asking the user a clarifying question or choosing between approaches">
## How to Ask (MANDATORY format)
Structured multiple-choice — never a free-form question buried in prose.
- **A native question tool exists in this session** (Claude Code's `AskUserQuestion`, or any
  harness tool that presents options and returns the user's choice): use it. Which harness this
  is is not the test — what THIS session offers is; Codex and Gemini sessions increasingly
  carry one.
- **No native question tool** (truly non-interactive runs): write a `{stage}-questions.md` file
  with `[Answer]:` tags — the fallback, never the preference.

Each question:
- 2–4 **meaningful, mutually-exclusive** options covering the real scenarios
- NEVER invent filler; an "Other"/free-text escape is always the last choice
- One topic per question; specific and unambiguous; lead with your recommended default
</important>

<important if="writing a question file because this session has no native question tool">
## Question-File Format
```markdown
## Question 1 — [the question]
A) [option]  B) [option]  X) Other (free text after the tag)

[Answer]:
```
Naming: `{stage}-questions.md` (e.g. `spec-questions.md`) in the directory the stage writes
its output to — not a fixed path outside the repo's layout.

Lifecycle: write the file → tell the user and wait for "done" → read answers →
**Validate Before Proceeding** (below) → act. A missing `[Answer]:`, or one that is not a listed
letter, means ask again — never guess, and never reinterpret free text as a letter choice.
</important>

<important if="reading the user's answers before you act on them">
## Validate Before Proceeding
- Scan answers for contradictions (scope vs risk, quick fix vs multi-subsystem) and ambiguity
- Conflict found → name it and ask one targeted follow-up in `{stage}-clarification-questions.md`,
  same format, citing the conflicting answer; never proceed on an unresolved contradiction, and
  never assume an answer to an ambiguous response
</important>
