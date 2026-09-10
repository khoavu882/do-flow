# Intent: [SHORT TITLE]

**Raised by:** [NAME OR ROLE] · **Date:** [DATE]

> An intent is written **before** any branch, feature directory or slug exists, and needs no command
> to create: copy this file to `agent-docs/intent/<kebab-description>.md` and fill it in. It is not a
> chain artifact — it carries no `Maturity` and no `Status`, because nothing has been decided yet.
>
> Write it in your own terms. Architecture, interfaces, file paths and task breakdowns are all
> deliberately absent: an intent records a problem worth someone's attention, not a plan for solving
> it. If it is picked up, `/do-brainstorm --intent <path>` reads it and turns it into a
> `requirement.md`, which is where decisions start being made.
>
> An intent that is never built is a success of this format, not a failure of it. That is why intents
> are not numbered: a number would claim a place in a queue that nobody has promised.

## 1. Problem

[What is wrong, missing or painful today, in your own words. Describe the situation, not a solution —
if a sentence here contains the word "add" or names a mechanism, it probably belongs in §2 or nowhere
yet.]

## 2. Proposed outcome

[What would be observably different if this were addressed? State it as something a person could
notice or check, rather than as the thing to build. "Reviewers stop missing X" rather than "add a
check for X".]

## 3. Affected

[Who and what this touches: the people who feel the problem, the systems involved, the existing
behaviour that would change. Name them even where you are unsure — a guess marked as one is more
useful than an omission.]

## 4. Constraints

[What already bounds this: deadlines, policies, contracts, systems that cannot change, decisions
already taken elsewhere. Write "none known" rather than leaving it blank, so a reader can tell the
difference between no constraints and no thought about them.]

## 5. Open questions

[What you do not know. List them rather than guessing — discovery treats these as the ambiguities it
must resolve, so an honest question here is more valuable than a confident answer that turns out to be
wrong.]
