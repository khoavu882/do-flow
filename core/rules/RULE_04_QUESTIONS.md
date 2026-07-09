# Question & Clarification Rules

## When to Ask
- Ask ONLY for genuine user-owned decisions unresolved by the request, the code, or sensible defaults
- Enough to act → act; don't ask to confirm the obvious (see RULE_02 Scope Discipline)
- One question that unblocks beats three that re-litigate settled choices

---

<important if="asking the user a clarifying question or choosing between approaches">
## How to Ask (MANDATORY format)
Structured multiple-choice — never a free-form question buried in prose.
- **Claude Code**: use the `AskUserQuestion` tool ("Other"/free-text is auto-provided)
- **Codex / Gemini / non-interactive**: write a `{stage}-questions.md` file with `[Answer]:` tags

Each question:
- 2–4 **meaningful, mutually-exclusive** options covering the real scenarios
- NEVER invent filler to fill slots; an "Other"/free-text escape is always the last choice
- One topic per question; specific and unambiguous; lead with a recommended default when you have one

OK: `A) PostgreSQL  B) MongoDB  C) Redis  D) Other`
NOT OK: `A) Yes  B) No  C) Maybe`
</important>

---

<important if="writing a question file for a non-interactive tool (Codex / Gemini)">
## Question-File Format
```markdown
## Question 1
[Specific question]

A) [Meaningful option]
B) [Meaningful option]
X) Other (describe after [Answer]:)

[Answer]:
```
Naming: `{stage}-questions.md` (e.g. `spec-questions.md`, `design-questions.md`) in the same
directory the stage already writes its output to — not a fixed path outside this repo's own layout.

Lifecycle: write file → tell the user what you created and wait for "done"/"completed" → read
answers → **Validate Before Proceeding** (below) → act. A missing `[Answer]:` means ask which
question, don't guess; an answer that isn't one of the listed letters means ask again, don't
reinterpret free text as a letter choice.
</important>

---

<important if="reading the user's answers before you act on them">
## Validate Before Proceeding
- Scan answers for contradictions (scope vs risk, "quick fix" vs "multi-subsystem") and ambiguity
- Conflict found → name it, ask one targeted follow-up in a `{stage}-clarification-questions.md`
  (same format, references the conflicting question/answer) — do NOT proceed on unresolved contradictions
- Never assume an answer to an ambiguous response
</important>
