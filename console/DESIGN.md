# DoFlow Console design

Read this before you change `console/web/`. It is the design of record of the Console: a local web UI that is becoming the remote control of DoFlow, read on a phone first and on a desktop second; it reads through the core and, since rows 162 and 165, relays four decisions to it (decide a gate, close a run, cancel a worker, start a session) (plain ES modules, no build step, no runtime dependency, CSP `default-src 'self'`). The shipped truth is `console/web/tokens.css` (tokens, both themes) and `console/web/app.css` (components). The two generated blocks below are rewritten from those files by `node console/scripts/build-design-md.ts --write`, and `console/test/design-md.test.ts` fails when they drift. Everything outside the generated blocks is hand-written; a token or class named in it must exist in the CSS (the test checks it).

## Principles

1. What needs the person comes first: a waiting gate is the loudest thing on a screen, and no other state looks like it. Everything else is calm.
2. State is never colour alone: every status has a tint, a shape and a word.
3. Motion explains change, never decorates. Only what changed moves, and work in progress shows as the dot flow: one dot going out along a connector and coming back. A view has at most one pulse. Everything has a still variant.
4. Honest data: unknown, stale and unreached are shown as such, never as zero or "live".
5. Quiet chrome, rich data: neutral surfaces and one accent (violet) that belongs to interaction (focus, selection, links), never to a run state. Status colours are reserved for status.
6. Craft in the small things: everything on the 4 px grid, tabular figures for numbers, mono for ids and commands, tightened large type, and a designed worst state for every view. A decorative eyebrow (a class whose name contains "eyebrow": `.eyebrow`, `.activity__eyebrow`, `.ev__eyebrow`) is sentence case with no tracking. Table heads, column heads and status labels keep capitals and `--tracking-caps`.
7. Give each view a clear lead and supporting layers. A gate, selected project or current checkout gets the strongest cue; running work stays easy to scan; completed history, metadata and limits recede. Do not turn every group into an equal card.

## Information architecture

Before: nine links of equal weight (Now, Sessions, Workflows, Layers, Workers, Advice, Follow-ups, Settings, Health) in a row under the header on a phone, the theme control in the header at every width, and a waiting gate visible only on Now (this project) or Layers.

After: three places a person watches, and everything else one step away.

| Place | Hash | Answers |
|---|---|---|
| Now | `#/`, `#/run/...`, `#/session/...` | the runs of this project: what needs you, what runs, what finished; a run and its chain |
| Sessions | `#/sessions...`, `#/compare` | who works in which checkout, and where work collides |
| Layers | `#/layers...` | every project on the machine live: gates, agents, briefs, logs and transcripts |
| More | `#/more` | the Manage pages (Follow-ups, Workflows, Workers, Advice, Settings, Health), session history, compare, the theme, the core version |

Every hash that worked before still works; `#/more` is the only new one. What waits for you is said on every page by the attention strip (see Shell).

### Decisions

Each line is a choice and the reading it rejected.

- **Four tabs on a phone, not nine links.** Rejected: a hamburger sheet (hides where you are and costs two taps for everything) and a scrolling row of nine (no item is findable by position).
- **More is a page, not a menu.** It has a hash, a back step and a focus order like any view. Rejected: a popover over the tab bar, which needs a focus trap and loses its place on reload.
- **Workers moved to Manage.** The page is a capability matrix of the harnesses, not the workers at work; those are on Layers. Rejected: keeping it as a fourth primary tab.
- **Labels kept: Now, Sessions, Layers; the Now page keeps the title Runs.** Rejected: renaming to Home or Machine, which breaks the words the docs, the palette and people already use.
- **Waiting is machine-wide and always in view:** a strip under the app bar plus a count on the Layers link, from the `machine` channel of the one stream every page already holds. Rejected: a count read once per page (goes stale without saying so) and a strip that polls (a second source of truth).
- **The palette and the token names stay.** Values moved (motion, the app bar and tab bar sizes, safe areas). Rejected: a new palette, which would discard the 270 proven contrast pairs for no gain in legibility.
- **The bottom tab bar, not a top one,** so the thumb reaches it; the app bar keeps only the brand, the connection chip and pause. The theme control moves to More below 768.
- **The chain is a stepper, not an indented outline:** a state dot on one line per step, the state in words under the name. Rejected: pill badges beside each name, which wrapped unevenly and hid the order.
- **The compact rail is one line:** a reached connector takes its node's colour, a not-reached one is dotted. Rejected: no connector to a not-reached node, which made a closed run read as loose pieces.
- **The dot flow replaces the marching dashes,** and runs on every connector the data says is running (the pulse stays one per view). Rejected: dashes that only slide one way (they read as decoration, not as work going out and coming back).
- **Connecting and paused are neutral panels.** Rejected: the failure tint for a stream that has not failed.
- **Gate cards are compact on a phone** (smaller head and padding; a task id equal to its slug is said once). Rejected: the desktop card at full height, which showed two gates per screen.

### Start a session (row 165)

- **The entry** is the item `.navrail__slot` (`data-slot="start-session"`, label "Start", a plus icon) between Sessions and Layers, always shown in `index.html`: a link in the rail at 768 and above, an item in the tab bar below. The slot is not hidden. A device that may not start still opens the page and reads why (below).
- **One scrolling form page, not a dialog and not one question per screen.** `#/start` is `.start-view` holding `.start`: the project (a select, shown only when more than one project is known), the checkout (radio rows `.start__choice`; a busy checkout is disabled and says why; the main checkout first), the harness (radio rows, none preselected; a startable harness whose main-session shape was not seen on a live run carries the note "not yet verified on a live run"; a harness that cannot start is listed with its reason under "Not available on this machine", `.start__blocked`), the model (a select grouped by where the model comes from, disabled until a harness is chosen; each option reads as the core's `bindingText` of its entry, a model with its provider and effort and the notes in brackets, and is keyed by that triple, so the same model under another provider or effort is another option; an entry the harness cannot take a part of is a disabled option ending ` [cannot start: <reason>]`; under the select one `.start__modelnote` line repeats the chosen option's notes in words behind a `?` mark, or says "The harness picks its own model." for the harness default, then one sentence on where the effort comes from, from the entry's `effortPlan` (row 178: "Effort: harness default (no harness session to follow)." for the default of a Console start, "Effort: high (tier binding)." for a bound effort; with no plan from the core the default keeps "The harness picks its own model and effort."), and is hidden when there is nothing to say), how the session starts ("Start with DoFlow's do skill", the default, or "Send my text only"), the first text with its `n / 8000` count (`.start__count`, `data-over` when too long), one sentence on the harness's permission mode, the limits line, and the Start button (`.start__submit`, full width, disabled with the missing step said beside it). The button opens the confirmation dialog of feature 162, which names the harness, model, checkout and project; nothing starts before it is confirmed. Rejected: a dialog (it does not survive a reload or the back step) and one question per screen on a phone: that idea is not done and no row promises it.
- **After the confirmation the page follows the session** in `.start__flow`, whose `data-state` is one of form, starting, running, streaming, ended, refused or unknown. The output is two panes (`.start__tail`, the last 200 lines of the session's `file:` lanes, masked); an End session button (`cancel-worker`) asks the same dialog; when the harness has a control channel the flow also draws the message box and Stop turn (below); "Open it in Layers" links to the session's agent page; "Start another" returns to the form after an end. A refusal says its reason in words and states that nothing was started (`.start__refusal`). After a lost reply the state is "unknown": it says there was no answer and to check Sessions, and starting again sends the same request id, which the core starts once.
- **A device that may not start** (a view device) gets `.start__viewonly`: one sentence and the terminal command, no form and no button.
- **Where else it shows.** Sessions lists "Sessions started in this project" (`.started-here`): the open ones and the newest ended ones, at most 8, newest first, each with who started it (`console`, a paired device's relay label such as `device.d-0123456789ab`, or `terminal` for a start typed in a terminal), its phase or how it ended and when, and its Layers link; the empty words show only when the project has no started session at all, and Layers shows the one `started-session` node; its inspector pane `.started` (`.started__facts`, `.started__acts`) has the facts, the End session control and the same output panes. Words follow the rest of the Console: "process seen", never "active" or "live".

### Talking to a started session (row 170)

- **One state word from the harness's own events.** The session page (Layers, the started-session inspector, and `.start__flow` while it runs) shows a turn badge: "Working" or "Waiting for you" only when the core observed the turn, else "Not observed: <reason>" (no turn event seen yet; its last message was refused; its channel is opening or closed; its supervisor stopped; it has no control channel; it was started without one), and "Ended: <reason>" once the channel is closed or the session is over (it sat unused for 30 minutes and its channel was closed; the harness exited; a message could not be written to it; it never started; its channel never opened; it was stopped). Rejected: guessing "Working" from a live process, which is the claim this feature refuses to make.
- **Three buttons and a message box, drawn only for an open channel.** Send (the follow-up), Steer (redirect the turn in progress) and Stop turn (end the turn, keep the session) share one box with its `n / 8000` count and a NUL or length issue said in words. While the turn is waiting, Steer reads "it is waiting: send instead" and Stop turn reads "it is waiting: there is no turn to stop", both disabled. While the session is being ended, or its supervisor is gone, all three are disabled with the reason. Each press opens the one confirmation dialog, as every action does; the box clears only after an applied Send or Steer, and an unanswered attempt keeps its request id, so pressing again replays rather than sends twice. End session (`cancel-worker`) is the only button that ends the session itself, and while the supervisor is gone it is the one offered: "Not observed: its supervisor stopped. End it with End session."
- **No channel is one sentence, not a broken form.** A session whose harness has no recorded channel, or that was started without one, shows "Send is unavailable: <reason>" and no box. The start form says it before the start: "You can talk to it while it runs." for a supported channel, followed by "Talking to it is not verified on a live run: <first unverified phrase>." until a live run is recorded; "Runs one prompt; Send is unavailable: <reason>." otherwise.
- **A view device reads, never acts.** A device that may not act gets one sentence in place of the box: "Sending needs this machine’s Console or a phone paired with control over the app." A phone browser page is such a device (R-3); a phone paired with control over the native transport and this machine's Console page are not.
- **Recent messages are rows of metadata.** Each row says the kind (First text, Send, Steer, Stop turn), who (Console, terminal, or "paired device d-…"), when, the size in bytes and whether it was accepted, written, refused or failed. A message's text is never shown, kept or logged here; the Console action log keeps `textBytes`, not the text.
- **The Console holds no limit of its own for these.** The core refuses with its own codes (`actor-rate-limited`, `channel-busy`, `prompt-too-long`, and so on) and the confirmation dialog says them in words; a start limit is the core's too.

## Tokens

`tokens.css` declares custom properties and `color-scheme` only; it styles no element. `:root` holds the theme-invariant tokens and the light theme. `[data-theme="dark"]` holds the dark theme, and the same values repeat under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])`. System (no attribute) lets the media query decide. A token changes in `tokens.css` first; `tokens.test.ts` re-proves every WCAG 2.2 AA contrast pair (4.5:1 text, 3:1 non-text and focus) in both themes.

<!-- generated:tokens -->
<!-- Generated by console/scripts/build-design-md.ts from the CSS. Change the CSS, then run it with --write. -->
```text
# theme-invariant (:root)
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
--font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace
--type-xs: 500 12px/16px var(--font-sans)
--type-sm: 400 14px/20px var(--font-sans)
--type-md: 400 16px/24px var(--font-sans)
--type-lg: 600 20px/28px var(--font-sans)
--type-xl: 650 28px/36px var(--font-sans)
--type-display: 700 40px/48px var(--font-sans)
--tracking-tight: -0.011em
--tracking-display: -0.022em
--tracking-caps: 0.06em
--space-1: 4px
--space-2: 8px
--space-3: 12px
--space-4: 16px
--space-5: 24px
--space-6: 32px
--space-7: 48px
--space-8: 64px
--radius-sm: 4px
--radius-md: 8px
--radius-lg: 12px
--radius-pill: 999px
--motion-fast: 120ms
--motion-base: 200ms
--motion-slow: 480ms
--motion-flash: 600ms
--motion-pulse: 2400ms
--motion-march: 1100ms
--motion-shimmer: 1400ms
--motion-swap: 160ms
--motion-row: 180ms
--motion-gate: 240ms
--ease-standard: cubic-bezier(0.2, 0, 0, 1)
--ease-exit: cubic-bezier(0.4, 0, 1, 1)
--ease-settle: cubic-bezier(0.22, 1, 0.36, 1)
--content-max: 1440px
--prose-max: 72ch
--gutter: 16px
--header-h: 48px
--tabbar-h: 56px
--navrail-w: 200px
--navrail-w-icons: 72px
--inspector-w: 400px
--target: 44px
--target-min: 24px
--focus-width: 2px
--focus-offset: 2px
--z-banner: 5
--z-header: 10
--z-panel: 20
--z-skip: 30
--safe-top: env(safe-area-inset-top, 0px)
--safe-right: env(safe-area-inset-right, 0px)
--safe-bottom: env(safe-area-inset-bottom, 0px)
--safe-left: env(safe-area-inset-left, 0px)
--chrome-top: calc(var(--header-h) + var(--safe-top))
--chrome-bottom: calc(var(--tabbar-h) + var(--safe-bottom))
# themed: light | dark ([data-theme="dark"], also under prefers-color-scheme: dark unless data-theme is light)
--bg: #F5F3EF | #0D1013
--surface: #FEFDFB | #15191C
--surface-2: #ECE9E4 | #1E2226
--surface-3: #FEFDFB | #262B2F
--border: #CDCAC3 | #32363A
--border-strong: #78746D | #7B8187
--text: #17130F | #ECEFF2
--text-muted: #514C46 | #A3A8AE
--accent: #5B2FD0 | #B69CFF
--accent-tint: #EFE9FD | #2A2148
--on-accent: #FFFFFF | #0D1013
--focus: #5B2FD0 | #B69CFF
--skeleton: #ECE9E4 | #1E2226
--skeleton-shine: #F8F7F3 | #2C3136
--scrim: rgb(20 26 35 / 0.40) | rgb(0 0 0 / 0.56)
--elev-1: none | none
--elev-2: 0 4px 12px rgb(16 24 40 / 0.12), 0 2px 4px rgb(16 24 40 / 0.06) | 0 8px 24px rgb(0 0 0 / 0.50), inset 0 1px 0 rgb(255 255 255 / 0.06)
--state-running-fg: #005198 | #71BFFF
--state-running-tint: #DDEDFF | #0E293D
--state-running-mark: #0076D3 | #3496EF
--state-awaiting-fg: #7B4300 | #F7B83D
--state-awaiting-tint: #FEEDC9 | #332305
--state-awaiting-mark: #B46E00 | #DFA11A
--state-done-fg: #0B5D2A | #67D283
--state-done-tint: #D9F3DD | #152619
--state-done-mark: #258343 | #3BB360
--state-rejected-fg: #45423C | #C3C8CC
--state-rejected-tint: #E7E4DF | #23272B
--state-rejected-mark: #6B6963 | #858A8F
--state-failed-fg: #9E141E | #FF8880
--state-failed-tint: #FFE4E1 | #391917
--state-failed-mark: #D02C2A | #ED4A49
--state-skipped-fg: #514C46 | #A3A8AE
--state-skipped-tint: #ECE9E4 | #1E2226
--state-skipped-mark: #78746D | #7B8187
--state-pending-fg: #514C46 | #A3A8AE
--state-pending-tint: #FEFDFB | #15191C
--state-pending-mark: #7E7A72 | #7B8187
--state-stale-fg: #55452F | #D0C2AF
--state-stale-tint: #F1EAE0 | #26211A
--state-stale-mark: #836E51 | #9D896E
--state-unknown-fg: #514C46 | #A3A8AE
--state-unknown-tint: #ECE9E4 | #1E2226
--state-unknown-mark: #7E7A72 | #7B8187
# overrides (:root inside the media query)
@media (prefers-reduced-motion: reduce) --motion-fast: 0ms
@media (prefers-reduced-motion: reduce) --motion-base: 0ms
@media (prefers-reduced-motion: reduce) --motion-slow: 0ms
@media (prefers-reduced-motion: reduce) --motion-flash: 0ms
@media (prefers-reduced-motion: reduce) --motion-pulse: 0ms
@media (prefers-reduced-motion: reduce) --motion-march: 0ms
@media (prefers-reduced-motion: reduce) --motion-shimmer: 0ms
@media (prefers-reduced-motion: reduce) --motion-swap: 0ms
@media (prefers-reduced-motion: reduce) --motion-row: 0ms
@media (prefers-reduced-motion: reduce) --motion-gate: 0ms
@media (min-width: 768px) --gutter: 24px
@media (min-width: 768px) --header-h: 56px
@media (min-width: 768px) --tabbar-h: 0px
@media (min-width: 1280px) --gutter: 32px
@media (min-width: 1280px) --target: 32px
```
<!-- /generated -->

How the names are used:

- Neutral ramp: the light theme is warm paper (`--bg`, `--surface`, `--surface-2` and the borders lean warm), the dark theme is graphite (a cool, slightly blue grey). Amber and blue are state colours only: amber is `awaiting` (`--state-awaiting-*`) and blue is `running` (`--state-running-*`). Violet (`--accent`) stays the interaction accent. The neutral, border and state hues are adapted by hand from the Console theme of Hallmark (`github.com/Nutlope/hallmark`, MIT License); values are converted to sRGB hex and adjusted for WCAG 2.2 AA, and no code or fonts are copied.
- Surfaces: `--bg` (page), `--surface` (header, cards, rail, panels), `--surface-2` (inset, hover, pressed), `--surface-3` (raised layers: popover, side panel). `--border` is decorative only; `--border-strong` (3:1) bounds controls and cards.
- Text: `--text`, `--text-muted` (secondary, timestamps, labels). `--accent` is for links, selected nav and chip text and the primary button fill; `--accent-tint` is a selected background; `--on-accent` is text on an `--accent` fill; `--focus` is the focus ring.
- Run states: `--state-<state>-fg` (text and icons), `-tint` (badge, banner and card background), `-mark` (node fill, connector, non-text). The states are `running`, `awaiting`, `done`, `rejected`, `failed`, `skipped`, `pending`, `stale`, `unknown`. Blue is `running`, amber is `awaiting`, `stale` is a warm taupe on purpose (never an amber that imitates `awaiting`), violet is "you can act here".
- Text on a state fill uses `-fg` on `-tint`; a full-rail stage pill is tint, 1.5 px `-mark` border and `-fg` text, because `-fg` on a `-mark` fill is not a proven pair.
- Type: `--type-xs` to `--type-display` are `font` shorthands (`font: var(--type-md)`); mono text sets `font-family: var(--font-mono)` after it. `--type-display` appears at most once per view and is used at the `--type-xl` size below 768 px. Numbers use `font-variant-numeric: tabular-nums`.
- Space is the 4 px scale `--space-1` to `--space-8`. Radius: `--radius-sm` tags, `--radius-md` cards, nodes and buttons, `--radius-lg` panels, the activity slot and banners. Chip radius: `--radius-sm` for the status chip `.badge` (with the `.conn` chip, `.model-chip` and `.srow__tag`); controls (`.chip`, the theme control) keep `--radius-pill`.
- Elevation (hairline panels): `--elev-1` is `none` in both themes, so resting cards carry no shadow and are bounded by `--border` or `--border-strong` and the surface step. Hover and expanded states use an edge or an inset ring (`border-color: var(--border-strong)`, `inset 0 0 0 1px var(--border-strong)`, `inset 0 0 0 2px var(--accent)`), never an outer shadow. `--elev-2` is only for the skip link `.skip`, the `.inspector` as drawer or sheet, the popover `.fpanel__new`, the help dialog `.help__panel` and the palette `.palette__panel`. The detail panels (`.rail-detail`, `.graph__panel`, `.spanel`, `.fpanel`) are shown in the `.inspector` and carry no card of their own.
- Layout: breakpoints sm < 768, md 768-1279, lg 1280-1919, xl 1920 and up. `--gutter`, `--header-h` and `--target` change per band (see the overrides above). `--target` is the minimum hit size (44 px below 1280, 32 px from 1280); nothing is smaller than `--target-min` (24 px). Content is capped at `--content-max`, prose at `--prose-max`. Layers: `--z-banner`, `--z-header`, `--z-panel`, `--z-skip`.
- Focus: `outline: var(--focus-width) solid var(--focus)` with `outline-offset: var(--focus-offset)`, on `:focus-visible` only. Heading targets (`h1[tabindex="-1"]`) and `main` show no ring because they are not controls.

### Surface hierarchy

- `--bg` is the page canvas; `--surface` marks a primary content group; `--surface-2` marks a nested or subordinate layer; `--surface-3` is reserved for overlays.
- On Runs, a waiting gate leads, the running list remains legible but quieter, and Finished is a compact history section. The three summary counts are not equal when a gate is waiting.
- On Sessions and Layers, conflicts lead and the current checkout/project is identifiable without adding another status color. Detail panels may rise above their source row; supporting notes and limits stay quieter.
- Use spacing, type, grouping and elevation to express information order. Reserve state tints for actual states and the accent for selection and interaction.

### Motion

Durations are `--motion-fast` (hover, focus, small fades), `--motion-base` (state colour change), `--motion-row` (a row opening its detail, view enter), `--motion-swap` (a node's state swap, the drawer coming in), `--motion-gate` (a decided gate turning open, the sheet rising), `--motion-slow` (layout release, the check draw), `--motion-flash` (the one-shot tint of something that changed), and the loops `--motion-pulse` (awaiting gate), `--motion-march` (one leg of the dot flow) and `--motion-shimmer` (skeleton, loading only). Easings: `--ease-standard` (enter and move), `--ease-exit` (leave), `--ease-settle` (arrive and stop, with no overshoot).

The primitives, all in the `motion` layer of `app.css`. The still variant is what the host shows under reduced motion, while stale, and when it is not the view's one loop:

| Keyframes (what moves) | Host | Duration | Loops | Still variant |
|---|---|---|---|---|
| `view-in` (opacity) | `.view-enter` | `--motion-row` | no | the view appears at once |
| `banner-in`, `banner-out` (opacity) | `.banner`, `.banner--leaving` | `--motion-fast` | no | the banner appears and leaves at once |
| `panel-in` (opacity, transform) | `.inspector` as drawer (from the right, `--motion-swap`) or sheet (rising from below, `--motion-gate` with `--ease-settle`) | see host | no | the panel appears at once; `panel-out` is declared but has no host, so closing is instant |
| `tint-decay` (opacity) | a 6 px ring in the item's tint on `data-changed="true"` (`.activity`, `.attempt`, `.tl-item`, full-rail nodes) or `data-fresh="true"` (`.srow`, `.gate-card` on Layers) | `--motion-flash` | no | a 2 px outline on the changed item (a 2 px inset bar on `.srow`) plus the live-region announcement |
| `fade` (opacity) | a stage `.rail__glyph` whose state changed | `--motion-swap` | no | the new glyph at once |
| `settle` (transform, opacity) | a full-rail glyph arriving at `awaiting`, with `--ease-settle` | `--motion-swap` | no | the new glyph at once |
| `gate-open` (transform, opacity) | a full-rail gate decided (`done` or `rejected`), with `--ease-settle` | `--motion-gate` | no | the decided glyph at once |
| `draw` (`stroke-dashoffset`) | the check of a full-rail node arriving at `done` | `--motion-slow` | no | the whole check |
| `pulse` (transform, opacity) | a ring on the awaiting gate `.rail__glyph` or `.gate-card__glyph` marked `data-loop="on"`: it opens, fades and rests before the next | `--motion-pulse` | yes | no ring; on the full rail a 3 px `--focus` outline on the `.rail__node`, and the words "Waiting for you" |
| `flow` (transform) | the dot flow: one dot on the connector into a running node, out and back (`alternate`, ease-in-out). Hosts: `.flow-edge` (full rail), `.flow-dot` (compact rail), `.chain__flow` (chain), each marked `data-loop="on"` | `--motion-march` per leg | yes | the dot at rest at the start of its track, plus an arrowhead into the running node on the full rail |
| `shimmer` (opacity) | the `.skel` blocks of a `.skeleton` marked `data-loop="on"` | `--motion-shimmer` | yes | flat `--skeleton` blocks |

- Keyframes animate only `transform`, `opacity` and SVG stroke (`stroke-dashoffset`, `stroke-dasharray`, `stroke-opacity`); colour changes on hover and focus are transitions.
- Nothing animates on first render. A theme change is instant.
- Only what changed since the last poll is marked (`data-changed="true"`, `data-fresh="true"`); its tint, a ring drawn by a pseudo-element, fades out once (`tint-decay`).
- Loop budget: an infinite animation runs only under `[data-loop="on"]`. A view marks at most one pulse: Run the current awaiting gate, Now the gate glyph of the first Needs you card, Layers the glyph of the first awaiting gate card. The dot flow is marked on every connector into a node the data says is running, and nowhere else: it is the picture of work in progress, so it never runs for a stage that is pending, done or not observed. A `.skeleton` is marked only while it shows. Every other host shows its still variant.
- Under `prefers-reduced-motion: reduce`, and while `#main` or `#inspector` carries `data-stale="true"`, rules in the `states` layer stop every animation, and every duration token is `0ms` under reduced motion. No script drives a frame. Each cue keeps a still replacement: the pulse becomes a focus-coloured outline plus the words "Waiting for you", the dot flow a resting dot (with an arrowhead on the full rail), the change tint an outline on the changed item plus the live-region announcement, the skeleton static `--skeleton` blocks.
- Under `forced-colors: active` the shape carries the state (`currentColor` icons, outlines in system colours); the selected nav item and chip keep a 2 px border. Nothing relies on a background colour alone.

## Shell

`index.html` holds the app bar `.site-header`, the banner slot and one `.shell` (`#shell`): a grid of the navigation `.navrail`, the attention strip `.attention`, the canvas `#main` (`.page`) and the inspector `#inspector` (`.inspector`). The grid lives in the `layout` layer and changes only with the band and with `data-inspectable` on `.shell`, which `web/app.js` sets from the route. The chrome honours the safe areas of a phone shell: `--safe-top`, `--safe-right`, `--safe-bottom` and `--safe-left` are the `env(safe-area-inset-*)` values, `--chrome-top` is the app bar plus the top inset and `--chrome-bottom` the tab bar plus the bottom inset; `.page` pads by them, so nothing sits under a notch or a home indicator.

| Band | Navigation | Canvas | Inspector |
|---|---|---|---|
| below 768 | a tab bar fixed at the bottom, `--tabbar-h` high plus `--safe-bottom`: Now, Sessions, Layers, More, each an icon over its label | one column | sheet: fixed at the bottom, full width, at most the viewport height minus `--chrome-top`, top corners `--radius-lg` |
| 768 to 1279 | a sticky column `--navrail-w-icons` wide, icon over label; the Manage group under a rule; More is hidden | the rest of the width | drawer: fixed at the right below the app bar, `--inspector-w` wide but leaving at least `--space-7` of canvas |
| 1280 and up | a sticky column `--navrail-w` wide, icon beside label, the group titled by `.navrail__heading` | the middle column | dock: a sticky third column `--inspector-w` wide |

- **Navigation** `.navrail`, `.navrail__link`, `.navrail__group`, `.navrail__more`, `.navrail__badge`, `.navrail__slot`. Now (`#/`), Sessions and Layers come first, then More (`.navrail__more`, shown below 768 only), then the Manage group `.navrail__group`: Follow-ups, Workflows, Workers, Advice, Settings and Health (hidden below 768, where More lists them). The current link carries `aria-current="page"`; on a Manage page the More link also carries `aria-current="true"`, so the tab bar always shows where you are. Now is current on every `#/run/...` and `#/session/...` page, Layers on every `#/layers...` page. A label is always visible: no icon stands alone. Every link is at least `--target` high. The bar is `--surface` with a `--border` edge toward the canvas.
- **Page icon** `favicon.svg`: a 16 px text SVG of the gate mark on the accent, linked from `index.html` and served by the static route under the unchanged policy (`img-src 'self'`). No binary icon, no data: URI.
- **App bar** `.site-header`: one quiet row `--header-h` high: the brand, the connection chip `.conn`, the `.pause` control (an icon below 1280, with its words as its name) and, from 768, the theme control `.theme` as three bare icons (the chosen one on `--surface-2`); the core version shows from 1440. Rejected: a labelled, bordered theme pill, which was the heaviest thing in the bar for the least used control.
- **Attention strip** `.attention`, `.attention__count`, `.attention__where`, `.attention__link`: one line under the app bar on every page but the Layers machine page (which leads with the same gates). In the `awaiting` tint it reads "3 gates waiting for you", then where: "on this machine, in 2 projects", "on this machine, in this project" or "on this machine, in" the one other project's label. The count is of the machine and says so, because the Now page lists one project and names it in its head. The Review link goes straight to the run when the one gate is in this project, to that project's Layers page when every gate is in one other project, else to the Layers machine page. `data-state="unknown"` reads "Waiting gates not observed" and why (the stream is down, refused, unsupported or paused, the core is older, the activity is unreadable). It never reads "nothing waiting" from a stream that is not being followed; a held record says "as of" its time, and with no gate in it the strip reads "Waiting gates not observed since" that time and why, never absent. The count is the core's awaiting runs (`runs.awaiting`), not the gates it lists (at most 8 a project). When the core left projects out of its summary (`limits.notShown`) or a summarized project's store did not read, it reads "At least 3 gates waiting for you", or with none counted "Gates on this machine not fully observed" and what was not observed. When the project list is unreadable a gate is "on this machine" only and Review opens the Layers machine page. With nothing waiting in a followed record that left no project out it is absent. The same count is the `.navrail__badge` on the Layers link (`3+` for an at-least count): its digit is `aria-hidden` and the link's name says the count once, in the strip's words. `web/derive/attention.js` is the pure model.
- **More** `.more`, `.more__section`, `.more__title`, `.more__list`, `.more__item`, `.more__label`, `.more__hint`, `.more__facts` (`web/views/more.js`): each destination is one row at least `--target` high, an icon, its name and one line on what it answers; then the theme control and the core version.
- **Canvas** `#main` (`.page`) holds the view and keeps `min-width: 0`, so wide content scrolls inside it. From 1280 an open panel docks beside the canvas and the canvas narrows for it; below that the drawer and the sheet overlay the canvas. The inspectable views are Run, Tasks, Sessions, a Layers project and the five management screens (`data-inspectable="true"` on `.shell`); Now, Workflows, the Layers machine page and the not-found page use the full width.
- **Inspector** `.inspector`, `.inspector__head`, `.inspector__title`, `.inspector__body`, `.inspector__scrim`. `createInspector` in `web/shell.js` sets `data-mode` to `dock`, `drawer` or `sheet` from the viewport width and re-applies it when the width crosses 768 or 1280, keeping the open content. Views put a panel in with `showPanel` and take it out with `hidePanel`; the rail detail, the task panel, the lane panel and the Layers agent and file panels all render here and carry no card of their own, nor a close control: the inspector's close button is the only one. While a panel is open, `aria-labelledby` names the inspector by `.inspector__title` and the panel's own heading (`labelledBy` of `showPanel`: `rail-detail-title`, `graph-panel-title`, `sessions-panel-title`, `fpanel-title`), in every mode; closing drops it, so the name is the "Details" of `index.html` again.
  - `dock`: a complementary landmark that never takes or traps focus. The column exists only while a panel is open (`data-panel="open"` on `.shell`): an empty column never takes width from the canvas, so a wide screen gives its width to the data. Rejected: a column that is always present with a "select an item" note, which kept the canvas from reflowing but left a third of a wide screen empty.
  - `drawer` and `sheet`: hidden until something opens. While open the inspector is a modal dialog (`role="dialog"`, `aria-modal="true"`) at `--z-panel` with `--elev-2`, over a `.inspector__scrim` in `--scrim`. Focus moves to the close button and Tab stays inside. Escape (the `close` entry of `web/keys.js`), the close button or a click on the scrim closes it. Focus then returns to the control that opened it, or to `#main` when a poll has rebuilt that control.
- **Palette** `.palette`, `.palette__panel`, `.palette__title`, `.palette__input`, `.palette__list`, `.palette__option`, `.palette__label`, `.palette__hint`, `.palette__none`, `.palette__note`. Ctrl K or Cmd K (the `palette` entry of `web/keys.js`) opens it, and `web/palette.js` builds it on the first open. It is a modal dialog on the `--z-skip` layer: a `--scrim` backdrop and a `--surface-3` panel at most 640 px wide with `--radius-lg` and `--elev-2`. The input is a combobox over a listbox (`aria-activedescendant`); Up and Down move and wrap, Enter goes, Escape closes, Tab stays on the input, and focus returns to the opener or to `#main`. It lists only what the page has already loaded and never fetches: the nine screens, then runs, session lanes and Layers projects, matched as a case-insensitive substring of label or hint, at most 50 options. An empty query lists the screens and the runs. The active option is `--accent-tint` with a 2 px `--accent` bar at its start (a `Highlight` outline under forced colours). A choice only sets `location.hash`. The palette and the shortcut list `.help` are never open together.
- **Permalinks:** a selection is part of the hash, so a reload or a shared link opens the same panel: `#/run/<slug>/<task>/stage/<id>`, `#/run/<slug>/<task>/gate/<id>`, `#/run/<slug>/<task>/tasks/<id>`, `#/sessions/` followed by the lane key, `#/layers/<project>`, `#/layers/<project>/agent/<agentKey>` and `#/layers/<project>/file/<fileKey>`.

## Components

Management screens use `.mtable` for data, `.matrix` for the keyboard grid, `.figure` for values, `.daytable` for day counts, `.sgroup` for settings, `.candidates` for layer details and `.doctor-head` for doctor freshness and refresh. Tables scroll and accept keyboard focus; status words use `.badge` and security markers use `.tag`.

Generated list of the top-level class blocks in `app.css` (elements are `block__element`, variants `block--variant`; state lives in `data-*` and `aria-*` attributes, not in extra classes):

<!-- generated:components -->
<!-- Generated by console/scripts/build-design-md.ts from the CSS. Change the CSS, then run it with --write. -->
`.activity`, `.acts`, `.attempt`, `.attempts`, `.attention`, `.badge`, `.banner`, `.banner-slot`
`.banner-wrap`, `.brand`, `.brand-gate`, `.brand-line`, `.brand-node`, `.btn`, `.candidates`
`.chain`, `.chip`, `.cmd`, `.code-chip`, `.confirm`, `.conn`, `.core-version`, `.countdown`, `.dash`
`.daytable`, `.doctor-head`, `.empty`, `.ev`, `.eyebrow`, `.f`, `.facts`, `.fbanner`, `.figure`
`.filter-status`, `.flow-dot`, `.flow-edge`, `.fpanel`, `.full-state`, `.gate`, `.gate-card`
`.gate-cards`, `.gate-chip`, `.gattempt`, `.gattempts`, `.gcard`, `.gdetail`, `.glane`, `.graph`
`.grid`, `.grow`, `.help`, `.hint`, `.icon`, `.inspector`, `.lane`, `.layers`, `.layers-banner`
`.layers-crumb`, `.layers-foot`, `.layers-head`, `.layers-inspect`, `.layers-lanes`, `.layers-link`
`.layers-none`, `.layers-note`, `.layers-section`, `.layers-sections`, `.layers-stream`
`.layers-title`, `.layers-unreadable`, `.logpane`, `.lrow`, `.masked`, `.matrix`, `.model-chip`
`.mono`, `.more`, `.mtable`, `.navrail`, `.noscript`, `.num`, `.ov-check`, `.ov-cross`, `.ov-forced`
`.page`, `.pair`, `.palette`, `.pause`, `.project-list`, `.rail`, `.rail-detail`, `.rail-fallback`
`.rail-note`, `.rail-scroll`, `.reltime`, `.replay`, `.replay-host`, `.run-head`, `.run-list`
`.run-rail`, `.run-row`, `.run-section`, `.saved-filters`, `.sbar`, `.segmented`, `.sessions`
`.sfilter`, `.sfoot`, `.sgroup`, `.shape`, `.shell`, `.shold`, `.site-header`, `.skel`, `.skeleton`
`.skip`, `.slane`, `.slane-children`, `.snote`, `.spanel`, `.srow`, `.srows`, `.start`
`.start-view`, `.started`, `.started-here`, `.state-panel`, `.stream`, `.summary`, `.tag`, `.theme`
`.tile`, `.timeline`, `.tl`, `.tl-item`, `.tl-list`, `.ttable`, `.vh`, `.view-enter`, `.view-head`
`.view-note`, `.view-title`, `.wf`, `.wf-list`, `.wtabs`
<!-- /generated -->

What an agent most often touches:

- **Status badge** `.badge` with `data-state`: `--radius-sm` chip, `-tint` background, `-fg` text in `--type-xs`, a 12 px inline SVG shape (`aria-hidden="true"`) and the word. Never a dot alone. Outcome badges reuse states: passed is `done`, failed is `failed`, unverified is `unknown` with the word "unverified".
- **Rail** `.rail`, `.rail--compact`, `.rail--full`, `.rail__item`, `.rail__node`, `.rail__glyph` with `data-type` (stage or gate) and `data-state`. Stages: filled for `running` and `done`, dashed outline for `skipped`, outline for `pending`, hatched for `unknown`. Gates are 24 px shapes on the connector: a diamond for approval, a hexagon for clarification. The nodes are buttons with a roving tabindex: one node has `tabindex="0"`, the rest `-1`. It scrolls inside itself, never the page. On the compact rail a connector into a reached node takes that node's mark, one into a `not-reached` node is dotted, and the connector into a running stage carries the `.flow-dot`.
- **Chain** `.chain`, `.chain__item`, `.chain__row`, `.chain__node`, `.chain__body`, `.chain__label`, `.chain__facts`, `.chain__chip`, `.chain__live`, `.chain__marker`, `.chain__twist`, `.chain__flow` (the Session view, `#/session/...`): a stepper in one `--surface` panel, still a `tree` of `treeitem` rows with a roving tabindex. Each step is a 24 px state dot `.chain__node` (`data-state`; filled with its tint when reached, hollow and dashed when not) on one vertical line, the name, and under it the state in words in the state's `-fg`, the live count and the marker. Children step in by `--space-4`; a parent shows a `.chain__twist` chevron that turns when open; the selected row is `--accent-tint` with an accent bar. The line into a step the data says is running carries the `.chain__flow` dot.
- **Gate card** `.gate-card`: the `awaiting` tint head (glyph, kind, how long), the gate's name, the run it belongs to, then the one way on: the link to the run, or the note that it is decided in a terminal. Compact below 768 (head `--target` high, `--space-3` padding), roomier above. The Approve and Reject buttons sit in its `.acts` area when the page may act, the note with the reason when it may not.
- **Activity slot** `.activity` (`.activity--gate`, `.activity--done`, `.activity--rejected`, `.activity--stale`): `--radius-lg`, `--elev-1` (no shadow), a 4 px left bar in the current state's mark, labelled by its title with `aria-labelledby`. The decide command is a command block.
- **Command block** `.cmd`, `.cmd__text`, `.cmd__copy`: mono `--type-sm` on `--surface-2`, a `--border-strong` edge, a trailing Copy button with an `aria-label`. The label reads "Copied" after a copy and the polite live region announces it; without clipboard access the text is selected.
- **Button** `.btn` with `.btn--primary` (accent fill), `.btn--secondary` (`--surface`, strong border), `.btn--ghost`. Height is `--target`; pressed is `--surface-2`, or `filter: brightness(0.92)` for primary.
- **Action button and confirmation dialog** (feature 162) `.btn--act` with `data-tone` of `approve` (the accent fill) or `danger` (the `failed` tint, border and the verb's word: reject, close, stop), in `.acts` areas (`.acts__row`, `.acts__reason`). They are drawn only when `/api/actions` says the action is allowed; otherwise the command block stays with one muted `.acts__reason` line. A press opens the one `.confirm` dialog (`.confirm__scrim`, `.confirm__panel` with `role="dialog"` and `aria-modal="true"`, `.confirm__title`, `.confirm__effect`, `.confirm__input`, `.confirm__count`, `.confirm__result`, `.confirm__actions` with Cancel and the verb button): a sheet below 768 px, a centred panel from 768. Focus starts on Cancel, Escape closes, Tab wraps; the verb button is the only thing that posts. A route change (a link, Back) closes it, and while it is open the global shortcuts of `web/keys.js` do nothing, so the palette and the shortcut list cannot open over it. On close focus returns to the control that opened it while that control is on the page, else to `#main`, then the `h1`. An `applied`, `unknown` or `stale` outcome makes the page refetch what it shows at once; "Review again" waits for that answer and builds the dialog from the refreshed row, and when the row still holds the revision the dialog opened with it builds nothing and says the page has not read the run again. `data-state` on `.confirm` is `ready`, `sending`, `applied`, `stale`, `refused` or `unknown`; the last three tint the result with the `failed` pair and say it in words. Where they sit: Approve and Reject in the `.gate-card` and in the run's `.activity` slot, Close run in the run head beside the step counter (it acts on the run, not on the current step), Stop worker in the head of a worker tab. Below 768 the buttons of a row and of the dialog share the full width in equal parts, `--target` high, and the sheet adds `--safe-bottom` under its buttons and covers the tab bar; from 768 they take their own width. The panel comes in with `panel-in` over `--motion-gate` on `--ease-settle`, the scrim fades.
- **Chip** `.chip`: a pill of `--target` height; filters use `aria-pressed`; selected is `--accent-tint` with `--accent` text plus a check icon (selection is never colour alone).
- **Segmented control** `.segmented`, `.segmented__opt`, and the theme control `.theme`, `.theme__opt`: a `radiogroup` of `role="radio"` buttons with `aria-checked` and a roving tabindex; arrow keys move and select (wrapping), Home and End jump. The theme choice is stored in `localStorage` under `doflow-console-theme` inside try/catch, and the page works without storage.
- **Connection chip** `.conn` with `data-state` of `unknown`, `done`, `stale` or `failed`: a shape and a word ("Updated 4 s ago", "Stale", "Offline", "Core unreachable"). It is in the header; `.conn__long` and `.conn__short` swap at 768 px.
- **Banner** `.banner`, `.banner__text` in `.banner-slot`: state tint, a 4 px left bar, an icon, one sentence and one action. The stale banner has `data-kind="stale"`.
- **Skeleton** `.skel`, `.skeleton`: `--skeleton` blocks with the final layout's dimensions, `aria-hidden="true"`, shown only after a delay. The shimmer runs only without reduced motion.
- **Layers** `.layers`, `.lrow`, `.lane`, `.project-list`, `.layers-banner`: plain lists of links, no tree widget; an agent, run or project row is one anchor that fills the row, and the link of the selected row carries `aria-current="true"`. **Task graph** `.graph`, `.gcard`, `.grow__btn`: cards and rows expose `aria-expanded` and open the task panel in the `.inspector`.
- **Model chip** `.model-chip`: mono `--type-xs` on `--surface-2`, a model id and never a state. **Masked chip** `.masked`: the masked icon plus the word "masked", "email" or "ip".
- **Replay** `.replay`: a range input with an `aria-label`, play, previous, next, and speed buttons that use `aria-pressed`.
- **Navigation and landmarks:** `.skip` (skip link, visible on focus), `.navrail__link` (the current route has `aria-current="page"`), `.vh` (visually hidden, still read by assistive technology), and a polite live region `#announcer` for changes. View titles are `h1` with `tabindex="-1"` so a route change can move focus to them.
- **Layers stream states** (`#/layers...`, no GET and no polling; the page draws only from `/api/live` frames): the banner under the head is one glyph, one word and one tint. `connecting` is the neutral wait; `following` is the quiet default and shows no banner; `stream down` (the browser's own reconnect is running) and `refused` (the device is no longer allowed; reconnecting stops) and `unsupported` (this browser has no EventSource) are the failure tints; `core-lacks-channel` names a core too old for the channel. A section that failed to read says `unreadable` with its code, and a harness source nobody records says `not observed` with the reason; neither is ever drawn as quiet or idle, and an agent is never called live, active, online or idle.

## States

Every view has these edges designed; a view is not finished until its worst state looks deliberate. Paused is a state the person chooses: the `.pause` control (`aria-pressed`) stops polling for the view, the `.conn` pill reads "Paused" (`data-state="paused"`), and no stale banner is raised while paused.

| State | Component and signal |
|---|---|
| Loading | `.skeleton` / `.skel` of the final layout, only after a delay; `#main` carries `aria-busy="true"` while it loads |
| Empty | `.empty`: a still line drawing (`aria-hidden`), a title, one sentence, a command block and an optional link; at most 480 px wide |
| Not observed | the `unknown` tint and the words "not observed" with the reason; on the `.attention` strip for the gates, on a Layers source for an agent. Never "idle", never zero |
| Connecting, paused stream | `.state-panel` with `data-kind="stream-connecting"` or `"stream-paused"`: the same panel in `--surface-2` with a `--border-strong` bar, because nothing has failed |
| Error | `.state-panel` with `data-kind="error"`: an icon, a title, one sentence naming what failed and what to do, then retry actions; the code is small, after the sentence |
| Stale | `.banner` `data-kind="stale"` and `.conn` `data-state="stale"`; times switch from relative ("3 min ago", `.reltime__rel`) to absolute ("at 14:02:10", `.reltime__abs`) on `#main[data-stale]`, so stale data never reads "ago" |
| No runtime or session | `.full-state` (a full page) with a countdown and a "Check now" button |
| Unknown, unreached | the `unknown` / `pending` marks: hatched or empty outline plus the word, never zero |
| Paused | `.pause` pressed, `.conn` `data-state="paused"`; nothing is fetched until resume, which refetches the full state and says one "Reconnected" summary instead of each change |
| Changed since last poll | `data-changed="true"` flashes once in the item's own tint; first paint is still |

## Phone and accessibility

- Touch: every control is at least `--target` (44 px below 1280) and nothing depends on hover; hover only adds a tint to what is already a visible link or button. The primary places are in thumb reach in the tab bar; a page's own actions sit in its content, not in the app bar.
- Reading a stream, a log or a transcript on a phone: it opens in the `.inspector` sheet over the page (the list stays where it was), mono text wraps instead of scrolling sideways, new records arrive at the end, and masked text stays the `.masked` chip. Tables scroll inside their own frame; the page never scrolls sideways.
- Focus order is the DOM order: skip link, app bar, navigation, attention strip, canvas, inspector. A route change moves focus to the view's `h1`. Keyboard on a desktop: the palette (Ctrl K or Cmd K), the `?` list, arrows in the rail, the chain and the radio groups.
- Contrast is AA in both themes (`tokens.test.ts` proves each pair); state is a shape and a word as well as a tint; `forced-colors` keeps borders and system colours; reduced motion and a stale page stop every animation and show the still variants.


## Do

- Show state with shape plus word plus tint. Reuse the nine states and their three tokens; add no new colour for a status.
- Use a token for every colour, size, radius, shadow, duration and easing. The only literals in `app.css` are `transparent`, `currentColor` and forced-colours system colours.
- Honour both themes and System, `prefers-reduced-motion` and `forced-colors`. Give every new loop or flash a still replacement in the same change.
- Build DOM with the `h()` helper in `web/dom.js` and set server-provided strings as text nodes only. No `innerHTML`, `outerHTML` or `insertAdjacentHTML` (`web-safety.test.ts` scans for them).
- Use real buttons and links, `:focus-visible` rings, a roving tabindex for composite widgets (tree, rail, radio groups), `aria-labelledby` on sections, and the polite live region for changes. Keep hit targets at `--target`, never below `--target-min`.
- Voice: short and plain, second person for actions, past tense for records, units on numbers, ids in mono. An error says what failed and what to do, never an apology. Say "process seen", "recorded", "started" or "last record" for an agent; a main session has no recorded start, so its time reads "context captured".
- Bind keys only through `web/keys.js`: add the entry to `SHORTCUTS` (the `?` list `.help` is built from it), and ask `isKey(event, id)` in a view instead of comparing `event.key` to a literal. Arrow groups keep their roving tabindex in the widget.
- Change a token in `tokens.css`, regenerate with `node console/scripts/build-design-md.ts --write`, and keep `tokens.test.ts` and `design-md.test.ts` green.

## Don't

- Don't add a runtime dependency, a font file, a CDN, an inline script or inline style, or a build step. System font stacks only.
- Don't use colour alone for meaning, a dot alone for a state, or the accent (violet) for a run state.
- Don't write "live", "active", "online" or "idle" for an agent or a stale view, and don't show unknown, stale or unreached data as zero.
- Don't animate on first render or on a theme change, don't add a second pulse to a view, and don't run the dot flow on anything the data does not say is running.
- Don't make a hit target smaller than `--target-min`, or hide a focus ring on a control.
- Don't edit the generated blocks by hand, and don't weaken `tokens.test.ts` or `design-md.test.ts` to pass: fix the stale side.
