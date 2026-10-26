# DoFlow Console

A read-only local web UI over the `doflow` command line. It shows the runs of one project (stage rail, current activity, task graph, replay), the workflow diagrams, who is working where (Sessions), and every DoFlow project on the machine with its agents and what they said (Fleet). It is a separate package, `@khoavu882/doflow-ui`, with no runtime dependency: Node built-ins only. It reads everything by running allow-listed `doflow` verbs and writes nothing.

`package.json` marks the package `private` and at version 0.1.0. Until its owner publishes it, run it from a checkout (below); the install hint the launcher prints, `npm install -g @khoavu882/doflow-ui`, works only after that.

## Run it

```bash
doflow ui                          # the project in the current directory
doflow ui /Users/example/project   # another project
doflow ui --port 4310              # a fixed port (default: the OS picks one)
```

`doflow ui [<project>] [--port N]` is the core's launcher (`docs/reference.md`, row `doflow ui`). It finds this package next to the installed core, or in `node_modules/@khoavu882/doflow-ui` above the project, and starts it. The package's own binary takes the same options plus the core path:

```bash
node console/bin/doflow-ui.js --core /Users/example/doflow/bin/doflow.js [--project /Users/example/project] [--port 4310]
```

| Flag | Meaning |
|---|---|
| `--core <abs path>` | Required. The core's `bin/doflow.js`. |
| `--project <abs dir>` | The project to show. Default: the current directory. |
| `--port <0..65535>` | Default 0: the OS picks a free port. |

Each flag takes the next argument as its value and may be given once. The process prints one line on stdout and nothing else there:

```text
doflow ui: http://127.0.0.1:<port>/#c=<launch code>
```

Open that link yourself; the Console opens no browser. The code works once and for 5 minutes. Running the command again prints a new link.

**Exit codes.** 0 after Ctrl-C or SIGTERM (it shuts down within 2 s); 2 for a bad flag, or when the core is missing, has no readable version, or is outside the range in `package.json` `doflowCore` (the message names the version found and the range needed); 1 when it cannot listen. **Needs** Node 24.22.1 or later with type stripping on (the default), and a core in `doflowCore`.

## Security model

- **Loopback only.** The server binds `127.0.0.1` and refuses any other host. A request whose `Host` header is not its own address gets 421, and an `/api` request with an `Origin` header that is not its own gets 403.
- **One launch code, one session.** The link's code is a 256-bit random value held as a digest, valid for 5 minutes and spent by its first use. The page removes it from the address bar and exchanges it at `POST /api/session` for a session cookie (`HttpOnly`, `SameSite=Strict`, no expiry). Sessions live in the process's memory and end with it.
- **No write route except `POST /api/session`.** Every other route is `GET`; any other method on a path gets 405. The session can only read (`scope: read`). The Console runs no verb that changes state, and the browser cannot ask it to.
- **Allow-listed verbs only.** The server spawns the core with `shell: false` from a fixed list of complete argument shapes (`console/src/verb-runner.ts`); parameters must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (a Fleet key, `^[0-9a-f]{16}$`) before they reach an argument list.
- **The page CSP is fixed** (092 IC-010) and sent on every response: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. The page has no inline script or style, no `style` attribute, and none of `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`; text from the API reaches the page as text nodes. `console/test/web-safety.test.ts` scans every shipped web file for these.
- **No path or secret reaches the page.** Projections copy only named fields. No path, pid, host, raw session id, journal note or free-form detail leaves the server. The browser holds a project only as a 16-hex key; the server maps it to a directory and the directory never leaves it. The core already masks transcript text, and the Console masks it a second time (`console/src/mask-lite.ts`) before it is sent. **The masking is masked, best effort:** it removes the secret shapes it knows (tokens, keys, bearer values, URL credentials, emails, IPs, home directories) and can miss one that has no known shape. The only thing the page keeps in the browser is the theme choice (`localStorage` key `doflow-console-theme`); the Fleet views and the stream use no storage API, which `web-safety.test.ts` checks, so transcript text lives only in the page's memory.
- **No cache of transcripts.** The `transcript` shape is never cached on the server, and the page keeps at most 500 stream events in memory.

## Views

| View | Route | Reads |
|---|---|---|
| Runs | `#/` | `GET /api/runs`: every run of this project as a stage rail, grouped Needs you, Running, Finished |
| Run | `#/run/:slug/:taskId` | `GET /api/runs/:slug/:taskId`: rail, current activity, timeline (`orchestrate --action timeline`), replay |
| Task graph | `#/run/:slug/:taskId/tasks` | the same route: task lanes and each task's attempts (`task-attempt --action inspect`, field `attempts`) |
| Workflows | `#/workflows` | `GET /api/workflows`: one diagram per task class, built ahead of time |
| Sessions | `#/sessions` | `GET /api/sessions` |
| Fleet | `#/fleet`, `#/fleet/:projectKey`, `#/fleet/:projectKey/:agentKey` | `GET /api/fleet`, `GET /api/transcript`, `GET /api/stream` |

Other routes: `GET /api/info` (core version and capabilities) and `GET /healthz`. Runs, Workflows and Sessions show the project the Console was started in; only Fleet spans projects. Views poll while visible: Runs and Fleet every 5 s, Run and Task graph every 3 s, Sessions every 10 s, Workflows every 30 s.

## States

Every view designs the same five states.

| State | When | What you see |
|---|---|---|
| empty | no runs, a run without a plan, a plan without attempts, no session records, no project | why it is empty and the command that changes it |
| loading | the first fetch is in flight | a skeleton after 300 ms; nothing before |
| error | the core failed or sent data in a shape the Console does not read | a sentence for the error code, what to do, and a retry |
| stale | 3 missed polls, or data older than 15 s; a run silent for 24 h | the data kept on screen with a stale mark and its last-updated time, never faded |
| no-runtime | `/api/info` reports the core missing or outside the range | a full-page state with the version found, the range needed and the install command |

A section of the Sessions or Fleet view that fails shows its own sentence in place and the others still render.

## Sessions: what it cannot see

Sessions lists the project's checkouts with their branch and last commit, and the records that name a session in each: hook sessions, DoFlow runs and their workers, slot holders, and the roadmap lease. It says "started" and "last hook record", never "active", "online" or "idle" for a main session, because no main-session record carries a heartbeat. It shows a process check only for worker runs and slot holders. Its footer lists three blind spots:

- A session in a tool with no installed or trusted DoFlow hooks, that runs no DoFlow command, leaves nothing.
- A plain `git commit` or merge from any tool leaves nothing either. The "outside DoFlow" marker only compares a commit time with the last DoFlow record; it says nothing about who committed.
- A hook session whose payload carries no model writes no model record, so it can be missing or show only a start.

With no config home the view says "Hook records are off on this machine: no config home" and still shows checkouts, claims and locks. At most 20 runs are inspected and 20 workers checked per poll; the footer counts the rest as not checked.

## Fleet

Fleet answers one question: across the DoFlow projects on this machine, which agents exist, how do they hang together, what is each one saying, and who works with whom. It shows only what records state.

- **Projects (`#/fleet`).** The projects this machine knows, the Console's own first (at most 12 per read, the rest counted). A project is known if its root is in the user-state `upkeep-roots` list or a hooked session started in it; temporary directories and non-DoFlow directories are left out and counted. Each row has a label, checkouts, agent counts by kind, model chips, traffic over the last 10 minutes and the last record.
- **Hierarchy (`#/fleet/:projectKey`).** An agent tree: main sessions at the top, children under the parent a record names (harness sub-agent records, worker callers, `childOf`, run keys). An agent with no recorded parent sits under "No parent in the records"; the Console never attaches it to a guess. A node carries only the label its own record gives. "Lead" appears only if a record says so.
- **Traffic.** Per agent and per model over 10 minutes: events per minute, tool calls and errors, tool duration, tokens. A figure the harness does not record is shown as unknown, never 0 (Codex records no tool status; Kiro records no tool duration). "Working together" groups agents by the basis a record gives: the same task, overlapping plan files, or the same model.
- **The stream (`#/fleet/:projectKey/:agentKey`).** The selected agent's replies, tool calls (name and masked arguments), tool results (status, size, time only), usage, dividers and DoFlow's own `record` events, newest last, with Follow and a kind filter. Reply text is capped at 4 KiB and tool arguments at 512 bytes. Thinking, prompts, attachments and tool-result text are never read. The panel's footer says the text is **masked, best effort** and counts the records it does not show.
- **Words.** Never "active", "online", "idle" or "live" for an agent: "process seen", "recorded", "started", "last record". A process check exists only for worker runs.

**Transport.** On a Fleet page the Console pushes over one `EventSource` (`GET /api/stream`): a snapshot, project updates every 5 s, transcript ticks every 1 s for the selected agent, and a 15 s keepalive. At most 2 streams per session; a third gets 429 `stream-limit`. After 3 stream errors in a row, on 429, or without `EventSource`, the page polls `/api/fleet` every 5 s and `/api/transcript` every 2 s instead, and retries the stream every 60 s; only the transport line changes.

**Known limits.**

- The stream needs a project. `GET /api/stream` takes a `project` key and answers 400 without one. `#/fleet` therefore reads `/api/fleet` once and opens the stream on the first listed project (and polls every 5 s while no project is listed).
- A hidden tab closes the stream. When the tab is visible again the browser's `EventSource` cannot send `Last-Event-ID`, so the stream restarts from the transcript's last 64 records and the page drops events it already holds. Events older than those 64 are lost from the view after a long hide.
- Stale under push means the stream has been broken for 20 s; the keepalive is invisible to the page.
- A project that never wrote DoFlow state and never started a hooked session is in neither store and is not listed. Temporary roots written to `upkeep-roots` by test runs are filtered by path, not removed at the source (FU-d34nre).
- No record links a harness sub-agent to the DoFlow worker run it launched, so Fleet shows no such edge.

### Transcript coverage

Seven harnesses, one entry each in `core/registry/transcripts.json`. Only synthetic fixtures are read in tests; no real transcript is a fixture.

| Harness | Reader | What Fleet shows |
|---|---|---|
| Claude Code | `claude-jsonl` | replies, tool calls, usage, sub-agent records |
| Codex | `codex-rollout` | replies, tool calls (no tool status), usage |
| Kiro | `kiro-jsonl` | replies, tool calls (no per-record time, no tool duration) |
| Copilot CLI | `copilot-events` | replies, tool calls; the join by directory name is unproven, so a node links only on a match |
| Pi | `pi-jsonl` | replies, tool calls; joined by the transcript header's working directory |
| Antigravity | none | DoFlow `record` events only: "transcript not linked", because its adapter records no session id (FU-v82erq) |
| OpenCode | none | DoFlow `record` events only: "no transcript reader for opencode" (FU-0mc1vc; a read-only SQLite open changed the `-shm` file in the spike, so no reader was built) |

Every agent, whatever its harness, shows DoFlow's own `record` events, so no panel is blank. Gemini CLI has no row: it left the registry. **Windows:** only a Claude Code location is listed for Windows, and its status is `unknown`; transcript locations on Windows are unverified (FU-062jdd). `doctor` reports an entry whose `verifiedOn` date is older than 90 days.

## Design system

Colour, type, space, radius and motion are tokens in `web/tokens.css`; views use no raw value. The design system is written down in the 093 feature records (`agent-docs/doflow/093-console-web-ui/design/design-system.md`, in the DoFlow development checkout), and `test/tokens.test.ts` recomputes the WCAG 2.2 contrast of every foreground and background pair it lists, in both themes. A change to a token starts there.

## Regenerating the diagrams

`web/diagrams/<class>.svg` are built ahead of time from the core's `workflow` verb with Pele (`pele@1.1.1`, a dev dependency pinned in `package-lock.json`) and ship with the package; the page never builds them. Regenerate them by hand after the workflow registry changes. **This is a step the person runs.** An agent does not run it: installing Pele and running the build were denied to agents in this feature.

```bash
cd console
npm ci                      # installs the pinned devDependency (pele@1.1.1)
npm run build:diagrams      # writes web/diagrams/<class>.svg from this checkout's core
npm run build:diagrams -- --core /Users/example/doflow/bin/doflow.js   # or from another core
```

Each SVG starts with a stamp (`source-sha256`, `pele` version) so `test/diagrams.test.ts` can tell when a diagram no longer matches its source. Commit the changed SVGs; `node_modules` is not committed.

## Tests

```bash
cd console
npm test              # node --test "test/**/*.test.ts"
npm run typecheck
```

`scripts/fixture-console.ts` (development only, not shipped) starts a Console with the real core over a scratch fixture project and HOME, for browser checks. Browser review (layout at 360, 768, 1280 and 1920 px, both themes, reduced motion) is done by a person.
