# Artifact Voice — prose rules for chain artifacts

How a chain artifact reads, sentence by sentence. Structure lives in `ARTIFACT_FORMAT.md`; this file
covers only the writing. Read on demand by `do-brainstorm`, `do-design` and `do-plan` at the point
each fills a template, and never loaded into a session by default.

## 1. The rules

Three minimums apply to every artifact before any category below. One bullet carries one claim, so a
reader can accept or reject it on its own. A `**Detail**` entry is written in complete sentences,
because a reviewer has to read it as an explanation. Bracket placeholders are filled in or deleted,
never stacked where a sentence belongs.

### Content patterns

- **Inflated claims.** "Stands as", "a pivotal moment", "marks a shift". State what the thing does
  and let the reader weigh it.
- **Name-dropping as proof.** Naming a company, a paper or a person to borrow their weight, without
  saying what they did or why it bears on this. Give the context or drop the name.
- **Shallow `-ing` phrases.** "Highlighting", "underscoring", "ensuring", "showcasing" tacked onto a
  clause to make a plain fact sound deeper than it is. Cut the phrase; the fact survives.
- **Sales language.** "Boasts", "vibrant", "rich", "seamless", "robust". An artifact describes a
  system to someone who has to maintain it, not to someone deciding whether to buy it.
- **Vague sourcing.** "Industry reports", "experts argue", "several sources". Name the source, or
  make the claim in your own name and own it.
- **Formulaic "challenges and outlook" sections.** A closing block that lists difficulties in the
  abstract and predicts the future in the abstract. If a risk is real it belongs in the risks index
  with a disposition; if it is not, it does not belong.

### Language and grammar

- **Overused words.** actually, additionally, crucial, delve, enhance, fostering, highlight,
  interplay, intricate, key, landscape, pivotal, showcase, tapestry, testament, underscore,
  valuable, vibrant. Each has a plainer replacement or no replacement at all.
- **Avoiding "is" and "are".** "Serves as", "stands as", "represents", "features" are almost always
  a longer way to write "is". Write "is".
- **"Not X but Y".** The construction spends a clause on something you are not claiming. Write Y.
- **Forced groups of three.** Three items because three sounds complete, when the subject has two or
  four. List what there is.
- **Synonym cycling and repeated openings.** Calling one thing by three different names across a
  page costs the reader a lookup each time; naming it the same way every time costs nothing. Equally,
  three consecutive sentences opening on the same word read as a template.
- **False "from X to Y" ranges.** "From configuration to deployment" only works when X and Y are the
  ends of a real span. Otherwise it is two examples wearing a range.
- **Passive voice with a clear actor.** "The template is filled" hides who fills it. Name the actor
  when there is one; the passive is fine when there genuinely is not.

### Filler and hedging

- **Long forms of short words.** "In order to" is "to". "Due to the fact that" is "because". "Has
  the ability to" is "can".
- **Stacked qualifiers.** "Could potentially possibly" hedges once and then twice more. Pick the one
  qualifier that is true.
- **Generic positive endings.** A closing sentence that praises the thing just described adds no
  information and costs the reader trust in the rest.
- **Announcing the next point.** "Let's dive in", "here's what you need to know", "first, some
  background". Make the point instead of introducing it.
- **Fake candour.** "Honestly", "look", "here's the thing". These signal a confidence the sentence
  has not earned.
- **Objections nobody raised.** Answering a question the reader did not ask, or rejecting an
  alternative nobody proposed, to look even-handed.
- **Restating the heading.** A section whose first sentence repeats its own heading has spent a
  sentence on nothing.
- **Forced punchlines and dramatic fragments.** A one-line paragraph for effect. Reserve the shape
  for the rare sentence that earns it.

### Style

- **Sentence case headings**, not Title Case.
- **No decorative emoji.** None appear in an artifact for ornament.
- **Straight quotes**, not typographic ones.
- **Bold for a functional reason only**: a structural label the format defines, or a term being
  defined. Bold for emphasis loses its force by the third use on a page.
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

Two constructs need no carve-out, because no rule in §1 reaches them, and are listed here so a prose
pass leaves them alone anyway. The `- [ ]` task markers `do-execute-plan` parses as an execution
contract carry no bold and no heading case, and rewriting one breaks execution, not only reading.
The arrow in `Superseded → <ref>` is an arrow rather than a dash, so the dash rule does not touch it,
but the checker matches that value literally and a prose pass that "tidies" the arrow breaks it.
