# Discipline sections

Optional parts of `requirement.md` and `design.md` for work that is not only a backend service.
Add the parts that match the feature and leave the rest out; a feature may match more than one.
Nothing here replaces a numbered section of either template.

How to use it:

- In `requirement.md`, each item under "Requirement" below becomes one `NFR-###` row in
  §4 Non-Functional Requirements, with at least one acceptance criterion in §6 that tests it. The
  Kind column takes the closest of the template's values; the row's label names the concern
  (accessibility, cost, privacy, compatibility, freshness).
- In `design.md`, add each part under "Design" below as a `###` subsection at the end of
  §5 Components & Boundaries, with the heading given here.
- A part that says it belongs in `specs.md` or `data-model.md` goes there, as
  `references/ARTIFACT_FORMAT.md` places it; `design.md` keeps the pointer those sections already have.
- A part that does not apply is not written. A part that applies but has nothing to decide is one
  line: `N/A: [why]`.

## User interface

Use when a person sees or operates a screen, page, component or terminal view.

**Requirement**

- Every state a person can meet is handled: empty, loading, error, partial data and success.
- Accessibility bar, named: the standard and level (for example WCAG 2.2 AA), keyboard-only use, and screen-reader use.
- Sizes and inputs supported: viewport widths, touch, pointer, keyboard.
- Languages, text direction, and what happens to long or missing text.
- Browsers or platforms supported, and how fast the interface must respond to an action.

**Design**

### Screens and states

| Screen | State | What the person sees | What they can do next |
|---|---|---|---|
| [name] | empty / loading / error / partial / success | [content, in the product's own words] | [action] |

### Interaction and navigation

- Entry points, the order of steps, and where each exit leads. A flow with a branch gets a diagram.
- What is kept when the person leaves and comes back (draft, scroll position, selection).

### Accessibility

- Keyboard: focus order, focus after an action or a dialog, shortcuts.
- Names and roles for every control that has no visible text; how a status change is announced.
- Contrast, text size and target size against the named standard; behaviour with reduced motion.

### Components reused

- Existing components reused, by name. A new component is listed with the reason an existing one does not fit.
- Events recorded for analytics, each with what it tells and what data it carries.

Design tokens, the visual states of a single component, breakpoints and other layout cues are not
written here: they go in `data-model.md` §1. The table above is about whole screens as a person meets them.

## Language model

Use when the feature calls a language model, or its output depends on a prompt, a retrieval step or an agent loop.

**Requirement**

- The quality bar, with a measure: which cases, which score or pass rate, judged how.
- Limits per request and per day: latency, cost, and what the person sees when a limit is reached.
- What data may be sent to the model provider and what may not.
- What the feature does when the model is wrong, refuses or is unavailable.
- Whether prompts and outputs are stored, for how long, and who may read them.
- Which outputs a person must review before they take effect.

**Design**

### Task and model

| Step | Model | Why this one | Fallback |
|---|---|---|---|
| [step name] | [model id as configured, not hard-coded] | [capability, cost or latency reason] | [other model, cached answer or no-model path] |

### Prompts and context

- Where each prompt lives in the repository and who may change it.
- What enters the context for each step, in order, with a size budget; what is dropped first when it does not fit.
- Output format and how it is checked before use (schema, parser, allowed values).
- Retrieval, tools or memory the step uses, and what each may read or change.
- How a prompt and its model are versioned, so an eval result names the pair it measured.

### Evals

| Eval | Cases | Bar | Run when |
|---|---|---|---|
| [name] | [count and source: written, sampled from real use, adversarial] | [score or pass rate] | [every change to a prompt or model / before release / on a schedule] |

### Failure modes

| Failure | How it is detected | What the feature does |
|---|---|---|
| Wrong or unsupported answer | [check] | [action] |
| Output that does not parse | [check] | [retry bound, then action] |
| Refusal | [check] | [action] |
| Timeout or provider error | [check] | [action] |
| Injected instruction in retrieved or user content | [check] | [action] |
| Cost or loop past its bound | [check] | [action] |

## Data pipeline

Use when the feature moves, transforms or reports on data in batches or streams.

**Requirement**

- Freshness, completeness and correctness bars, each with a measure.
- Retention, and what must be deleted on request.

**Design**

### Sources and outputs

| Dataset | Owner | Schema location | Freshness | Consumer |
|---|---|---|---|---|
| [name] | [team or system] | [path] | [bar] | [who reads it] |

### Runs and recovery

- Schedule or trigger, and what a late or failed run does to consumers.
- Re-run and backfill: whether a run can be repeated safely, and how far back.
- Quality checks, where they run and what a failed check blocks.

## Infrastructure and operations

Use when the feature changes how software is built, deployed, configured or run.

**Requirement**

- Availability and recovery bars; the maintenance window, if any.
- Who must be able to operate it, and with which access.

**Design**

### Rollout and rollback

- Environments in order, the check that lets a rollout continue, and the step that undoes it.
- Changes that cannot be undone (data migration, deleted resource), each with its safeguard.

### Capacity and observation

- Expected load and the limit that was tested.
- Signals, alerts and the runbook entry for each alert.

## Library, CLI or SDK

Use when the feature's users are other programs or developers.

**Requirement**

- Supported versions of the language, runtime and platforms.
- Compatibility promise for existing callers.

**Design**

Each public symbol, command, flag and file format is an `IC-###` entry in `specs.md` §1, not a
part of `design.md`; give each entry its stability (stable or experimental) and the version it
appeared in.

### Compatibility

- What changes for an existing caller, and the migration step if any.
- Deprecations: what replaces each one and when it is removed.
- One runnable example per main use.
