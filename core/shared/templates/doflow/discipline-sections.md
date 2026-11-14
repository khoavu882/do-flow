# Discipline sections

Optional parts of `requirement.md` and `design.md` for work that is not only a backend service.
Add the parts that match the feature and leave the rest out; a feature may match more than one.
Nothing here replaces a numbered section of either template.

How to use it:

- In `requirement.md`, add the rows under "Requirement" below to §4 Non-Functional Requirements and
  §6 Acceptance Criteria, with the template's own ID scheme.
- In `design.md`, add each part under "Design" below as a `###` subsection at the end of
  §5 Components & Boundaries, with the heading given here.
- A part that does not apply is not written. A part that applies but has nothing to decide is one
  line: `N/A: [why]`.

## User interface

Use when a person sees or operates a screen, page, component or terminal view.

**Requirement**

- Every state a person can meet has an acceptance criterion: empty, loading, error, partial data and success.
- Accessibility bar, named: the standard and level (for example WCAG 2.2 AA), keyboard-only use, and screen-reader use.
- Sizes and inputs supported: viewport widths, touch, pointer, keyboard.
- Languages, text direction, and what happens to long or missing text.

**Design**

### Screens and states

| Screen or component | State | What the person sees | What they can do next |
|---|---|---|---|
| [name] | empty / loading / error / partial / success | [content, in the product's own words] | [action] |

### Interaction and navigation

- Entry points, the order of steps, and where each exit leads. A flow with a branch gets a diagram.
- What is kept when the person leaves and comes back (draft, scroll position, selection).

### Accessibility

- Keyboard: focus order, focus after an action or a dialog, shortcuts.
- Names and roles for every control that has no visible text; how a status change is announced.
- Contrast, text size and target size against the named standard; behaviour with reduced motion.

### Visual system

- Existing components and tokens reused, by name. A new component or token is listed with the reason an existing one does not fit.
- Breakpoints and what changes at each.

## Language model

Use when the feature calls a language model, or its output depends on a prompt, a retrieval step or an agent loop.

**Requirement**

- The quality bar is an acceptance criterion with a measure: which cases, which score or pass rate, judged how.
- Limits per request and per day: latency, cost, and what the person sees when a limit is reached.
- What data may be sent to the model provider and what may not.
- What the feature does when the model is wrong, refuses or is unavailable.

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

### Public surface

| Name | Kind | Stability | Since |
|---|---|---|---|
| [symbol, command or flag] | function / type / command / flag / file format | stable / experimental | [version] |

### Compatibility

- What changes for an existing caller, and the migration step if any.
- Deprecations: what replaces each one and when it is removed.
- One runnable example per main use.
