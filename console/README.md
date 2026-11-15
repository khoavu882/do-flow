# DoFlow Console

A read-only local web UI over the `doflow` command line. It shows the runs of one project (stage rail, current activity, task graph, replay), the workflow diagrams, who is working where (Sessions), and every DoFlow project on the machine, layer by layer, with its runs, gates, briefs, reports, agents and what they said, all streaming live (Layers). It is a separate package, `@khoavu882/doflow-ui`, with no runtime dependency: Node built-ins only. It reads everything by running allow-listed `doflow` verbs and writes nothing.

`package.json` marks the package `private` and at version 0.1.0. Until its owner publishes it, run it from a checkout (below); the install hint the launcher prints, `npm install -g @khoavu882/doflow-ui`, works only after that.

## Build a local package

From the repository checkout, stage the JavaScript package before packing it:

```bash
cd console
npm run build:package
npm pack .pack
```

The build uses the core release builder and writes `console/.pack`. Pack that staged directory: Node does not strip TypeScript inside `node_modules`. Packing the unbuilt source directory is refused by the prepack check. Install the resulting tarball alongside a compatible DoFlow core to use the launcher.

## Run it

```bash
doflow ui                          # the project in the current directory, on loopback
doflow ui /Users/example/project   # another project
doflow ui --port 4310              # a fixed port (default: the OS picks one)
doflow ui --lan                    # reachable from a phone on the same network, see "Pair a phone"
doflow ui --action devices         # list the paired phones
```

`doflow ui [<project>] [flags]` is the core's launcher (`docs/reference.md`, row `doflow ui`). It finds this package next to the installed core, or in `node_modules/@khoavu882/doflow-ui` above the project, and starts it. The package's own binary takes the same options plus the core path:

```bash
node console/bin/doflow-ui.js --core /Users/example/doflow/bin/doflow.js [--project /Users/example/project] [--port 4310] [--lan [--listen-address <private local IP>]]
```

| Flag | Meaning |
|---|---|
| `--core <abs path>` | Required. The core's `bin/doflow.js`. |
| `--project <abs dir>` | The project to show. Default: the current directory. |
| `--port <0..65535>` | Loopback default 0: the OS picks a free port. With `--lan`: the port this project last used, else the first free one of 47380 to 47399; `--port` wins and is the only one tried. |
| `--lan` | Serve HTTPS on a private address, with a certificate the Console generates, for paired phones. |
| `--listen-address <IP>` | With `--lan`: the address to serve on instead of the automatic choice. Must be an RFC1918, Tailscale CGNAT (`100.64.0.0/10`) or IPv6 unique-local literal already assigned to a local interface. DNS names, wildcard, public and unassigned addresses are refused. |
| `--tls-cert <abs path>` / `--tls-key <abs path>` | Your own certificate chain and key instead of the generated one. Given together, and with `--listen-address`, without `--lan`. |
| `--action pair` `[--scope view\|control]` | Print a fresh pairing code block for the LAN Console already running. |
| `--action devices` `[--json]` | List the paired devices. |
| `--action revoke --device <id>` | Revoke one device (`d-` and 12 hex digits, as `devices` shows it). |

Each flag takes the next argument as its value and may be given once; `--lan` and `--json` take none. The three actions run without the core handshake and listen on nothing.

In loopback mode the process prints one line on stdout and nothing else there:

```text
doflow ui: http://127.0.0.1:<port>/#c=<launch code>
```

Open that link yourself; the Console opens no browser. The code works once and for 5 minutes. Running the command again prints a new link. Loopback mode creates no `console/` directory.

**Exit codes.** 0 after Ctrl-C or SIGTERM (it shuts down within 2 s); 2 for a bad flag, or when the core is missing, has no readable version, or is outside the range in `package.json` `doflowCore` (the message names the version found and the range needed); 1 when it cannot listen. **Needs** Node 24.22.1 or later with type stripping on (the default), and a core in `doflowCore`.

## Pair a phone

`doflow ui --lan` serves HTTPS on a private address of this machine and prints one block on stdout: the address, the certificate's SHA-256 fingerprint, a one-use pairing code valid for 5 minutes, a link that carries the code in its fragment, and a QR code when stdout is a terminal. Lines about what it chose go to stderr, each prefixed `doflow ui: `.

1. **Address.** Without `--listen-address` the Console takes the one RFC1918 address on a non-virtual interface (no Docker, bridge, VPN or tunnel adapters: names such as `docker`, `br-`, `veth`, `utun`, `tun`, `tap`, `wg`, `ppp`, `ipsec`, `cscotun`, `gpd`, and Windows names containing VMware, VirtualBox, Hyper-V, vEthernet, TAP-, WireGuard, Tailscale or ZeroTier). With none or several candidates it exits 2 and lists what it saw; pass `--listen-address`. `100.64.0.0/10` is accepted when named, never chosen.
2. **Certificate.** A self-signed ECDSA P-256 certificate with one IP subject alternative name per address, valid 397 days, kept in `<config home>/console/tls` (mode 0700, key 0600) and reused until 30 days before it ends. While the Console runs it checks the end date once a day and at each pairing: inside the last 30 days it prints one warning, and past the end date it serves no LAN request (503 `cert-expired`) and prints a line telling you to restart `doflow ui --lan`, which issues a new certificate (a device that pinned the old fingerprint pairs again). Your own pair via `--tls-cert` and `--tls-key` (absolute paths; the IP SAN and key match are checked before listening).
3. **Scan, then compare, before you proceed.** Scan the QR code or open the link. The phone's browser warns that the certificate is not trusted, because it is self-signed. **Before you proceed past that warning**, compare the SHA-256 fingerprint printed in your terminal with the one your browser shows in the certificate details. Proceed only if they match; the page then asks for a name for the phone and sends the code to `POST /api/pair`. If they differ, stop: someone else is answering at that address. The page shows a fingerprint too, labelled "from your link": it is a value the link carried, so a hostile page can show any value there, and the page never presents pressing the button as the check.
4. **After pairing.** A phone that paired through a browser is `view` for ever (below). The phone holds a device credential: the `HttpOnly`, `Secure`, `SameSite=Strict` cookie `doflow_device` for a browser, or a `Bearer dfd1_...` token for a native client (the pair reply carries it once). The Console stores only the token's SHA-256. The credential ends after 30 days without use, or when it is revoked.
5. **Scope.** A device may read four routes: `GET /api/info`, `GET /api/runs`, `GET /api/runs/:slug/:taskId` and `GET /api/workflows`. Every other route answers 403 `phone-scope`. Scope `control` can be chosen at pairing (`--action pair --scope control`) and is stored, but grants nothing more yet; and only a device paired by a native client over the Bearer transport, which pins the certificate, can hold it. A browser pairing with a control code becomes a `view` device (the pair reply says so), and a stored record that pairs a browser with control reads as `view`. `--action devices` shows each device's transport (`browser` or `native`).
6. **Manage.** `doflow ui --action pair` prints a new code for the running Console; `--action devices` lists id, name, scope, how it paired, when, last seen, last address and state; `--action revoke --device <id>` ends a device's access at its next request, from any process. At most 64 active devices. A revoked device and one idle for over 30 days are kept for another 30 days so they read as revoked or expired (`device-expired`), not unknown; an expired one does not count toward the 64.

The device store is machine-wide: `<config home>/console/lan.json` (DoFlow's config home is `doflow` under an absolute `XDG_CONFIG_HOME`, else under `$HOME/.config`), guarded by a lock file, with a remembered port per project. Several Consoles on one machine share it. No device list, token or code is written to stdout except the pairing block and `--action devices`.

Residual risks, stated so they are not a surprise:

- A browser keeps cookies per host, not per port. Another service on the same address and a different port can read or overwrite `doflow_device` for that host; the cookie is a bearer credential, so use a dedicated address when that matters.
- The one-use code travels in the link's fragment, which a browser does not send to the server; anyone who sees the terminal block or the QR code before it is used can pair. The code expires after 5 minutes and is consumed by its first success.
- **A browser-paired device can be impersonated on a hostile network.** On a Wi-Fi an attacker controls, someone can answer at the address with their own certificate and their own page, which shows any fingerprint it likes and reads the code from the link's fragment. Only your own comparison before you proceed past the warning defeats that, and a page cannot enforce it. That is why a device paired through a browser can only view runs and workflows, and why `control` needs the native client, which pins the certificate.
- **Pairing is rate limited so that strangers cannot lock the owner out.** Each attempt is counted before its body is read (so parallel requests count one by one) and given back when it succeeds or fails for any reason but a refused code. A client address may have 5 refused codes in a fixed 10-minute window, then `POST /api/pair` answers 429 with `Retry-After`. Past 20 refused codes overall the Console only slows every pairing down (150 ms more per refused code, at most 3 s) and never refuses on the overall count, so a code freshly minted by `--action pair` stays redeemable. Codes are 128 bits and at most 16 are pending, so guessing one is infeasible at any rate this allows.
- Browsers add `Sec-Fetch-Site` to their requests. In LAN mode any `/api` request whose value is not `same-origin` or `none` is refused (403), for every method; a request with no such header (a native client) is judged by its Bearer alone.
- An unpaired caller learns nothing about which `/api` paths exist: every `/api` path but the pairing exchange answers 401 `device-unpaired` until a device credential is shown.
- `lan.json` is read only as a regular file of at most 1 MiB, never through a symlink, and only from a folder this user owns that is not writable by others (a writer sets it to 0700, or refuses the store). Anything else is `store-unreadable`: the Console refuses every device and never overwrites the file.
- The store lock has a ceiling: POSIX has no compare-and-delete, so reclaiming a stale lock can, with a stale lock and three or four writers at once, briefly let two writers hold it. A writer re-reads its lock just before replacing `lan.json` and gives up with `store-busy` when it is no longer its own, which leaves a gap of one read to one rename (the exact trace is in the header of `console/src/lan-store.ts`).
- This is not end-to-end verified on a real phone: whether Chrome for Android keeps the fragment through its certificate warning, and whether it shows the SHA-256 fingerprint, were not confirmed.

## Security model

- **Loopback by default; explicit private HTTPS for phones.** Without `--lan` the server is HTTP on `127.0.0.1`. `--lan` (or `--listen-address` with your own certificate) serves HTTPS on one private address: RFC1918, Tailscale CGNAT `100.64.0.0/10` or IPv6 unique-local, assigned to a local interface. Wildcards, public addresses, DNS names and unassigned addresses are refused. Host and Origin allowlists are exact in both modes; proxy headers are not trusted. The certificate is self-signed, so a phone is paired once by comparing its fingerprint (see Pair a phone); do not continue past a fingerprint that differs.
- **Loopback: one launch code, one browser session.** The link's code is a 256-bit random value held as a digest, valid for 5 minutes and consumed by its first successful exchange at `POST /api/session`. The page removes it from the address bar. The cookie is `HttpOnly` and `SameSite=Strict`. Sessions live in process memory and end with the process. LAN mode has no such session: `POST /api/session` is refused (405) and paired devices are used instead.
- **LAN: paired devices only.** Every `/api/*` route except `POST /api/pair` needs a device credential (cookie for a browser, Bearer for a native client; both together are refused). The token is `dfd1_` plus 32 random bytes, shown once and stored only as its SHA-256. A revoke from any process is seen on the next request.
- **A device's scope is narrow.** It may use only `GET /api/info`, `GET /api/runs`, `GET /api/runs/:slug/:taskId`, `GET /api/workflows`, `GET /api/live` (every channel kind), `GET /api/sessions` and the worker-run reads `GET /api/worker-runs/:slug` and `GET /api/worker-runs/:slug/:runId/{result,status,log,transcript}` (one list, `console/src/scopes.ts`; `view` and `control` read the same list). Briefs, reports and transcripts reach a device only through `/api/live` lanes; its stream re-checks the device on every keepalive and ends on a revoke or an expiry. Management routes and every other API route answer 403 `phone-scope`. Loopback keeps its own read scope.
- **Two write routes.** `POST /api/session` (loopback) and `POST /api/pair` (LAN) are the only non-`GET` routes; any other method on a path gets 405. A session or device can only read. The Console runs no verb that changes state, and the browser cannot ask it to. The pairing, device and certificate files are the Console's own state and are written by the Console process and the `--action` commands.
- **Allow-listed verbs only.** The server spawns the core with `shell: false` from a fixed list of complete argument shapes (`console/src/verb-runner.ts`); parameters must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (a project, file or agent key, `^[0-9a-f]{16}$`) before they reach an argument list.
- **The page CSP is fixed** (092 IC-010) and sent on every response: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. The page has no inline script or style, no `style` attribute, and none of `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`; text from the API reaches the page as text nodes. `console/test/web-safety.test.ts` scans every shipped web file for these.
- **Projections and masking.** Projections copy only named fields. Management screens place path fields relative to a named anchor or show a withheld label, and show bounded, masked reasons and evidence as text. Free text may retain paths outside those anchors. Pids, hosts, raw session ids and journal notes do not leave the server. The browser holds a project only as a 16-hex key; the server maps it to a directory and the directory never leaves it. The core already masks transcript text, and the Console masks it a second time (`console/src/mask-lite.ts`) before it is sent. **The masking is masked, best effort:** it removes the secret shapes it knows (tokens, keys, bearer values, URL credentials, emails, IPs, home directories) and can miss one that has no known shape. The only thing the page keeps in the browser is the theme choice (`localStorage` key `doflow-console-theme`); the Layers view and the stream use no storage API, which `web-safety.test.ts` checks, so transcript text lives only in the page's memory.
- **No cache of transcripts.** The `transcript` shape is never cached on the server. A `transcript:` lane keeps a window of at most 200 events and 131072 bytes in the hub, and the page keeps at most 500 events in memory.

## Views

| View | Route | Reads |
|---|---|---|
| Runs (rail: Now) | `#/` | `GET /api/live` channel `now`, member `runs`; polled: `GET /api/runs`. Every run of this project as a stage rail, grouped Needs you, Running, Finished |
| Run | `#/run/:slug/:taskId`, `#/run/:slug/:taskId/stage/:id`, `#/run/:slug/:taskId/gate/:id` | `GET /api/live` channel `run:<slug>:<taskId>`, member `run`; polled: `GET /api/runs/:slug/:taskId`. Rail, current activity, timeline (`orchestrate --action timeline`), replay |
| Task graph | `#/run/:slug/:taskId/tasks`, `#/run/:slug/:taskId/tasks/:task` | the same channel and route: task lanes and each task's attempts (`task-attempt --action inspect`, field `attempts`) |
| Workflows | `#/workflows` | `GET /api/workflows`: one diagram per task class, built ahead of time |
| Sessions | `#/sessions`, `#/sessions/:lane`, `#/sessions/history` | `GET /api/live` channel `now`, member `sessions`; polled: `GET /api/sessions`, `GET /api/sessions-history` |
| Compare | `#/compare`, `#/compare/:slugA/:taskIdA/:slugB/:taskIdB` | `GET /api/sessions-history`: side-by-side run comparison, metric deltas, stage alignment, and cost/token breakdown |
| Session (Chain) | `#/session/<slug>/<taskId>[/<node>[/<tab>]]`; `<node>` is `main`, `stage/<id>`, `gate/<id>`, `task/<id>`, `attempt/<task>/<token>` or `worker/<runId>`, and `<tab>` (worker nodes only) is `log`, `transcript`, `result` or `process` | `GET /api/live` channels `run:<slug>:<taskId>` (member `run`) and `tasks:<slug>` (member `workers`), `worker:<runId>` (members `worker` and `result`) for the selected worker run, and `worker:<runId>:out` and `:err` while its Log tab is open, at most 5 channels; polled: `GET /api/runs/:slug/:taskId` and `GET /api/worker-runs/:slug`. One run's chain as an outline tree (main session, stages and gates, tasks, attempts, worker runs, child runs under their granter) and four worker tabs: Log (`GET /api/worker-runs/:slug/:runId/log`), Transcript (`.../transcript`, read once), Result (`.../result`) and Process (`.../status`) |
| Layers | `#/layers`, `#/layers/:projectKey`, `#/layers/:projectKey/agent/:agentKey`, `#/layers/:projectKey/file/:fileKey` | `GET /api/live` channels `machine` (member `machine`) and `layers:<pk>` (member `layers`), and for the inspector `transcript:<pk>:<ak>` or `file:<pk>:<fk>`; no GET and no polling, see Layers |
| Settings | `#/settings`, `#/settings/:key` | `GET /api/settings` (`config-list`, `config-schema`) every 30 s; resolved values, layers and locked rules |
| Advice and shadow | `#/advice[/kind/:kind][/pick/:pickId]` | `GET /api/advice[?kind=:kind]` (`config-list`, `advise-report`, `advice-picks`) every 30 s |
| Follow-ups | `#/followups`, `#/followups/:id` | `GET /api/followups?state=:state[&cursor=:cursor]` (`followups`, `lifecycle-overview`) every 30 s; `GET /api/followups/:id` on selection |
| Health | `#/health`, `#/health/store/:id` | `GET /api/storage` every 60 s; `GET /api/doctor` once on open and again only on Refresh |
| Workers | `#/workers`, `#/workers/:harness/:group/:cell` | `GET /api/workers` (`worker-matrix`, `config-list`) every 30 s; `GET /api/doctor` once on open and again only on Refresh |

The seven management routes are `GET /api/settings`, `/api/advice`, `/api/followups`, `/api/followups/:id`, `/api/doctor`, `/api/storage` and `/api/workers`. A paired device is refused all seven with 403 `phone-scope`. Sectioned routes keep other sections visible when a supported-range core lacks a verb; the missing section says the core does not provide it. The individual follow-up, doctor and storage routes return 501 `core-lacks-verb` when their read is missing. Settings and Advice show the Console's resolved values; settings environment overrides from the shell that started the Console are not passed through and may resolve differently in a terminal.

Other routes: `GET /api/info` (core version and capabilities), `GET /healthz`, `GET /api/sessions-history` (`sessions-history`; lists completed workflow runs within retention cutoff with durations, workers, and token costs), and the worker routes `GET /api/worker-runs/:slug` (`worker-runs`; on a core without it, one `worker --action status` per active attempt, at most 16, with `source: "active-attempts"`), `GET /api/worker-runs/:slug/:runId/result` (`worker-result`), `.../status` (`worker --action status --worker-run`), `.../log?stream=out|err[&cursor=<c> | &before=<c>]` (`worker-log`) and `.../transcript` (the run's transcript in this project). A worker route checks its slug, run id and query before any verb runs (400 `usage`) and answers 501 `core-lacks-verb` on a core without the verb. Runs, Workflows and Sessions show the project the Console was started in; only Layers spans projects. A route with a selection (a stage, a gate, a task, a Sessions lane such as `hook/<key>` or `worker/<slug>/<task>/<token>`, or a Session node and tab) opens the view with that item selected; a segment that fails its pattern is the not-found view and makes no fetch. Runs, Run, Task graph, Sessions and Session read the live stream (below) and fall back to polling their GET while it is down (Layers is stream-only): Runs every 5 s, Run, Task graph and Session every 3 s, Sessions every 10 s; an open Log tab reads forward from its last position every 3 s instead. Layers has no polling fallback: when the stream is down the view says so in its stream banner. Workflows polls every 30 s. "Chain" links open the Session screen from the Now run row and gate card, the Run view's head and the Tasks head, and the palette lists one `<slug> / <taskId>` target per run with the hint `Chain`.

## States

Every view designs the same five states.

| State | When | What you see |
|---|---|---|
| empty | no runs, a run without a plan, a plan without attempts, no session records, no project | why it is empty and the command that changes it |
| loading | the first fetch is in flight | a skeleton after 300 ms; nothing before |
| error | the core failed or sent data in a shape the Console does not read | a sentence for the error code, what to do, and a retry |
| stale | 3 missed polls, or data older than 15 s; a run silent for 24 h | the data kept on screen with a stale mark and its last-updated time, never faded |
| no-runtime | `/api/info` reports the core missing or outside the range | a full-page state with the version found, the range needed and the install command |

A section of the Sessions, Layers, Settings, Advice, Follow-ups or Workers view that fails shows its own sentence in place and the others still render.

## Sessions: what it cannot see

Sessions lists the project's checkouts with their branch and last commit, and the records that name a session in each: hook sessions, DoFlow runs and their workers, slot holders, and the roadmap lease. It says "started" and "last hook record", never "active", "online" or "idle" for a main session, because no main-session record carries a heartbeat. It shows a process check only for worker runs and slot holders. Its footer lists three blind spots:

- A session in a tool with no installed or trusted DoFlow hooks, that runs no DoFlow command, leaves nothing.
- A plain `git commit` or merge from any tool leaves nothing either. The "outside DoFlow" marker only compares a commit time with the last DoFlow record; it says nothing about who committed.
- A hook session whose payload carries no model writes no model record, so it can be missing or show only a start.

With no config home the view says "Hook records are off on this machine: no config home" and still shows checkouts, claims and locks. At most 20 runs are inspected and 20 workers checked per poll; the footer counts the rest as not checked.

## Layers

Layers answers one question: across the DoFlow projects on this machine, what is each layer of the work doing and what waits for a person. It replaces the earlier Fleet page. It shows only what records state, and every byte on it arrives over `GET /api/live`: the view makes no GET and runs no timer.

- **Machine page (`#/layers`).** One row per project (the Console's own first), from the `machine` channel: open and awaiting runs, the newest awaiting gates, open worker runs and observed sessions, and what the page cannot see. A project is known if its root is in the user-state `upkeep-roots` list or a hooked session started in it; test scratch folders and non-DoFlow directories are left out and counted, and a project under a temp folder is listed with a `temp` mark. The page shows the first 16 projects' activity and counts the rest.
- **Project page (`#/layers/:projectKey`).** From the `layers:<pk>` channel: a lane per checkout with its runs and their stages and gates, the main session, worker runs, sub-agents, and the briefs, reports, envelopes, prompts and worker logs the project wrote (at most the 64 newest), review state per feature, observed sessions with their audit lines and denials, the agent tree and traffic, and a coverage table with one row per registry harness saying what is observed and why not. A record that names no checkout or run key is shown under "Not placed in a checkout" and never attached to a guess. A gate shows who decided it: `autopilot`, "decided manually" (a direct command, typed by a person or by an attended agent for them), or "decider not recorded" for a record written before feature 161.
- **Inspector.** An agent (`#/layers/:projectKey/agent/:agentKey`) opens its transcript as a `transcript:<pk>:<ak>` lane: replies, tool calls (name and masked arguments), tool results (status, size, time only), usage, dividers and DoFlow's own `record` events, newest last, with Follow and a kind filter. Reply text is capped at 4 KiB and tool arguments at 512 bytes. Thinking, prompts, attachments and tool-result text are never read. A file (`#/layers/:projectKey/file/:fileKey`) opens its text as a `file:<pk>:<fk>` lane. A file is addressed by its key and the Console never sends a path. The panel's footer says the text is **masked, best effort** and counts the records it does not show. Masking covers secrets and home paths, best effort; other paths and ids an agent writes in its own text are shown as written.
- **Words.** Never "active", "online", "idle" or "live" for an agent: "process seen", "recorded", "started", "last record". A process check exists only for worker runs.
- **Not observed.** Agent questions and permission prompts are not observed and the coverage table says so (a follow-up, FU-jk71y1, covers them).

**Latency.** Measured on loopback with `node console/scripts/measure-layers.ts` against this checkout's core (24 samples per kind; the sample ends when the page's data path delivers the item, not at a DOM render): a new audit line p50 82.4 ms, p95 85.8 ms, max 88.6 ms; a new brief line p50 49 ms, p95 52.1 ms, max 53.1 ms. The target is p50 under 300 ms and max under 1000 ms. **Worst case, about 1.2 s:** when a file-watch event is lost the core finds the change on its next 1 s pass, so the page shows it up to about 1.2 s later, above the 1 s target; this is accepted. The numbers are loopback only; a LAN is not measured here (it is a later feature, 163).

**Live transport.** Runs, Run, Task graph, Sessions, Session and Layers share one `EventSource` per page on `GET /api/live?ch=<channel>[,<channel>...]`, 1 to 8 distinct channels: `now`, `run:<slug>:<taskId>`, `tasks:<slug>`, `worker:<runId>`, the log channels `worker:<runId>:out` and `worker:<runId>:err`, and, since feature 161, `machine`, `layers:<projectKey>`, `file:<projectKey>:<fileKey>` and `transcript:<projectKey>:<agentKey>` (a key is 16 lowercase hex). Each message is one envelope `{v: 1, ch, id, type, at, data}` (`snapshot`, `patch`, `reset`, `error` or `gone`; a log channel sends `append` instead of `patch`). The SSE `id:` is the position on every channel of the connection (`<epoch>/<ch>=<pos>,...`): `<n>` on most channels (a `transcript:` lane too: the hub's counter), and `<ino>:<offset>` on a log channel and a `file:` lane, the file's inode and the `to` of its last frame. The page sends it back as `since` when it reopens, and a channel that has not moved since then gets nothing. A log position is used whatever the vector's epoch: a position with the window's inode at a piece boundary inside the window gets one `append` from there, one at the window's end gets nothing, and any other gets a `snapshot` of the window. The server sends `retry: 2000` and, every 15 s, a named `keepalive` event (`event: keepalive`, `data: {}`, no `id:`) that the page watches: 30 s without any message or keepalive counts as a closed stream, so a frozen server that keeps the socket open ends live mode too. A bad `ch` or `since` is 400 `usage`, and so is a log position on another channel or an `<n>` on a log channel.

- **One events child.** Behind every live connection the Console runs one `doflow events --follow --control stdin` child. It is started when the first live channel is needed, gets a `sub` or `unsub` line on stdin as channels come and go, and is ended (stdin end, SIGTERM, SIGKILL after 1 s) when the last `/api/live` connection closes. If it exits for any other reason, every live channel gets `error` `events-down` and the child is restarted after 1 s, 2 s, 5 s, then every 30 s; the delay goes back to 1 s once a child has run for 60 s. A stdout line that is not an envelope ends the child and takes the same restart path.
- **Same data as the GET.** Each channel's state is built from the child's sections by the same code that answers the GET routes, so a `snapshot` equals the GET reply for the same records.
- **Layers kinds.** `machine` and `layers:<pk>` are composed from the core's sections of the same name by closed-field projectors (`console/src/layers-compose.ts`); a resume from a position the hub still holds (the last 64 frames of a channel) gets the missed patches, else a snapshot. A `transcript:` lane holds a window of at most 200 events, each tagged with the hub position of the frame that carried it. At most 32 lanes (worker log, file and transcript together) per Console; one past that gets `error` `too-many-lanes`. At most 8 distinct projects are followed across `layers`, `file` and `transcript` channels (`too-many-projects`).
- **Capability gate.** The Console does not compare versions. Before it sends a `sub` of a `machine`, `layers`, `file` or `transcript` channel it reads `doflow events --kinds --json` once per core child; a channel whose kind the core does not list (an older core refuses the flag with exit 2) gets `error` `core-lacks-channel` and no `sub` is sent, while the older channels keep working. A read with no exit leaves the gate unknown and the next subscribe tries again.
- **Restart.** A `machine` or `layers` channel and a `file` or `transcript` lane that hold state are kept through `events-down` with no frame for 5 s; the new child's snapshot is then diffed into one `patch` (a transcript lane replaces its window with one snapshot, a file lane merges it). After 5 s of no child the channel gets `error` `events-down` as any other.
- **Log channels.** `worker:<runId>:out` and `:err` are not composed from sections. The Console holds one window of at most 131072 bytes per log channel, fed by the child's `snapshot`, `append`, `reset`, `error` and `gone` frames, masks every piece again (`console/src/mask-lite.ts`) and forwards the frames with its own counter and clock in the id. No verb runs per `append` or on a timer.
- **Log support gate.** The first log channel subscribed runs one `worker-log` tail read through the verb pool. No log channel is sent to the events child as a `sub` line before that read answers. A core answer (exit 0, or a JSON error id) means logs are supported and the log channels are followed. The old-core answer means they are not: every log channel then gets `error` `core-lacks-verb` and nothing else for the rest of the Console's run. Any other failure leaves support unknown, and the next log subscribe tries again.
- **Bounds.** A channel whose queue would pass 524288 bytes is cleared, gets `error` `queue-full`, and then one fresh `snapshot`. A connection with more than 1048576 bytes queued, or with bytes pending and no `drain` for 60 s, is closed. A message over 262144 bytes is sent as `reset` `frame-cap`.
- **Polling fallback.** When the stream is refused (429, or three reconnect errors in a row), unsupported (503, or no `EventSource` in the page) or closed, or a channel sends `error`, `reset` or `gone`, the view polls its own GET at the interval in Views. The header pill reads `Polling` instead of `Live`, and a notice says "Push unavailable; polling every N seconds."; when the stream is back it says "Push restored." and the GET timer stops. The page reopens the stream after 30 s when it was refused or unsupported, and after 5 s when it closed. A hidden tab or a pause closes the stream; it reopens with `since` when the tab is visible again. Live data is stale when data had arrived and the connection has not been open for 20 s; after any switch to polling that follows live data, that rule holds until the view's polled GET has answered once.
- **Old core.** A core inside the `doflowCore` range that has no `events` verb answers the child with an unknown flag, command or verb, exit 1 or 2, before any stdout line and with no `[ERROR]` line. The Console then treats live as unavailable for the rest of its run: the child is not restarted, open live connections get `error` `live-unavailable` and end, and `/api/live` answers 503 `live-unavailable`. The views keep polling, as they did before this feature.
- **Older core and the Session screen.** A core without `worker-runs`, `worker-result` or `worker-log` answers the matching worker route 501 `core-lacks-verb`, and a missing `runs` or `result` section on its `tasks:` or `worker:` channel counts as the same. The Session outline then says "This DoFlow core does not list worker runs, so attempts’ worker runs are not checked." and the worker tabs say, per tab: "This DoFlow core does not provide worker logs." (Log), "This DoFlow core does not provide transcripts." (Transcript), "This DoFlow core does not provide worker results." (Result) and "This DoFlow core does not provide worker process status." (Process).
- **Not verified.** The browser review (360, 768, 1280 and 1920 px, both themes, reduced motion) is still to be done by a person. The live path has not been run on Windows, so its behaviour there is unknown.

**Stream cap.** `/api/live` takes a slot per open connection: at most 4 per session or paired device (`MAX_STREAMS_PER_SESSION` in `console/src/stream-cap.ts`) and 16 over the whole Console. A connection past either gets 429 `stream-limit` as JSON before any stream header, and a closed stream frees its slot. A paired device may open `/api/live` (see the device scope above); the same caps apply.

**Known limits of Layers.**

- A hidden tab closes the stream. It reopens with `since`: a `machine` or `layers` channel gets the patches it missed when the hub still holds them (the last 64), else a snapshot; a `transcript:` lane gets the newer events when its position is inside the hub's 200-event window, else a snapshot of the window. Events that left that window during a long hide are not shown again.
- Stale under push means the stream has been broken for 20 s; the keepalive is invisible to the page.
- A project that never wrote DoFlow state and never started a hooked session is in neither store and is not listed. Temporary roots written to `upkeep-roots` by test runs are filtered by path, not removed at the source (FU-d34nre).
- No record links a harness sub-agent to the DoFlow worker run it launched, so Layers shows no such edge.
- A `file:` lane follows a file found through the 64 newest artifacts; a file pushed off that list stays followed for up to about 25 s, then the lane is `gone`.
- The `machine` channel's `activity` is recomputed at most once per second, because hook sessions write constantly.

### Transcript coverage

Seven harnesses, one entry each in `core/registry/transcripts.json`. Only synthetic fixtures are read in tests; no real transcript is a fixture.

| Harness | Reader | What Layers shows |
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

`scripts/fixture-console.ts` (development only, not shipped) starts a Console with the real core over a scratch fixture project and HOME, for browser checks. Pass `--manage` to add the settings, follow-ups, goals, advice and doctor management world; `--manage --empty` is refused. Browser review (layout at 360, 768, 1280 and 1920 px, both themes, reduced motion) is done by a person.
