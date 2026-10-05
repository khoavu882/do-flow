# Artifact Voice — prose rules for chain artifacts

How a chain artifact reads, sentence by sentence. Structure lives in `ARTIFACT_FORMAT.md`; this file
covers only the writing. Read on demand by `do-brainstorm`, `do-design` and `do-plan` when
filling a template, and never loaded into a session by default.

## 1. The rules

Three minimums apply to every artifact before any category below. One bullet carries one claim, so a
reader can accept or reject it on its own. A `**Detail**` entry is written in complete sentences,
because a reviewer has to read it as an explanation. Bracket placeholders are filled in or deleted,
never stacked where a sentence belongs.

### Content patterns

- **Inflated claims.** "Stands as", "a pivotal moment". State what the thing does.
- **Name-dropping as proof.** Naming a company, paper or person to borrow weight. Say what they did
  and why it bears on this, or drop the name.
- **Shallow `-ing` phrases.** "Highlighting", "underscoring", "ensuring" tacked onto a clause to
  make a plain fact sound deeper. Cut the phrase; the fact survives.
- **Sales language.** "Boasts", "vibrant", "rich", "seamless", "robust". An artifact serves a maintainer, not a
  buyer.
- **Vague sourcing.** "Industry reports", "experts argue", "several sources". Name the source, or own
  the claim.
- **Formulaic "challenges and outlook" sections.** A closing block of abstract difficulties and
  predictions. A real risk belongs in the risks index with a disposition.

### Language and grammar

- **Overused words.** actually, additionally, crucial, delve, enhance, fostering, highlight,
  interplay, intricate, key, landscape, pivotal, showcase, tapestry, testament, underscore,
  valuable, vibrant. Use a plainer word or none.
- **Avoiding "is" and "are".** "Serves as", "stands as", "represents", "features" are almost always
  a longer way to write "is". Write "is".
- **"Not X but Y".** The construction spends a clause on something you are not claiming. Write Y.
- **Forced groups of three.** Three items because three sounds complete. List what there is.
- **Synonym cycling and repeated openings.** Calling one thing by three names costs the reader a
  lookup each time; name it the same way every time. Three consecutive sentences opening on the same
  word read as a template.
- **False "from X to Y" ranges.** "From configuration to deployment" only works when X and Y are the
  ends of a real span. Otherwise it is two examples wearing a range.
- **Passive voice with a clear actor.** "The template is filled" hides who fills it. Name the actor
  when there is one.

### Filler and hedging

- **Long forms of short words.** "In order to" is "to". "Due to the fact that" is "because".
- **Stacked qualifiers.** "Could potentially possibly" hedges once and then twice more. Pick the one
  qualifier that is true.
- **Generic positive endings.** A closing sentence that praises what was just described adds nothing.
- **Announcing the next point.** "Let's dive in", "first, some background". Make the point instead of introducing it.
- **Fake candour.** "Honestly", "look", "here's the thing". These signal a confidence the sentence
  has not earned.
- **Objections nobody raised.** Answering a question nobody asked, or rejecting an alternative
  nobody proposed, to look even-handed.
- **Restating the heading.** A section whose first sentence repeats its own heading has spent a
  sentence on nothing.
- **Forced punchlines and dramatic fragments.** A one-line paragraph for effect.

### Dead context

- **A status section states what is true now.** Status lines, ledger summaries, blockers and next
  actions are rewritten in place: when a fact stops being true, replace or delete it in the same
  edit. No appended history and no "was", "previously" or "no longer" narrative; history lives in
  `git log`, the decision register's superseded records and `plan.md`'s History.
- **Resolved and finished things leave the page.** A cleared blocker, a finished phase's narration,
  a rejected option nobody still needs and a note about a tool that has since changed are deleted,
  not struck through or kept "for context".
- **One home per fact.** A fact lives in one artifact; others cite it by id or path instead of
  restating it. Copying a decision's text, a task's description or another file's list creates a
  second version that goes stale.
- **Hand-backs report results.** An agent's report holds outcomes, evidence locators, deviations and
  open questions; it does not restate the brief, narrate steps or repeat what a command printed.

### Style

- **Sentence case headings**, not Title Case.
- **No decorative emoji.**
- **Straight quotes**, not typographic ones.
- **Bold for a functional reason only**: a structural label the format defines, or a term being
  defined.
- **No em or en dashes.** A comma, a colon or a full stop does the work, except where §2 carves the
  rule out.

## 2. Carve-outs

**Precedence:** a construct the checker parses governs over a prose rule that would rewrite it; a
prose rule applies in full to free prose.

| Prose rule | Conflicting construct | Which governs |
|---|---|---|
| Bold for a functional reason only | The `- **<ID>:**` detail-entry shape the checker locates entries by | The detail shape governs. The bold is a structural label, not emphasis. |
| Bold for a functional reason only | The `Responsibility` / `Owns` / `Does not own` / `Contracts` labels of a `design.md` §3 component entry | The labelled shape governs. `ARTIFACT_FORMAT.md` §10 declares these four labels and their order. |
| No em or en dashes | The literal `None — initial version.` that `ARTIFACT_FORMAT.md` §3 requires a new artifact to write | The literal governs. Write the em dash. |
| Sentence case headings | Every `##` section heading in the four chain-artifact templates, which `ARTIFACT_FORMAT.md` names by their exact words and `validate-artifacts.sh` locates History by | The template headings govern. Do not re-case a heading in a chain artifact. |
| Sentence case headings | The `#### <ID>: <text>` heading form of a detail entry, §1's second grammar | The heading governs. Its ID is matched literally against an index row, so its case is not free. |

Everything a carve-out protects is the marked construct itself. The prose that follows it on the
same line is free prose, and every rule in §1 applies there.

Two constructs need no carve-out because no §1 rule reaches them; a prose pass still leaves them
alone. The `- [ ]` task markers `do-execute-plan` parses carry no bold and
no heading case; rewriting one breaks execution. The arrow in `Superseded → <ref>` is not a dash,
but the checker matches it literally, so a prose pass that "tidies" it breaks it.
