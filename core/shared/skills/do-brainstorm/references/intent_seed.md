# Seeding from an intent (`--intent <path>`)

Steps named here are SKILL.md's.

**`--intent <path>`** seeds this stage from a pre-branch intent. An intent lives at
`agent-docs/intent/<kebab-description>.md`, outside the branch-coupled tree, and is written before any
branch or feature exists — so it is the one input this skill may be given that did not come from the
conversation. When the flag is present:

- Read the file. Carry its Problem, Proposed outcome, Affected and Constraints into the requirement you
  write, in §1, §2 and §4 respectively. Treat its **Open questions** as ambiguities for step 3's
  clarification loop — they are the originator saying what they did not know, not answers to fold in.
- Fill `requirement.md`'s `**Intent:**` header field with the path you read, so a reader can see where
  the problem statement came from and judge whether it was reinterpreted.
- Never move, rename, delete or rewrite the intent. It records what was asked; `requirement.md` records
  what the project decided to do about it, and the two are allowed to diverge.
- A path that does not exist is a mistake, not an absence: say so and stop, rather than proceeding as
  though no intent had been named.

Without the flag, nothing below changes and no intent is owed — discovery starting from a conversation
alone is the ordinary case.
