# DoFlow Console v2: design proposal

Status: proposal, 2026-11-07. Nothing here is built. `DESIGN.md` stays the system of record for tokens,
components and states; this file says what changes and why. Facts marked **(S)** were read from code or
files in this checkout; everything else is a proposal or an inference and is labelled so.

## 1. What this proposal asks you to decide

| # | Decision | Default I recommend | Why |
|---|---|---|---|
| D1 | Browser transport for live data | Keep **SSE**, multiplex channels on one stream | One-way fits the read-only Console, the CSP, the Origin/cookie checks and the session cap (S). |
| D2 | WebSocket | **Not now.** Revisit only if the Console gains write actions that need replies on the same channel | It needs a hand-written `upgrade` handler and frame code in a package with no dependencies (S). |
| D2b | HTTP/3 and WebTransport | **Not in v2.0.** Keep the client transport behind one adapter so it can be added later (section 7.10) | Node 26.12.1 here has no QUIC; loopback has no packet loss to fix; a native add-on breaks the no-dependency rule |
| D3 | UDP | **Not to the browser** (impossible). Optional later as a loopback "doorbell" from the runtime to the Console server | Browsers cannot open UDP. A doorbell is lossy, so it can only hint, never carry data. |
| D4 | Who reads runtime files | The **core**, through one new read-only streaming verb; the Console server only forwards | The core owns schemas and masking; the Console never reads files itself (S). |
| D5 | Editing settings in the Console | **Read-only in v2.0.** Edit mode is a separate, later decision (section 8) | `POST /api/session` is the only write route today and a test enforces it (S). |
| D6 | New core verbs | Yes, six read-only verbs (section 7). This is a change in the core package, not only in `console/` | The Console may only call allow-listed verbs (S). |

## 2. Where the Console is today (S)

- Plain ES modules, no framework, no build step, no runtime dependency; Node type stripping on the server
  (`console/package.json`, `bin/doflow-ui.js`). 29.8k lines including tests.
- Hash routes: Runs `#/`, Run `#/run/:slug/:taskId`, Task graph `.../tasks`, Workflows, Sessions, Fleet
  `#/fleet[/:project[/:agent]]` (`web/views.js`).
- Refresh: Runs 5 s, Run and Task graph 3 s, Sessions 10 s, Workflows 30 s, all polling. **Only Fleet
  pushes** (SSE, `src/stream.ts`), and each SSE tick is still one spawned `doflow` verb.
- Server runs only allow-listed read verbs (`verb-runner.ts` `SHAPES`), pool of 2 plus 1 for transcript,
  10 s timeout, 4 MiB output cap. Loopback by default; remote mode needs a private IP, a TLS certificate
  with an IP SAN, and gives a phone-scope session only four routes.
- Not found anywhere in `console/`: WebSocket, UDP, `fs.watch`, an HTTP `upgrade` handler.
- Not shown today: worker output logs, worker results, settings, advice and shadow picks, follow-ups,
  lifecycle events, telemetry, dispatch, session history.
- Guards a redesign must respect: `web-safety` (no `innerHTML`, no inline style or script, no `http:` or
  `https:` string in web files, `index.html` loads exactly `tokens.css`, `app.css`, one `app.js`),
  `tokens` (270 contrast pairs, light and dark parity), `hallmark-rules` (4 px grid), `design-md`
  (DESIGN.md under 400 lines, generated blocks), `package-shape` (no dependencies), `live-discipline`
  (poller rules, only `keys.js` binds keys), the server route-table test.

## 3. Goals and non-goals

Goals, from your list:

1. **See every session**, those that worked and those working, across projects.
2. **Follow the whole chain** for one session: main session, stages, tasks, attempts, workers, tool calls,
   transcripts, logs, results, as one navigable structure.
3. **See and (later) change project settings**: worker concept, advice, shadow, rollout.
4. **A better product feel**: layout, motion, a clear workflow concept, live data over a socket.

Non-goals: no framework or bundler; no remote assets; no gate decision made from the Console (it shows
the command to run, as today); no new write route in v2.0; no claim about "live" that the data cannot back.

## 4. The model the UI should teach: one flow, seven levels

The Console today shows pieces. v2 makes one object model visible, and every screen is a view onto it.

```text
Project
 └─ Session            a main coding-tool session (harness, model, role: primary)
     └─ Run            one workflow instance (task class, state, gates)
         └─ Stage      authoring / design / planning / implementation / verification / review
             └─ Task   a plan line (graph, overlaps)
                 └─ Attempt        a claim on a task (token, owner, state)
                     └─ Worker run     a headless worker (harness, tier, model, read-only or edit)
                         └─ Events     tool calls, transcript, stdout/stderr log
                             └─ Result     report status, read-only check, offered or withheld
```

Where each level comes from today (S): Run = orchestration journal; Stage = `program[]` and `history[]`;
Task and Attempt = `task-attempts/<slug>.json`; Worker run = `worker-runs/<slug>.json`; Events = harness
transcripts (byte-cursor reader) and `worker-output/<runId>.out.log`; edges = Fleet `tree` kinds
`worker-caller`, `worker-childOf`, `attempt-runKey`, `dispatch-claim`.

**Honesty rule, kept from DESIGN.md:** where a link is not recorded, draw an "unlinked" marker, never a
guessed edge. The README states that no record ties a harness sub-agent to the worker run it launched (S);
v2 shows that gap instead of hiding it (open question Q2).

## 5. Information architecture and layout

### 5.1 Navigation

| Area | Question it answers | Replaces / extends |
|---|---|---|
| **Now** (home) | What needs me, what is running, what just finished, across all projects | Runs + Sessions + Fleet landing |
| **Sessions** | Every session, worked and working; filter by project, harness, state, time | Sessions (live only today) |
| **Session** (detail) | The whole chain of section 4 for one session | Run + Task graph + Fleet project |
| **Workflows** | The nine classes, with live runs drawn on them | Workflows (static SVG today) |
| **Workers** | Which harnesses can be workers or orchestrators, their runs, results and logs | New |
| **Advice** | Shadow vs acting picks, agreement, verdict gate | New |
| **Follow-ups** | Open follow-ups, goals, release readiness | New |
| **Settings** | Effective settings per layer, with provenance | New |
| **Health** | Doctor, probes, storage, retention, telemetry contract | New |

A **command palette** (`Ctrl/Cmd-K`, registered in `keys.js` as the guard requires) jumps to any run,
session, follow-up, setting key or screen. It is the fastest way to cover the larger map.

### 5.2 Shell

```text
┌──────────┬───────────────────────────────────────────────┬───────────────────────┐
│ rail     │ canvas                                        │ inspector (drawer)    │
│ Now      │  head: title · state · freshness · pause      │  selected node:       │
│ Sessions │  ┌─────────────────────────────────────────┐  │   Overview            │
│ Workflows│  │ outline / flow map / list               │  │   Log  (live tail)    │
│ Workers  │  │                                         │  │   Transcript          │
│ Advice   │  │                                         │  │   Result              │
│ Follow-up│  └─────────────────────────────────────────┘  │   Settings in effect  │
│ Settings │  footer: blind spots · data age               │                       │
│ Health   │                                               │                       │
└──────────┴───────────────────────────────────────────────┴───────────────────────┘
```

- **At 1280 px and wider:** three regions. The inspector holds the selected node's tabs and stays open
  while you move selection in the canvas.
- **768 to 1279 px:** rail collapses to icons; the inspector becomes an overlay drawer.
- **Below 768 px:** one column; the inspector is a bottom sheet. Remote phone scope keeps its four routes
  (`PHONE_ROUTE_ALLOWLIST`) and sees only Now and Session overview until more routes are allow-listed on
  purpose.
- Every selection is in the URL hash (`#/s/<session>/<node>/<tab>`), so a view can be shared and reloaded.
  Hashes carry keys only, never paths or labels, as today (S, `views.js`).

### 5.3 Screens

**Now.** Three bands: *Needs you* (waiting gates, blocked, quota stops; the loudest thing on screen, as
Principle 1 requires), *Running* (one row per session with a stage rail and the newest event line),
*Finished since you looked* (a digest keyed on your last visit, stored in `localStorage`; never sent
anywhere). Each row opens the Session screen with the inspector on the relevant node.

**Session.** Left: an outline tree of the chain in section 4 with a state chip per node and a count of
live children. Centre: the flow map (stages and gates, current node highlighted, task graph below it).
Right: the inspector. Selecting a worker run shows **Log** (live tail of its stdout and stderr, masked),
**Transcript** (harness transcript where a reader exists), **Result** (report status, read-only check,
offered or withheld, quota) and **Process** (pid group, deadline, liveness). Replay (exists today) widens to
scrub across workers, not only the journal.

**Workers.** A matrix of the seven harnesses against the capabilities the registry records
(`runnableProbe`, `oneShot`, `structuredOutput`, `readOnly`, `spawnDenial`, `isolatedEdit`, `model`) and
the orchestration cells (`spawn`, `wait`, `status`, `cancel`, `resume`, `nest`), each cell
supported / unknown with the evidence file, plus a live list of worker runs. This turns the "can every
harness be a worker or an orchestrator" question into a screen that stays true as evidence is added.

**Advice.** Per decision kind (`advice.kinds.*`: `off`, `shadow`, `act`): picks per day, how often the
model agreed with the rule, outcomes, and the verdict-gate state (`advice-verdicts.json` ships empty by
design). Shadow picks show side by side with what actually ran. Unknown stays unknown, never 0.

**Settings.** Table of keys from `core/registry/settings.json` with type, default, scope
(`global-only`, `narrow-only`, `project-overridable`), the layer that wins (default, user, project,
environment) and the file it came from. Groups follow the concepts you named: *Workers* (`workers.*`,
`dispatch.*`, `team.*`), *Advice and shadow* (`advice.*`), *Review and debate*, *Rollout*. Read-only in v2.0.

## 6. Motion

Principles (DESIGN.md Principle 3 stays): motion explains change; only what changed moves; **at most one
looping animation per viewport**; every loop has a still variant; `prefers-reduced-motion` and the
stale state turn all loops off (S, `app.css` motion layer).

| Moment | Effect | Properties | Duration | Still variant |
|---|---|---|---|---|
| Row → detail | Shared-element transition of the row into the head (View Transitions API where available; plain `view-in` fade otherwise) | transform, opacity | 180 ms | instant swap |
| New event in a log or timeline | Newest lines tinted, tint decays | background opacity | 600 ms | no tint, a "new" marker |
| Worker running | Dashed connector flows along the one active edge | stroke-dashoffset | loop, 1.2 s | static dashes |
| State change on a node | Chip morphs (shape, word, tint together), previous state ghosts out | opacity, transform | 160 ms | instant swap |
| Gate decided | Lock icon opens, rail advances one step | transform | 240 ms | instant swap |
| Panel open or close | Inspector slides, canvas does not reflow during the move | transform | 160 ms | instant swap |
| Data goes stale | Colour drains to neutral, loops stop (exists) | filter via token | 200 ms | already still |

Budget: animate `transform`, `opacity` and SVG stroke properties only; never width, height or top/left.
No JS-driven frame loop. Setting values from JS stays `style.setProperty('--x', ...)` as `web-safety`
demands. New colours are tokens with a contrast pair in `tokens.test.ts`; new classes must exist in the CSS
(`design-md` test).

## 7. Live data over a socket

### 7.1 Requirements

Latency from a runtime write to pixels under 500 ms on loopback; no lost state after a reconnect;
bounded memory and CPU on the server; masked text only; works with the existing Origin, cookie and
session-cap rules; degrades to polling when the stream is unavailable; honest freshness ("data age").

### 7.2 Options

| Option | Reaches browser | Lossless | Fits read-only and CSP | Cost | Verdict |
|---|---|---|---|---|---|
| Polling (today) | yes | yes | yes | one verb spawn per tick | keep as fallback |
| **SSE** | yes | yes with ids | yes (S: already used for Fleet) | none | **recommended** |
| WebSocket | yes | yes | needs `upgrade` handler, hand-written frames, Origin and cookie check at upgrade; `connect-src 'self'` for `ws:` is from memory, not tested here | high, no dependency allowed | later, only if D2 changes |
| SSE over HTTP/3 | yes, but only over TLS the browser trusts | yes | yes | no QUIC server in Node core (7.10) | not now |
| WebTransport (HTTP/3) | yes (Baseline since Safari 26.4, March 2026, per 2026 articles) | yes, plus optional unreliable datagrams | `https` with explicit port; self-signed needs `serverCertificateHashes` | a native add-on or a hand-written QUIC stack | revisit on the triggers in 7.10 |
| UDP datagram | **no** (browsers cannot) | no | n/a | n/a | server-side hint only |
| Unix socket or named pipe (`net` IPC) | no | yes | n/a | medium | server-side only, see 7.4 |
| `fs.watch` on the state directory | no | no (events coalesce, platform differences) | n/a | low | a hint, always paired with a stat or cursor read |

Checked here (S): Node's `dgram.createSocket('unix_dgram')` is rejected with `ERR_SOCKET_BAD_TYPE`, so
datagram sockets are UDP over IP only; a unix-domain channel must use `net` (stream). `fs.watch` fires on
file creation in a plain directory (macOS, Node 26.12.1).

### 7.3 Recommended architecture

```text
 runtime writers (hooks, verbs, supervisors)      unchanged: they keep writing durable files
   │  worker-output/*.log (append)  runs/*.jsonl (append)  task-attempts/*.json (rename)
   ▼  lifecycle/events/*.json (new file)  orchestration/*.json (rename)
 doflow events --follow   (NEW core verb, read-only, one long-lived child per Console)
   │  watches + cursors + masking; emits NDJSON frames to stdout
   ▼
 Console server           spawns the child, restarts with backoff, forwards frames, applies limits
   │  GET /api/live?ch=…  (SSE, one stream, many channels)
   ▼
 browser                  one EventSource, a client store, views subscribe to channels
```

Why a core verb and not file reads in the Console: schemas, retention, masking and the "unknown is not
zero" rules live in the core; the Console already refuses to read files (S). One long-lived child also
removes the per-tick spawn cost (pool of 2, 10 s timeout) that makes polling heavy today.

The child can be tested without a browser (`doflow events --follow --json` in a terminal), and any other
UI (a TUI, a Pi or Kiro extension) can reuse it.

### 7.4 Event envelope

```json
{ "v": 1, "ch": "worker:w-1a2b3c4d5e6f:out", "id": "<revision-or-cursor>", "type": "append",
  "at": "2026-11-07T12:00:00.000Z", "data": { } }
```

- `id` is per channel and monotonic: a `revision` or `seq` for snapshot stores, a byte cursor
  `<inode>:<offset>:<seq>:<ms>` for logs (the format `transcripts/cursor.ts` already uses (S)).
- SSE `id:` carries a vector of the channels in use so `Last-Event-ID` resumes all of them. A fresh
  `EventSource` cannot send it (S: the current client falls back to the last 64 records), so the client
  also passes `?since=` explicitly on reopen.
- `type`: `snapshot` (full state, once per channel on subscribe), `patch` (changed sections only, as the
  Fleet stream does), `append` (new log or transcript records), `reset` (cursor invalid: refetch),
  `error` (channel failed; others continue), `gone` (file pruned).
- Frames are bounded (256 KiB, like the transcript reader) and masked twice (core `maskBody`, then
  `mask-lite.ts`, as today).

### 7.5 Channels

| Channel | Source (S unless noted) | Kind |
|---|---|---|
| `now` | `list`, `observed`, `slots` | snapshot + patch on `revision` |
| `run:<slug>:<task>` | orchestration journal `revision`, `history[]` | patch |
| `tasks:<slug>` | `task-attempts/<slug>.json` `revision` | patch |
| `worker:<runId>` | `worker-runs/<slug>.json` `seq`, `phase` | patch |
| `worker:<runId>:out` and `:err` | `worker-output/<runId>.{out,err}.log` | append by byte cursor |
| `transcript:<project>:<agent>` | harness transcript, existing cursor reader | append |
| `followups` | `lifecycle/events/*.json` (new file per event) | append |
| `advice` | `advice/picks/*.jsonl` | append |
| `fleet:<project>` | existing `projects`, `tree`, `traffic` | patch (as today) |

### 7.6 Safe tailing rules (S)

- A worker's log file is created only after the run is `running`; the run record gets its `output` pointers
  only at exit, but the path is deterministic. Tolerate `ENOENT` for a moment.
- The sink writes whole masked lines but nothing locks the file, so read only up to the last `\n`.
- Output stops growing at 4 MiB and only the final record says `truncated`; show "log capped" when the run
  has ended with `truncated`.
- **Never stream `<runId>.last.log` while the run is `running`**: the worker writes it unmasked and the
  supervisor masks it after exit.
- Retention keeps the newest 200 files for 30 days: a tailer must handle the file disappearing (`gone`).
- Run records are replaced by rename: a read sees the old or the new file, never half; retry on parse error;
  refuse any file whose `version` is not 1.

### 7.7 Limits and failure modes

Streams per session: raise the cap from 2 to 4 for the multiplexed `/api/live` plus two log panes, keep
`429 stream-limit` after that. Per-channel queue cap 1 MiB, then drop that channel with `error` (the client
resubscribes from its cursor). The child is restarted with backoff 1 s, 2 s, 5 s, 30 s; while it is down the
server answers `error` on all channels and the client falls back to the poller with a visible "polling"
badge. Freshness is shown as data age, from the newest frame, not from the connection state.

### 7.8 Where a socket from the runtime would help (optional, later)

Writers are short-lived processes, so there is no daemon to push. If measurement shows file watching adds
more than 500 ms, add a **doorbell**: after each durable write, a writer sends a small non-authoritative
message `{ch, id}` to an endpoint the Console registers in the state directory. Rules: it only wakes the
reader, which still reads the file; a lost or forged message must change nothing but timing. Prefer a
`net` unix socket (Windows: named pipe) with owner-only permissions over UDP on loopback, because any local
process can send UDP to loopback. Bash hooks could use `/dev/udp`, but that is exactly the spoofable path, so
this stays behind decision D3 and a measured need.

### 7.9 WebSocket, if D2 changes

Only for bidirectional use (subscribe or unsubscribe without reconnect, acknowledged cursors, or write
actions with replies). Needs: `upgrade` handler on the existing `http` server, Origin and cookie check
before the 101, RFC 6455 text frames only, ping and pong, 1 MiB frame cap, the same channel envelope as
7.4 so the client store does not change. Test with the existing `stream.test.ts` approach plus a frame
fuzz test. Check `connect-src 'self'` for `ws:` in Safari before committing (not verified here).

### 7.10 HTTP/3 and WebTransport

Researched 2026-11-07. Sources are marked; blog posts are weaker than specs and are labelled as such.

**What exists**

- **Node (S, this machine):** v26.12.1 rejects `require('node:quic')` and `require('node:http3')` with
  `ERR_UNKNOWN_BUILTIN_MODULE`, even with `--experimental-quic`, and `process.versions` lists no `ngtcp2`
  or `nghttp3`. So Node core on this machine has no QUIC and no HTTP/3 server. Upstream tracking is in
  nodejs/node issue #57281 ("Update on QUIC"); I did not confirm which release will ship it.
- **Browsers (web sources, 2026):** WebTransport is reported as supported in Chrome 97+, Edge 98+,
  Firefox 114+ and Safari 26.4+ (shipped March 2026), with the W3C API at Candidate Recommendation
  (30 July 2026) and the IETF wire drafts still in working-group last call, so not an RFC. Treat these
  dates as secondary-source claims.
- **Connecting (S, MDN):** the URL must be `https` with an explicit port. A self-signed server can be
  trusted with `serverCertificateHashes`: X.509v3, validity under two weeks, ECDSA P-256 (not RSA), the
  SHA-256 hash passed by the page, and a dedicated connection (`allowPooling` false). That is a good fit
  for a local tool: the Console could mint a short-lived certificate at launch and hand the hash to the
  page. Whether Firefox and Safari accept `serverCertificateHashes` I could not confirm (a Mozilla bug
  tracks it); a W3C issue titled "Consider removing serverCertificateHashes" (#623) is open, so the
  feature's future is not settled.
- **Node server options:** `@fails-components/webtransport` (a libquiche C++ binding with prebuilt
  binaries for macOS, Linux and Windows; its own README calls it a stopgap until Node ships native
  support) or a pure-JS QUIC project such as `quico` (marked "active development"). Both are
  dependencies. `console/package.json` forbids any dependency map (S, `package-shape.test.ts`).

**Why it does not help v2.0** (inference from the above and from the Console's shape)

1. Loopback has no packet loss and no round-trip cost to hide; QUIC's gains (no TCP head-of-line
   blocking, 0-RTT, connection migration, datagrams) show up on lossy or changing networks.
2. The Console is read-only and one-way. SSE already carries ordered, replayable text with ids; unreliable
   datagrams add nothing, because the data that matters (state, logs) must not be lost.
3. Plain HTTP/3 needs TLS that the browser trusts; the local mode serves `http://127.0.0.1` and the
   remote mode already needs a user-supplied certificate with an IP SAN (S). QUIC adds a second UDP
   listener and an Alt-Svc handshake on top of that.
4. A native add-on or a hand-written QUIC stack in a no-dependency package is a security and maintenance
   cost larger than the whole of phase P1.

**When to revisit** (any one of these)

- `node:quic` ships without a flag and `process.versions` lists the QUIC libraries.
- Phone or Tailscale use becomes the main way people watch runs, where loss and network switching are
  real, and measurements show SSE stalls (reconnect time above 3 s p95).
- A feature needs high-rate, loss-tolerant data (for example a live token-rate graph at 20 Hz) next to
  reliable log streams.

**How v2.0 keeps the door open:** the client store consumes envelopes (7.4), not an `EventSource`. Put
the connection behind `web/live.js` with one adapter interface (`open(channels, since)`, `close()`,
`onFrame`, `onState`) and ship the SSE adapter. A WebTransport adapter would map the same envelope to one
bidirectional stream per channel, try WebTransport first, and fall back to SSE exactly as the poller falls
back today. Nothing else in the UI changes.

## 8. Settings, advice and shadow

**Read path (v2.0).** New verbs `settings-effective` (layers, winner and file per key) and `settings-schema`
over the core's existing `settings list|schema|validate` actions (S: `src/runtime/settings/cli.ts`). The UI
adds provenance chips and validation messages; it writes nothing.

**Write path (decision D5, later).** If you want edit: a second route `POST /api/settings`, loopback
only, same Origin, `Sec-Fetch-Site` and `application/json` checks as the session exchange, a per-launch
CSRF token in the body, one key per request, the core's `config set` as the only writer (so lock, backup
and size rules apply), and a diff preview before commit. The CLI refuses security-relevant keys
(`autopilot.enabled`, `verify.reuse`, `workers.enabled`, `workers.models`, `workers.billing`, every
`advice.*`) and says you must edit the file yourself; **the Console must not become a way around that**, so
those keys render with "edit in your settings file" and a copyable snippet. The route-table test and the
README rule ("no write route except the session exchange") change in the same pull request.

**Worker concept screen.** The `workers.enabled` order, bound models per tier, eligibility per harness with
the reason a harness is not eligible, and the billing mode, next to the Workers matrix of section 5.3.

**Shadow screen.** For each kind in `shadow`: what the model picked, what the rule did, whether they
agreed, and the outcome when known. The screen states plainly that `act` is gated by a passing verdict and
that none ships (S: `advice-verdicts.json` is empty).

## 9. New read-only core verbs

All return `{v:1,...}`, mask text, bound size, and add their shape id to the Console allow-list and the
`read-contract` test.

| Verb | Returns | Source |
|---|---|---|
| `events --follow` | NDJSON frames of section 7.4 for the requested channels | files listed in 7.5 |
| `worker-log` | one page of `out`/`err` text by byte cursor, plus run phase | `worker-output/*` |
| `worker-result` | `report`, `readOnly` or `isolation`, `resultOffered`/`withheld`, `quota`; field list agreed first | `worker-runs` + `resultOfRun` |
| `sessions-history` | finished sessions with start, end, run states, worker counts | `sessions.log`, journals, worker runs (30-day retention) |
| `settings-effective`, `settings-schema` | section 8 | settings registry + layers |
| `advice-report`, `followups-list` | agreement and shadow counts; open follow-ups and goals | `advice/picks`, `lifecycle/events` |

`project.ts` drops `output`, `process` and `report` from worker status on purpose (S); `worker-result` is
where a field-by-field privacy decision is made once, not scattered across projectors.

## 10. More features worth building

Ranked by value over cost, each independent of the rest:

1. **Command palette and global search** over runs, sessions, follow-ups, settings keys.
2. **"Since you looked" digest** on Now, plus a browser notification (opt-in) and the tab-title badge
   (exists) when a gate waits.
3. **Permalinks and a redacted export** of a run's chain (JSON bundle) for bug reports; the masking pass
   runs before export.
4. **Session compare**: two runs side by side (stages, durations, workers, retries), useful for judging a
   change to a prompt or a setting.
5. **Cost and quota view**: tokens by model and agent from Fleet `traffic`, quota stops from worker reports;
   unknown stays unknown.
6. **Harness role matrix** (section 5.3 Workers): which harnesses can be workers or orchestrators, with
   the evidence file for each cell.
7. **Health page**: doctor findings, probe freshness, storage and retention, telemetry contract version.
8. **Saved filters and pinned projects** in `localStorage`.
9. **Failure explainer**: for a blocked or failed run, the stop reason and the next command, from the
   journal's own fields; no free-text guessing.
10. **Keyboard map** (`?` exists): add `g` then letter navigation and `j/k` through the outline.

## 11. Phasing

| Phase | Ships | Needs | Acceptance |
|---|---|---|---|
| P0 Shell | Rail + canvas + inspector, hash permalinks, palette, motion primitives | client only | all existing screens run inside the shell; `web-safety`, `tokens`, `hallmark-rules`, `design-md` green; reduced-motion and 360/768/1280/1920 px reviewed by a person |
| P1 Live core | `events --follow`, `/api/live`, client store; Now, Run and Sessions off polling | core + console | event-to-pixel p95 under 500 ms on loopback with the fixture console (`--tick`); kill the child and the UI shows "polling" within 3 s and recovers |
| P2 Chain | Session screen, Log, Result, Process tabs, `worker-log`, `worker-result` | core + console | a running worker's log grows in the page with under 1 s lag; a pruned log shows `gone`; `.last.log` is never read while running |
| P3 Read-only management | Settings, Advice and shadow, Follow-ups, Health, Workers matrix | verbs of section 9 | every key in the registry renders with its winning layer; unknown shown as unknown |
| P4 History and compare | Sessions history, compare, cost | `sessions-history` | finished sessions listed within the retention window; a session older than retention says so |
| P5 Decisions | Settings edit (D5), doorbell (D3), WebSocket (D2) | your call | each behind its own pull request and test plan |

Test plan: the fixture console (`scripts/fixture-console.ts`) gets a `--worker-log` mode that grows a
masked log and flips run phases; stream tests cover partial lines, inode change, truncation, pruning,
reconnect with `since`, backpressure and the 4-stream cap; `read-contract` checks every new shape; the
design guards stay as they are, with new tokens added to the contrast table.

Performance budgets (proposed, none exist today): first usable paint under 1 s on loopback; `app.css`
split per area so the first load stays under the current 128 KB (it is one file now (S)); no layout
animation; server CPU under 5% idle with one open page.

## 12. Risks and open questions

- **Q1. Does `fs.watch` coalescing lose appends on a busy log?** Plan: never trust the event, always read
  from the cursor; add a 1 s safety scan while a worker is `running`.
- **Q2. Linking a harness sub-agent to its worker run.** The supervisor sets `DOFLOW_RUN_ID`,
  `DOFLOW_LINEAGE_ID` and a binding unit for the worker (S: `launchObserved`); whether the harness's own
  session records carry them is unverified. If not, the Session screen shows the edge as unlinked.
- **Q3. Windows.** Process liveness is always `unknown` on win32 (S) and transcript paths are unverified
  (FU-062jdd); the Log and Result tabs work from files, the Process tab shows "unknown".
- **Q4. Cross-package change.** Section 9 changes the core and the Console together; the Console's
  `doflowCore` range and the contract tests must move in the same release.
- **Q4b. Transport drift.** WebTransport's spec status and `serverCertificateHashes` support are moving;
  re-check them against MDN and the browsers' release notes before acting on 7.10.
- **Q5. Dynamic import.** Splitting JS per area needs `import()` of relative files; `web-safety` allows
  only relative `.js` imports, but I did not confirm it accepts dynamic ones.
- **Q6. Clock.** A `runs/2027-12-05.jsonl` file exists in this checkout, so some clock was ahead at some
  point; never order events by file name, only by `at`/`seq`.
- **R1. Scope.** This is three to five features. Ship P0 and P1 first; they change how it feels and cost no
  new privacy decision.
